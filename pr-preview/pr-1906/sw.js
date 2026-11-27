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
		buildId: "a22362e20260-7615628b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1906/\":\"a59fd3c9fcc2cfd9\",\"/knowledge-medium/pr-preview/pr-1906/index.html\":\"a59fd3c9fcc2cfd9\",\"/knowledge-medium/pr-preview/pr-1906/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1906/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1906/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1906/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1906/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1906/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1906/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1906/assets/FacadeVFS-BncZGyZ6.js\":\"6a0e7512719c1f53\",\"/knowledge-medium/pr-preview/pr-1906/assets/OPFSCoopSyncVFS-BFx_o-jv.js\":\"8c71cd3764c95feb\",\"/knowledge-medium/pr-preview/pr-1906/assets/OPFSWriteAheadVFS-BjXpYZPU.js\":\"a10fbbe89d5c2f7e\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-async-D9vBKqjQ.js\":\"94c2051c787d7af2\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-iPGTibNX.js\":\"7855c137fba7e004\",\"/knowledge-medium/pr-preview/pr-1906/assets/worker-Bbvtp6s6.js\":\"ff4ca5ece7da078e\",\"/knowledge-medium/pr-preview/pr-1906/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1906/chunks/app-BppOdq28.js\":\"14d4c4a4227436f5\",\"/knowledge-medium/pr-preview/pr-1906/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1906/index.js\":\"6f802dc41642b786\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1906/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1906/assets/AccessHandlePoolVFS-HKRyJFTR.js\":\"542e2a3eb6274500\",\"/knowledge-medium/pr-preview/pr-1906/assets/IDBBatchAtomicVFS-ppHmHEfG.js\":\"6abec8fde789f281\",\"/knowledge-medium/pr-preview/pr-1906/assets/MemoryVFS-l1lSP-oh.js\":\"9a52ec006d5e94b1\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-CedV45ih.js\":\"fef4b34c58a92fa3\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-async-B7Jvxs_W.js\":\"eeacadf5ff1bc771\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1906/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1906/chunks/AccessHandlePoolVFS-BaMyDHB8.js\":\"e95a54d898d40ef0\",\"/knowledge-medium/pr-preview/pr-1906/chunks/FacadeVFS-0gkRfU9j.js\":\"a8848d61c5eb945f\",\"/knowledge-medium/pr-preview/pr-1906/chunks/IDBBatchAtomicVFS-Cei714mj.js\":\"1f80c11ea16af94a\",\"/knowledge-medium/pr-preview/pr-1906/chunks/MemoryVFS-AQVLsIwi.js\":\"c3cd044595fd868b\",\"/knowledge-medium/pr-preview/pr-1906/chunks/OPFSCoopSyncVFS-JMEfuh_a.js\":\"419ff536e51e2036\",\"/knowledge-medium/pr-preview/pr-1906/chunks/OPFSWriteAheadVFS-8buO8bFx.js\":\"80de8ab98b73b57d\",\"/knowledge-medium/pr-preview/pr-1906/chunks/Preview-VFKyhIRU.js\":\"7dc37e595905caeb\",\"/knowledge-medium/pr-preview/pr-1906/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1906/chunks/card-CetLO0Cg.js\":\"18ad1eb36e015d7d\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dist-CSASIgOo.js\":\"8f0ab59fd03d174f\",\"/knowledge-medium/pr-preview/pr-1906/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1906/chunks/mc-wa-sqlite-DbwrbJBh.js\":\"20e4d36f1f77d88b\",\"/knowledge-medium/pr-preview/pr-1906/chunks/mc-wa-sqlite-async-C7OIUbwk.js\":\"15a5437aca899096\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-B_nukJfL.js\":\"ecb82225b9b8799d\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-BbUsvT2t.js\":\"fbd0196ff0f70944\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-ByBBua-I.js\":\"dabf408d0d3c6f97\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-C40zibCQ.js\":\"30878706d33d0290\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-DCHxzXJE.js\":\"cda5feca40e66e65\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-DqIl9pFD.js\":\"004d30fdf4c782d4\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-DwqHXaGC.js\":\"6adbd607691386ed\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-dom-server-legacy.browser.production-Bokgz2cz.js\":\"18338fe8537fdfed\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-dom-server.browser.production-CRuctMYx.js\":\"2d10c633cb1d3526\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-dom-server.edge.production-Dp_NZSs6.js\":\"e0e6dc161e8c1cbe\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-mzKJluuX.js\":\"5b45afe3082548b1\",\"/knowledge-medium/pr-preview/pr-1906/chunks/server.browser-DnTj525N.js\":\"c5ec08af573d6a4e\",\"/knowledge-medium/pr-preview/pr-1906/chunks/textarea-BuSml0X7.js\":\"487cdec29120f445\",\"/knowledge-medium/pr-preview/pr-1906/chunks/ui-wJ268JY9.js\":\"7cf119fe1ce3b915\",\"/knowledge-medium/pr-preview/pr-1906/chunks/wa-sqlite-BLuoBMdD.js\":\"6af6c7011042ad2f\",\"/knowledge-medium/pr-preview/pr-1906/chunks/wa-sqlite-async-CQMV-Fb9.js\":\"48678bf19cb7a875\",\"/knowledge-medium/pr-preview/pr-1906/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1906/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1906/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1906/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1906/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1906/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1906/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1906/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1906/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1906/src/App.js\":\"babee8a7d571c8f4\",\"/knowledge-medium/pr-preview/pr-1906/src/appUpdate.js\":\"56460f0b42a6c433\",\"/knowledge-medium/pr-preview/pr-1906/src/appVersion.js\":\"485a4e0aabf3702c\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/initialLayout.js\":\"b731355b3cd37e84\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/openWorkspaceData.js\":\"fe16f3dc295ca2e6\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/resolveWorkspace.js\":\"f642e8accd1435e9\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/workspaceBootstrap.js\":\"c0ab4284881dab7c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockComponent.js\":\"a5600ae11b778c9d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockCrumbs.js\":\"000c1b1f88a7ef4e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockEditor.js\":\"d09ccce3dcaefd76\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockLoadingPlaceholder.js\":\"cc3ac6846c00450b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockProperties.js\":\"c9b5c0f3aef190cc\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockSearchPicker.js\":\"39b20519da784d22\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ConfirmBulkDeleteDialog.js\":\"aa9e0602e13ac176\",\"/knowledge-medium/pr-preview/pr-1906/src/components/DividerHandle.js\":\"c2d985c4e2f79ff4\",\"/knowledge-medium/pr-preview/pr-1906/src/components/DraftEditor.js\":\"ff375dd94f8087fd\",\"/knowledge-medium/pr-preview/pr-1906/src/components/GutterPill.js\":\"f3fff1a71a37bc4f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/Header.js\":\"a02eeedd922a2843\",\"/knowledge-medium/pr-preview/pr-1906/src/components/LazyBlockComponent.js\":\"8a7701eca13ae24b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/Login.js\":\"ec00cdc7606c9ed3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ZoomableSurface.js\":\"7caa4d2f4a132e43\",\"/knowledge-medium/pr-preview/pr-1906/src/components/editModeKeepalive.js\":\"2cf6a8201f436bc8\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyDisplay/PropertyDisplayScope.js\":\"71fe27f532a92c0d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"00eabec00c43a520\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/RefPropertyEditor.js\":\"8cd7a40218fdd509\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/RefTargetTypePicker.js\":\"df3777c5cf5154eb\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/SelectPropertyEditor.js\":\"dc5f0ff075ccaaef\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/TypesPropertyEditor.js\":\"6d0fb705a3a439ee\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/defaults.js\":\"9b7c863523d39d14\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/kernelValuePresets.js\":\"d82992e82beec2a3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/selectablePresets.js\":\"b5d68a1789eda276\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/typesPropertyUi.js\":\"488d8facc6c3e978\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/AddPropertyForm.js\":\"65fb4d46d1cb07b0\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/PropertyPicker.js\":\"98db064dbf6d87f8\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/PropertyRow.js\":\"07757339313c9ff9\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/Rows.js\":\"329cd6a2ac942981\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/actions.js\":\"253fd4058a365fb5\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/declarationOnly.js\":\"79bca2cd77587be4\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/layout.js\":\"9de3f80496755bbd\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/model.js\":\"51e24617c6ce70ff\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/shapeUi.js\":\"13b4dfbb25d6794b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/shapes.js\":\"498e2fcd194a8d4c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/usePropertyEditingActivation.js\":\"850fb6bc9cb56578\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/visibility.js\":\"46ff8f6a25055705\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanelSections.js\":\"da431c7d49ee97e3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/BlockEmbed.js\":\"2c49771371b7051c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/BlockLink.js\":\"794af8a83c5eed91\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/BlockRef.js\":\"0fa92316574794c9\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/CompactReferenceLink.js\":\"9b939d8467c45498\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/ReferenceLink.js\":\"811a8c7e55e17056\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/cycleGuard.js\":\"8bef0038fe164db0\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/cycleGuardContext.js\":\"77c1124db51294ac\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/linkInteraction.js\":\"cb05c5dcf962e9d6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/referenceLayout.js\":\"2ad10786561464e0\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/useBlockRefAncestors.js\":\"6e8d89ba3b0dac51\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockGutter.js\":\"d6b43eba2ec7a3db\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockInfoDialog.js\":\"3e43c3f4d85b5773\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockReadText.js\":\"52058f6ae2fd4d78\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockTypeBlockRenderer.js\":\"6101e568764c2f6f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BulletHoverCard.js\":\"9e2eecf0a1629d19\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/CodeMirrorContentRenderer.js\":\"8088563d13d85a04\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"7b627d0d7cf030de\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/ColumnResizeHandles.js\":\"1ab35b4522c6a720\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4f7955b54cfcef2b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/DefaultBlockRenderer.js\":\"540717877bbfaa43\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/LayoutRenderer.js\":\"da4fdd261514fd91\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/MarkdownContentRenderer.js\":\"7c7a3ffbc1328584\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/MissingDataRenderer.js\":\"913bad9f0a077704\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/PanelRenderer.js\":\"0ae731661611fb78\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f4e24f8789c86f2d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/TopLevelRenderer.js\":\"64c583ba8d2f7e89\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/blockGutterMode.js\":\"76e26a45869d4da4\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/blockTitleText.js\":\"27543c819b9d44ab\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/fieldCreationKeydown.js\":\"1dcc6b6ce2b1d011\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/layoutRootContext.js\":\"9b1355a1147d8581\",\"/knowledge-medium/pr-preview/pr-1906/src/components/typeChip/TypeChip.js\":\"7a6b73aef03aa6bd\",\"/knowledge-medium/pr-preview/pr-1906/src/components/typeChip/chipStyle.js\":\"81194b76f63ff72b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/anchored-floating.js\":\"99e86cfa1c00b41d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/button.js\":\"f7c48bd8e09f7465\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/card.js\":\"37b638cade639d67\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/checkbox.js\":\"20daabbb6bda4122\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/collapsible.js\":\"2eb02e39a6417076\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/command.js\":\"4708c2ecaf70d815\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/context-menu.js\":\"c4e3a502354436af\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/dialog.js\":\"e4879c87b8cb0897\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/dropdown-menu.js\":\"935197002f2477ff\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/floating-listbox.js\":\"82851b798cd65825\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/index.js\":\"e7f796c2d856f77f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/input.js\":\"d969800b247f8c42\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/kbd.js\":\"9d4be70883554b10\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/label.js\":\"c2342bcb61b10e34\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/textarea.js\":\"aaa368dceb07e1fb\",\"/knowledge-medium/pr-preview/pr-1906/src/components/useEditModeYieldKeepalive.js\":\"0eb7cd34d16529df\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/BootFallback.js\":\"b7d66dba66832a75\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/FocusedRowLazyMount.js\":\"39416a8f63a3bc02\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/LazyViewportMount.js\":\"9a00df13755fc2fe\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/LocalDbCorruptionFallback.js\":\"60bf9ac39ee12c14\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/error.js\":\"86e88f8ec9c9b7eb\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/lazyMountRegistry.js\":\"ce09268cd6aa0cad\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/suspense.js\":\"525c1b3e3a0c7372\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/CreateWorkspaceDialog.js\":\"8305549af34b449d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/PendingInvitations.js\":\"7047d4bdcfcfbb6c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/SyncProgress.js\":\"bb039e830e787348\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/UnlockProgress.js\":\"c27f6c791bb2f58f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceKeyGate.js\":\"7ca3183ffe9c8bbc\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceSettingsDialog.js\":\"3417a905f4f7c629\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceSwitcher.js\":\"2f772e9529cbaadb\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceSyncGate.js\":\"174dc72c5135ca73\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/ConversionFlow.js\":\"aab9781d04fdd0be\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/ConversionFlowHost.js\":\"6fb6afc69cedb395\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/EncryptionSection.js\":\"a75a710cbbc44b0b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/attachmentPrompts.js\":\"fe1e3bad70ba6eb7\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/bundleFolderPrompts.js\":\"053360a6758f582c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/conversionFlowDeps.js\":\"17b56668c844519d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/conversionFlowStore.js\":\"e9c31df74929bde7\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/flowUi.js\":\"382cb002844f5530\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/useConversionRun.js\":\"c38cdf3422ac6644\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/keyUi.js\":\"474d6a5f5c2e234d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/useCloseOnKeyLoss.js\":\"26c7f74c67d82387\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/useCloseOnServerE2ee.js\":\"cc7391c1505cbe6c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/workspaceUnlocked.js\":\"a27b474e77c71549\",\"/knowledge-medium/pr-preview/pr-1906/src/context/backgroundSubtree.js\":\"0bb4ec7fa71cad2c\",\"/knowledge-medium/pr-preview/pr-1906/src/context/block.js\":\"9a36b58cdfd1d1c4\",\"/knowledge-medium/pr-preview/pr-1906/src/context/layoutWsContext.js\":\"54d722710fcd2e28\",\"/knowledge-medium/pr-preview/pr-1906/src/context/propertyDisplay.js\":\"f568ed2d193eb0e8\",\"/knowledge-medium/pr-preview/pr-1906/src/context/repo.js\":\"bd0c23aa43173a6e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/aliasClaim.js\":\"3c771249ef781e2c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/aliasSeatNamespace.js\":\"39dab0b87ddd5732\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/blockData.js\":\"a16b6e486a13e7d2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/blockType.js\":\"93591b90475b514c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/changeScope.js\":\"eca30291fd02adf5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/codecs.js\":\"00e2b25cfc4dcdfb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/derivedData.js\":\"ca131e822230ad0c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/errors.js\":\"9206c03676a1afe1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/events.js\":\"8866a4f0e95dbc3c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/handle.js\":\"451fa26e979135cc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/index.js\":\"0537055259d35af9\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/mutator.js\":\"5f7068f1ca8920e3\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/processor.js\":\"a2df1589bbf5c263\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/propertySchema.js\":\"0e83b4ebce0f74a7\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/query.js\":\"596d90aa760ea7cb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/sameTxProcessor.js\":\"f8921a0501e907dc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/schema.js\":\"451fa26e979135cc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/tx.js\":\"451fa26e979135cc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/typedBlockQuery.js\":\"544185a5bb14706a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/user.js\":\"ffbfbc3cd4c05b2e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/valuePresetCore.js\":\"fbca547981be7b8a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/valuePresets.js\":\"8d418e3ed170c1b7\",\"/knowledge-medium/pr-preview/pr-1906/src/data/attachmentCleanerIOVerb.js\":\"2519158e7ec242d6\",\"/knowledge-medium/pr-preview/pr-1906/src/data/block.js\":\"c43651f65bb81a29\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockCache.js\":\"365eb87614a596a8\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockId.js\":\"9c81d2575fd8bf72\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockLiveness.js\":\"8ef7d499d82312ff\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockMerge.js\":\"5693ee6f210071ba\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockSchema.js\":\"8529d0dcd0930e8d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockTypeLookup.js\":\"14139e57dbb7fee0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockTypes.js\":\"a7d300f3cf5e6541\",\"/knowledge-medium/pr-preview/pr-1906/src/data/childrenView.js\":\"5adfc54d22497597\",\"/knowledge-medium/pr-preview/pr-1906/src/data/clientContext.js\":\"e3d68429f18cd5a0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/dbFileSiblings.js\":\"9727d42f42d78fb2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/definitionSeeds.js\":\"baf0da7963c321de\",\"/knowledge-medium/pr-preview/pr-1906/src/data/derivedIds.js\":\"2552ae0437f73774\",\"/knowledge-medium/pr-preview/pr-1906/src/data/drawnSubtree.js\":\"b06e5725682fdf6c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/facetBridge.js\":\"02c0a801d17023b2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/facets.js\":\"c9333a803933393c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/globalState.js\":\"170b3cc6b42fd471\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/aliasClaimRederiveProcessor.js\":\"7e161d13e41c88de\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/ancestorBatch.js\":\"405111fcde85eda1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/blockTypeTypeifyProcessor.js\":\"508b68c1d4b148b8\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/clientSchema.js\":\"5dfecdb79f5ce870\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/commitPipeline.js\":\"db0a76b5be0c3f33\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/devAssertions.js\":\"415a4b3c836338e4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/firstSync.js\":\"43d547ecc25b1018\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/freshInitialLoad.js\":\"efea201b3f9a03f8\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/graphBackfillClaim.js\":\"4fcc15c06f109d37\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/handleStore.js\":\"dd6a44f6b3bc876a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/idleMarkerJobs.js\":\"ed778d5d2791c1ee\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/initialDownload.js\":\"b887eb2e79993dae\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/initializeClientDatabase.js\":\"cbb5319e62d37504\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/jsonCanonical.js\":\"40f54fd68eb4d959\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/kernelInvalidation.js\":\"b97e8bcb82b3fc7b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/kernelProcessors.js\":\"2ae0df6b0364bd18\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/kernelQueries.js\":\"be617188f2a1627c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/mergeTypeMembershipProcessor.js\":\"443713a4425e2c06\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/normalizeReferencesProcessor.js\":\"04b524a1e2641b64\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/poolInstrumentation.js\":\"7e387f2babea1324\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/processorRunner.js\":\"3e94f8f2b5fad4cd\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyCellBackfill.js\":\"d0cd977498f6b33a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyChildMint.js\":\"466fbe2b01a28571\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyChildrenProcessor.js\":\"d12408f97673f548\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b28fe152e0ccfca3\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyDefinitionSynthesis.js\":\"dfe70765651a32f6\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyKeyScan.js\":\"c620d1df58f743ae\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertySchemaResolution.js\":\"8032f917a8d08961\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyValueEdits.js\":\"42291e230614c125\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/raiseProtocol.js\":\"b11ab579671fa4e0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/readBatch.js\":\"4d19061c8d38a76b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/refProjection.js\":\"4afbf7e9a5a35f09\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/referenceTargetLookups.js\":\"5b8e00b60160d558\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/referenceTargetProcessor.js\":\"bc62026000f96685\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/replayMerge.js\":\"61bfdf434ba93cb0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/sqlBinds.js\":\"14e737160d59e034\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"2df335ed27f100cb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/arrivalProcessors.js\":\"c2505b8dacafedc0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/invalidate.js\":\"560fb517593175ea\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/materialize.js\":\"e869b7c94ba31eab\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/observer.js\":\"41d74c131ad65364\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/reconcile.js\":\"1bc6fe971337b130\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/timingMetrics.js\":\"d130f732ddebd33f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/treeQueries.js\":\"4b33b9cbb9eee31b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/txEngine.js\":\"d197d9285ec51dd9\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/txSnapshots.js\":\"c4537180a172e363\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/typedBlockQuery.js\":\"a63e5370f8a96669\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/undoManager.js\":\"e1132b4dcaafead7\",\"/knowledge-medium/pr-preview/pr-1906/src/data/invalidation.js\":\"610957aaeac89a5a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/kernelDataExtension.js\":\"d57e4eab3b33b620\",\"/knowledge-medium/pr-preview/pr-1906/src/data/kernelPage.js\":\"15731014116a7b78\",\"/knowledge-medium/pr-preview/pr-1906/src/data/kernelValuePresetCores.js\":\"10bf6e4d8bb414cc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localDbCorruptionSignal.js\":\"fb84f55215426b00\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localDbStorage.js\":\"52f88a99d5a9eee2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localDbVfs.js\":\"1a1ae48784beb1e8\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localSchema.js\":\"c69a3e52c3611f2a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/maintenance.js\":\"5d4e262b43dbfed2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/mergeProperties.js\":\"207eea47e28964a2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/metricsConsoleHook.js\":\"7427667ba97a81a9\",\"/knowledge-medium/pr-preview/pr-1906/src/data/migrationsPage.js\":\"b25b81f082d0bd90\",\"/knowledge-medium/pr-preview/pr-1906/src/data/mutators.js\":\"c58d073cbed633fb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/orderKey.js\":\"d9f53ea9442c5e4c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/orderKeyPlacement.js\":\"d1debf6d67f7bf24\",\"/knowledge-medium/pr-preview/pr-1906/src/data/outlineSurface.js\":\"9ed3030b8f88cf53\",\"/knowledge-medium/pr-preview/pr-1906/src/data/pendingEditorContent.js\":\"5a838cf1a1e5efa9\",\"/knowledge-medium/pr-preview/pr-1906/src/data/pendingUploadsSql.js\":\"3a865ac025c3da98\",\"/knowledge-medium/pr-preview/pr-1906/src/data/pluginStateExtensions.js\":\"7996dba9a175e5d0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/powerSyncLogger.js\":\"16ce9fe59a1b68c4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/projectorRuntime.js\":\"dd50d2cd60a9ba99\",\"/knowledge-medium/pr-preview/pr-1906/src/data/properties.js\":\"e129fa68a0cba7d1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertiesPage.js\":\"1cb926344af2dab0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyChildren.js\":\"06d3754397570871\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDefinitionFanout.js\":\"bdecaa220b555b32\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDefinitionMetadata.js\":\"709c6d6f648a8a31\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDefinitionRegistry.js\":\"32dcd16a57e5e8ec\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDisplayMode.js\":\"0e8ca4ebccc13732\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyRowCreation.js\":\"123091b73018c0d0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertySchemaCreation.js\":\"fea8a0d8d3c2e28d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertySeeds.js\":\"1997ca6b32f9e0bb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/recentsPage.js\":\"0383984c6b4a52d2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/refTargetComparableProperty.js\":\"0fa9e6331b0cdd88\",\"/knowledge-medium/pr-preview/pr-1906/src/data/referenceBlock.js\":\"903184bc7bbb9a38\",\"/knowledge-medium/pr-preview/pr-1906/src/data/rejectedUploads.js\":\"9c4dee04f173ee6d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/releasePowerSyncConnection.js\":\"a6796d4ce762766c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/repo.js\":\"a5dda56c47717344\",\"/knowledge-medium/pr-preview/pr-1906/src/data/repoProvider.js\":\"0a97522ee250fc31\",\"/knowledge-medium/pr-preview/pr-1906/src/data/rowProperty.js\":\"aa7a4ef2aa701cae\",\"/knowledge-medium/pr-preview/pr-1906/src/data/searchFilter.js\":\"d2b3c95238e9e898\",\"/knowledge-medium/pr-preview/pr-1906/src/data/seedIdentityLedger.js\":\"65370c19fd78b027\",\"/knowledge-medium/pr-preview/pr-1906/src/data/stateBlocks.js\":\"2620e24808d658f5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/structuralEditPolicy.js\":\"c76aa7f4d9676ed3\",\"/knowledge-medium/pr-preview/pr-1906/src/data/structuralInsert.js\":\"21eb33405973dd10\",\"/knowledge-medium/pr-preview/pr-1906/src/data/subtreeDelete.js\":\"b2f880b1ad41089b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/syncStreamLock.js\":\"f7fa63e0cb9dead1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/syncedTableSqlRecognizer.js\":\"f835dd1b70c279e7\",\"/knowledge-medium/pr-preview/pr-1906/src/data/syncedTableWriteGuard.js\":\"cd71266a96ff8c98\",\"/knowledge-medium/pr-preview/pr-1906/src/data/targets.js\":\"13efce5cfba618ad\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeColors.js\":\"5bb0b187d2751a77\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeDefinitionMetadata.js\":\"062fab60da03abe4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeDefinitionRegistry.js\":\"3b85025738751cd5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeExtraction.js\":\"8226059fda10fd3d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeInitialValues.js\":\"54cf8f428b9b76d1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typePropertyGroups.js\":\"54d729c7c5df0c98\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeSeeds.js\":\"4d07645dca3a242f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeTagger.js\":\"796565d6db0a1214\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typedRecords.js\":\"73ee753f54ab1194\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typesPage.js\":\"1226f08178434385\",\"/knowledge-medium/pr-preview/pr-1906/src/data/userPrefs.js\":\"391732619d6fa4c4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/userSchemasService.js\":\"1b34426bf7421f72\",\"/knowledge-medium/pr-preview/pr-1906/src/data/userTypesService.js\":\"30c1f5f999103eb4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/valuePresetRegistry.js\":\"46235e6c6c0924fc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/visibleChildren.js\":\"63429019def756db\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceConversion.js\":\"4f1ae98bd929b357\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceFirstSync.js\":\"e038c02e46887b8c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceIdNamespace.js\":\"c67ac0a8307156d9\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceSchema.js\":\"49ce3ed28c081a78\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaces.js\":\"ce110629c1adbe25\",\"/knowledge-medium/pr-preview/pr-1906/src/data/writeAheadLog.js\":\"fda3861fe9f4e9e8\",\"/knowledge-medium/pr-preview/pr-1906/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/BlockPasteShellDecorator.js\":\"64d8681dfc704cb3\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/atTrigger.js\":\"a36fe09a2808968d\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/autocomplete.js\":\"b258161332223a05\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/codeMirrorExtensions.js\":\"aa57fec308f3adb7\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/contentFlush.js\":\"81456d01e30e4ac7\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/defaultInteractions.js\":\"0c68a0843d32d747\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/editSettleSignal.js\":\"6b346c760345b3d7\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/insertImage.js\":\"2dfa3a2194875d0b\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/referenceCompletionRange.js\":\"1acfcd8b0d044007\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/referenceTargetTypes.js\":\"b3884aca4a76bfe3\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/syntaxContext.js\":\"2035be9836b16628\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/triggerMatch.js\":\"f8d13447b1b88bbc\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/AppRuntimeProvider.js\":\"ea00d576582737b3\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/BlockFocusShellDecorator.js\":\"cb5a553f5449d634\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/ExtensionRenderBoundary.js\":\"a229df68bc8571a4\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/PanelContentRecovery.js\":\"eaa408cb292f5e2a\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/apiCatalog.js\":\"7f9017742d874759\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/approveExtensionHere.js\":\"7b646f872a925f3c\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/armedCutAppMount.js\":\"cb7d9c754f15558d\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/batchableKeyedStore.js\":\"c779e62fb4ccb14d\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/blockInteraction.js\":\"de29b12fe43b28e5\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/blockSelectionAction.js\":\"2c6481dd8fe787c7\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/compileExtensionModule.js\":\"0896d77a4427bd97\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/compiledModuleCache.js\":\"7c2b3921f992d67f\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/continuousGestures.js\":\"788def31fef131bb\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/core.js\":\"d63da6876f418746\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/defaultRenderers.js\":\"46e76ed88518e642\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/definitionFanoutAppMount.js\":\"0a07c9b2baa7eefc\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/dialogAppMount.js\":\"1d84b9f007656d41\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/dynamicExtensionSeeds.js\":\"6d4baf9003a792b4\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/dynamicExtensions.js\":\"524445b3b37c04dd\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/exampleExtensions.js\":\"592b2eef8006fb71\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionApprovalStatus.js\":\"c364128368ea2abd\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionLoadErrorToast.js\":\"97f033a63544f36a\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionLoadErrors.js\":\"713b3b29668a75c3\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionLookup.js\":\"091e7bae3ba511b4\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionToggles.js\":\"bb19ab1a534b0d06\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionUtilitiesCss.js\":\"da8652487b77ad90\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/kernelPageDeletionGuard.js\":\"a90b99ce3309ada1\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/liveRuntime.js\":\"47eaaa8cbc513cea\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/openExtensionsSettings.js\":\"11b5c2388ffca371\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/overridesCache.js\":\"1039d13e534feab1\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/pluginIds.js\":\"18edf0d77112023c\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/processorRejectionToast.js\":\"89b8b88a85e5de3c\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/runtimeActions.js\":\"d40a6d2750d13af5\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/runtimeContext.js\":\"f7a59f66c102217e\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/staticAppExtensions.js\":\"5f4364766716d26f\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/staticDataExtensions.js\":\"2ef23ba8782c48c2\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/toastAppMount.js\":\"d31af1c28ecc9a19\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/useOverrides.js\":\"1aadc178f923cb5b\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/useShortcutSurfaceActivations.js\":\"a68a367960c9f26f\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/discoverToggleTree.js\":\"233c8ce08319da59\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/facet.js\":\"a45ad6411b00c7df\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/resolveAppRuntime.js\":\"2d6d0f66047fe6fc\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/runtimeEvents.js\":\"9052925ad9f68bba\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/togglable.js\":\"40fbf0fe4d69430b\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/variantFacet.js\":\"beff51f0f8bf90c1\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/verbFacet.js\":\"40b1e653e721194f\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/block.js\":\"5c529b8d099f396d\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/focusedChild.js\":\"3127a97aa78341e1\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/propertySchemas.js\":\"a575df9906a4fd87\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/typeRegistry.js\":\"464f314e8095e050\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useAncestorCrumbs.js\":\"ed4a26a17bfc4beb\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useAutocompleteListbox.js\":\"002e937c96eeaeff\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useDebouncedSearch.js\":\"c9d2b7bddab0b323\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useDebouncedValue.js\":\"944d149aa93675ad\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useFacetValue.js\":\"5245e5adce67f957\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useIsFocalRender.js\":\"606a2272e52763c4\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useIsReadOnly.js\":\"ff984e6afa59f696\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useMaterializeBacklog.js\":\"bde42c8b58816bc4\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useMinuteClock.js\":\"b3a97dda22e17fd3\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/usePanelLayoutProjection.js\":\"8cfdc48547618bbb\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/usePendingInvitations.js\":\"f7087a5269b427c9\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useRendererRegistry.js\":\"045f97fd7a6e1ccb\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useRetainedFieldRows.js\":\"f07a2fbae7c2ea6e\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useWorkspaces.js\":\"10d946d7fb767429\",\"/knowledge-medium/pr-preview/pr-1906/src/lib/utils.js\":\"33da80b4d52ebc0a\",\"/knowledge-medium/pr-preview/pr-1906/src/main.js\":\"a4f254407bc7440e\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/MarkdownImage.js\":\"cf8de8eb8d8ea7c9\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/blockSeparators.js\":\"5ad6f244f23a3235\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/context.js\":\"b31524c0f976de91\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/defaultMarkdownExtension.js\":\"590a26d5cccb138c\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/extensions.js\":\"30513fbc41dcb42d\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/renderMarkdownHtml.js\":\"2c5d0df08a54ba47\",\"/knowledge-medium/pr-preview/pr-1906/src/minimal-editor.js\":\"5325ed18d36bae60\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/armedCut.js\":\"e17b74c414f7bfe8\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/captureMediaVerb.js\":\"c300cabd8e3dd4af\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/clipboard.js\":\"9a2f7ace20e050dc\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/decision.js\":\"bfc7f3b1e24fe4ac\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/operations.js\":\"e652447a56c21f75\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/account-header/AccountHeaderItem.js\":\"cb5c661f498f5f90\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/account-header/index.js\":\"4a69d5ef244d6d25\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"05c4c123481eefff\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/askAgent.js\":\"c65706a10a210871\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/askedStore.js\":\"0763ab8b30c0aa16\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3890a02c4682da30\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/chipState.js\":\"ddf355c8863e153b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e4dc0cdc76221fa3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/index.js\":\"6bc71f053f0ebd64\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ef4ef8db19e9c8ee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/schema.js\":\"cde8b58e88364499\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/AgentTokensDialog.js\":\"f65bb090874c8a01\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bcdebd84ed50b8b9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/addMedia.js\":\"3b84ec4c1120c9cc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/backlinks.js\":\"af3ac424d731e27f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/block.js\":\"70e787c22b7a6278\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/context.js\":\"bf189571cdb09e5a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d18affaaea3b1fa9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/index.js\":\"57cfcafafb970531\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/outline.js\":\"e6b087d46d506753\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/properties.js\":\"015a5324067ce3c1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/refs.js\":\"c351b96a8136864d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0b7b0e170d5249c3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/search.js\":\"6aff27d9fcf9963e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/shared.js\":\"804f4328ed048f4b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2e14b2f63226e98b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/text.js\":\"56b040a897667d3a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentWrites.js\":\"199b95e74b7ff744\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/authoringCatalog.js\":\"07bf1916046f5465\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/blockRefTargets.js\":\"b70a58c6a4d2d1e9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/bridge.js\":\"80b98d940980397c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/bridgeLoop.js\":\"4197d2a5d2bf9e1b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/changeHistory.js\":\"3ec082ba4b7d23ce\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/commands.js\":\"a41c1c6954f7cf1d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/commentsCommands.js\":\"6512b3eecd2a5983\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/dataExtension.js\":\"714ac083e212611f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/dataModelGuide.js\":\"4811fad5d7893440\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/dayPropertyInputs.js\":\"48e738688d005315\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/describeRuntime.js\":\"f53d9288eec14170\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/extensionLint.js\":\"13844995d5c88a88\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/grainAudit.js\":\"a4b309ac04201248\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/healthCommand.js\":\"55fad631f9d03704\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/index.js\":\"649d13d0cc352639\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/presetIdentity.js\":\"111ab954bfee2d02\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"9e04d1d635d3c655\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/readMedia.js\":\"09e9b1a768d90dd6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/schema.js\":\"9d46985a2f69fc13\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/serialization.js\":\"bc1de7eb61e51e5c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/targets.js\":\"15de3efd814b8ef1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/tokens.js\":\"1a5a2cf76eb02e17\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/watchEvents.js\":\"e6b5bdce20d61ddf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/workspaceGuard.js\":\"004f44588f7be42b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/writeCommands.js\":\"c33e9830186743e5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/AliasCollisionToast.js\":\"5cce54edf87cd9be\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/DuplicateNameBanner.js\":\"89a936f51d248bad\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/collisionMerge.js\":\"381817b7d7b83c24\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/dataExtension.js\":\"2e8d784bac7b14cc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/index.js\":\"4140e3da3b5acdc7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/mergeCollisionAction.js\":\"712eea5bc589e6af\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/pageStyling.js\":\"02381e2c31e42c4e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/rejectionToast.js\":\"5181dd3d650424c9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/syncProcessor.js\":\"83ec1547c671f295\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/actions.js\":\"be22310fd4527264\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/addComment.js\":\"68e77c6fbf9857ba\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/anchor.js\":\"8790eefb83350ad1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/anchorState.js\":\"858df2ce13ec81c0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/commentLinks.js\":\"020da04bf23bd081\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/confirmThreadDeletion.js\":\"c41a475051276c39\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/container.js\":\"89b368f3a024d59c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/dataExtension.js\":\"bffbded0eebaaf49\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/deleteComment.js\":\"bfef0de62ba5ae17\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/highlights.js\":\"4dac9f08ff166d4c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/index.js\":\"ae1d513c9125de6d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/linkedCommentsPill.js\":\"1a2375d1157325c9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/margin.js\":\"9325376fcb151c3e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/marginAnchorLinks.js\":\"2e82a4b8705cb12e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/marginSchema.js\":\"ec19921dec68d597\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/newComment.js\":\"878d64c0cc00ba1c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/ownThreadPicker.js\":\"2c1db4b7a959f757\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/placement.js\":\"50b0db49c3922ebe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/queries.js\":\"f1d88132962e8a86\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/quotePosition.js\":\"d008b1be6e9abbf8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/quotedIn.js\":\"a294ab5f3d81a63a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/quotedRange.js\":\"e3339024f6357768\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/rangeRefs.js\":\"d4aa443169668266\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/readHighlights.js\":\"74ec49962144bb71\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/readSelection.js\":\"a75ea6fb4e445136\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/readSelectionUi.js\":\"a2310caf2d5b5f4e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/reanchor.js\":\"95f985639fa99647\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/schema.js\":\"5ef04bca97da85d9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/scope.js\":\"caa45229296134f3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/scopeThreads.js\":\"f01f1e3bdefc9d54\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/splitRetarget.js\":\"41fa2fddaf3bdb00\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/suggestionCard.js\":\"3bdb6f421eaf4a2c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/suggestions.js\":\"e8a2784e8b21a71f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/summaries.js\":\"40d43ab6a8a1a40b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/summaryBatch.js\":\"60368e79a8ba9622\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/surface.js\":\"c40d555b3ef91913\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/threadNavigation.js\":\"177e39a5f876e885\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/threads.js\":\"b816a41415965d72\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/ui.js\":\"f15fdf797233d818\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/uiStore.js\":\"c544aedf1d9efa45\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-intents/appIntents.js\":\"d4ad4bba45017ac0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-intents/index.js\":\"8cee448fa6e1b4c4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-update-prompt/index.js\":\"1d5a6ad32c98b427\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-update-prompt/status.js\":\"df5e82d6abdf9855\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"abe6d8d5f8001e0d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/MediaBlockRenderer.js\":\"9f2316321dfab931\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6e2a8f84f6930ad7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/MediaUploadReconciler.js\":\"b92fa9b4747b982f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/assetDownLane.js\":\"5503a8322d10ec98\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/assetResolver.js\":\"9e4c37c06e0413f7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/assetUpload.js\":\"079ccee706d061b3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/attachmentCleanerIO.js\":\"7f4f89f0ef4c50a1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/supabaseAuditIO.js\":\"24ac65317ce2aba8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/blobStore.js\":\"1d9a4e868f88833e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/browserMedia.js\":\"ca417bd2a3924abb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/byteStore.js\":\"45efe231bed0d58e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/cleanerIO.js\":\"266aecc13b3212f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/cleanupAttachments.js\":\"3e38f4b13a36ee47\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/dataExtension.js\":\"1f3cfd9b1e7df353\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/downLane.js\":\"bbc01bcd8f02b964\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/index.js\":\"0e77704c9bffcb0b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/insertImageContribution.js\":\"ad2bf6de2491be65\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/laneArming.js\":\"2ea52b7e105a576a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/laneLock.js\":\"b53633cd7397ca02\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaBlock.js\":\"6f8191866f3bf8bf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaCapture.js\":\"7226bd05c0758e91\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaLanes.js\":\"b93e9d85f78dbf5f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaViewers.js\":\"7be6666e48fa81fe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaViewersFacet.js\":\"3c8356ab103444a9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/pasteCapture.js\":\"e10fb14100c929d2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/resolver.js\":\"d1d37d6516c93882\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/retryUploadsAction.js\":\"eca7218c3509afb1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/storagePaths.js\":\"26a2ee1d476f265a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadDrain.js\":\"e35b72c7b54ac90f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadLaneStatus.js\":\"aaa99860b1aafebd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadReconcile.js\":\"58349273b94e59cb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadRecovery.js\":\"e4b06b2a18ff2312\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadStore.js\":\"0f93dfe22e7dcb56\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/useAssetObjectUrl.js\":\"0359b66887d6e7a9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9e97623cb5c70000\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/BacklinksViewSection.js\":\"725fea5f8c07d36e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/facet.js\":\"dcb4d401dccd85ab\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/index.js\":\"319df6caa3553e2b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/prop.js\":\"8921b38a5b10fad0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/BacklinkFilters.js\":\"71f2a32c3581ef1c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1d71ccd027fe4198\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/BlockEntry.js\":\"d265665ed7b589c3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/LinkedReferences.js\":\"a4d9868196f37c17\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c991b3200bd383c7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/dailyNoteDefaults.js\":\"59cd883c8eb4c49d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/dataExtension.js\":\"f7b709db55a1e3eb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/edgeExclusions.js\":\"59c62f5def05fe79\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/filterProperty.js\":\"d51fcb6d95c335ad\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/index.js\":\"0c4eb0f922a5eeae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"afc6b2c6ce9fa7cb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/applies.js\":\"1fbd9a30ea46d80b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/countQuery.js\":\"5cf89900e6e57a3b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/expansionStore.js\":\"14e5e431c62b64f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/index.js\":\"8a166e4b713e1b58\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e9d14c50d0b26dd0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/presentationInvalidation.js\":\"4ede6d4dc8ac601f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/propertyEditorOverride.js\":\"2d53eb0659e89fa5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/propertyFilter.js\":\"458c9a784fdfe266\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/query.js\":\"b7a69a2b3f16a8ae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/resolveFilter.js\":\"355be87cd2a7fc71\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/sourceBatch.js\":\"51b926b0e44bbdb5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/sources.js\":\"cb9956a866702bbb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/useBacklinks.js\":\"d6a9fcfe3264dee8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b1bce0513013ca5d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/BirthdayCelebration.js\":\"c4fedc8961b33b17\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/BirthdayOverlay.js\":\"eb49ebb46949e6b3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/gate.js\":\"52d3892c098a391e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/index.js\":\"60f24a78ae0b373e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/wolfTheme.js\":\"9e7e397f222366dd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/BlockDragLayer.js\":\"1de200b9a6990b54\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/dragController.js\":\"387f27f50b19cdfa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/dropTarget.js\":\"3e2c373a46b0c1df\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/index.js\":\"f50049b6e924d698\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/projection.js\":\"04366c25131ee54d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-info/BlockMetaCard.js\":\"d80e59c4c91e678f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-info/index.js\":\"612734240cd8b413\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/AddTagDialog.js\":\"3ce2649516fd46d3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"44b3fd2665e0bdf3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/TagNameIssueHint.js\":\"d21bf9f3ebca601c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/addTagAction.js\":\"59d07d8f871ce190\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/appendTag.js\":\"3d9fd7b043f09133\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/config.js\":\"8e013d648e741fa2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/dataExtension.js\":\"b9923509105281d2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/index.js\":\"9274355d7e10b2fa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/propertyEditorOverride.js\":\"e7d88bbb0418955d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b3415155263d09f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3e6ee620869adc99\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c96a02ed57319201\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a2583dfe6d35b1d0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b6e5f622407f2270\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/index.js\":\"b24b2f693752b8b6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e88642b04316b087\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/CharacterCountItem.js\":\"ab7ce45c9a2cf77e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5c7199f9f6dd370a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/actions.js\":\"93059759ba8472a6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/blockType.js\":\"9eeba7847a6103b1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/charCount.js\":\"36db40cab5bbbd09\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/dataExtension.js\":\"8072df23dad5a343\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/index.js\":\"e63032cdaaa3c262\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/profiles.js\":\"ef4aac996533107f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/properties.js\":\"67fcbc2a6369f9cc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/subtree.js\":\"585e601ad8a04cb3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/textCounts.js\":\"b04c23c57f0d1da6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/colemak-keybindings/index.js\":\"8f1b3c48638d0f15\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/CommandPalette.js\":\"bb7a97d098fd7b79\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/HeaderItem.js\":\"2e444e4156471f58\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/context.js\":\"b226a92d36f84f22\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/index.js\":\"3939b09bf278899f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/selection.js\":\"db81b9b5aeff081b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/toggleStore.js\":\"52174f8f19dcbb2d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/useCommandPaletteActions.js\":\"5986a8e92dacce4d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/ContributorBadges.js\":\"2eed31001615442c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/ProfilePicture.js\":\"44ef19c28c3dec62\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/author.js\":\"a7159df891e1de3e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/codeMirrorExtensions.js\":\"2a408a49fe447dda\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/dataExtension.js\":\"75ae36b189a2a963\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/index.js\":\"26456f0c58ecf1bb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/mentionAutocomplete.js\":\"551bd122feb492c1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/processor.js\":\"252422da7d3880aa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/profiles.js\":\"410a23a47f17ae22\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/queries.js\":\"e0f619fccb26c2ff\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/schema.js\":\"8c26b04110741041\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/useCommentAuthor.js\":\"0671fc3f9f7dc69d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"0ca42389628bca98\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/followOrigin.js\":\"c5790ce6ce7ed50f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/index.js\":\"d4f86a13ce4ab7fb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"9bec04fb3984ea45\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"27caab126a792690\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/CalendarGrid.js\":\"c042805fd3698579\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DailyNotePicker.js\":\"c73657ffa1db9442\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"47e463c084015067\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DateNavDecorator.js\":\"a44e1880be9f9804\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DateScrubOverlay.js\":\"23af130424ea3c07\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DayPropertyControl.js\":\"c19a85a80aa7b093\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DayValueReferenceControl.js\":\"8898963965d424bd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/HeaderItem.js\":\"8a4c7834fb8317ba\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/ReschedulePicker.js\":\"ea65e6fa4062d1bd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b5ab55ef04eac256\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/actions.js\":\"9260becf71acfa53\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/blockDateAdapter.js\":\"4a98df48168e5b2a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/calendar.js\":\"cd4d27e2e9bd8e5a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dailyNotes.js\":\"8ff162a7f61e39c7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dataExtension.js\":\"53d353d0c7c066e4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubActions.js\":\"c70159b503900a0f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubGesture.js\":\"dbd2554252a6b15e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubGestureActions.js\":\"01202b10f12acc30\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubRecognizer.js\":\"51f0133e92a68cbf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dayProperty.js\":\"1bd302c913795878\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"be72f699f2460f83\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/deletionGuard.js\":\"8fba696bdb68a476\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dueQuery.js\":\"b3490037331127da\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/index.js\":\"31209afcc6eae9cc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/landing.js\":\"ad62af01faa61e9d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/localSchema.js\":\"233cca2dacf935eb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/referenceDateAdapter.js\":\"9112f75c08c3010e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/rescheduleAction.js\":\"dae1af09530bfd97\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/schema.js\":\"0cff750fa2f0c38e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/spreadBlockDates.js\":\"c1f5b2354dca103f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/spreadDatesAction.js\":\"4dd5d8c94569dca6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/today.js\":\"2669a9fb913a76a0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f847db5d7f2a8a1f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"6cc81eb95b984d46\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/audit.js\":\"5b9c9fd3e4e7bc39\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/auditAction.js\":\"e1a559d60f64d96d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/auditRanges.js\":\"c7880f4301d7ed27\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/diagnosticsSource.js\":\"4e3ee6c6c626c7e2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/divergenceScan.js\":\"88c5a435866be554\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/index.js\":\"9d067ddf726d8a9c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/propertyChildrenChecks.js\":\"af6990b21c161fa7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/referencesMirror.js\":\"ecf9b8b9f08e90f0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/rowJson.js\":\"3f1118b105083f7e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/schedule.js\":\"f3d05a159f6709fa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/store.js\":\"a7b52640eb205187\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-maintenance/action.js\":\"85826092ad872056\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-maintenance/index.js\":\"8e88695e6053dce9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-maintenance/plugin.js\":\"fe3136c64105a837\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"842cb33ed5e1f1e1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/actions.js\":\"5e05998a51520fd8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/changeMarker.js\":\"777f1f1f36bc3c06\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/diagnostics.js\":\"ab821761da759912\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/fileSystemAccess.js\":\"4f6666ff76f5c1f1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/filenames.js\":\"39a7e5b8a1002837\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/index.js\":\"da0f187fcd35cdb7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/mirror.js\":\"7433c0ba45fa7c5c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/runLock.js\":\"e88b7cea3ca451e7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/runtimeHealth.js\":\"f19b74dd53b90057\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/schedule.js\":\"1d7e2338c1892b4b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/store.js\":\"b16dd46c8cc2d4f8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/default-themes/index.js\":\"789e4356e09abd1a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/default-themes/themes.js\":\"5dd2182387be6519\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/diagnostics/facet.js\":\"ace25637d693bc5c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/diagnostics/useDiagnostics.js\":\"ff6d37fadb17c0e4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/dismissals.js\":\"3d526f86760b84f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/index.js\":\"c1a50ff2eb6a0ff3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/status.js\":\"a591202327392443\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/store.js\":\"e6bf7b56d82e8d6c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"66a2da44b0cc98f1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f5b96cdcdb9cfc4b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/actions.js\":\"36fc14771a478e4d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/config.js\":\"7a868f0dc7854f58\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/dataExtension.js\":\"90e7c0f03bdab752\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/effect.js\":\"1d4afd4170b5202c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/index.js\":\"3f59e850c7d5437d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bc63ce683e824d0b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/useToggleTree.js\":\"dd5588b7a3083168\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/ExtractTypeDialog.js\":\"312086b015efc698\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4c288cb6cd152a14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/PropertyShapePicker.js\":\"934811e4ff778904\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/action.js\":\"e51e7c5303e694b8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/index.js\":\"bc88ec43f76b7d93\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/FindReplaceDialog.js\":\"d3f6c61078630e9b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/HeaderItem.js\":\"fec13b52546ce270\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/dataExtension.js\":\"0f553eb4eb4900c0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/index.js\":\"3e8ad21c24e44faf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/search.js\":\"ddd14d7a454687f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/toggleStore.js\":\"e95af79c31e2cb53\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/LocationPropertyEditor.js\":\"3f54551593dada91\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/MapView.js\":\"237c4089921dec92\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/blockTypes.js\":\"da00625419f529b8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/codeMirrorExtensions.js\":\"cd7755b4a7fa2e71\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/createOrFindPlace.js\":\"1db6f1bba874f5db\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/currentLocation.js\":\"232b04ef2c942e78\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/dataExtension.js\":\"8b6ebfc5ff4a344d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/geoContentDecorator.js\":\"74705e2c048a89d5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/googlePlacesClient.js\":\"51bced4f3105982d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/index.js\":\"946341b35fafd471\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/locationsPage.js\":\"9c0b34b66f1fe3ad\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/mapViewport.js\":\"6828c90194d2c153\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/pickCurrentLocation.js\":\"1fd5e6d214b135f4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/placeAutocomplete.js\":\"5e9d3093337b6ee4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/placeNameCollision.js\":\"7f32a75a928300aa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/properties.js\":\"9fea21845ba83c02\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/propertyEditorOverrides.js\":\"69b69491d727aec3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/query.js\":\"afdc2aea41b58494\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/usePlaceSearch.js\":\"521b6d2d44fd8680\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"122f1d27fd8809b4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ddfa5525bad61326\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"137c49367ff3ad8c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/config.js\":\"8398e74203b0d1dd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/dataExtension.js\":\"7d1c7527508da589\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/facet.js\":\"12b625b67d80c744\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/grouping.js\":\"e1115743aa58ce55\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/index.js\":\"7cc488a58272daf8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"97c347e13554144b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/query.js\":\"6fd3f323a15eba1a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/resolveConfig.js\":\"6762b4102e2f3610\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d0ba7abe69d6d257\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"85b24b00f29ea289\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/HtmlDocumentContent.js\":\"f9bd39bc5d67a088\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/HtmlFrame.js\":\"a6a0f1a4d42b16a3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/actions.js\":\"8343a72e05330ed6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/blockType.js\":\"d5bb8139d47c2fd6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/confirmRunScripts.js\":\"1b60fcf20e7f0a3c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/dataExtension.js\":\"dbd798328e609033\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/frameAnnotations.js\":\"8f9ad3bb62db0733\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/frameDocument.js\":\"ae92aa6e53c4b0a3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/frameTheme.js\":\"ec0bc3b6d86f6d7f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/index.js\":\"39ab22f77ae85799\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/scriptConsent.js\":\"f151c722d8e40d97\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/sourceMap.js\":\"2876b7b83276d11b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/useDocumentScripts.js\":\"c9affa5c29aab8ce\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/index.js\":\"d918c127753a145e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/record.js\":\"747802958583691e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/recordStore.js\":\"5258c484296ef678\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/responsiveness.js\":\"95a89eb61b9eb195\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/schedule.js\":\"d7cc224e1b0f0ca2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/sessionContext.js\":\"785a0ad81a39801e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"14f33f30799694be\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"12d89134b1d3d56b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/actions.js\":\"9aabc0f319e824da\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/config.js\":\"a7e0ec3bd8a6c471\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/dataExtension.js\":\"b52ec3444eb90180\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/effect.js\":\"984d85069cfd92be\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/index.js\":\"e3ed4e9d05c84afb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/keyCapture.js\":\"4cce726b549cdb4a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/overrideStore.js\":\"c66c92806d823fdc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5fef1f482ee14132\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/HeaderItem.js\":\"021177748fe0353f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/LeftSidebar.js\":\"47253cb20ea6da19\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/actions.js\":\"02e4599ded5b9eb0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/facet.js\":\"64a14cc97a66205e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/index.js\":\"d9cff21d3d0113ca\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/shortcuts.js\":\"97bcb13c0d0965fd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/toggleStore.js\":\"040be42e2356827b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/MergePicker.js\":\"2eceba04f009dda6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/index.js\":\"4ac3d5f7ceb7e7cb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/mergeAction.js\":\"480ab2fbfb188955\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/strategy.js\":\"d1a42aed56cb3799\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/Button.js\":\"520eaaecbb04cf11\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"11ac33caaa43a3c9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/defaultItems.js\":\"11bce3b0e5178dd8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/facet.js\":\"5f19a634bc9693ff\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/index.js\":\"cb0bfc5531095282\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"4c725a972b4fd93d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4a95960caf9080d1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5be063462ae73b95\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/facet.js\":\"522c274856e500e6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/index.js\":\"2bebe70276f1f93f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/MoveDestinationPicker.js\":\"46edca972d7a995d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/blockSubtreeMembership.js\":\"264e10435dff6624\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/contextMenuItem.js\":\"91e493c3ac28fd3f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/index.js\":\"6f116081887dd2e4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/moveAction.js\":\"3517a3fbabe424f4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/moveBlocks.js\":\"d89e6d20b7dece45\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/selectionAfterMove.js\":\"7472753480bd6003\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/TutorialBanner.js\":\"b0c35e6b42bc5e92\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/action.js\":\"3cbee0b6b693938c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/bannerDismissal.js\":\"e4894a80682b08dd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/documents/cheatSheet.js\":\"0b187881f106954e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/index.js\":\"011073724fde4a57\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/keys.js\":\"f5215521979bf99c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/landing.js\":\"2f97176d5372dd07\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/outline.js\":\"484228b1a0dc6f98\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/seed.js\":\"9bd601f31cc445ab\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/PerfTrendDialog.js\":\"fd00d059514a57f0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/analyze.js\":\"8a7642b68b92795b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/diagnosticsSource.js\":\"d9bd051d22003d74\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/index.js\":\"173df0b566732143\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/load.js\":\"635e24bd8dfb5e8a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/monitorRun.js\":\"aada6fd8f8f4d169\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/schedule.js\":\"cbfd4540c620565b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/series.js\":\"1dd2746ff984f8ec\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/store.js\":\"3a2e271b41c00a85\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/trendAction.js\":\"5b0ea52e2d0823fe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/verdict.js\":\"338b261946a01872\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/plain-outliner/clickToEditAction.js\":\"3815c885b8079e26\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/plain-outliner/index.js\":\"499a0d144e40aff2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/plain-outliner/interactions.js\":\"a8c2f593ae113dea\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"af99e5e181a26561\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/MigrationGate.js\":\"f87a0569bf7847e6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/MigrationGateDialog.js\":\"aa735fc484b26218\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/action.js\":\"c26f256de1808cf4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/index.js\":\"3ff1d5baad9c3531\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/localRunMessage.js\":\"ce9f0deb7e513d6e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/plugin.js\":\"3552d0129f4ff3b6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/progressReport.js\":\"863887083ea98197\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/sweepProgress.js\":\"b80ea967605df211\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/FieldRowRenderer.js\":\"99338d63d88a4a91\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/ValueRowRenderer.js\":\"c420361a3e37f5eb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/actions.js\":\"be150d7061e7386f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/autocomplete.js\":\"0ec4e602beeff3b4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/fieldRow.js\":\"848defc3bfb70c45\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/index.js\":\"9f53855c4620544b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/referenceWarning.js\":\"3b421c5e8d353b8a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/valueAutocomplete.js\":\"775449ca7fdce91f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/valueSchema.js\":\"0c50fa012fc76d4f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/HeaderItem.js\":\"ecd131970b6783a8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/QuickFind.js\":\"f95628eb399624fe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/index.js\":\"01a98770410a5f01\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/recents.js\":\"cd891dc7f88ac86b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/resultItems.js\":\"57e0ee615527a441\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/selection.js\":\"696998efb87ace8d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/toggleStore.js\":\"44f1b380f3ee6b18\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/HeaderItem.js\":\"2037b91910526568\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/RecentsPageBlockRenderer.js\":\"677dabe84ee8059e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/grouping.js\":\"9e99ec5ce085ef16\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/index.js\":\"ccc2f8b26c1c2352\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/target.js\":\"901ed6a95c495478\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/codeMirrorExtensions.js\":\"86d5aea32080e3ab\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/contentPrefill.js\":\"8ca0ed72f5d8fe2a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/dataExtension.js\":\"86b1a8d333bc5e13\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/index.js\":\"7c009af95c0140e1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"6f2ef7f54c993e52\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/invalidation.js\":\"858d06a4bcbb2639\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/localSchema.js\":\"f495d5ec1a274e99\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/blockrefs/index.js\":\"34c398fdf293e6a5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c0eb287a99b36984\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/index.js\":\"40403114eeca9c97\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/referenceNode.js\":\"324676b31bd00275\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/remark-reference-occurrences.js\":\"61129e440399ae14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"6a0cb39c0318ee09\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/index.js\":\"bb8889681f37cc01\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1dd6358f32876cfb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e4861a374f1a9770\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/mergeRetargetProcessor.js\":\"e0b2cf0f4e5a561d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/parseFence.js\":\"8f98eab3cd444b3c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/referenceParser.js\":\"d383884d2a5644e3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/referenceProjection.js\":\"ce45f4d439e10373\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/referencesProcessor.js\":\"b3ea122a6e865d3f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/renameProcessor.js\":\"8b9333dc0e662b3a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/spanReplacement.js\":\"98e66535f8ad7056\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/htmlToOutline.js\":\"e5319c4cc9c9def2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/index.js\":\"f34c92b6a0b54754\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e7569ad4236121b0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/pasteDecision.js\":\"7f4127f93a2ac916\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/action.js\":\"368788bfa2316fe9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/blockIds.js\":\"50ce450b96d572d0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/content.js\":\"d6d76560956ce478\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/effect.js\":\"efe32b4b924a52f7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/ids.js\":\"95cb5f0ca44aa1f8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/import.js\":\"3c70b095810edcc6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/index.js\":\"b416e607e84e2839\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/plan.js\":\"fb795e3e46e98d5b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/plugin.js\":\"32448bac88935862\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/promotion.js\":\"3d90ee3d53e258a3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/properties.js\":\"5e3e1666c5f59d7e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/references.js\":\"e28d28610c3a105b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/report.js\":\"8172a378a9d6c695\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/roamMemo.js\":\"054c35a97592c277\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/runtime.js\":\"1d801b9a7aae7880\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/schemaReconciliation.js\":\"1416022249f7ad18\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/srsMarkers.js\":\"50a2ab87b1dd89d8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/todo.js\":\"862bdc341051eaa4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/typeCandidates.js\":\"44aed298244659b8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/types.js\":\"0151e86f4ef536c6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/search-health/index.js\":\"f6cf9635b6151c3c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/search-health/store.js\":\"578a361feabf646f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/HeaderItem.js\":\"a73a23df6ceb963e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"02517d54bca09b81\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/index.js\":\"06f46704a68de934\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/model.js\":\"24e73a9b682e0d35\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/toggleStore.js\":\"afaba3202c27c47e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/useKeyInspector.js\":\"a692b697999817b6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"fb3f257d7cc45fe7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/ShellDecorator.js\":\"c8a79ce8d88078d5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/actions.js\":\"9c795821a3f68bbc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e7b28f4980a54f70\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/index.js\":\"237062552341e8e2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/shell.js\":\"f43f4efa94785fa0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/surface.js\":\"f32f33e1619ae323\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/walker.js\":\"ae8a1ea7d91a31fa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3b2fdc56efce0ebf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/dataExtension.js\":\"838956226aaf601a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/index.js\":\"cec93b523ab1fc0a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/indicator.js\":\"b0580db36bed6d74\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/moveSrsState.js\":\"6f8fa85bc9fd0941\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c099c495cd44c094\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/scheduler.js\":\"bad8c846e7098695\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/schema.js\":\"0a844929f383a6a5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"eebd14a4f1a090ce\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/srsClipboard.js\":\"64158e484376d49d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"99e7aafb4078213b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e591daf191b90413\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/DeckPicker.js\":\"847edd6fb0cdf61f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/ReviewControls.js\":\"49ffc4feb831e45e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/ReviewDeckRenderer.js\":\"cb4f36d87c32c254\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/ReviewSession.js\":\"47d966807784a4de\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/actions.js\":\"c345b81e19f95a20\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/archive.js\":\"f6c90e5ab2198984\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/dataExtension.js\":\"df838b2137408047\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/deck.js\":\"2f61bf57c38d8c4b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/dueQuery.js\":\"dc38de6e1589734b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/gradeDecision.js\":\"108dc02060149bcf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/index.js\":\"803a5e2b0d9ba208\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/keyHints.js\":\"01e892853158d74a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/reviewCardLayout.js\":\"a2646c4a4a840152\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/reviewProgress.js\":\"014f35f68a36a56b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/schema.js\":\"9354208a1b68eeea\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/useDueCards.js\":\"4d18c9a17df21dba\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/startup-metrics/index.js\":\"4b210624822cb04d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/startup-metrics/record.js\":\"2d6e88a8a86fa120\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/storage-persistence/index.js\":\"f9b237558581fc65\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/storage-persistence/persistenceStatus.js\":\"a6c60c6da91d1da7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/storage-persistence/requestAction.js\":\"c78a32a30995a9f0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/TypeChipsDecorator.js\":\"6d2d15b791c73e55\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/codeMirrorExtensions.js\":\"195f4461f45ef18b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/index.js\":\"29849b3b80fd454b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/typeAutocomplete.js\":\"8b90932c924951a2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4b3b643c14ce3d9f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/actions.js\":\"03acc3d90f797020\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/anchor.js\":\"7a1cb788c7b0db01\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/events.js\":\"b54f2500ad6b6a83\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/gestureActions.js\":\"6be721e911540739\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/index.js\":\"09a504374c2dfc04\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c0ff02f3868759e6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/sync-metrics/collect.js\":\"60068415e9333517\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/sync-metrics/index.js\":\"197cc90942915198\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/sync-metrics/record.js\":\"9a5167f8c59ad896\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/RejectionDialog.js\":\"5963c41f96798e38\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/SystemStatusHeaderItem.js\":\"cbf13210c5540633\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/index.js\":\"334bc03f919117c5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/model.js\":\"7afaa4dabda59824\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/queueCounts.js\":\"e40ef20bc46f532c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/rejectedHelpers.js\":\"2ff455000483d15f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/rematerializeAction.js\":\"d31dd010e4bf5c1a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/useHysteresis.js\":\"7e19d2d3914a6835\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/ColumnHeaders.js\":\"0ece142b786a9aaa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/QueryUi.js\":\"36e32d881e7a041a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/TableLayout.js\":\"edd6617840f59f92\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/actions.js\":\"83e749b8624e9f23\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/cellEdits.js\":\"e9aa4e4ec8758827\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/childrenViews.js\":\"a5eba82ce003e2b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/columns.js\":\"f2b7e0ca99fff919\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/controller.js\":\"71163cb8f5fd9a1e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/convert.js\":\"91bc1ef7c1b33e90\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/dataExtension.js\":\"f4cc361ab6565ebb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/index.js\":\"96a6247b6ca88b69\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/keys.js\":\"38dfb5de443fa023\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/model.js\":\"2a994367a1faeaee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/QueryText.js\":\"5c83b1d716c8e5b1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/backfill.js\":\"0628c7e48e114ebc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/completion.js\":\"002f50d6132eeffb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/format.js\":\"47b6153764c32946\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/parse.js\":\"49df9f38bc314b45\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/queryValue.js\":\"045db0575eab2696\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/registrations.js\":\"b4ee929017b39b31\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/source.js\":\"71c485eec15d1aaf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/registry.js\":\"a97be63560cd07c1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/rowGutter.js\":\"7f3fee542137b110\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/rowVerbs.js\":\"01f2c623c8bd5ef4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/schema.js\":\"e2a4d13e6a7df910\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/sort.js\":\"37285b679a82b24c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/theme-toggle/effect.js\":\"b62a1fab4e89a7eb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/theme-toggle/index.js\":\"c4d024bfb0b0ff36\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/theme-toggle/theme.js\":\"f1dcb2fe89b19d19\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/actions.js\":\"c746caf351144621\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/dataExtension.js\":\"c4c7cbd05db6b5cf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/index.js\":\"acb5e96b5456de6d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/schema.js\":\"f0106b8c388bb633\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/TouchSelectionLayer.js\":\"62257e9c169ec8d2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/actions.js\":\"f2c2e2420388a520\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/defaultItems.js\":\"39f516ea9e18f95a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/facet.js\":\"61557aa82ff7018f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/holdRecognizer.js\":\"320a0cdccb7d97ff\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/index.js\":\"813f50b427831858\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/update-indicator/UpdateIndicator.js\":\"b7a4b6d12aa70e02\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/update-indicator/index.js\":\"c9e51daaf0c06965\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/update-indicator/loadTimes.js\":\"4020d47b9110a12f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/VideoNotesRenderer.js\":\"c11b259e3cf23e07\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/VideoPlayerRenderer.js\":\"42af54d940fcb9e5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/VideoTimeStamp.js\":\"dafb6d2c59b9449b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/actions.js\":\"e60bce8e35c656a4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/index.js\":\"8b54139405480084\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/markdown.js\":\"98517ceb814de6b0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/notes.js\":\"7df22d3587c3c32f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/registry.js\":\"68ea37f7ce5eb9f3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/remark-timestamps.js\":\"ac306b12040e9533\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/view.js\":\"92c45ca956772000\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/LinkHints.js\":\"7a164b2577e782d5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/index.js\":\"14d64ab43cbf090f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/model.js\":\"f384b07a8a68c942\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/settings.js\":\"68f5417104e977e1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-normal-mode/actions.js\":\"c923818298ef7a7f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-normal-mode/index.js\":\"dd6d608625ac8362\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-normal-mode/interactions.js\":\"0d7ef53d1b75b27c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/workspace-header/index.js\":\"481e462d7ac6372c\",\"/knowledge-medium/pr-preview/pr-1906/src/registerServiceWorker.js\":\"d32b0269e58938e9\",\"/knowledge-medium/pr-preview/pr-1906/src/requestPersistentStorage.js\":\"c301f5436bac022a\",\"/knowledge-medium/pr-preview/pr-1906/src/services/authRequestDeadline.js\":\"dd1468dfe228ad8c\",\"/knowledge-medium/pr-preview/pr-1906/src/services/authStorage.js\":\"92c84d1233426264\",\"/knowledge-medium/pr-preview/pr-1906/src/services/powersync.js\":\"fbfa7cc249297f51\",\"/knowledge-medium/pr-preview/pr-1906/src/services/supabase.js\":\"3bebfa10e3095efb\",\"/knowledge-medium/pr-preview/pr-1906/src/services/uploadErrorClassifier.js\":\"ef151d7cee6715ae\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/ActiveContexts.js\":\"4779f51fea1b5834\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/HotkeyReconciler.js\":\"005a24e0ff3641c5\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/WipeLocalDataDialog.js\":\"7e1818f8b6d22ba5\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/actionDispatch.js\":\"4a47e793867e6ad6\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/actionRefItems.js\":\"52a7562e48fc6bfa\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/applyKeybindingOverrides.js\":\"921efd1fd22313ab\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/blockActions.js\":\"8fdbbdace7dac0ef\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/blockMergeGesture.js\":\"3fe5e515350e4a9b\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/canonicalizeChord.js\":\"8a77a75c35a0bcf1\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/defaultContexts.js\":\"974f0dc650b26d8f\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/defaultShortcuts.js\":\"2d3db553413386de\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/effectiveActions.js\":\"d2f5e9d45933e7da\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/gestureAction.js\":\"ccc4e21c538c131f\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/gestureBinding.js\":\"1d05ecffc1eb5c28\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/holdRegistry.js\":\"ca140f3960e4e812\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/keybindingConflicts.js\":\"39f7030c3f62a676\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/keybindingOverrides.js\":\"5ff28732d7b9ccd8\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/pointerAction.js\":\"1fd47d83083c8400\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/resolve.js\":\"b32e2121bf9f1bba\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/runAction.js\":\"c0174f0f4a9cdc02\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/sequenceMatcher.js\":\"8bbe188d9072b697\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/types.js\":\"ac5863c15c133b22\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/useActionContext.js\":\"e424df2a17503b46\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/useActionDiscovery.js\":\"ad3e989ca81cb249\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/utils.js\":\"6501716f4f96245d\",\"/knowledge-medium/pr-preview/pr-1906/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1906/src/sw/bootStore.js\":\"56e1667edc9d98b6\",\"/knowledge-medium/pr-preview/pr-1906/src/sw/previewDatabases.js\":\"4b8f9834447c3861\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/byteTransform.js\":\"5c024728214ac220\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/attachmentCleaner.js\":\"04366b632ab992ac\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/attachmentParts.js\":\"4f6fa1ae18cea522\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/bundleParts.js\":\"2f86d37dd9d66627\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/bundleRecord.js\":\"aa04ff2248269c6a\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/manifest.js\":\"b5d83a918ac2d3f0\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/takeBundle.js\":\"f77cc2672ec79cd3\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/verifyBundle.js\":\"324986c9ee5947bd\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/cleaningStage.js\":\"91e638e981e1abea\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/conversionKey.js\":\"39260f80fc3b812e\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/conversionServer.js\":\"5fe034205e89a7a0\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/flip.js\":\"ce2009574b340377\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/flipAttempts.js\":\"4995bea26fc299b3\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/pages.js\":\"8bfb8a2895aab6e6\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/preflight.js\":\"4060abb3e3eaf5f8\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/reseal.js\":\"cff8038d90e200ea\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/runConversion.js\":\"f0d6a905c856fb51\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/runLock.js\":\"a162487294534232\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/sealing.js\":\"2b344d33d2628597\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/sealingStage.js\":\"1166906bf2213c56\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/stage.js\":\"999f13b05e45b584\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/verifyReseal.js\":\"826d37ccfd8569c1\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/aad.js\":\"30b6aca9785956a2\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/aead.js\":\"117e19bd11d09b04\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/base32.js\":\"6aedf785626aae68\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/base64url.js\":\"5382a600e1dbaaeb\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/binaryEnvelope.js\":\"0e69316e15ba69e5\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/byteAead.js\":\"80012987347b2028\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/canary.js\":\"c39ef92df9a91907\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/contentHash.js\":\"589b3911972e604a\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/contentKey.js\":\"81a6d83d574d3a57\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/derivedIdNamespace.js\":\"c1b3306be524150e\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/envelope.js\":\"6e074bd3533c9190\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/hex.js\":\"7a8e6f0d840f6190\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/sha256Hex.js\":\"79ba69ca10b58705\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/workspaceKey.js\":\"3994e36194e1d493\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/conversionState.js\":\"02c489b6acc1c0d4\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/createEncryptedWorkspace.js\":\"eb35f6b53e32bf91\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/pastedKey.js\":\"1ca8b75083147388\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"0e40472f67bada68\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ea71e2751d6a6c3d\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/keyStore.js\":\"b107f38c34d1cb8a\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/mintWorkspaceKey.js\":\"1dcca9677d2b7798\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/modePin.js\":\"8b14d769e5f2fe82\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/openWorkspaceKeys.js\":\"3b71c3b8f449fe03\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/resolveWorkspaceEntry.js\":\"13705e99790652d0\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/resolver.js\":\"4723fcffbfa0d019\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/workspaceAccess.js\":\"a3ebc57f514b71a2\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/transform.js\":\"5428a53c6a0c9309\",\"/knowledge-medium/pr-preview/pr-1906/src/themeBootDefaults.js\":\"39692fadc98c26d2\",\"/knowledge-medium/pr-preview/pr-1906/src/types.js\":\"526784ce9c87e14e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/ClientLocalSettings.js\":\"01ac6fcdc2fa197c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/abortableSleep.js\":\"77481b977e17b4fa\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/array.js\":\"dfcb887c1fe8c10b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/backlinkAutocomplete.js\":\"29762caf482c986b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/blockCrumbs.js\":\"f0db3457a205ab88\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/blockrefAutocomplete.js\":\"48f3c0f66ccaa4c0\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/cadencedIdleJob.js\":\"ef64fa16ef5fb5ad\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/callbackSet.js\":\"17153d70e6082012\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/clientId.js\":\"a4bcd838a2e8f62d\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/codemirror.js\":\"992a539193367d7a\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/codemirrorCompletion.js\":\"1698983e39610b00\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/copy.js\":\"0e122612259827f8\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dailyPage.js\":\"312d719b9f2cf2c8\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dbForensics.js\":\"b832577039559300\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dbForensicsHooks.js\":\"d13743bd036e42d2\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/deleteBlockThroughUi.js\":\"1dc861d71aff4bbd\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dialogs.js\":\"a7e6082cc25f72dc\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dom.js\":\"81edf9d0e9493956\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/downloadBlob.js\":\"1255aa5cbccdc7ad\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/drawnWalk.js\":\"960b2f035685b1ad\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/exportSqliteDb.js\":\"30a7ace9f4446db6\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/fileSystemAccess.js\":\"75cbb99cd8859c73\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/flipSlide.js\":\"aa0dff4bca126021\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/fnv1a.js\":\"ad8e9cc0b54ef385\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/formatBytes.js\":\"a9b832573ef57f43\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/fuzzyRank.js\":\"461ca5f898c2b4b9\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/idbKeyedStore.js\":\"60229428de85b1a6\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/idleCallbackPolyfill.js\":\"e6c4e0d143a5d640\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/keyboardAwareScroll.js\":\"0ac9f6e9d95c3c78\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/keyboardViewport.js\":\"63f96f75b3cef505\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/lastWorkspace.js\":\"5fbc366791747437\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/layoutColumns.js\":\"e65c2e68122699e0\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/layoutSessionDom.js\":\"891d7b94bff10055\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/layoutSessionId.js\":\"f1b1cca65a21fc90\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/linkClickGestures.js\":\"387a6591954051ef\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/linkTargetAutocomplete.js\":\"a95ef7b4d8464245\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/localDbCorruption.js\":\"b445564be6ab00a1\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/localDbRecovery.js\":\"cfe571cb13699b57\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/markdownParser.js\":\"38c41084e06ccf6d\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/memoize.js\":\"e167038946b358dc\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/nameFieldCommit.js\":\"25f118a37655f95c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/nameList.js\":\"f6276d6014e00dd4\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/navigation.js\":\"6215a3eb33685bca\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/omnilinerNamespace.js\":\"6acc69b39e3a140f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/opfsPageScan.js\":\"391299a1875778c7\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelClearance.js\":\"b2ac52e468cb15f9\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelHistory.js\":\"8877bf7474a4f7e6\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelLanes.js\":\"9e197e12d1539a4f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelLayoutProjection.js\":\"d309fc966e903973\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelScrollAnchor.js\":\"86d3b422e050f502\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelUrlFlags.js\":\"63acce4c2f65ce0d\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/platform.js\":\"b1bebd9f231a6d93\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/pluralize.js\":\"1ca9f5600569831b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/propertyCreation.js\":\"a9ac97b5910337a2\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/propertyNavigation.js\":\"db0c2e58068251dc\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/propertyValueContext.js\":\"44b61435399f42c7\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/react.js\":\"14af153248cf41fd\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/relativeDate.js\":\"12e05ee3a6e2c141\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/relativeTime.js\":\"52b4ee770506705e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/renderScope.js\":\"4302b2bf049ae3d0\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/resolvedThenable.js\":\"7511c62b9b35f7d6\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/routing.js\":\"6d6068bd3bd4e4f7\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/safeMode.js\":\"5fb7c3de77439bd9\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/scheduleIdle.js\":\"4ae44b004183f852\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/screenWakeLock.js\":\"cd2624297bc37be5\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/selection.js\":\"ccec38dde6ba8e91\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/softKeyboardGrab.js\":\"9bb71b997559610e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/startupTimeline.js\":\"a9b3a650c9ac42ef\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/state.js\":\"92f3112fda34c299\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/string.js\":\"f76c1399b902e21c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/surfaceZoom.js\":\"24194f3db1a7c79c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/time.js\":\"6908f531b7a518b7\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/toast.js\":\"2090ea8f0adb0986\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/toggleStore.js\":\"81e6df619ec6c207\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/untilStopped.js\":\"f2cbcc26d50dc647\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/userActivity.js\":\"df275fc2fd7c83b0\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/viewTransition.js\":\"f7ad19bec6385938\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/viewport.js\":\"440326c2a6ffc463\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/webLock.js\":\"5075d1cad87a6e20\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/workspaceRecovery.js\":\"241dd8321f14fdf8\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/workspaceSnapshotStore.js\":\"7f25f02ebeb93f78\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-compiler-runtime.js\":\"94a0c8034c2daf09\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-client.js\":\"692b71bed6f2ec79\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-server-edge.js\":\"b25655b76dfe492e\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-server.js\":\"a1ad6db4bb2bf1fd\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-static-edge.js\":\"37b4096c634c758c\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-static.js\":\"1622b69913b2db4b\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-test-utils.js\":\"cfc091072e27f658\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom.js\":\"893f311fe453472d\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-jsx-runtime.js\":\"9ee9e369b415a1c5\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react.js\":\"07d041e7da9f4c69\",\"/knowledge-medium/pr-preview/pr-1906/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1906/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1906/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
