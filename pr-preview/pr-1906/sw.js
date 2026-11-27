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
		buildId: "b52e1fda2a24-bea4bd81",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1906/\":\"f43cb97077910d71\",\"/knowledge-medium/pr-preview/pr-1906/index.html\":\"f43cb97077910d71\",\"/knowledge-medium/pr-preview/pr-1906/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1906/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1906/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1906/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1906/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1906/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1906/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1906/assets/FacadeVFS-BncZGyZ6.js\":\"6a0e7512719c1f53\",\"/knowledge-medium/pr-preview/pr-1906/assets/OPFSCoopSyncVFS-BFx_o-jv.js\":\"8c71cd3764c95feb\",\"/knowledge-medium/pr-preview/pr-1906/assets/OPFSWriteAheadVFS-BjXpYZPU.js\":\"a10fbbe89d5c2f7e\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-async-D9vBKqjQ.js\":\"94c2051c787d7af2\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-iPGTibNX.js\":\"7855c137fba7e004\",\"/knowledge-medium/pr-preview/pr-1906/assets/worker-Bbvtp6s6.js\":\"ff4ca5ece7da078e\",\"/knowledge-medium/pr-preview/pr-1906/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1906/chunks/app-CTG49wdq.js\":\"93383a7711f81c5d\",\"/knowledge-medium/pr-preview/pr-1906/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1906/index.js\":\"3949ebf53a2ebda3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1906/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1906/assets/AccessHandlePoolVFS-HKRyJFTR.js\":\"542e2a3eb6274500\",\"/knowledge-medium/pr-preview/pr-1906/assets/IDBBatchAtomicVFS-ppHmHEfG.js\":\"6abec8fde789f281\",\"/knowledge-medium/pr-preview/pr-1906/assets/MemoryVFS-l1lSP-oh.js\":\"9a52ec006d5e94b1\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-CedV45ih.js\":\"fef4b34c58a92fa3\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-async-B7Jvxs_W.js\":\"eeacadf5ff1bc771\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1906/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1906/chunks/AccessHandlePoolVFS-CMtLeVMf.js\":\"c7dedf9dfa6d181e\",\"/knowledge-medium/pr-preview/pr-1906/chunks/FacadeVFS-B4a6WxBC.js\":\"8259c70b2ac81eb3\",\"/knowledge-medium/pr-preview/pr-1906/chunks/IDBBatchAtomicVFS-DwEcOqSr.js\":\"522d1e1c41ea1f55\",\"/knowledge-medium/pr-preview/pr-1906/chunks/MemoryVFS-nypNSIP0.js\":\"48bf86fda307163b\",\"/knowledge-medium/pr-preview/pr-1906/chunks/OPFSCoopSyncVFS-CPzqVg9a.js\":\"5009ebdaa3c3a757\",\"/knowledge-medium/pr-preview/pr-1906/chunks/OPFSWriteAheadVFS-C5MisjkI.js\":\"bef8397b352add64\",\"/knowledge-medium/pr-preview/pr-1906/chunks/Preview-ZA4C-kYm.js\":\"149749b208bbc2d2\",\"/knowledge-medium/pr-preview/pr-1906/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1906/chunks/card-C4Dad860.js\":\"60555f31b1dc01c5\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dist-IPnFwXsj.js\":\"6c769716e3618336\",\"/knowledge-medium/pr-preview/pr-1906/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1906/chunks/mc-wa-sqlite-DbwrbJBh.js\":\"20e4d36f1f77d88b\",\"/knowledge-medium/pr-preview/pr-1906/chunks/mc-wa-sqlite-async-C7OIUbwk.js\":\"15a5437aca899096\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-34Hh-zaQ.js\":\"7199088ea02f72b4\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-6Lha6w_N.js\":\"1cc12f23c238d247\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-BPm7i82Y.js\":\"d04365213064c94a\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-BSMt1eW1.js\":\"ecfc33bf6864debe\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-B_hsvVcf.js\":\"f3f82dad2d8929a9\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-Bt9v1ZWc.js\":\"1ad6a6121a95ff6f\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-Dhj6Xx5z.js\":\"6ab2acbfe695a025\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-aef_DSut.js\":\"b16684e8b7cbf10f\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-dom-server-legacy.browser.production-B4AYG75a.js\":\"ae81caaee7dba28b\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-dom-server.browser.production-DLWrw5of.js\":\"d3b9e5d7789de0ee\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-dom-server.edge.production-DK2mFo7e.js\":\"608085a8933ecce8\",\"/knowledge-medium/pr-preview/pr-1906/chunks/server.browser-DGbz2JY-.js\":\"645179a7977cf0ec\",\"/knowledge-medium/pr-preview/pr-1906/chunks/textarea-C8DedphG.js\":\"c67d8f40dc144d83\",\"/knowledge-medium/pr-preview/pr-1906/chunks/ui-J_97iMRA.js\":\"53bd5b1160b6e761\",\"/knowledge-medium/pr-preview/pr-1906/chunks/wa-sqlite-BLuoBMdD.js\":\"6af6c7011042ad2f\",\"/knowledge-medium/pr-preview/pr-1906/chunks/wa-sqlite-async-CQMV-Fb9.js\":\"48678bf19cb7a875\",\"/knowledge-medium/pr-preview/pr-1906/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1906/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1906/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1906/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1906/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1906/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1906/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1906/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1906/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1906/src/App.js\":\"ff7ed7cf5cf365df\",\"/knowledge-medium/pr-preview/pr-1906/src/appUpdate.js\":\"93874509d9e6a7d6\",\"/knowledge-medium/pr-preview/pr-1906/src/appVersion.js\":\"7d7e1146da59ba32\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/initialLayout.js\":\"6d0a0da243335793\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/openWorkspaceData.js\":\"90cdea5afc8d3637\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/resolveWorkspace.js\":\"8e699aa7b7e32a42\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/workspaceBootstrap.js\":\"bf439d7094dc289a\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockComponent.js\":\"ac54bc4da2bf306e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockCrumbs.js\":\"6ac286bee2ecb77f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockEditor.js\":\"255f54a780eac157\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockLoadingPlaceholder.js\":\"4de964e228497f3d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockProperties.js\":\"981507955a87ac26\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockSearchPicker.js\":\"5d3aa488474e5a41\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ConfirmBulkDeleteDialog.js\":\"757b5c9dac16cb15\",\"/knowledge-medium/pr-preview/pr-1906/src/components/DividerHandle.js\":\"23e4838b7b57161b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/DraftEditor.js\":\"94da8578bd7deb3e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/GutterPill.js\":\"e969115e3eac4a7a\",\"/knowledge-medium/pr-preview/pr-1906/src/components/Header.js\":\"b707e6cb6c35b3b5\",\"/knowledge-medium/pr-preview/pr-1906/src/components/LazyBlockComponent.js\":\"e31ad767377c25af\",\"/knowledge-medium/pr-preview/pr-1906/src/components/Login.js\":\"ddb4975e228525a8\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ZoomableSurface.js\":\"739b8cddc71d622e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/editModeKeepalive.js\":\"52929117a6ab9b3b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e482c7ffc61cc18a\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3cba5070866d65d5\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/RefPropertyEditor.js\":\"da88902b69ec64ed\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/RefTargetTypePicker.js\":\"ebb2075df82ab530\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/SelectPropertyEditor.js\":\"5f412e915bcc79fb\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/TypesPropertyEditor.js\":\"9ade019ea825c403\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/defaults.js\":\"8d8a76ed214123e6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/kernelValuePresets.js\":\"440b12a722da080e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/selectablePresets.js\":\"75341915d42e7318\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/typesPropertyUi.js\":\"d6917cdf46340197\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/AddPropertyForm.js\":\"62a9d1430f10ec6c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/PropertyPicker.js\":\"e42ca98ff11b5ca9\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/PropertyRow.js\":\"f4056580235c5c50\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/Rows.js\":\"2c7771c2eaa52f2a\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/actions.js\":\"6b0a0f8084f477a2\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/declarationOnly.js\":\"e310e971809089a3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/layout.js\":\"df816afce0478d34\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/model.js\":\"27f50ec4e37f198e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/shapeUi.js\":\"58706ad453266813\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/shapes.js\":\"c2cc108e0efff99c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/usePropertyEditingActivation.js\":\"1e0f22d9f4a90f0d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/visibility.js\":\"9f4eb7980c7203b0\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanelSections.js\":\"477b6f4d6d85212f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/BlockEmbed.js\":\"df094e6270d54384\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/BlockLink.js\":\"302da356e5f0cb3f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/BlockRef.js\":\"254b9308e30ecb2e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/CompactReferenceLink.js\":\"5a42b84c8f3081a4\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/ReferenceLink.js\":\"e94c427b2387d37e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/cycleGuard.js\":\"90c0e15ca15e69f6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/cycleGuardContext.js\":\"d3775c13cdfe5e05\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/linkInteraction.js\":\"76c851dda11b9697\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/referenceLayout.js\":\"1828abb5835ae6f7\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/useBlockRefAncestors.js\":\"0e1c31fd02d0cac8\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockGutter.js\":\"3167c7ae309ae878\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockInfoDialog.js\":\"a1234d692d8a075c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockReadText.js\":\"97f6a2f73e94bcf6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockTypeBlockRenderer.js\":\"84824882739435f6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BulletHoverCard.js\":\"4aa5ee64d3e43bf8\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/CodeMirrorContentRenderer.js\":\"924f8e8a77f5bb9c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"26a5374ebcc9f8dc\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/ColumnResizeHandles.js\":\"ae4938b7f8b11271\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9bf5c6d358d35eb3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/DefaultBlockRenderer.js\":\"5a11a5126c1a8a94\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/LayoutRenderer.js\":\"ef8141ba2d5d5cfa\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/MarkdownContentRenderer.js\":\"60d2ed1929560a82\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/MissingDataRenderer.js\":\"7a9c6d3cbd90891f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/PanelRenderer.js\":\"3546ac662bbb1489\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/PropertySchemaBlockRenderer.js\":\"9df42e0d41c3179b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/TopLevelRenderer.js\":\"c404a1ea7322ede1\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/blockGutterMode.js\":\"78b41ac96c417b8f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/blockTitleText.js\":\"af5e724be07fbc5c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/fieldCreationKeydown.js\":\"2c466d45920ae418\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/layoutRootContext.js\":\"57969fa9baa04268\",\"/knowledge-medium/pr-preview/pr-1906/src/components/typeChip/TypeChip.js\":\"03b482490ee8c4fe\",\"/knowledge-medium/pr-preview/pr-1906/src/components/typeChip/chipStyle.js\":\"0ae3e6a069b30925\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/anchored-floating.js\":\"f7f93dcf86d584b3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/button.js\":\"b19fcbbefbda31ff\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/card.js\":\"f324e0a9f0d6ccfa\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/checkbox.js\":\"8a7715b95273be15\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/collapsible.js\":\"04bed8744e7b8443\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/command.js\":\"ca1353d524cc2df6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/context-menu.js\":\"3d967b1bab897985\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/dialog.js\":\"9323ac7bb3e91890\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/dropdown-menu.js\":\"1bfa8b78f7e52e81\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/floating-listbox.js\":\"e27945373bdf7079\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/index.js\":\"a5c58ffbb06769ad\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/input.js\":\"fffc66ff9847f825\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/kbd.js\":\"38c3fbfb0a0cfbff\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/label.js\":\"e3790a7520058059\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/textarea.js\":\"a6c3d51c097df409\",\"/knowledge-medium/pr-preview/pr-1906/src/components/useEditModeYieldKeepalive.js\":\"3eba2889cad947f3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/BootFallback.js\":\"c1814ac574e162ae\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/FocusedRowLazyMount.js\":\"0135943f51464362\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/LazyViewportMount.js\":\"c270694ad6eb9a48\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/LocalDbCorruptionFallback.js\":\"6b16d2d0ea2c286e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/error.js\":\"f1cd7666fd348caa\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/lazyMountRegistry.js\":\"e68100a523f22995\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/suspense.js\":\"636b3f52424fc389\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/CreateWorkspaceDialog.js\":\"0730093243b51034\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/PendingInvitations.js\":\"f7d1dafc48b8d061\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/SyncProgress.js\":\"09f8f250208365c1\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/UnlockProgress.js\":\"3490adddd222a5ee\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceKeyGate.js\":\"be742dae2c1e2747\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceSettingsDialog.js\":\"ada17e93f2abed2d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceSwitcher.js\":\"f14b6b88eb31ff44\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceSyncGate.js\":\"f1f79bf7e475dbc9\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/ConversionFlow.js\":\"c1b1437cf54b3a67\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/ConversionFlowHost.js\":\"535f865bbdca2825\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/EncryptionSection.js\":\"8bdf0b7b1bede1e7\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/attachmentPrompts.js\":\"a665017db4930bfe\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/bundleFolderPrompts.js\":\"da45df436cffff38\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/conversionFlowDeps.js\":\"f7d3a7f974222da9\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/conversionFlowStore.js\":\"45b7a93fbb7bceba\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/flowUi.js\":\"ede1e62b3284ccdd\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/useConversionRun.js\":\"c7967cc6c44ad64b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/keyUi.js\":\"eed39c77f1034dc3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/useCloseOnKeyLoss.js\":\"0283ac73ed8c2185\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/useCloseOnServerE2ee.js\":\"3c421eeda54b5f4f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/workspaceUnlocked.js\":\"cd03060f233ec3ad\",\"/knowledge-medium/pr-preview/pr-1906/src/context/backgroundSubtree.js\":\"fbe1ff4af127b4cc\",\"/knowledge-medium/pr-preview/pr-1906/src/context/block.js\":\"e82c543c88c920d2\",\"/knowledge-medium/pr-preview/pr-1906/src/context/layoutWsContext.js\":\"e6bbbc6fd17219e3\",\"/knowledge-medium/pr-preview/pr-1906/src/context/propertyDisplay.js\":\"44f44f69dd8b33a3\",\"/knowledge-medium/pr-preview/pr-1906/src/context/repo.js\":\"a61413be5b05dd5e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/aliasClaim.js\":\"f3c859cbc22013f1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/aliasSeatNamespace.js\":\"613ded27a01a5372\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/blockData.js\":\"a90237895a3f6d34\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/blockType.js\":\"1d24b8a6edf57aea\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/changeScope.js\":\"db8d31f312cdbdb6\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/codecs.js\":\"382af68ea5c7d752\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/derivedData.js\":\"4dc23cc1c8d1daaa\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/errors.js\":\"4970d7a4c1d587b3\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/events.js\":\"63c5f5d7d30f932b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/handle.js\":\"95d09e85dd8da95d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/index.js\":\"95ca5ed33a875bcb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/mutator.js\":\"38422855931d6200\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/processor.js\":\"2cb41f34a4971187\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/propertySchema.js\":\"c2a031965463698f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/query.js\":\"956d4dbb4efa6b16\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/sameTxProcessor.js\":\"4b67855d8fd7d05a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/schema.js\":\"95d09e85dd8da95d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/tx.js\":\"95d09e85dd8da95d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/typedBlockQuery.js\":\"0b8b07cd3343e4e0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/user.js\":\"7a76e5b25ce8791c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/valuePresetCore.js\":\"ee6854a2190adfb9\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/valuePresets.js\":\"54d09acd9818d383\",\"/knowledge-medium/pr-preview/pr-1906/src/data/attachmentCleanerIOVerb.js\":\"9c3ff7c5f90c7bdc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/block.js\":\"0b01a2f093dd434f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockCache.js\":\"10cc1707a118f162\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockId.js\":\"716d707e48eaa536\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockLiveness.js\":\"a6f444da387b5e5d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockMerge.js\":\"cfefa296c77fc8ff\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockSchema.js\":\"cbba38172133d664\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockTypeLookup.js\":\"2deb8a197baa3ea5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockTypes.js\":\"73a30d7a21b997a0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/childrenView.js\":\"bbcafe66defcfdfa\",\"/knowledge-medium/pr-preview/pr-1906/src/data/clientContext.js\":\"f7625219a4624ff5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/dbFileSiblings.js\":\"3503b7e1ba0cbf73\",\"/knowledge-medium/pr-preview/pr-1906/src/data/definitionSeeds.js\":\"1d52f54fe85be74d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/derivedIds.js\":\"805a4d2ec03a22c1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/drawnSubtree.js\":\"1a646b41ee00d72c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/facetBridge.js\":\"8800f6860243176a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/facets.js\":\"94430046e36c2378\",\"/knowledge-medium/pr-preview/pr-1906/src/data/globalState.js\":\"937f4386fe163c74\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/aliasClaimRederiveProcessor.js\":\"4a8524fcb65d0deb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/ancestorBatch.js\":\"d24dccf45d94718e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/blockTypeTypeifyProcessor.js\":\"d3f55d4eca883f6d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/clientSchema.js\":\"982ed20fccab605d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/commitPipeline.js\":\"d5da1deb6fccabcf\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/devAssertions.js\":\"ae46d703e2e7c6d0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/firstSync.js\":\"48b93c8446b5a321\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/freshInitialLoad.js\":\"e70cd6738fa882f4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/graphBackfillClaim.js\":\"bc4911a7e52635fc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/handleStore.js\":\"d1671a7187109aba\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/idleMarkerJobs.js\":\"c44f55ff86b1b3ee\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/initialDownload.js\":\"45b46f58a84e472d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/initializeClientDatabase.js\":\"522043f2a78cae19\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/jsonCanonical.js\":\"309128be83515ed5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/kernelInvalidation.js\":\"6289a5281c9a07e6\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/kernelProcessors.js\":\"dc655b50277d5375\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/kernelQueries.js\":\"90f7fd1965c58603\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/mergeTypeMembershipProcessor.js\":\"ddd221d159bf476a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/normalizeReferencesProcessor.js\":\"53ac17ff8a36c92e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/poolInstrumentation.js\":\"c970c426a77c0e75\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/processorRunner.js\":\"2229614073cf2492\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyCellBackfill.js\":\"cdc99cce481f61ea\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyChildMint.js\":\"dd22d37568d70c10\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyChildrenProcessor.js\":\"2cbb4d65d7a4143d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyDefinitionChangeProcessor.js\":\"362b60bb6724c250\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyDefinitionSynthesis.js\":\"74a7e9bdf6de7af4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyKeyScan.js\":\"f6dc0b1ee1eebac5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertySchemaResolution.js\":\"c518460694febfa8\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyValueEdits.js\":\"c879a883e1447eb2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/raiseProtocol.js\":\"103ca69422aca4ef\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/readBatch.js\":\"f0440a00c8840f19\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/refProjection.js\":\"ffc7ab69952f7430\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/referenceTargetLookups.js\":\"4a2d6b360b93f79f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/referenceTargetProcessor.js\":\"3295551c59a7d10a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/replayMerge.js\":\"46a974bc2bdae1af\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/sqlBinds.js\":\"0ca4aa62b5180639\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e0ec7df6ea532fc5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/arrivalProcessors.js\":\"823fc0b33d960945\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/invalidate.js\":\"e46087bb462b5618\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/materialize.js\":\"36e98465deb2df69\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/observer.js\":\"8821b86499b70b67\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/reconcile.js\":\"5a1a1324ab3d1de3\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/timingMetrics.js\":\"64a0bb09fc483684\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/treeQueries.js\":\"b6648ffbfe4c89b1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/txEngine.js\":\"ebe21010c3737296\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/txSnapshots.js\":\"a9463d44a8fb3904\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/typedBlockQuery.js\":\"98f033a6d5a8e9bd\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/undoManager.js\":\"b5470535f73d8b2a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/invalidation.js\":\"89480187c29e310a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/kernelDataExtension.js\":\"4409fdac21757f86\",\"/knowledge-medium/pr-preview/pr-1906/src/data/kernelPage.js\":\"f4a093b3b1a61562\",\"/knowledge-medium/pr-preview/pr-1906/src/data/kernelValuePresetCores.js\":\"0131f6a4fcff6b0b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localDbCorruptionSignal.js\":\"c5fbe1419721c174\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localDbStorage.js\":\"3bbd01d49cf36fce\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localDbVfs.js\":\"948b534c24f5b439\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localSchema.js\":\"5d47719de088ebe2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/maintenance.js\":\"83a6611d784da740\",\"/knowledge-medium/pr-preview/pr-1906/src/data/mergeProperties.js\":\"43f61bfc33f5a577\",\"/knowledge-medium/pr-preview/pr-1906/src/data/metricsConsoleHook.js\":\"37e8b82c711e888d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/migrationsPage.js\":\"8cbcf5fe8d72e382\",\"/knowledge-medium/pr-preview/pr-1906/src/data/mutators.js\":\"a6d007c23ef4fbcb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/orderKey.js\":\"01b46ed6df7ad0b2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/orderKeyPlacement.js\":\"3b6aef3f60ed9388\",\"/knowledge-medium/pr-preview/pr-1906/src/data/outlineSurface.js\":\"6fc01ee48f995fd0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/pendingEditorContent.js\":\"8807b70feee956fd\",\"/knowledge-medium/pr-preview/pr-1906/src/data/pendingUploadsSql.js\":\"6b8a002447040edc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/pluginStateExtensions.js\":\"0f0464ad36cef225\",\"/knowledge-medium/pr-preview/pr-1906/src/data/powerSyncLogger.js\":\"b294f39e2cd96823\",\"/knowledge-medium/pr-preview/pr-1906/src/data/projectorRuntime.js\":\"2f2b5dd188944797\",\"/knowledge-medium/pr-preview/pr-1906/src/data/properties.js\":\"16d5cf2dab6040ce\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertiesPage.js\":\"dfafe72471135e5f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyChildren.js\":\"078532beaf91d318\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDefinitionFanout.js\":\"f5eb1e65bd25babf\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDefinitionMetadata.js\":\"ce24ff084fd2e7c5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDefinitionRegistry.js\":\"b867121c44a3ef27\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDisplayMode.js\":\"8a0edb26b0799d37\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyRowCreation.js\":\"be4b032e3ea64d09\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertySchemaCreation.js\":\"2a0a378fc890fa9c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertySeeds.js\":\"f4e14e64e455ba90\",\"/knowledge-medium/pr-preview/pr-1906/src/data/recentsPage.js\":\"56505918f55a3422\",\"/knowledge-medium/pr-preview/pr-1906/src/data/refTargetComparableProperty.js\":\"cb984c9b666cc5e5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/referenceBlock.js\":\"4dc7fdbf7f669a6a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/rejectedUploads.js\":\"88b489366e0fd36f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/releasePowerSyncConnection.js\":\"aa3f238d67a44311\",\"/knowledge-medium/pr-preview/pr-1906/src/data/repo.js\":\"bc9de647c7ab59b4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/repoProvider.js\":\"15e89e83e777d211\",\"/knowledge-medium/pr-preview/pr-1906/src/data/rowProperty.js\":\"04c060253a9ca600\",\"/knowledge-medium/pr-preview/pr-1906/src/data/searchFilter.js\":\"22ab9a6ae97e1958\",\"/knowledge-medium/pr-preview/pr-1906/src/data/seedIdentityLedger.js\":\"d83b8dfeb8f79ed4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/stateBlocks.js\":\"2663a114f9fcc565\",\"/knowledge-medium/pr-preview/pr-1906/src/data/structuralEditPolicy.js\":\"0296c4ad5bd15689\",\"/knowledge-medium/pr-preview/pr-1906/src/data/structuralInsert.js\":\"fe163498e8f62391\",\"/knowledge-medium/pr-preview/pr-1906/src/data/subtreeDelete.js\":\"9919917009241a6e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/syncStreamLock.js\":\"782a5cb7eacc342f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/syncedTableSqlRecognizer.js\":\"bb21e04d320db10f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/syncedTableWriteGuard.js\":\"12caf51393745d35\",\"/knowledge-medium/pr-preview/pr-1906/src/data/targets.js\":\"3f4860c53c07e33d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeColors.js\":\"bcc5817a891a4126\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeDefinitionMetadata.js\":\"30e48974cc87a02b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeDefinitionRegistry.js\":\"7aa8582564c05a6d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeExtraction.js\":\"b5618bfd6cf662b1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeInitialValues.js\":\"0c07cf1d3926b1ae\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typePropertyGroups.js\":\"00f670c94771a1ca\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeSeeds.js\":\"a00990a4db745fc8\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeTagger.js\":\"1e54ba587d5f4b9b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typedRecords.js\":\"b4bbaf348fbe772c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typesPage.js\":\"d06d3e3aab52b368\",\"/knowledge-medium/pr-preview/pr-1906/src/data/userPrefs.js\":\"da626457f7651137\",\"/knowledge-medium/pr-preview/pr-1906/src/data/userSchemasService.js\":\"dacd23e6202d361a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/userTypesService.js\":\"1767607e24a63beb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/valuePresetRegistry.js\":\"c773c5d3ea2c743e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/visibleChildren.js\":\"4afb3454fd37a0c9\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceConversion.js\":\"d04ebb21cecce560\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceFirstSync.js\":\"473b5846016680fc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceIdNamespace.js\":\"951bce98835a270b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceSchema.js\":\"0e20031a8defd5ce\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaces.js\":\"3f083d2c260b5fb7\",\"/knowledge-medium/pr-preview/pr-1906/src/data/writeAheadLog.js\":\"95ea66011184da2c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/BlockPasteShellDecorator.js\":\"26d6bc639eaa39d9\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/atTrigger.js\":\"e84c98cfec1436aa\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/autocomplete.js\":\"f3d5076b7389f617\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/codeMirrorExtensions.js\":\"3333afc70f58f834\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/contentFlush.js\":\"b1240d043a3dfefb\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/defaultInteractions.js\":\"54c14e2a0518a169\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/editSettleSignal.js\":\"f7e0ee5947515ddd\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/insertImage.js\":\"f512e9d4e88e0200\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/referenceCompletionRange.js\":\"4cd643a637e15d4d\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/referenceTargetTypes.js\":\"f9afba6bb814d970\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/syntaxContext.js\":\"b61c0cae76237ff0\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/triggerMatch.js\":\"6344272799f2a8a6\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/AppRuntimeProvider.js\":\"150578f3060df6ef\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/BlockFocusShellDecorator.js\":\"e86b97047b84f300\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/ExtensionRenderBoundary.js\":\"fce3a327bfb8e352\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/PanelContentRecovery.js\":\"ee37e010321b41d4\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/apiCatalog.js\":\"b0db4b4d13dc5811\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/approveExtensionHere.js\":\"8261fb1e5a9bf61a\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/armedCutAppMount.js\":\"d5d5877816db224b\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/batchableKeyedStore.js\":\"8619c5e1479e615b\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/blockInteraction.js\":\"e5cd3b242a75ebd7\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/blockSelectionAction.js\":\"8a8f2a504cf3f2bf\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/compileExtensionModule.js\":\"f1beef8bcb77c49d\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/compiledModuleCache.js\":\"8d6c5f2dedbeba91\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/continuousGestures.js\":\"71a3ef25f73e3a5e\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/core.js\":\"473dadee5fc71b15\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/defaultRenderers.js\":\"ac91236b1a2af485\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/definitionFanoutAppMount.js\":\"ec1358f2a05256d7\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/dialogAppMount.js\":\"b1ec0efeaf1cc40d\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/dynamicExtensionSeeds.js\":\"2aaaca9f93cc68cc\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/dynamicExtensions.js\":\"5c28e9ed95f83c49\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/exampleExtensions.js\":\"d4fe468a0ddc3408\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionApprovalStatus.js\":\"44a35aafc7d7c62c\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionLoadErrorToast.js\":\"ebc9dac8ea29099f\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionLoadErrors.js\":\"980ad67112f5fe66\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionLookup.js\":\"f041ae8094704d2f\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionToggles.js\":\"0e5b2a9d7bd7fc67\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionUtilitiesCss.js\":\"54d0fc90ddbe2552\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/kernelPageDeletionGuard.js\":\"63fd6630a10671ec\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/liveRuntime.js\":\"abaa9926551bd74b\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/openExtensionsSettings.js\":\"f5610109348a4d61\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/overridesCache.js\":\"dc100900e5ee97c1\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/pluginIds.js\":\"cbab7a9c8c06b769\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/processorRejectionToast.js\":\"6c1ef20ee0bd4227\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/runtimeActions.js\":\"56a72626a22fa89c\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/runtimeContext.js\":\"33e6df0509b640eb\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/staticAppExtensions.js\":\"f9e66a7522483c4f\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/staticDataExtensions.js\":\"ce20700f4f7b0cf9\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/toastAppMount.js\":\"e17308a285405171\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/useOverrides.js\":\"a13c08d469c49071\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/useShortcutSurfaceActivations.js\":\"f5739b7d102cc09e\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/discoverToggleTree.js\":\"ff5264be09970549\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/facet.js\":\"f20f13a1953a6547\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/resolveAppRuntime.js\":\"b9616b83e3a54d5e\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/runtimeEvents.js\":\"55c66e5e0925d94f\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/togglable.js\":\"27f4ce450b1ac046\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/variantFacet.js\":\"501fed91215bfc15\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/verbFacet.js\":\"24ee20988ae61096\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/block.js\":\"47eaaf419ee95bf1\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/focusedChild.js\":\"8a78059cad3fda5c\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/propertySchemas.js\":\"1bfc5d2be9b87535\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/typeRegistry.js\":\"017b0b060221742d\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useAncestorCrumbs.js\":\"5f31033d11476dd0\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useAutocompleteListbox.js\":\"89106e38f3ddb283\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useDebouncedSearch.js\":\"4bcd89056b7f3b50\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useDebouncedValue.js\":\"e2b24f6513b0915b\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useFacetValue.js\":\"f87e003b04559d95\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useIsFocalRender.js\":\"90d1547ab5585d3b\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useIsReadOnly.js\":\"db9ead418a10d2dd\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useMaterializeBacklog.js\":\"7bdc43df7c875bcc\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useMinuteClock.js\":\"d89061f7508bdde7\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/usePanelLayoutProjection.js\":\"3d861b005035d139\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/usePendingInvitations.js\":\"27436e57e4129db0\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useRendererRegistry.js\":\"e0fbc11b068c4b56\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useRetainedFieldRows.js\":\"4a1ee6a9744161dd\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useWorkspaces.js\":\"566f4e49dd7b0820\",\"/knowledge-medium/pr-preview/pr-1906/src/lib/utils.js\":\"f0613cc9e61acb8a\",\"/knowledge-medium/pr-preview/pr-1906/src/main.js\":\"c40f5b84d75e712d\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/MarkdownImage.js\":\"27d4ca61870b262a\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/blockSeparators.js\":\"0add17f2902b2b4d\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/context.js\":\"6169e7649eb35d09\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/defaultMarkdownExtension.js\":\"2ae47ffd0b67e499\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/extensions.js\":\"bfe56e7a1f253b5d\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/renderMarkdownHtml.js\":\"32a54dbcb37caad6\",\"/knowledge-medium/pr-preview/pr-1906/src/minimal-editor.js\":\"f2a28eb1e5372911\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/armedCut.js\":\"6cffb341e2aeb3a8\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/captureMediaVerb.js\":\"33f0f5b38bd39a11\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/clipboard.js\":\"f41dc263fc57f76e\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/decision.js\":\"b8f42c1055322f01\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/operations.js\":\"cb64149695b43bdf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/account-header/AccountHeaderItem.js\":\"333624699e4aa971\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/account-header/index.js\":\"8944ed7d32e436be\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5d447563bab3b75a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/askAgent.js\":\"c09237761423eade\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/askedStore.js\":\"78bb99c33ac32d0d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fc257229a70a3a6f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/chipState.js\":\"66cacc27d307bc17\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/dataExtension.js\":\"1568fd8d8b933e24\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/index.js\":\"182b9bfb85e1722a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c4200076ec2ffa24\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/schema.js\":\"6df680551c93fcac\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a3ff36b231d319aa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/BridgePairingDialog.js\":\"fc2afdab742cc900\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/addMedia.js\":\"e8fb35d1571cafb0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/backlinks.js\":\"6b6b0263cf0fa42b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/block.js\":\"7ffa749a6f1755ae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/context.js\":\"7f20b6ac41e997ec\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/displayIds.js\":\"2cf9f3c40dfd6b48\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/index.js\":\"e469d443c0444e0c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/outline.js\":\"5fa2a37888ad40a2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/properties.js\":\"2a3b29d98866de40\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/refs.js\":\"3d25fce75009688b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f5916b846e2ec821\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/search.js\":\"d989d1edab5aa78b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/shared.js\":\"f54655a9a36f7b86\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"7f4316cf2ca6c74e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/text.js\":\"1a8dff844ccdec6b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentWrites.js\":\"1f56b6448e20c482\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/authoringCatalog.js\":\"3f6fc96f257feb3c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/blockRefTargets.js\":\"b8b19f2d29081cb0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/bridge.js\":\"b8df972cb8559189\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/bridgeLoop.js\":\"9102309878d3549e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/changeHistory.js\":\"1c108f340848ccee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/commands.js\":\"9e246097617e632b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/commentsCommands.js\":\"34e06e187b4234a8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/dataExtension.js\":\"b5352fe3b2e7dd7f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/dataModelGuide.js\":\"7cb3f2676357b4c1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/dayPropertyInputs.js\":\"3427b91026c1c324\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/describeRuntime.js\":\"8aeef50bdaf932ef\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/extensionLint.js\":\"ad7131a70ee9c563\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/grainAudit.js\":\"155c9dc3b2716032\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/healthCommand.js\":\"58718c791f3f169b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/index.js\":\"f7c5772c100df52f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/presetIdentity.js\":\"5d73bbfab774171f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"185e48801c234ff3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/readMedia.js\":\"56013dcfe5f2e839\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/schema.js\":\"582f924c54347bc6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/serialization.js\":\"5b4ca9c1eee5aea0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/targets.js\":\"25a9890764a76237\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/tokens.js\":\"8dd4c63d1872fe5e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/watchEvents.js\":\"efccfc5e4c72b256\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/workspaceGuard.js\":\"9104f2b85cfc4bd3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/writeCommands.js\":\"cdf76d9f2ebcf0cb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/AliasCollisionToast.js\":\"2c2e03a1a70d88f4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/DuplicateNameBanner.js\":\"467ae819b3d52e51\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/collisionMerge.js\":\"b6c613e813b31278\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/dataExtension.js\":\"4ecb56f052c34a50\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/index.js\":\"84a8863716239e41\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/mergeCollisionAction.js\":\"323b52e212af7e36\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/pageStyling.js\":\"f29702221806a750\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/rejectionToast.js\":\"b86d45418b4b6e13\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/syncProcessor.js\":\"2f94d55a51960027\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/actions.js\":\"ff151a246d08e380\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/addComment.js\":\"d08157e9a4399933\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/anchor.js\":\"86e422e764b23077\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/anchorState.js\":\"615fcb0e7efbed6b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/commentLinks.js\":\"2c02227da03975f1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/confirmThreadDeletion.js\":\"a47704051ba938cb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/container.js\":\"eb67c82e94adbb91\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/dataExtension.js\":\"9e7c9ac04d0e7c6e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/deleteComment.js\":\"7cd0214a89ca6089\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/highlights.js\":\"7a62d3632636e798\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/index.js\":\"5c21805b375b478c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/linkedCommentsPill.js\":\"f8694811c944e6ee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/margin.js\":\"db6ee055870de379\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/marginAnchorLinks.js\":\"13303275f9e095a9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/marginSchema.js\":\"430059776591ad11\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/newComment.js\":\"d2637bd8d50589b1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/ownThreadPicker.js\":\"a4d41bb2efbef959\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/placement.js\":\"78ae6c2b2dcc8201\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/queries.js\":\"cde0c469064a57d4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/quotePosition.js\":\"9a7eb97f55728db0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/quotedIn.js\":\"6984a762f37f93bf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/quotedRange.js\":\"04308fde52e5cc02\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/rangeRefs.js\":\"9a758479ff25e9a6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/readHighlights.js\":\"c9e4ba8f63773a76\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/readSelection.js\":\"bcc1de49e6a6cb79\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/readSelectionUi.js\":\"aba57a151a10da91\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/reanchor.js\":\"724c0fada9593a63\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/schema.js\":\"82029ab04a459812\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/scope.js\":\"ef7e995f0fcd9c73\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/scopeThreads.js\":\"87996f73e8782beb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/splitRetarget.js\":\"b94262047e11c69f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/suggestionCard.js\":\"017a1e6807b7722a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/suggestions.js\":\"c8b9f7c35db920c7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/summaries.js\":\"f5224ba5fd6bd04e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/summaryBatch.js\":\"f66cc92ba83fab47\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/surface.js\":\"d17a455d23b5e557\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/threadNavigation.js\":\"8502af8a15671b19\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/threads.js\":\"66be2794c44b0ee6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/ui.js\":\"d553278ff4c81dfe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/uiStore.js\":\"2e825fa29bec8c26\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-intents/appIntents.js\":\"c00c2fb8c0ea921d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-intents/index.js\":\"4c65e6baaf4434f8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-update-prompt/index.js\":\"b7e5cb290f9b6d45\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-update-prompt/status.js\":\"633919fa706d7d87\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5acc27595b31e381\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/MediaBlockRenderer.js\":\"8545ba6c303cbb85\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c0e2d9ba6a8a594a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/MediaUploadReconciler.js\":\"0140da4d2786128a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/assetDownLane.js\":\"b16e3ebea2de8e65\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/assetResolver.js\":\"7c0fc0e704daca3f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/assetUpload.js\":\"f5fba02cea7a807a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/attachmentCleanerIO.js\":\"0b64d584595e6d4e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/supabaseAuditIO.js\":\"193e1ffbe2db2f73\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/blobStore.js\":\"0ef146f06432597b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/browserMedia.js\":\"ca1ccd129467419a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/byteStore.js\":\"6e4c8177b7757072\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/cleanerIO.js\":\"61372516c52ce4de\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/cleanupAttachments.js\":\"3cae38255dfa1602\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/dataExtension.js\":\"4d8bc88ebb367030\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/downLane.js\":\"c3cccdeba9126964\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/index.js\":\"df3fea11be6be3eb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/insertImageContribution.js\":\"f293c83c971213d7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/laneArming.js\":\"76194a65446457ee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/laneLock.js\":\"2cd9bd9728450e46\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaBlock.js\":\"dfbd165b814c2883\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaCapture.js\":\"c79fbe408e30564b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaLanes.js\":\"979a424ca8af79dc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaViewers.js\":\"a4a2c1ff57869637\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaViewersFacet.js\":\"72bac6e4d93ff73a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/pasteCapture.js\":\"e80f26be7d8d6168\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/resolver.js\":\"e46a49febc2ce158\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/retryUploadsAction.js\":\"b2d83a86d99bb671\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/storagePaths.js\":\"704af71b55aafe23\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadDrain.js\":\"6a9e203803f77c8c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadLaneStatus.js\":\"b6550f317a245567\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadReconcile.js\":\"2ecbf479c7d44720\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadRecovery.js\":\"3d4c0d10726c5492\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadStore.js\":\"83062968b254a456\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/useAssetObjectUrl.js\":\"ab4c0bef086d75a6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"fa722d48625af3bf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/BacklinksViewSection.js\":\"25b56d0ae5e66f0f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/facet.js\":\"99f8e92ce808253b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/index.js\":\"63a413c8998c8739\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/prop.js\":\"d114d1576e9ec384\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/BacklinkFilters.js\":\"386d7a968a20a718\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"fcf2cf3f3538457b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/BlockEntry.js\":\"f0b3254a47f0b3d0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/LinkedReferences.js\":\"c3c9603ffeccb17f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8fb74d276939860c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/dailyNoteDefaults.js\":\"141e1fb390a9c8d6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/dataExtension.js\":\"8b871f4d7258b9cb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/edgeExclusions.js\":\"8fce1196d3447f81\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/filterProperty.js\":\"84b61edffddee5af\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/index.js\":\"7dc4d445b3ab828e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"3db94113ce6f537d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/applies.js\":\"d74d7bec29870671\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/countQuery.js\":\"d42380fc1014a1c6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/expansionStore.js\":\"81411cf15aaa407b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/index.js\":\"24959808ef5d06af\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d0e838ed5d65101e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/presentationInvalidation.js\":\"6e5ddb1f7406c4ee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/propertyEditorOverride.js\":\"5b371f8e76635bed\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/propertyFilter.js\":\"4d55ad5e561f596a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/query.js\":\"a21b37b5ecee2b75\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/resolveFilter.js\":\"fce78dc541d6bd6e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/sourceBatch.js\":\"b1d63f4a917c3652\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/sources.js\":\"1bef668cd83a514f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/useBacklinks.js\":\"44d638d27a6699ae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"3c4671aff249a004\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/BirthdayCelebration.js\":\"f0c19daf9d82420c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/BirthdayOverlay.js\":\"c900f4f7bd6cd0d8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/gate.js\":\"5571562b938466d8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/index.js\":\"181ceae24787d849\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/wolfTheme.js\":\"bf41be42617149d0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/BlockDragLayer.js\":\"f351557d787d8e4d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/dragController.js\":\"929db5bf31361721\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/dropTarget.js\":\"ab39512eef2dab5a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/index.js\":\"7dd64c6a3d35f8ca\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/projection.js\":\"fbd119b9358c6e94\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-info/BlockMetaCard.js\":\"8aa9f0431e6ae4a5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-info/index.js\":\"e60f32f31012fa32\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/AddTagDialog.js\":\"61e432754e27fcfa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b9ba2a9af974b026\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/TagNameIssueHint.js\":\"66278ef89c81b402\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/addTagAction.js\":\"20f3fc20d9725864\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/appendTag.js\":\"1c5d3946e985ce74\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/config.js\":\"723d0f882a6fd279\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/dataExtension.js\":\"a643c90e87da58f7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/index.js\":\"a3685b641fa7d318\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/propertyEditorOverride.js\":\"79c575cbaca38c15\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/BreadcrumbList.js\":\"bbafdcc107f68cf4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"68a23a5f8fbfbf02\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6e39b49f8ef7622c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"fe6d94e47e69a031\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"86a1e39034e53525\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/index.js\":\"d83527fcbd0e9837\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"9c50ea368679a332\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/CharacterCountItem.js\":\"91d2649cd0996d2d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3b3aeb76eb98e7d5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/actions.js\":\"4219549a55b6bd41\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/blockType.js\":\"0d897a6314ab8c4f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/charCount.js\":\"a74450cf61f94501\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/dataExtension.js\":\"c4013619dc4bc89e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/index.js\":\"489a8bba122fa955\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/profiles.js\":\"36741b968db45872\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/properties.js\":\"aed3139334da8b10\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/subtree.js\":\"78110a1b2168ad6e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/textCounts.js\":\"adfca845dd16ad73\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/colemak-keybindings/index.js\":\"1a1d1b16bd6ac45f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/CommandPalette.js\":\"6c46168aee879c15\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/HeaderItem.js\":\"e07161c98a0eb843\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/context.js\":\"d0348079f5b1b038\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/index.js\":\"e0d53e8d20cc552c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/selection.js\":\"436adbdae292d066\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/toggleStore.js\":\"a04ca8f770652cee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/useCommandPaletteActions.js\":\"3cacce96e4f4388b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/ContributorBadges.js\":\"e63609a652f32ef1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/ProfilePicture.js\":\"dca587ff799e13f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/author.js\":\"ff2965180d318eed\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/codeMirrorExtensions.js\":\"94319e5874bd9ffd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/dataExtension.js\":\"a35d7d5d26f511b2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/index.js\":\"e17e24f12243a87e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/mentionAutocomplete.js\":\"9fcb5a7e9c91daad\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/processor.js\":\"1647930c61650414\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/profiles.js\":\"14daf06a519dcdfa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/queries.js\":\"276c5fb1eec25d5c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/schema.js\":\"efd13a63d878b42f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/useCommentAuthor.js\":\"931c2cb822858953\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9337b0e150bdb523\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a4fe3c2d37f8a07b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/index.js\":\"a0164bc31a580938\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b86b16bbb715b3b6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"9d2ce873257cb25b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/CalendarGrid.js\":\"1b5b67d36ae1dc1f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DailyNotePicker.js\":\"0b33e9d469bbbf9d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d76a0d835c380e16\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DateNavDecorator.js\":\"4654bec6fb787324\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DateScrubOverlay.js\":\"686a10ed395a9333\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DayPropertyControl.js\":\"2b32db37f0e63f12\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DayValueReferenceControl.js\":\"ab7ce9259a79c2c3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/HeaderItem.js\":\"825cad2003a89096\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/ReschedulePicker.js\":\"25010f2fc141e18e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/SpreadDatesDialog.js\":\"79ddb60d862d200a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/actions.js\":\"d84d9bbae9ff16ba\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/blockDateAdapter.js\":\"8762d4b0003b1edc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/calendar.js\":\"1b6b9c5122ce8dd1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dailyNotes.js\":\"f68d982a62cd9b7c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dataExtension.js\":\"805cb1a86d7c5ec2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubActions.js\":\"15cadba493b00128\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubGesture.js\":\"7681f5f3ff9efda4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3c8ef111b7bfd282\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubRecognizer.js\":\"a5525c2cda034ed3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dayProperty.js\":\"ee34d12d707d435a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"99a6cf11fa7ee8a9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/deletionGuard.js\":\"39bc436011a6f2bc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dueQuery.js\":\"ded9947d8ac51be0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/index.js\":\"1e9039f4758aebe1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/landing.js\":\"9217973bbaba1e36\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/localSchema.js\":\"85631d56a877aacd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/referenceDateAdapter.js\":\"845f4c39975d786d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/rescheduleAction.js\":\"6efef4487b75d35b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/schema.js\":\"43d35eb50e297460\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/spreadBlockDates.js\":\"8c18af4b98987ff3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/spreadDatesAction.js\":\"7226cbe41f665951\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/today.js\":\"f481b92501835022\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c93523e6ec2b03b8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"0fb0bbb754a3ddfa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/audit.js\":\"bd159d108b64894a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/auditAction.js\":\"62e3739a08ef48b2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/auditRanges.js\":\"da5851f165101d50\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/diagnosticsSource.js\":\"637a202d925c4c74\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/divergenceScan.js\":\"011fde3c952c0c1e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/index.js\":\"e8b2e3c682b07503\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d609d16194dfa075\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/referencesMirror.js\":\"f80b12f6740dfd9e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/rowJson.js\":\"c986d8cabbdf7632\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/schedule.js\":\"ebcac0850a27d902\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/store.js\":\"4940b57e37dea019\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-maintenance/action.js\":\"31858502c33ec608\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-maintenance/index.js\":\"7d32d3c90a58217c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-maintenance/plugin.js\":\"cad53c126f8d0436\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"99e41c28c52949b2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/actions.js\":\"1b8fdeebc17332f7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/changeMarker.js\":\"325c8f8e5efada6c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/diagnostics.js\":\"cf8f876d090677d5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/fileSystemAccess.js\":\"b4ae979dddd45f4e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/filenames.js\":\"9869b845ecb11703\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/index.js\":\"aa4ae823a187eb59\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/mirror.js\":\"32ab50b0f86022b0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/runLock.js\":\"f267b50ff61b10fb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/runtimeHealth.js\":\"b43408b5b6b0ab6a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/schedule.js\":\"d219982aaf3b4e8c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/store.js\":\"585606b80f01d15f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/default-themes/index.js\":\"0df866547ee5b417\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/default-themes/themes.js\":\"972da83b80a7dbdf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/diagnostics/facet.js\":\"372b45b667e7be8f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/diagnostics/useDiagnostics.js\":\"da600f26e23b655d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/dismissals.js\":\"fd23475d8412d621\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/index.js\":\"73290139ec5d2a46\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/status.js\":\"7649e5332f31a520\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/store.js\":\"da1f05b69d51fa1d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2a73fe7034c8d626\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5fa59bba55d9eaf2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/actions.js\":\"a675b433533d0c23\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/config.js\":\"c34602808c26bf21\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/dataExtension.js\":\"9d9f3712961eac8f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/effect.js\":\"933bf947a5915f9e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/index.js\":\"f39cb0a3a4811b8c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/propertyEditorOverride.js\":\"11f66030ae6dce94\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/useToggleTree.js\":\"18e29030c97fe99e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/ExtractTypeDialog.js\":\"e2f1f1d3d41738ac\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"20cdcbe31b357622\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/PropertyShapePicker.js\":\"dc195b715eeb497b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/action.js\":\"a828b53bf282d8bc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/index.js\":\"8ca6e02d27b7a5ae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/FindReplaceDialog.js\":\"1b1af230ad49aff0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/HeaderItem.js\":\"b7c10510e325afb2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/dataExtension.js\":\"4b4c32b511029fe5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/index.js\":\"2a4e18b678634ed2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/search.js\":\"c5126a2e0dbd0f78\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/toggleStore.js\":\"6336972bd995012f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/LocationPropertyEditor.js\":\"9110038001edd2f3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/MapView.js\":\"41482ba7438431b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/blockTypes.js\":\"9b534de388ce77c6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/codeMirrorExtensions.js\":\"eaebed066da61663\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/createOrFindPlace.js\":\"3dc7c23d1315c2b7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/currentLocation.js\":\"65ccaa02c4cf9c1f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/dataExtension.js\":\"b637da096e1e7570\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/geoContentDecorator.js\":\"4291ebe80077717c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/googlePlacesClient.js\":\"e0f04f08988a0428\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/index.js\":\"21cd65a0a07fbb06\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/locationsPage.js\":\"1a36b00af866d240\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/mapViewport.js\":\"feb55650f11ddc2e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/pickCurrentLocation.js\":\"979999f557898bd6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/placeAutocomplete.js\":\"6376e71c0e380742\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/placeNameCollision.js\":\"1a7ca433b9a1a6cb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/properties.js\":\"1d13cc405d4f405c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/propertyEditorOverrides.js\":\"5c4d498610f9393a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/query.js\":\"fb5a406cf614703b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/usePlaceSearch.js\":\"1e70b922c4fc59ff\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f9e8816d453d24dd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"af2ffd35b29cfd38\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"17d1ce3a6a357335\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/config.js\":\"c482d44c11f0fc57\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/dataExtension.js\":\"eeed980bcdba5b83\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/facet.js\":\"bdfa58f2cd7c27ef\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/grouping.js\":\"c82b580d31d1bc4e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/index.js\":\"985331cdc8741c78\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e7cc07f7387a4a31\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/query.js\":\"9a746e95da48b88d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/resolveConfig.js\":\"cfe749d26ac99507\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"8df589e422f43904\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b83b6875ae418d48\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/HtmlDocumentContent.js\":\"47a7bfa1e2b21695\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/HtmlFrame.js\":\"ce27c4006b756d07\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/actions.js\":\"24f158f568d0e9b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/blockType.js\":\"18bbe997e59f81dc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/confirmRunScripts.js\":\"c998eb2699e26f12\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/dataExtension.js\":\"cb57cfe2cf49ad9e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/frameAnnotations.js\":\"e7e9df11e00b0c21\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/frameDocument.js\":\"a0565e0b5479f2be\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/frameTheme.js\":\"3cb227f48420bfc4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/index.js\":\"171b5eed6dd543a0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/scriptConsent.js\":\"bc494f709fc71bc5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/sourceMap.js\":\"56ba5c182580154e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/useDocumentScripts.js\":\"b5a9032001aaf7ba\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/index.js\":\"21cbe7bd76879e22\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/record.js\":\"265ee8fbb1fa9d66\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/recordStore.js\":\"ef5122a876657ff8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/responsiveness.js\":\"0490579c3ccf1948\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/schedule.js\":\"f1624aa94ba66057\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/sessionContext.js\":\"4206ab80f35ad304\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9913b32cc0d559ca\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7aa92152cdb20223\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/actions.js\":\"f9b393a1aef53245\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/config.js\":\"385bbd3ec10c67e9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/dataExtension.js\":\"9b52bac54c71cd7e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/effect.js\":\"6e8bdccaa9a59a7d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/index.js\":\"8db56cc897114f9a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/keyCapture.js\":\"82b9d025813bbc4c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/overrideStore.js\":\"4a62d000687ff42c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"34e333773b6f94b3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/HeaderItem.js\":\"9f8ee1cd8c1590c9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/LeftSidebar.js\":\"ac72e6442d5d81b2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/actions.js\":\"f597a1aef55563f5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/facet.js\":\"c9d56511190ab1a3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/index.js\":\"e7c5cbb32c661093\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/shortcuts.js\":\"f5f296e2c2cdf6d2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/toggleStore.js\":\"3a531da279380e6d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/MergePicker.js\":\"51045fd9059061d9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/index.js\":\"25cabc3f75dcc2ec\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/mergeAction.js\":\"108bae20f2890f69\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/strategy.js\":\"ac04464322779c9f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/Button.js\":\"18badc7d327772f6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"86470321e6622eb9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/defaultItems.js\":\"2a8496dcf749288b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/facet.js\":\"efb6e8d2767a411b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/index.js\":\"393d5fda403a35ef\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f8178d9f3ee01a7b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/actions.js\":\"acf8f92516eb3213\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5e92b11e04e066ae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/facet.js\":\"aebec0f9c1231dd2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/index.js\":\"5c9f7a66edc11e93\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/MoveDestinationPicker.js\":\"d902b44768eb2d3d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/blockSubtreeMembership.js\":\"7c789edb9fb43a08\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/contextMenuItem.js\":\"fa91fdff5a9e449b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/index.js\":\"58847a7c6fa351a6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/moveAction.js\":\"55c9a36e87d56426\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/moveBlocks.js\":\"1a283c1f3a93f907\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/selectionAfterMove.js\":\"8743f911139e4c53\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/TutorialBanner.js\":\"0ea30b9b06473e85\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/action.js\":\"d3fbdb6d78a1e6da\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/bannerDismissal.js\":\"485d21bc98f6d5df\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/documents/cheatSheet.js\":\"5c6fff7d968e6072\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/index.js\":\"864a65c2d013c6f3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/keys.js\":\"09a3d205fd3fdd16\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/landing.js\":\"fccebd9ef5128310\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/outline.js\":\"b26660f3d225bb32\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/seed.js\":\"1bb13ae8e6f9d4e5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b50ae2613bddcbae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/analyze.js\":\"68a9bfccc934fddb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/diagnosticsSource.js\":\"53575d28a1190bd2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/index.js\":\"8bce10188b4304fb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/load.js\":\"6a3e673f246660b6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/monitorRun.js\":\"7d02e4463119d9d1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/schedule.js\":\"04856ff550003622\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/series.js\":\"a6dd341128c20610\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/store.js\":\"288e4e02fe6f09f9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/trendAction.js\":\"45cf0db9891dbea8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/verdict.js\":\"2f33cede474ad721\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/plain-outliner/clickToEditAction.js\":\"44e5cd764d43f7e0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/plain-outliner/index.js\":\"63cfd4075115945d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/plain-outliner/interactions.js\":\"40a2c125324eacb1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"030ead92b7209423\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/MigrationGate.js\":\"97795733293adbfc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/MigrationGateDialog.js\":\"73ff13992987ad70\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/action.js\":\"21aafe29252f9d07\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/index.js\":\"49db2a7270935111\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/localRunMessage.js\":\"0b5b974442883c29\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/plugin.js\":\"de7feac856526925\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/progressReport.js\":\"7636d84b421f1df1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/sweepProgress.js\":\"c3b944499c6caa8d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/FieldRowRenderer.js\":\"ea3b8c6611e4ede8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/ValueRowRenderer.js\":\"9cbf8186a671b112\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/actions.js\":\"164276f8d3605e13\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/autocomplete.js\":\"bc2347246b95e956\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/fieldRow.js\":\"edfb63b266f3a2d5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/index.js\":\"895934b4d621b2f9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/referenceWarning.js\":\"a0bf8df8bc1f6252\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/valueAutocomplete.js\":\"72708e6345de403d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/valueSchema.js\":\"8222444a32d91df9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/HeaderItem.js\":\"9fdf8958f8dc8917\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/QuickFind.js\":\"4ee385d0b5e39110\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/index.js\":\"2924bb8f4479c293\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/recents.js\":\"b6de8cd6f7985931\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/resultItems.js\":\"c8fc57b2a3614e08\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/selection.js\":\"5186e4f853c08045\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/toggleStore.js\":\"62206b8f90cadd64\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/HeaderItem.js\":\"e6f1811534aa773c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d0473ea15490fe4a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/grouping.js\":\"4dfd27046b353dde\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/index.js\":\"f8d6b6eddcc6aced\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/target.js\":\"676ca11aa15cbbf2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/codeMirrorExtensions.js\":\"02d7a4166ef05894\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/contentPrefill.js\":\"6f621c3b5c701f75\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/dataExtension.js\":\"8971848f0f7b6f98\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/index.js\":\"def74e7a35865976\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"87523a172df18aba\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/invalidation.js\":\"393414ed1d76bca7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/localSchema.js\":\"331c687fb2fec59f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/blockrefs/index.js\":\"bd41f9684f188e18\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8ed2582f33823a9b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/index.js\":\"e6c86438bf143255\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/referenceNode.js\":\"e7885593b339b89e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b8668e2d17811589\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7780135abf73f645\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/index.js\":\"35cfa3fb3ef56d06\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"eb3d1cc76a7908be\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"12caeeed0d22efb7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/mergeRetargetProcessor.js\":\"596121968a045fbf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/parseFence.js\":\"924bcae577541b25\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/referenceParser.js\":\"eb52c91dca8e6edf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/referenceProjection.js\":\"1c2fb7ee5319f402\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/referencesProcessor.js\":\"f111482fb93aef38\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/renameProcessor.js\":\"fbf4eb18103b6ab7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/spanReplacement.js\":\"aecb09325714fd1e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/htmlToOutline.js\":\"5a197b5b17181613\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/index.js\":\"520f788b7bd3deeb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a00ef2adf3b7bfd1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/pasteDecision.js\":\"7fd5dbf291612d70\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/action.js\":\"52f512fef7c439d2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/blockIds.js\":\"f3ede82fb9660c68\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/content.js\":\"040a82fc6152936a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/effect.js\":\"c94b02ae665edc40\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/ids.js\":\"382f1f010e9d198e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/import.js\":\"e28aaafcf345923e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/index.js\":\"6645c99f28d31d22\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/plan.js\":\"00644692d1fc16bb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/plugin.js\":\"f771a796ee2ec12b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/promotion.js\":\"1386553dd447b22a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/properties.js\":\"51a0703c1ba492ea\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/references.js\":\"a6183b46ebff8de4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/report.js\":\"d6224449cdb09d18\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/roamMemo.js\":\"a943f36ff9d17930\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/runtime.js\":\"5dbd9d9da6b10c2a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/schemaReconciliation.js\":\"db8913dc1c69e02b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/srsMarkers.js\":\"c0681de1253177c8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/todo.js\":\"3a5a328c714dbbd9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/typeCandidates.js\":\"5f6064648bca4377\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/types.js\":\"dbd9bb6ff2b54add\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/search-health/index.js\":\"63b706d5010f830c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/search-health/store.js\":\"39ee8fc05e14d4be\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/HeaderItem.js\":\"d4f266d0966cacbf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e3d0119defdfbcd7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/index.js\":\"09d5ef03be20963d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/model.js\":\"54c0d9830253f9c4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/toggleStore.js\":\"9928b5f57bda4538\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/useKeyInspector.js\":\"9fd633c4ad5ceff7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"87290822b2a71458\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/ShellDecorator.js\":\"62257176e862d1b8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/actions.js\":\"e27fafd7d4ca70ed\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/exclusionsFacet.js\":\"815dcad01552d96d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/index.js\":\"d24993c4dd17b2e0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/shell.js\":\"575b83d979eb6359\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/surface.js\":\"a76aded696b02541\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/walker.js\":\"756122d9a4a122c9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/RescheduleToast.js\":\"59f52e73276a8d07\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/dataExtension.js\":\"ff7ff15d9a96bc1d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/index.js\":\"1ffe608e1886fa37\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/indicator.js\":\"b97aeab1247e2dfe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/moveSrsState.js\":\"e176b82ffa189a0c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f9b26294ca12b0a1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/scheduler.js\":\"c4f458165128e221\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/schema.js\":\"01a73ef0e004d23b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"1352337bdd37118d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/srsClipboard.js\":\"3f058b3ef8b0d018\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a49b74bb10c27b0c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f5f60c18dfab6e13\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/DeckPicker.js\":\"498d8903de1538c5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/ReviewControls.js\":\"782d23c63f07b768\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/ReviewDeckRenderer.js\":\"34e73063357a89f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/ReviewSession.js\":\"e33df64df50e4cde\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/actions.js\":\"d8e6d0aa3e072202\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/archive.js\":\"22667161dfa89caa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/dataExtension.js\":\"f2d8dca9f5281f58\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/deck.js\":\"3c98decda18374f8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/dueQuery.js\":\"7fbe5e386f131d03\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/gradeDecision.js\":\"3b7aaa169ae9eb65\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/index.js\":\"b0f800026932c27b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/keyHints.js\":\"093dc14a0c875889\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/reviewCardLayout.js\":\"52df305c677cbfe3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/reviewProgress.js\":\"cd34d1fe7f730edd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/schema.js\":\"c3e645e66b1a2167\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/useDueCards.js\":\"c01682759e9c5524\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/startup-metrics/index.js\":\"c36c811e3004a06d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/startup-metrics/record.js\":\"43083552566ec45a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/storage-persistence/index.js\":\"151a9b45113ba1bd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/storage-persistence/persistenceStatus.js\":\"818e47c7200398dd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/storage-persistence/requestAction.js\":\"f5054ac1402071fe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/TypeChipsDecorator.js\":\"a94099cb24cc876e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/codeMirrorExtensions.js\":\"f28b951af33b257c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/index.js\":\"288796858434fd5b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/typeAutocomplete.js\":\"498479b9e95e1866\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"a907610af924af16\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/actions.js\":\"85d0ae0ac3a6b2d9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/anchor.js\":\"0e0b2ae8529568e1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/events.js\":\"11d7433bf9632cad\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/gestureActions.js\":\"c2e1cbc31e72469b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/index.js\":\"e1759cd22acf8003\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"df71a1fecad5fc1c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/sync-metrics/collect.js\":\"4eeea02a688a621b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/sync-metrics/index.js\":\"7de7b5a0e93815cb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/sync-metrics/record.js\":\"1693a22ffb21d489\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/RejectionDialog.js\":\"8a5d1599e4735f89\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/SystemStatusHeaderItem.js\":\"3948e6a7bca985fb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/index.js\":\"2996945ad07388bd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/model.js\":\"b27e9bbccdd36920\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/queueCounts.js\":\"b2a03094c7e3678a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/rejectedHelpers.js\":\"4e7b59d197115d6e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/rematerializeAction.js\":\"0a4127d776ac3728\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/useHysteresis.js\":\"5b279546d1f5f99e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/ColumnHeaders.js\":\"e09cabe1493f5829\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/QueryUi.js\":\"e587cc2348981a4b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/TableLayout.js\":\"0c2ed5d0260e822e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/actions.js\":\"b58566312d447909\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/cellEdits.js\":\"3d59c6dfc8a962fc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/childrenViews.js\":\"ece7e87351b0ebed\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/columns.js\":\"88c16e0aec25679e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/controller.js\":\"1334e87f086b2f89\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/convert.js\":\"e54a076ac1d01c6d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/dataExtension.js\":\"2fc7f1614cd8d0f0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/index.js\":\"be3354a9466e90d0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/keys.js\":\"3ab997e11bb761c3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/model.js\":\"2dab4c32053e914c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/QueryText.js\":\"d46667504d24d107\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/backfill.js\":\"cf26aea885fde11c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/completion.js\":\"bbac5b54fa18cf93\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/format.js\":\"868a9b22d37d1958\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/parse.js\":\"628e6b062fba9597\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/queryValue.js\":\"d911938f04094521\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/registrations.js\":\"ff13bd9c135e929a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/source.js\":\"742dda15703bd10d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/registry.js\":\"173fff4125ba0b69\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/rowGutter.js\":\"5ed8ddcd64bbeb09\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/rowVerbs.js\":\"47e0f5bb4dec1265\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/schema.js\":\"6e991dd523fa8865\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/sort.js\":\"f639cc320535b443\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/theme-toggle/effect.js\":\"ef9ddd0fcda869b1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/theme-toggle/index.js\":\"bc098f5ef4d0a152\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/theme-toggle/theme.js\":\"d5849e5a5e28b5f1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/actions.js\":\"93ee9df37320301c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/dataExtension.js\":\"3d180b28132d8ece\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/index.js\":\"b0480a137152f7c9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/schema.js\":\"8289d5364592503c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4146a6717c5d6f9d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/actions.js\":\"7539cd1df5925719\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/defaultItems.js\":\"f4f56ce6081ec5ef\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/facet.js\":\"11adf8156366dc6f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/holdRecognizer.js\":\"55f12bd2f6245148\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/index.js\":\"49e5de52ae6de3ba\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/update-indicator/UpdateIndicator.js\":\"91afa3d60df47fa5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/update-indicator/index.js\":\"c018ce8d95640918\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/update-indicator/loadTimes.js\":\"80f02c589f8424e9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/VideoNotesRenderer.js\":\"270c25149f3bc59d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/VideoPlayerRenderer.js\":\"d309c03bc85d8034\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/VideoTimeStamp.js\":\"621fdefba029a9ba\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/actions.js\":\"55e0a8faf5ee42be\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/index.js\":\"15b3425038a2bb2d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/markdown.js\":\"46ab573446a3abbe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/notes.js\":\"6d943987cd102e70\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/registry.js\":\"41e75245b11b64cd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/remark-timestamps.js\":\"ecc0b2f631932476\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/view.js\":\"59509419ac104798\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/LinkHints.js\":\"7fc8f6aa2da76fa7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/index.js\":\"76deecddcbc0dbf6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/model.js\":\"3d3ca5a2fb979ef3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/settings.js\":\"8294a4dc9b80c0a4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-normal-mode/actions.js\":\"1ee10da054bf62cf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-normal-mode/index.js\":\"d098e7f719a38614\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-normal-mode/interactions.js\":\"c8f0695e8cca5afd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/workspace-header/index.js\":\"ffc3f9de3c485693\",\"/knowledge-medium/pr-preview/pr-1906/src/registerServiceWorker.js\":\"7c4b4f18c9c9dea9\",\"/knowledge-medium/pr-preview/pr-1906/src/requestPersistentStorage.js\":\"b42553ad50fff6f0\",\"/knowledge-medium/pr-preview/pr-1906/src/services/authRequestDeadline.js\":\"49346933f24bfcca\",\"/knowledge-medium/pr-preview/pr-1906/src/services/authStorage.js\":\"d38f307a1aeb9360\",\"/knowledge-medium/pr-preview/pr-1906/src/services/powersync.js\":\"54cf33a9ded5f260\",\"/knowledge-medium/pr-preview/pr-1906/src/services/supabase.js\":\"363327dcbf29189f\",\"/knowledge-medium/pr-preview/pr-1906/src/services/uploadErrorClassifier.js\":\"c6a7b87b200e0811\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/ActiveContexts.js\":\"1d052aec6cda1425\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/HotkeyReconciler.js\":\"58f7908fbdc83020\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/WipeLocalDataDialog.js\":\"6fd49f47af975f08\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/actionDispatch.js\":\"a3092cc4aa2cdc48\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/actionRefItems.js\":\"279827215f0a7900\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/applyKeybindingOverrides.js\":\"fc694a7653e36534\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/blockActions.js\":\"a1dba4c5763955bb\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/blockMergeGesture.js\":\"27905a3afa22b4b1\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/canonicalizeChord.js\":\"c0b1d65667ec4fbe\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/defaultContexts.js\":\"9dacd9290ee5e347\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/defaultShortcuts.js\":\"c7a29fa620c91ab1\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/effectiveActions.js\":\"0095682893c8a60f\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/gestureAction.js\":\"c61707404ae7df49\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/gestureBinding.js\":\"67bd19a6b998fe91\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/holdRegistry.js\":\"ccd33c9347a85763\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/keybindingConflicts.js\":\"5a3269ae0bc75b6a\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/keybindingOverrides.js\":\"0d919dc6ea98e924\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/pointerAction.js\":\"c6e72213f77b6a40\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/resolve.js\":\"2e56ae01ed78fa20\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/runAction.js\":\"8051951c18513644\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/sequenceMatcher.js\":\"d3638ef191044b4d\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/types.js\":\"9aed3d159177acda\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/useActionContext.js\":\"6d975a597005b578\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/useActionDiscovery.js\":\"ed42ba00ad2d5771\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/utils.js\":\"b5e391ddcd52c22e\",\"/knowledge-medium/pr-preview/pr-1906/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1906/src/sw/bootStore.js\":\"6ef265c194f4cf9d\",\"/knowledge-medium/pr-preview/pr-1906/src/sw/previewDatabases.js\":\"5ef033bb1c52e3ce\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/byteTransform.js\":\"87f62fad1686ad3c\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/attachmentCleaner.js\":\"4032a9308d803266\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/attachmentParts.js\":\"8d95036b881a68a1\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/bundleParts.js\":\"ebe8e30e4b0acbc9\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/bundleRecord.js\":\"ff6c0b471f1c367c\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/manifest.js\":\"dd2d1196dfe63949\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/takeBundle.js\":\"57a189a0462d48a8\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/verifyBundle.js\":\"facd694d8110b27b\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/cleaningStage.js\":\"62ab5cfd19aa54e1\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/conversionKey.js\":\"5b0b56819dbf89af\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/conversionServer.js\":\"59364d4f74462fe0\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/flip.js\":\"7c0ddc14a123b8a9\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/flipAttempts.js\":\"fab0d04e4a42c608\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/pages.js\":\"17555811bfce75ab\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/preflight.js\":\"497a7b958bd2553b\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/reseal.js\":\"5f24fac049844cd6\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/runConversion.js\":\"79b59b41b0d9a413\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/runLock.js\":\"b237a608f1edbd62\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/sealing.js\":\"32fc5017e7793e36\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/sealingStage.js\":\"e780acc7e770bce6\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/stage.js\":\"5df2d486a4fd27fa\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/verifyReseal.js\":\"7ad6bf3ac129a1d7\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/aad.js\":\"f5de32b1737318c7\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/aead.js\":\"78aa7122c1036ae4\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/base32.js\":\"94c33dc0d1b101aa\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/base64url.js\":\"35922a8f4c159a3c\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/binaryEnvelope.js\":\"28cc3ea1f65cf4a4\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/byteAead.js\":\"d56d93e0288850a0\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/canary.js\":\"d859af13c9688a08\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/contentHash.js\":\"07ca8ff84f73111f\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/contentKey.js\":\"e5c6afe3f8fc74de\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/derivedIdNamespace.js\":\"07b92f6eea9f6f5f\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/envelope.js\":\"0561d8a5cafd8384\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/hex.js\":\"36de13717fd9d0f4\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/sha256Hex.js\":\"245907fe14cc7c1e\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/workspaceKey.js\":\"9596431fd7da602b\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/conversionState.js\":\"5ed881ba4ce03252\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b548f63422cb78a9\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/pastedKey.js\":\"c110f57c7f3f13bf\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"fae0cd0ce42d9d63\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/upgradeWorkspacePin.js\":\"3d6b7831c7a310f3\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/keyStore.js\":\"f851d4dcf99b5f14\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/mintWorkspaceKey.js\":\"da63c0a90913abb6\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/modePin.js\":\"16322efc591e96fd\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/openWorkspaceKeys.js\":\"633ac7265a80e73a\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/resolveWorkspaceEntry.js\":\"bd74f034b65ca771\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/resolver.js\":\"09bc4a0d96c2f2bf\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/workspaceAccess.js\":\"a112e4e97abb5d6b\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/transform.js\":\"49971c39694e5788\",\"/knowledge-medium/pr-preview/pr-1906/src/themeBootDefaults.js\":\"8703a46c4d04f7d0\",\"/knowledge-medium/pr-preview/pr-1906/src/types.js\":\"90f12bc0ae7beece\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/ClientLocalSettings.js\":\"370b47317d079dc3\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/abortableSleep.js\":\"97f436eb65765757\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/array.js\":\"8c6787bd24b748ec\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/backlinkAutocomplete.js\":\"4d9b6cc2d36f7198\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/blockCrumbs.js\":\"bf71afd5b98f779f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/blockrefAutocomplete.js\":\"e4589d709cf73c96\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/cadencedIdleJob.js\":\"8a141bd432a299b8\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/callbackSet.js\":\"66bd3b2bbc78506e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/clientId.js\":\"d264f47e35c92f13\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/codemirror.js\":\"a30402e498293f3a\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/codemirrorCompletion.js\":\"4f299e24826d2fdb\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/copy.js\":\"6cd9fd9baddfda85\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dailyPage.js\":\"149da21e9046e1d0\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dbForensics.js\":\"5bd11c9af5a9f676\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dbForensicsHooks.js\":\"1639c9202736db7f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/deleteBlockThroughUi.js\":\"7e775d447048ab2f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dialogs.js\":\"cde296c382bf592e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dom.js\":\"ae26c812164c0b33\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/downloadBlob.js\":\"06ee43c278a34cba\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/drawnWalk.js\":\"2cd30520e27ef4fd\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/exportSqliteDb.js\":\"16ca675a2ab2b0ea\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/fileSystemAccess.js\":\"b3236d958bbc0310\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/flipSlide.js\":\"09c0bc66c8d34fce\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/fnv1a.js\":\"70c2617e6c6be01c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/formatBytes.js\":\"9813535c85163993\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/fuzzyRank.js\":\"18a60eb0de63b04e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/idbKeyedStore.js\":\"eb74f8ab931dbd5a\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/idleCallbackPolyfill.js\":\"91da6975abce40bd\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/keyboardAwareScroll.js\":\"4b7a1c101899a26b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/keyboardViewport.js\":\"7702f059610f1ce3\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/lastWorkspace.js\":\"7cd599434138653e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/layoutColumns.js\":\"1a33e2720100340b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/layoutSessionDom.js\":\"97bd45670cd63769\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/layoutSessionId.js\":\"43be01df7c9ba8df\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/linkClickGestures.js\":\"3473e7194d9228b5\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/linkTargetAutocomplete.js\":\"2a95341d95ee72c7\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/localDbCorruption.js\":\"c5e1be88e131ce46\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/localDbRecovery.js\":\"fdc8a842c114de7a\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/markdownParser.js\":\"5d176bc8f413c1a4\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/memoize.js\":\"c1f39a375a282272\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/nameFieldCommit.js\":\"41877a3dc55bcfb5\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/nameList.js\":\"37e8adfee0bd104d\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/navigation.js\":\"945348acc0b3fe58\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/omnilinerNamespace.js\":\"25bad0cd8ae560ce\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/opfsPageScan.js\":\"85e9325006608862\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelClearance.js\":\"adad052bff220045\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelHistory.js\":\"2573de9ece95a5ba\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelLanes.js\":\"fd62831f050d8a48\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelLayoutProjection.js\":\"25217f845508a46f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelScrollAnchor.js\":\"e3267d4578895c6c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelUrlFlags.js\":\"324cea249f8527de\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/platform.js\":\"95479dedac4d1e29\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/pluralize.js\":\"63a56fe296c5d4a0\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/propertyCreation.js\":\"45261cba1c40d88f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/propertyNavigation.js\":\"b5df52f9f721cc62\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/propertyValueContext.js\":\"a2c9adff577ec07b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/react.js\":\"5ab4fcf6af356793\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/relativeDate.js\":\"1b0507d469e62360\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/relativeTime.js\":\"a1c43f3781775ead\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/renderScope.js\":\"9384f6febb55733d\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/resolvedThenable.js\":\"50994a11ac785d2b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/routing.js\":\"c71faf04f1855f51\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/safeMode.js\":\"231b8dabbfaa9e7a\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/scheduleIdle.js\":\"ab0812ae2daaf7b4\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/screenWakeLock.js\":\"230f83f7b1c02ae8\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/selection.js\":\"d3699cefe23935e3\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/softKeyboardGrab.js\":\"c7040df06e286f62\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/startupTimeline.js\":\"0b4f6950faed585f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/state.js\":\"6af6360b251a890c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/string.js\":\"bca852b19ab16f76\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/surfaceZoom.js\":\"548e7b1f608501f2\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/time.js\":\"4c3ee9879568a86e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/toast.js\":\"74341197e09823fd\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/toggleStore.js\":\"e74995935208ae26\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/untilStopped.js\":\"ba0d2e19ff65ecf1\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/userActivity.js\":\"19b8f7e76d7a81ed\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/viewTransition.js\":\"98314fea95537be0\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/viewport.js\":\"456cfb548b295945\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/webLock.js\":\"e6f6449eb4ea6f83\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/workspaceRecovery.js\":\"b260c6168858dd9b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/workspaceSnapshotStore.js\":\"03d438c7ba22279a\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-compiler-runtime.js\":\"5235f8dad7ea73b0\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-client.js\":\"9da79f38b64cb3dc\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-server-edge.js\":\"4a10290da46f1466\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-server.js\":\"d6e0b25fd825c2c3\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-static-edge.js\":\"040a73d1926d3379\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-static.js\":\"b756481ca2e77890\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-test-utils.js\":\"504462fcd3d8ed2a\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom.js\":\"0596a51bd2e2df50\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-jsx-runtime.js\":\"fdbc7c49416037da\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react.js\":\"f0ed89683a1a4b82\",\"/knowledge-medium/pr-preview/pr-1906/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1906/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1906/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
