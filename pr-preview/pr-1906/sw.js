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
		buildId: "d20448114e56-50311217",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1906/\":\"cdaa21d0c43d7a8d\",\"/knowledge-medium/pr-preview/pr-1906/index.html\":\"cdaa21d0c43d7a8d\",\"/knowledge-medium/pr-preview/pr-1906/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1906/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1906/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1906/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1906/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1906/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1906/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1906/assets/FacadeVFS-BncZGyZ6.js\":\"6a0e7512719c1f53\",\"/knowledge-medium/pr-preview/pr-1906/assets/OPFSCoopSyncVFS-BFx_o-jv.js\":\"8c71cd3764c95feb\",\"/knowledge-medium/pr-preview/pr-1906/assets/OPFSWriteAheadVFS-BjXpYZPU.js\":\"a10fbbe89d5c2f7e\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-async-D9vBKqjQ.js\":\"94c2051c787d7af2\",\"/knowledge-medium/pr-preview/pr-1906/assets/wa-sqlite-iPGTibNX.js\":\"7855c137fba7e004\",\"/knowledge-medium/pr-preview/pr-1906/assets/worker-Bbvtp6s6.js\":\"ff4ca5ece7da078e\",\"/knowledge-medium/pr-preview/pr-1906/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1906/chunks/app-CP5UMC6w.js\":\"e7d0e1043cfe9547\",\"/knowledge-medium/pr-preview/pr-1906/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1906/index.js\":\"5dbd54e99d2c8f3f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1906/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1906/assets/AccessHandlePoolVFS-HKRyJFTR.js\":\"542e2a3eb6274500\",\"/knowledge-medium/pr-preview/pr-1906/assets/IDBBatchAtomicVFS-ppHmHEfG.js\":\"6abec8fde789f281\",\"/knowledge-medium/pr-preview/pr-1906/assets/MemoryVFS-l1lSP-oh.js\":\"9a52ec006d5e94b1\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-CedV45ih.js\":\"fef4b34c58a92fa3\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-async-B7Jvxs_W.js\":\"eeacadf5ff1bc771\",\"/knowledge-medium/pr-preview/pr-1906/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1906/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1906/chunks/AccessHandlePoolVFS-Cplth_sX.js\":\"8f6305dbbbbf856d\",\"/knowledge-medium/pr-preview/pr-1906/chunks/FacadeVFS-B4QD_rs7.js\":\"c9280db412117d36\",\"/knowledge-medium/pr-preview/pr-1906/chunks/IDBBatchAtomicVFS-DGG03vMT.js\":\"1e6b8b4bec7f9fb7\",\"/knowledge-medium/pr-preview/pr-1906/chunks/MemoryVFS-eT-aOWYK.js\":\"a0594c6abebeb5b1\",\"/knowledge-medium/pr-preview/pr-1906/chunks/OPFSCoopSyncVFS-D2ylvpdb.js\":\"86d9ecdb0a352131\",\"/knowledge-medium/pr-preview/pr-1906/chunks/OPFSWriteAheadVFS-C3TUxy2q.js\":\"8c61edeaca54862a\",\"/knowledge-medium/pr-preview/pr-1906/chunks/Preview-D5zRTFX3.js\":\"8ee59962870c33cf\",\"/knowledge-medium/pr-preview/pr-1906/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1906/chunks/card-0mw6rfR3.js\":\"71fa1763e06dc6d3\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1906/chunks/dist-CxsvqkxA.js\":\"6677f028766e7d62\",\"/knowledge-medium/pr-preview/pr-1906/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1906/chunks/mc-wa-sqlite-DbwrbJBh.js\":\"20e4d36f1f77d88b\",\"/knowledge-medium/pr-preview/pr-1906/chunks/mc-wa-sqlite-async-C7OIUbwk.js\":\"15a5437aca899096\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-BcPvHhIk.js\":\"fbbf03c0944dd002\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-C4SrTUCY.js\":\"d842dc442037debe\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-CbftN-9h.js\":\"6b4e353b2e6cdc84\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-DXgP5lRt.js\":\"c704e8fa59d4508d\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-DtFD128o.js\":\"b0e8af18d27fc8a5\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-IxIawCl9.js\":\"64aa6b6c3d1a233b\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-X3gZQ3Zu.js\":\"aeb10c15fd5fb829\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-dom-server-legacy.browser.production-BONuOya2.js\":\"aca032c39a53d810\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-dom-server.browser.production-CnbmnfcI.js\":\"272919a5af3f9d7d\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-dom-server.edge.production-BXU7-v__.js\":\"9f481eee874f5894\",\"/knowledge-medium/pr-preview/pr-1906/chunks/react-jqdyXjLn.js\":\"7d2552b533c25c69\",\"/knowledge-medium/pr-preview/pr-1906/chunks/server.browser-CLKsqieS.js\":\"221dcdba521c16c9\",\"/knowledge-medium/pr-preview/pr-1906/chunks/textarea-BeEt5dds.js\":\"72df451582cd2808\",\"/knowledge-medium/pr-preview/pr-1906/chunks/ui-D7al8W84.js\":\"756e3c2aa89a18b4\",\"/knowledge-medium/pr-preview/pr-1906/chunks/wa-sqlite-BLuoBMdD.js\":\"6af6c7011042ad2f\",\"/knowledge-medium/pr-preview/pr-1906/chunks/wa-sqlite-async-CQMV-Fb9.js\":\"48678bf19cb7a875\",\"/knowledge-medium/pr-preview/pr-1906/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1906/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1906/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1906/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1906/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1906/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1906/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1906/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1906/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1906/src/App.js\":\"9869a095f44de000\",\"/knowledge-medium/pr-preview/pr-1906/src/appUpdate.js\":\"c018c20a4dc59e8f\",\"/knowledge-medium/pr-preview/pr-1906/src/appVersion.js\":\"7f27a4bcc645a048\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/initialLayout.js\":\"d28f8ee32889d98f\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/openWorkspaceData.js\":\"48db82cb7a7feafe\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/resolveWorkspace.js\":\"d85d5160d43d459e\",\"/knowledge-medium/pr-preview/pr-1906/src/bootstrap/workspaceBootstrap.js\":\"a14e450b6f35ffdb\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockComponent.js\":\"cdcf4f6f445e85d9\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockCrumbs.js\":\"95f61e8c955853eb\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockEditor.js\":\"a5a35aeaccd688b9\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockLoadingPlaceholder.js\":\"699b093ea16facef\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockProperties.js\":\"875ac147f2f94049\",\"/knowledge-medium/pr-preview/pr-1906/src/components/BlockSearchPicker.js\":\"beb90aaf38680218\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ConfirmBulkDeleteDialog.js\":\"e9854c56ea8d286b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/DividerHandle.js\":\"e589e633a3b8c6cf\",\"/knowledge-medium/pr-preview/pr-1906/src/components/DraftEditor.js\":\"1ad4dbfb3afae485\",\"/knowledge-medium/pr-preview/pr-1906/src/components/GutterPill.js\":\"1904345220dd99af\",\"/knowledge-medium/pr-preview/pr-1906/src/components/Header.js\":\"cceb62dd902c6f71\",\"/knowledge-medium/pr-preview/pr-1906/src/components/LazyBlockComponent.js\":\"8e09435bfc18db14\",\"/knowledge-medium/pr-preview/pr-1906/src/components/Login.js\":\"9a026598bd4f1e28\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ZoomableSurface.js\":\"8585c2ecc4ce2e78\",\"/knowledge-medium/pr-preview/pr-1906/src/components/editModeKeepalive.js\":\"295065edf4cb19f8\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyDisplay/PropertyDisplayScope.js\":\"77e046b8fd3ec87c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d50ebedbe23dd9dd\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/RefPropertyEditor.js\":\"2579e0a355da1fa2\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/RefTargetTypePicker.js\":\"3a887845e199851f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/SelectPropertyEditor.js\":\"ff6df622cd3e9e26\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/TypesPropertyEditor.js\":\"5afe30e0a1644874\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/defaults.js\":\"abb0bc271b75ddd4\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/kernelValuePresets.js\":\"ce19e27ab64bfa58\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/selectablePresets.js\":\"60a2344635339f97\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyEditors/typesPropertyUi.js\":\"dad555e4708a8f19\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/AddPropertyForm.js\":\"8877c93b22e6f888\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/PropertyPicker.js\":\"042d75a50ec56d19\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/PropertyRow.js\":\"5da71023cb59d3d4\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/Rows.js\":\"46cd9484372dcd0f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/actions.js\":\"5cb387f2f1aee9bd\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/declarationOnly.js\":\"380440abfa7c32c6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/layout.js\":\"ae981e0e103d7bba\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/model.js\":\"a3fdbeddbd45829c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/shapeUi.js\":\"a6b2a805f588a4c6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/shapes.js\":\"7e9902c3f3f3f347\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/usePropertyEditingActivation.js\":\"fcd0aea11a187ea0\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanel/visibility.js\":\"3e38283d2d928d19\",\"/knowledge-medium/pr-preview/pr-1906/src/components/propertyPanelSections.js\":\"c2b1d96a4a8947f7\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/BlockEmbed.js\":\"1911a84b14258609\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/BlockLink.js\":\"246de1b615dc46dc\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/BlockRef.js\":\"132001d9f9ca49d5\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/CompactReferenceLink.js\":\"f3428def9e6a2589\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/ReferenceLink.js\":\"105cee7fa7bbbf1e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/cycleGuard.js\":\"910f0d61f7226391\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/cycleGuardContext.js\":\"cd317f58ee868230\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/linkInteraction.js\":\"481a43fd8743e4bf\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/referenceLayout.js\":\"9443ac74bc41a670\",\"/knowledge-medium/pr-preview/pr-1906/src/components/references/useBlockRefAncestors.js\":\"b3ae4249d9b884cf\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockGutter.js\":\"ac0bea202f1a564c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockInfoDialog.js\":\"d4e11af39f1ed159\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockReadText.js\":\"19945748b97a03a4\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BlockTypeBlockRenderer.js\":\"9925c28896853d33\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/BulletHoverCard.js\":\"2cae1d01e6d33160\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/CodeMirrorContentRenderer.js\":\"b6e3a8c531191d1b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"5878b3f2451dfad6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/ColumnResizeHandles.js\":\"fee293dac861aa67\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"21c32fd023dbf436\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/DefaultBlockRenderer.js\":\"98cd19812e154d0b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/LayoutRenderer.js\":\"d86d3b17650bb77b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/MarkdownContentRenderer.js\":\"9918f7be75b9014f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/MissingDataRenderer.js\":\"af682ea4e7c37ec8\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/PanelRenderer.js\":\"f3360e948510f73d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/PropertySchemaBlockRenderer.js\":\"47bae05da23b53a3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/TopLevelRenderer.js\":\"761aab59a4c35150\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/blockGutterMode.js\":\"cf2b34e6d206d981\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/blockTitleText.js\":\"1597ea1bb44761ed\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/fieldCreationKeydown.js\":\"3eb3e3f7a6b1fd2e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/renderer/layoutRootContext.js\":\"4a66d1f6949f9e75\",\"/knowledge-medium/pr-preview/pr-1906/src/components/typeChip/TypeChip.js\":\"3dfe7d349cbf5222\",\"/knowledge-medium/pr-preview/pr-1906/src/components/typeChip/chipStyle.js\":\"f43a8a3a841805aa\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/anchored-floating.js\":\"578b3882d436286a\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/button.js\":\"3687b66ade8389c2\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/card.js\":\"4d2b4a67009d6237\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/checkbox.js\":\"0b1b09720d856de6\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/collapsible.js\":\"74343ca78a954a07\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/command.js\":\"a8c3347b13baced3\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/context-menu.js\":\"31fe2f8e41dfb561\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/dialog.js\":\"5a11805c54919187\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/dropdown-menu.js\":\"c9f46b016216a9ce\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/floating-listbox.js\":\"2d18464f534f6d17\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/index.js\":\"414709453c6ce4c4\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/input.js\":\"b573171baa355cd8\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/kbd.js\":\"a99b9a09a97a3537\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/label.js\":\"b82fcc8301902d4d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/ui/textarea.js\":\"467f7b69411ad311\",\"/knowledge-medium/pr-preview/pr-1906/src/components/useEditModeYieldKeepalive.js\":\"2270a5cb63d74098\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/BootFallback.js\":\"d0ed1629a006cf04\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/FocusedRowLazyMount.js\":\"fb472a5a3fa86451\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/LazyViewportMount.js\":\"c314380eae61682d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/LocalDbCorruptionFallback.js\":\"8e4387d92f05dc9d\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/error.js\":\"bae93b85f29c19b9\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/lazyMountRegistry.js\":\"d4bc3763ae37a5b0\",\"/knowledge-medium/pr-preview/pr-1906/src/components/util/suspense.js\":\"ab753d2160cb8c21\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/CreateWorkspaceDialog.js\":\"9c252f0c889defec\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/PendingInvitations.js\":\"b7a60772097ec70e\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/SyncProgress.js\":\"1f7324f10870862c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/UnlockProgress.js\":\"269fe4820876c0be\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceKeyGate.js\":\"45e620d53db3296f\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceSettingsDialog.js\":\"5f8b77a3d81b11ea\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceSwitcher.js\":\"b0f6421ab23469ba\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/WorkspaceSyncGate.js\":\"205f5ec8ceaee7c0\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/ConversionFlow.js\":\"88684a48505445cc\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/ConversionFlowHost.js\":\"8a04e2475d3fa527\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/EncryptionSection.js\":\"3754f5889e23285b\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/attachmentPrompts.js\":\"c359261f12b9a9e9\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/bundleFolderPrompts.js\":\"18c7d452db135043\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/conversionFlowDeps.js\":\"ddf9aacaab4e19cd\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/conversionFlowStore.js\":\"751011dd872ae102\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/flowUi.js\":\"372d6d980314a69c\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/conversion/useConversionRun.js\":\"758771d8aeea2eab\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/keyUi.js\":\"5ae98e70e1962374\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/useCloseOnKeyLoss.js\":\"5c1514a33830a258\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/useCloseOnServerE2ee.js\":\"e220ff93321f2a5a\",\"/knowledge-medium/pr-preview/pr-1906/src/components/workspace/workspaceUnlocked.js\":\"a0a660ef81b338e8\",\"/knowledge-medium/pr-preview/pr-1906/src/context/backgroundSubtree.js\":\"ef5c8f71eace00f1\",\"/knowledge-medium/pr-preview/pr-1906/src/context/block.js\":\"354369c200707a3a\",\"/knowledge-medium/pr-preview/pr-1906/src/context/layoutWsContext.js\":\"f1c73339ae69b435\",\"/knowledge-medium/pr-preview/pr-1906/src/context/propertyDisplay.js\":\"9b0f5a0f94c83ff5\",\"/knowledge-medium/pr-preview/pr-1906/src/context/repo.js\":\"6bba06447e58805e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/aliasClaim.js\":\"8a35517e66edb4e2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/aliasSeatNamespace.js\":\"65732f4165a60c3d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/blockData.js\":\"5c8f448ed1e7c0c4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/blockType.js\":\"6f1448159bf2ba36\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/changeScope.js\":\"cf75666e024a16af\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/codecs.js\":\"fc7bd1990ba1db03\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/derivedData.js\":\"15d5d4ba8dca93fe\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/errors.js\":\"c8667482de8f86f0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/events.js\":\"f0c590def9bbe1fc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/handle.js\":\"00b3f6de4402232c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/index.js\":\"da57baa762986563\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/mutator.js\":\"27b0e5a91985fe12\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/processor.js\":\"6142ce93ef622b6b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/propertySchema.js\":\"a04c7f6d9abde0c7\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/query.js\":\"39a203d2c0df1ca0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/sameTxProcessor.js\":\"9c35177b1a24d7f2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/schema.js\":\"00b3f6de4402232c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/tx.js\":\"00b3f6de4402232c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/typedBlockQuery.js\":\"6097d4e634abcdae\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/user.js\":\"19ae7c4ca33d016e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/valuePresetCore.js\":\"4700c6173e7fa858\",\"/knowledge-medium/pr-preview/pr-1906/src/data/api/valuePresets.js\":\"ce10ca99fb4db21d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/attachmentCleanerIOVerb.js\":\"46f316d9ba244f3e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/block.js\":\"11654438f8ba1e9f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockCache.js\":\"b1b29adaf2751691\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockId.js\":\"199a865295804e9b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockLiveness.js\":\"44e3ce0ecec49dfc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockMerge.js\":\"01075ae8eeedcb20\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockSchema.js\":\"50b08f3acbadf59e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockTypeLookup.js\":\"b2e2aad254215942\",\"/knowledge-medium/pr-preview/pr-1906/src/data/blockTypes.js\":\"59e82831ced77ef4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/childrenView.js\":\"ffb24f3dca81661e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/clientContext.js\":\"90048a50fc24d180\",\"/knowledge-medium/pr-preview/pr-1906/src/data/dbFileSiblings.js\":\"9cee4f73c4540703\",\"/knowledge-medium/pr-preview/pr-1906/src/data/definitionSeeds.js\":\"066e417aa7dfd238\",\"/knowledge-medium/pr-preview/pr-1906/src/data/derivedIds.js\":\"b07256f3de8e8b85\",\"/knowledge-medium/pr-preview/pr-1906/src/data/drawnSubtree.js\":\"853cf88e3d8f2086\",\"/knowledge-medium/pr-preview/pr-1906/src/data/facetBridge.js\":\"df578ba98b9be88f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/facets.js\":\"399989c222412933\",\"/knowledge-medium/pr-preview/pr-1906/src/data/globalState.js\":\"d2f4bcabbbcd622f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/aliasClaimRederiveProcessor.js\":\"a20d593f4a2156a0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/ancestorBatch.js\":\"489df8fa9b31dc6b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/blockTypeTypeifyProcessor.js\":\"b3e24c096c6b1252\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/clientSchema.js\":\"350b5c771dd18b58\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/commitPipeline.js\":\"1031f1d70189f52f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/devAssertions.js\":\"cd43f68e36ffe6d6\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/firstSync.js\":\"b6442fd79352cfcc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/freshInitialLoad.js\":\"6a893a72f885c86c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/graphBackfillClaim.js\":\"67cdb7597c6b4ec0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/handleStore.js\":\"96de202100a436b3\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/idleMarkerJobs.js\":\"69dc049fa807992f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/initialDownload.js\":\"3716f95fe0a12a70\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/initializeClientDatabase.js\":\"64a64b6b065872d5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/jsonCanonical.js\":\"d4ccb177bf4354ba\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/kernelInvalidation.js\":\"cf913ea83406f5e3\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/kernelProcessors.js\":\"ecb5e98b938c2ad0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/kernelQueries.js\":\"374f8bb4426364ee\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/mergeTypeMembershipProcessor.js\":\"a85c534b3bd6e860\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/normalizeReferencesProcessor.js\":\"f3b96acb8e380474\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/poolInstrumentation.js\":\"37fcb452e2ea9cff\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/processorRunner.js\":\"5a6f2d9bb34fc47a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyCellBackfill.js\":\"590a2c995f2f5564\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyChildMint.js\":\"9245cc7e2d0f063a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyChildrenProcessor.js\":\"027af81a0bb78d8b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyDefinitionChangeProcessor.js\":\"212af57c355be0c7\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyDefinitionSynthesis.js\":\"c3fb848da173f58a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyKeyScan.js\":\"7f8aa9510a50b9e5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertySchemaResolution.js\":\"ea5071e69ae10af0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/propertyValueEdits.js\":\"43e1e2cc5b304fe6\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/raiseProtocol.js\":\"c0aa22a97b4016e0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/readBatch.js\":\"8d1ad05bd4459541\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/refProjection.js\":\"0fe005e14403b849\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/referenceTargetLookups.js\":\"c0f2faf82319d618\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/referenceTargetProcessor.js\":\"1533c62b9aad2274\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/replayMerge.js\":\"9a2621ec7e7c811b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/sqlBinds.js\":\"2607886249764296\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"af5d4453ce8351e2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/arrivalProcessors.js\":\"5e25964de5bd680f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/invalidate.js\":\"961517d7d1fa45bc\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/materialize.js\":\"5e68d7ccc9dcec2e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/observer.js\":\"da77ab656dacc49b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/syncObserver/reconcile.js\":\"4ad46cc0967b921a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/timingMetrics.js\":\"c12a709fb44eb352\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/treeQueries.js\":\"3cc1786e9839d8d7\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/txEngine.js\":\"d0abbde5fc2831a0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/txSnapshots.js\":\"a04001209dc40469\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/typedBlockQuery.js\":\"3be033430bf67bd0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/internals/undoManager.js\":\"ee673a898b0c8eea\",\"/knowledge-medium/pr-preview/pr-1906/src/data/invalidation.js\":\"e05ed045dfa5f6c2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/kernelDataExtension.js\":\"4b13618d765a0e76\",\"/knowledge-medium/pr-preview/pr-1906/src/data/kernelPage.js\":\"70b3672f58cbffaa\",\"/knowledge-medium/pr-preview/pr-1906/src/data/kernelValuePresetCores.js\":\"6c34cb6d023e0fa1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localDbCorruptionSignal.js\":\"b8ee6825564db125\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localDbStorage.js\":\"9341a5197e472a3d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localDbVfs.js\":\"e3f2257ef150949a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/localSchema.js\":\"03f8ca38db187dae\",\"/knowledge-medium/pr-preview/pr-1906/src/data/maintenance.js\":\"71366d2bbd5e793e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/mergeProperties.js\":\"67a006cded367827\",\"/knowledge-medium/pr-preview/pr-1906/src/data/metricsConsoleHook.js\":\"d15f3199e8276125\",\"/knowledge-medium/pr-preview/pr-1906/src/data/migrationsPage.js\":\"9518a24b8aa7535f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/mutators.js\":\"832490dd94c14643\",\"/knowledge-medium/pr-preview/pr-1906/src/data/orderKey.js\":\"c7ac6dc453dbdc6f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/orderKeyPlacement.js\":\"aa7a7e17b719f52f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/outlineSurface.js\":\"9bc1c701808844a3\",\"/knowledge-medium/pr-preview/pr-1906/src/data/pendingEditorContent.js\":\"0086aabe7f138cf4\",\"/knowledge-medium/pr-preview/pr-1906/src/data/pendingUploadsSql.js\":\"4ba18054962c89e6\",\"/knowledge-medium/pr-preview/pr-1906/src/data/pluginStateExtensions.js\":\"b5065a85915e613d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/powerSyncLogger.js\":\"d5e68216755fed3d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/projectorRuntime.js\":\"8ef2bb0033910bb8\",\"/knowledge-medium/pr-preview/pr-1906/src/data/properties.js\":\"927eec74256ce306\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertiesPage.js\":\"9d2d0e14062ca1d5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyChildren.js\":\"320fedf211d50f9a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDefinitionFanout.js\":\"c940eb6be4477c94\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDefinitionMetadata.js\":\"9b8bd4f5f729f1de\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDefinitionRegistry.js\":\"bbcf806ca449d516\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyDisplayMode.js\":\"4c72a3b494ba3275\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertyRowCreation.js\":\"b9e1be3cf19ad6ee\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertySchemaCreation.js\":\"46ef7273c0edeae5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/propertySeeds.js\":\"3e740ceab688cbe7\",\"/knowledge-medium/pr-preview/pr-1906/src/data/recentsPage.js\":\"eb6316a1bcadcb50\",\"/knowledge-medium/pr-preview/pr-1906/src/data/refTargetComparableProperty.js\":\"e56fa3c74af2df4f\",\"/knowledge-medium/pr-preview/pr-1906/src/data/referenceBlock.js\":\"e0894186bae4c58d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/rejectedUploads.js\":\"be14e763d8dccaa0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/releasePowerSyncConnection.js\":\"1455c5fec497d682\",\"/knowledge-medium/pr-preview/pr-1906/src/data/repo.js\":\"23ce80d51ae49569\",\"/knowledge-medium/pr-preview/pr-1906/src/data/repoProvider.js\":\"1014c38d335eb173\",\"/knowledge-medium/pr-preview/pr-1906/src/data/rowProperty.js\":\"6c6e1bf42f22506c\",\"/knowledge-medium/pr-preview/pr-1906/src/data/searchFilter.js\":\"25b4a9683c079f39\",\"/knowledge-medium/pr-preview/pr-1906/src/data/seedIdentityLedger.js\":\"835b245a7290c1f0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/stateBlocks.js\":\"fd9ce0e69f8453d1\",\"/knowledge-medium/pr-preview/pr-1906/src/data/structuralEditPolicy.js\":\"216d7a7a7b4c9d17\",\"/knowledge-medium/pr-preview/pr-1906/src/data/structuralInsert.js\":\"5bac03870b686514\",\"/knowledge-medium/pr-preview/pr-1906/src/data/subtreeDelete.js\":\"775a8194f7ae5cea\",\"/knowledge-medium/pr-preview/pr-1906/src/data/syncStreamLock.js\":\"5967d4335c16f5a2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/syncedTableSqlRecognizer.js\":\"dd74c54f25d2edc5\",\"/knowledge-medium/pr-preview/pr-1906/src/data/syncedTableWriteGuard.js\":\"e750752baece8d19\",\"/knowledge-medium/pr-preview/pr-1906/src/data/targets.js\":\"40fc01184946c1eb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeColors.js\":\"c4e0654cfe121ec2\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeDefinitionMetadata.js\":\"e87d3b6f69ce52ef\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeDefinitionRegistry.js\":\"b9bd41cf0d81a8c9\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeExtraction.js\":\"bf3d97d2d79a38d8\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeInitialValues.js\":\"1fe6e7bc15468528\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typePropertyGroups.js\":\"d33e331807000feb\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeSeeds.js\":\"6d8f5adcfe4558c0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typeTagger.js\":\"b0ea4d7dc33d64d0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typedRecords.js\":\"f049b0d3b1553e9b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/typesPage.js\":\"0d4ed6bb775aa76e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/userPrefs.js\":\"6f1ef2d7292915dd\",\"/knowledge-medium/pr-preview/pr-1906/src/data/userSchemasService.js\":\"fe5459dda533e28d\",\"/knowledge-medium/pr-preview/pr-1906/src/data/userTypesService.js\":\"265992b17be2c82a\",\"/knowledge-medium/pr-preview/pr-1906/src/data/valuePresetRegistry.js\":\"6c79bb17c2bff250\",\"/knowledge-medium/pr-preview/pr-1906/src/data/visibleChildren.js\":\"5393d5a3d714d2ef\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceConversion.js\":\"a14dbd123317b23e\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceFirstSync.js\":\"4a751cccde3e6739\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceIdNamespace.js\":\"ede493e84f0c6177\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaceSchema.js\":\"3bc404d8101d8bf0\",\"/knowledge-medium/pr-preview/pr-1906/src/data/workspaces.js\":\"69e07b9e596bad9b\",\"/knowledge-medium/pr-preview/pr-1906/src/data/writeAheadLog.js\":\"968ff37de16f4b09\",\"/knowledge-medium/pr-preview/pr-1906/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/BlockPasteShellDecorator.js\":\"70361d5343323f8a\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/atTrigger.js\":\"76449cf4e5118347\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/autocomplete.js\":\"edd792db7d0cb8c6\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/codeMirrorExtensions.js\":\"397199eb9b1adf77\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/contentFlush.js\":\"0ed947fb351ab4f5\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/defaultInteractions.js\":\"8ed7e81cdeabdf05\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/editSettleSignal.js\":\"b6d3fdfd8183f293\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/insertImage.js\":\"c0fce9eb3246760e\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/referenceCompletionRange.js\":\"95c500d8c9d17f71\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/referenceTargetTypes.js\":\"039f08445375c999\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/syntaxContext.js\":\"0b4b770cc347d156\",\"/knowledge-medium/pr-preview/pr-1906/src/editor/triggerMatch.js\":\"e38fdd10c4eb8a0e\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/AppRuntimeProvider.js\":\"feb8fb7b10598b0b\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/BlockFocusShellDecorator.js\":\"496fe512013a39dc\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/ExtensionRenderBoundary.js\":\"b9e6a9384b0e2ff0\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/PanelContentRecovery.js\":\"b2e6ad971c4db243\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/apiCatalog.js\":\"750672a3f0601706\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/approveExtensionHere.js\":\"4594d23e5a2c13ba\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/armedCutAppMount.js\":\"23d996ec372c1f78\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/batchableKeyedStore.js\":\"82a74fec2462e6ff\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/blockInteraction.js\":\"4cd9f3d328379322\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/blockSelectionAction.js\":\"53f4450514862597\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/compileExtensionModule.js\":\"d0e0cddb4a17b67b\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/compiledModuleCache.js\":\"47b31be974d01c61\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/continuousGestures.js\":\"8dbf462a6a27f6f7\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/core.js\":\"c2821bba382a9990\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/defaultRenderers.js\":\"6a0a6be0ee4c9103\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/definitionFanoutAppMount.js\":\"437cdcc93aa160fd\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/dialogAppMount.js\":\"95111ce4e4134775\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/dynamicExtensionSeeds.js\":\"230e0037f82a2115\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/dynamicExtensions.js\":\"6427b4a86c1f8be9\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/exampleExtensions.js\":\"7e3448544395d8c5\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionApprovalStatus.js\":\"a7db586b0f029534\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionLoadErrorToast.js\":\"df06e7f9e4462d65\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionLoadErrors.js\":\"4ca676a0736725da\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionLookup.js\":\"50d5149b026b0173\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionToggles.js\":\"9a33c93550ce79fa\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/extensionUtilitiesCss.js\":\"ea7451438671f622\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/kernelPageDeletionGuard.js\":\"f8cf012c2374e36c\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/liveRuntime.js\":\"6edb506037fd2a41\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/openExtensionsSettings.js\":\"c2a7cabcfc41923c\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/overridesCache.js\":\"397b7a94bdc1ef79\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/pluginIds.js\":\"9f57b946657bef5b\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/processorRejectionToast.js\":\"517e6b5771a72cea\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/runtimeActions.js\":\"87084b57e19ea9c3\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/runtimeContext.js\":\"f837f0643736b248\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/staticAppExtensions.js\":\"0a5da78492bb1199\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/staticDataExtensions.js\":\"c1b7dc0a5f89da88\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/toastAppMount.js\":\"9dce17442fe39016\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/useOverrides.js\":\"a8523593c6a8c95a\",\"/knowledge-medium/pr-preview/pr-1906/src/extensions/useShortcutSurfaceActivations.js\":\"f89f290ccdc85772\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/discoverToggleTree.js\":\"dee5b26576acde79\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/facet.js\":\"4e134ffe8298dd67\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/resolveAppRuntime.js\":\"e33be88253926415\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/runtimeEvents.js\":\"3576a97f09e4970f\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/togglable.js\":\"111cd16808948760\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/variantFacet.js\":\"c5f5a86a92db0945\",\"/knowledge-medium/pr-preview/pr-1906/src/facets/verbFacet.js\":\"81c7ab1595489e6f\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/block.js\":\"eba3e14357f7dc5a\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/focusedChild.js\":\"097c285632d12345\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/propertySchemas.js\":\"8d32bef648e8842c\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/typeRegistry.js\":\"adf805bee4f3c2a2\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useAncestorCrumbs.js\":\"9848bdf7b2d86e89\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useAutocompleteListbox.js\":\"ea35534181cbce35\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useDebouncedSearch.js\":\"c7630cf34e35ec81\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useDebouncedValue.js\":\"9752fee91aa1cf41\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useFacetValue.js\":\"30e42d85fc21b667\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useIsFocalRender.js\":\"65b143bb42b58a79\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useIsReadOnly.js\":\"63cf73a9e6cb5bf4\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useMaterializeBacklog.js\":\"2161adda793b7915\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useMinuteClock.js\":\"5f86b01050fbe135\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/usePanelLayoutProjection.js\":\"79cfc4e1f66d72e6\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/usePendingInvitations.js\":\"689ed9ced365cdd8\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useRendererRegistry.js\":\"d8a5100f52a81ea2\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useRetainedFieldRows.js\":\"bae421e704e111f1\",\"/knowledge-medium/pr-preview/pr-1906/src/hooks/useWorkspaces.js\":\"91610cdb2a747976\",\"/knowledge-medium/pr-preview/pr-1906/src/lib/utils.js\":\"b0a4de46942c1fd0\",\"/knowledge-medium/pr-preview/pr-1906/src/main.js\":\"4205ac999eda0f78\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/MarkdownImage.js\":\"b50423a8017f0fee\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/blockSeparators.js\":\"1ed2a23b9884f204\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/context.js\":\"dca38df9bc2155a2\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/defaultMarkdownExtension.js\":\"2ca7b03c952738c4\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/extensions.js\":\"b9c4545e50964a18\",\"/knowledge-medium/pr-preview/pr-1906/src/markdown/renderMarkdownHtml.js\":\"48cc4fa60d4a2f67\",\"/knowledge-medium/pr-preview/pr-1906/src/minimal-editor.js\":\"65cd6538553a7d80\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/armedCut.js\":\"ad3aa8bec26bc3b7\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/captureMediaVerb.js\":\"b2e506303f1db9ce\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/clipboard.js\":\"eac2a019eb30840f\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/decision.js\":\"3f0afcf1472be3a5\",\"/knowledge-medium/pr-preview/pr-1906/src/paste/operations.js\":\"b6a547442086af67\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/account-header/AccountHeaderItem.js\":\"75a42012bd89ea65\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/account-header/index.js\":\"9cfd1aea6aa234ac\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"06d41e25135805ee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/askAgent.js\":\"f51986cfe82ba466\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/askedStore.js\":\"2b6c9783a4100332\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"c1bc04c1206b7fc6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/chipState.js\":\"d8855534368cff1b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2b74d72feabb4056\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/index.js\":\"352c24f064997269\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c42a9ab35a1f6313\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-dispatch-companion/schema.js\":\"c86e0ec1ecf61f1c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/AgentTokensDialog.js\":\"51f51265904e63cf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b8d3c4a5817ee69d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/addMedia.js\":\"11a02d4eb47ab35f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e24812d22bdea178\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/block.js\":\"0faf8e705254d557\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/context.js\":\"d8bac8e52e6cb3af\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7c1c6b32aa9384cc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/index.js\":\"39801df8e293d5f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/outline.js\":\"974455f7a6080254\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/properties.js\":\"795808f9be698ff2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/refs.js\":\"5852965d59c5a56e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"dda0e639a92641a2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/search.js\":\"6df386218d74f6f7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/shared.js\":\"999f618059eb5890\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a7adee0c28537f37\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentViews/text.js\":\"3310c31ff25acf8a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/agentWrites.js\":\"c37cba82b0cf38e2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/authoringCatalog.js\":\"43a6263d68b3c045\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/blockRefTargets.js\":\"91af2a562a4f1931\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/bridge.js\":\"3aefd879893195c3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/bridgeLoop.js\":\"c83648426eb2e4b0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/changeHistory.js\":\"d299a06a43295186\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/commands.js\":\"c825a980be1a5f40\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/commentsCommands.js\":\"69597c94a7768c8a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/dataExtension.js\":\"25f40de914ac5976\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/dataModelGuide.js\":\"8a7742f564927028\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/dayPropertyInputs.js\":\"7b6e6dfdb06fd678\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/describeRuntime.js\":\"5746de4b8ef1eef8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/extensionLint.js\":\"0e93d3567123a074\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/grainAudit.js\":\"ba50a959710842b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/healthCommand.js\":\"c913ee4804857d24\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/index.js\":\"1b04d51edadcb224\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/presetIdentity.js\":\"4008a670223a457d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0a3a503f631abeb2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/readMedia.js\":\"2fc977002315f188\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/schema.js\":\"d7d4a4176c164c9a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/serialization.js\":\"61cf3e4ba92ae148\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/targets.js\":\"74400e3a2225dab0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/tokens.js\":\"f49cedb7b4627bc4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/watchEvents.js\":\"5a217c9889fbb517\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/workspaceGuard.js\":\"c2242e30e9fffae0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/agent-runtime/writeCommands.js\":\"ecd3b5529620334c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/AliasCollisionToast.js\":\"01c0084730ef84e7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/DuplicateNameBanner.js\":\"473fa25c67652110\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/collisionMerge.js\":\"f638a90acc955d01\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/dataExtension.js\":\"42da4ff19b417eab\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/index.js\":\"ba2c9ee96875e611\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/mergeCollisionAction.js\":\"a288008750c7ab54\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/pageStyling.js\":\"e49c0de247a3220a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/rejectionToast.js\":\"48cda0c98545cac7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/alias/syncProcessor.js\":\"138967432878a549\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/actions.js\":\"4d17cb8fb13e4447\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/addComment.js\":\"c7346128a959a8f4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/anchor.js\":\"3695e8189af1b6af\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/anchorState.js\":\"b2d7afdcfb0bf95f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/commentLinks.js\":\"21f38746e96d1923\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/confirmThreadDeletion.js\":\"ae7d7eaf2e60b81b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/container.js\":\"dce701f35d76f8a2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/dataExtension.js\":\"75d8d44a876fa8c0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/deleteComment.js\":\"0e649b6380edea75\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/highlights.js\":\"6bc701bf285afe13\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/index.js\":\"57eaa4ddb25e35ed\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/linkedCommentsPill.js\":\"5632fb8cf4d611b1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/margin.js\":\"b6d486f2a0241274\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/marginAnchorLinks.js\":\"311457947edd585b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/marginSchema.js\":\"f7295e1191b69f32\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/newComment.js\":\"656e1fca7d3fe0e8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/ownThreadPicker.js\":\"10ac01d016a0494d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/placement.js\":\"a97fd72758c0f7bc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/queries.js\":\"3295157fc36c50f6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/quotePosition.js\":\"e48006746469b4e2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/quotedIn.js\":\"271e855e9a0ebc64\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/quotedRange.js\":\"b110a50769ffc983\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/rangeRefs.js\":\"fdb58285d9467658\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/readHighlights.js\":\"ec2b58e0b5635bca\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/readSelection.js\":\"e4b6e34a5e1826fb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/readSelectionUi.js\":\"f1ac159723a90051\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/reanchor.js\":\"05470a9f0b1fccca\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/schema.js\":\"3773878f28fca256\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/scope.js\":\"2bfaf426e5aac774\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/scopeThreads.js\":\"0db846722ecc7a87\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/splitRetarget.js\":\"da725da1dc2a9c16\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/suggestionCard.js\":\"b4c5ac0605e2f795\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/suggestions.js\":\"98e8d1de2af1aaa2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/summaries.js\":\"d86184e8980d8407\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/summaryBatch.js\":\"1d277090fe8c0096\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/surface.js\":\"3e1f186ab3861c1a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/threadNavigation.js\":\"eae27dd1bde5ecda\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/threads.js\":\"aafe92111dd2059a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/ui.js\":\"c5d0be1e1607ddc7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/annotations/uiStore.js\":\"a2eba21a61b3ece3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-intents/appIntents.js\":\"d523909a342bd27f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-intents/index.js\":\"c782227f1dca255e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-update-prompt/index.js\":\"e6949d1938443605\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/app-update-prompt/status.js\":\"e42ca917eda0244b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"97a7151658bd8207\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/MediaBlockRenderer.js\":\"08e553176236df57\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9ae4bc3c91b56804\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/MediaUploadReconciler.js\":\"a9f90e3cc1375c92\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/assetDownLane.js\":\"f0f3af71d5a5f939\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/assetResolver.js\":\"4ebb7b64103f439d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/assetUpload.js\":\"882e13efb8afb2fa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/attachmentCleanerIO.js\":\"523717c5c5fe6925\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/supabaseAuditIO.js\":\"aaa15ceaa7a581bb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/blobStore.js\":\"7ff08b2d43d94600\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/browserMedia.js\":\"6aad360d4545eb6e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/byteStore.js\":\"4b68a58a97b31e6a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/cleanerIO.js\":\"8c3923014e350219\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/cleanupAttachments.js\":\"900353fd9d6fe23d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/dataExtension.js\":\"b86c516b437cb9b1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/downLane.js\":\"5c590892babbd909\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/index.js\":\"a66f3b2827e0898d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/insertImageContribution.js\":\"280d11b785cb7781\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/laneArming.js\":\"61bd0cfc155b16bc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/laneLock.js\":\"0551088592a65fae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaBlock.js\":\"dc66e1132335ac4b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaCapture.js\":\"851a0884cb2a7549\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaLanes.js\":\"f0ca118f29a97044\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaViewers.js\":\"712a96045490bd18\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/mediaViewersFacet.js\":\"9cadeedf6458f4fe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/pasteCapture.js\":\"f9be9c93db08c7cd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/resolver.js\":\"e8bea930041f24bd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/retryUploadsAction.js\":\"3813337d0a084789\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/storagePaths.js\":\"cb29c8be221cd8ac\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadDrain.js\":\"2ca2cb68d23a7398\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadLaneStatus.js\":\"2f095ffbe94e399f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadReconcile.js\":\"0940b97ca7e6844f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadRecovery.js\":\"5a5ec1a4203c9c6a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/uploadStore.js\":\"db310aa1c04c46ce\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/attachments/useAssetObjectUrl.js\":\"9f620385d7a74e95\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"21ba0f23e734e23f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c6d8769d279fb5e8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/facet.js\":\"44ebbe72882541a3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/index.js\":\"7a3df540ad72030f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks-view/prop.js\":\"530a6c9174b4f5e8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/BacklinkFilters.js\":\"8b9d1e6a3d82bb16\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"79d8edef783d14ea\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/BlockEntry.js\":\"0bb2a3c8fefe4d15\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/LinkedReferences.js\":\"a90731b690930525\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3c3cae77ec63da3a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/dailyNoteDefaults.js\":\"32dfd0858a2ebeae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/dataExtension.js\":\"3aeb8554b1317b7e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/edgeExclusions.js\":\"24f6896ff4bd4eac\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/filterProperty.js\":\"8535aafb047a01f6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/index.js\":\"f376b523b21e6022\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"eb2c936d62966dd4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/applies.js\":\"1dd907363fb9d9dd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/countQuery.js\":\"7b4bfda7aeff8b5c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/expansionStore.js\":\"fa164bd5312336ee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/index.js\":\"524958fed4a7997c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ada04a756b1e2e6e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/presentationInvalidation.js\":\"954a01ac7e5e61cb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/propertyEditorOverride.js\":\"6886cc3990985163\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/propertyFilter.js\":\"266e4c5a05347bbe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/query.js\":\"af69a93690ea6a4c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/resolveFilter.js\":\"163128d29d13e94f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/sourceBatch.js\":\"669d45fec396cb0e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/sources.js\":\"6d33d7e79d5f051e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/useBacklinks.js\":\"d37df8b41af2675d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"bb59f8cfbbed0854\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/BirthdayCelebration.js\":\"122b0016dfb5a63e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/BirthdayOverlay.js\":\"57538de45a5ae48c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/gate.js\":\"2fc9275b66b19f6c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/index.js\":\"9384ff8fc1322a2d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/birthday/wolfTheme.js\":\"edb82a1cbcde8d5e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/BlockDragLayer.js\":\"01ae93846d5f4feb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/dragController.js\":\"df3f1c71e220a530\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/dropTarget.js\":\"02ac5c6286b9fdde\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/index.js\":\"dee869a33728a1f0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-drag/projection.js\":\"3abc008bc3dc1a8b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-info/BlockMetaCard.js\":\"2b657a53e430b32e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-info/index.js\":\"e6ae5293824efe64\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/AddTagDialog.js\":\"edfd56d1a6b09b0d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2bd25e4d23b36748\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/TagNameIssueHint.js\":\"8770176ac5d23637\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/addTagAction.js\":\"80aae5364f8769c7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/appendTag.js\":\"a81bbf419a3f2606\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/config.js\":\"c10bce1ec61ce789\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/dataExtension.js\":\"81cadfd5f4cbc855\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/index.js\":\"b3be61c6154ade4a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/block-tagging/propertyEditorOverride.js\":\"894dd96a43cac743\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/BreadcrumbList.js\":\"7709b79b25f27b60\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"08cb57bd11ae405a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8d49e41c5530b46f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1eaa7129a80073fe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"ad47283c520ba61d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/index.js\":\"f081994024e3d847\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7eb3f5882b1ecbaa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/CharacterCountItem.js\":\"36d2b6e53850a715\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/ProfilePropertyEditor.js\":\"cad3d7851dbc3c28\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/actions.js\":\"d6d051da523025da\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/blockType.js\":\"3b37cbe8ef5b0c28\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/charCount.js\":\"b985433b1408ff5d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/dataExtension.js\":\"ae897b96a5db685f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/index.js\":\"2ea0f46468e425d1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/profiles.js\":\"42fc9194211d859c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/properties.js\":\"28129d9d477f1b1a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/subtree.js\":\"425cfc753bdeb8fd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/character-counter/textCounts.js\":\"597f9be92897e339\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/colemak-keybindings/index.js\":\"1c25a71257d95f83\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/CommandPalette.js\":\"533ae14fedbe4fdd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/HeaderItem.js\":\"3f0fead5f3be79b9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/context.js\":\"3b73cc35540c090c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/index.js\":\"b79312678ec0627c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/selection.js\":\"cd0b61d8a511221b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/toggleStore.js\":\"1c82b5969895858c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/command-palette/useCommandPaletteActions.js\":\"5553f4b6ec2883f9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/ContributorBadges.js\":\"9981b6ad3589fd48\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/ProfilePicture.js\":\"69833bdd9f03e0a5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/author.js\":\"45c0a84a1972a0d4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/codeMirrorExtensions.js\":\"13c124af485c506c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/dataExtension.js\":\"9af624b6efcd561a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/index.js\":\"cd057f7fdbf387fd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/mentionAutocomplete.js\":\"0dbc10c7b815da67\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/processor.js\":\"76487450c6bbad12\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/profiles.js\":\"df9fbf82abb0bcb9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/queries.js\":\"8de06be5aecab6f1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/schema.js\":\"ecdaf21f4ccc87f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/contributors/useCommentAuthor.js\":\"943fc9afb491fd69\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"5b4d0a8ab7fc7b2f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2c2d7020a9bfc5e9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/index.js\":\"820fd897249506c4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4a3a1cd07ffc6e9f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"de0820579928011a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/CalendarGrid.js\":\"8d69519a84b6c21e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DailyNotePicker.js\":\"0d777e2a4d03e5a5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9db7b5a46211bd36\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DateNavDecorator.js\":\"0ecdcaacfd20573d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DateScrubOverlay.js\":\"d35868bfe8d258b2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DayPropertyControl.js\":\"37993de0ed594d74\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/DayValueReferenceControl.js\":\"81b5499b69b7110b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/HeaderItem.js\":\"9b71c724b78972bb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/ReschedulePicker.js\":\"af4198e68cf48c1d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5ef90683e159ae70\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/actions.js\":\"704a30d7eb659983\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/blockDateAdapter.js\":\"e3fbaf6b5c85569f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/calendar.js\":\"f11cc5ed5f925450\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dailyNotes.js\":\"a3073f2ebe8e4369\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dataExtension.js\":\"6b9eb33631b910f6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubActions.js\":\"1bdc6959717e183e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubGesture.js\":\"a479f3c50a42977b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubGestureActions.js\":\"4c19f37126d63b06\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d3e85d2461806929\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dayProperty.js\":\"9efe86a705b22111\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"9003a5420df76a90\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/deletionGuard.js\":\"52a107da598ba525\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/dueQuery.js\":\"906c756682dbbbcc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/index.js\":\"65f7a06864292560\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/landing.js\":\"89dff18a24d23e2a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/localSchema.js\":\"e18bc4c2e2eb4816\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/referenceDateAdapter.js\":\"575d0c153032b2c7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/rescheduleAction.js\":\"79037a7ce723ac07\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/schema.js\":\"423b000813431fbb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/spreadBlockDates.js\":\"26752c664f416c21\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/spreadDatesAction.js\":\"cd1319322ce9be9f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/today.js\":\"e976273432ceeb48\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"fcd770010ec5bbf5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"5f4aec10295a9629\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/audit.js\":\"ff7583f6f20124f8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/auditAction.js\":\"92df5bba8785c7e6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/auditRanges.js\":\"7e19ef9446b86344\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/diagnosticsSource.js\":\"24047d074899d945\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/divergenceScan.js\":\"c990b07d9b778f2a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/index.js\":\"6da0664d7b9140b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/propertyChildrenChecks.js\":\"596af6b41e095dbf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/referencesMirror.js\":\"8ad50dcf878712ec\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/rowJson.js\":\"de4136c2620b5f0f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/schedule.js\":\"db1eabd113008250\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/data-integrity/store.js\":\"7d17f5dd77a349a3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-maintenance/action.js\":\"9cab37a1f0c66854\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-maintenance/index.js\":\"65c2a06aeb8aa388\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-maintenance/plugin.js\":\"23b5d63d4896aa10\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"30428853adebc5b9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/actions.js\":\"63196068790a2e4d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/changeMarker.js\":\"3504b26cae78cd84\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/diagnostics.js\":\"fa396dd174551cbb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/fileSystemAccess.js\":\"2052886be41de2af\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/filenames.js\":\"46090dfe76705291\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/index.js\":\"bbf0474b2d8b5acc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/mirror.js\":\"e22482c1b44fb879\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/runLock.js\":\"f64c1c7a5402a144\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/runtimeHealth.js\":\"aacd5631a8c0dd5c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/schedule.js\":\"32c0f6bc4a72c9de\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/db-mirror/store.js\":\"c0cb8e687cf51760\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/default-themes/index.js\":\"3653a17813fbcefc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/default-themes/themes.js\":\"4bd992cd274c6a10\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/diagnostics/facet.js\":\"e4a00797c72d0811\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/diagnostics/useDiagnostics.js\":\"3cf89e2f83f66e2a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/dismissals.js\":\"faad871f024d08d3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/index.js\":\"9a72ab008369d8f5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/status.js\":\"5a75897a00f0128f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extension-prompts/store.js\":\"a0fb9966e0097760\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4680ca4dc6954674\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c78091be47206362\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/actions.js\":\"9d2a594b8ebbe39a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/config.js\":\"2492759f1b789ba9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/dataExtension.js\":\"41e27c8efe484507\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/effect.js\":\"52ed77327fa2f141\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/index.js\":\"0c4f3121d4cdd212\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ee9b35f527beb78f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extensions-settings/useToggleTree.js\":\"8371039046f74487\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/ExtractTypeDialog.js\":\"95fede08ce4868ae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"0af6fc9990c3b44f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/PropertyShapePicker.js\":\"0ee41409fb14ce61\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/action.js\":\"63922bf6168859c7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/extract-type/index.js\":\"3c4b3198b602cc64\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/FindReplaceDialog.js\":\"cd4d0981ad91dd0e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/HeaderItem.js\":\"dd027991e2778f6b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/dataExtension.js\":\"d95aebe6fff21b6f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/index.js\":\"b8992987e8c34a6f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/search.js\":\"1b86118c9471de96\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/toggleStore.js\":\"94f6e595bf373909\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/LocationPropertyEditor.js\":\"db79cc50b3fed305\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/MapView.js\":\"c6fa43a5b8161e4a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/blockTypes.js\":\"3b9cda605719ecac\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/codeMirrorExtensions.js\":\"e296b37c387a9264\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/createOrFindPlace.js\":\"359b7fa21654d172\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/currentLocation.js\":\"3ed55a303ffa23d9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/dataExtension.js\":\"c0a64d44ad3b90aa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/geoContentDecorator.js\":\"6d06edc8aded8766\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/googlePlacesClient.js\":\"afc7bf51a38a2c47\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/index.js\":\"c0b3006a2ad1716e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/locationsPage.js\":\"4a5b3f04c652f46a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/mapViewport.js\":\"5ce735f26d03cf19\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/pickCurrentLocation.js\":\"134aa2140bb95466\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/placeAutocomplete.js\":\"fdba42f7a6db840a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/placeNameCollision.js\":\"ad4bc523e376f9f6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/properties.js\":\"9754dbd6b3fcd6f9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/propertyEditorOverrides.js\":\"4b7e9f38fd1f7726\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/query.js\":\"3b8e26f1a45f090c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/geo/usePlaceSearch.js\":\"6981472fea38e8b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ce7906fa4e9e2d8b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b4eeba1f44e4e6ad\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1a2f18ffe94306dd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/config.js\":\"b4276a99f06a8a02\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/dataExtension.js\":\"488d75d53cdc9d52\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/facet.js\":\"e15d1a543fa91b07\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/grouping.js\":\"c15ae4fa6daefebb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/index.js\":\"1e54e7894e6606ea\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"da4cc0beb980299d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/query.js\":\"a453c49c48b03184\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/resolveConfig.js\":\"249fc5f3c51f3e06\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"966a91c715ba4c59\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b44ca05a9696a4d2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/HtmlDocumentContent.js\":\"ce4fc2fd9ad01999\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/HtmlFrame.js\":\"915320f64538562d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/actions.js\":\"858699b96f7753b8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/blockType.js\":\"2e83f7dbf0854d10\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/confirmRunScripts.js\":\"f537191317cba39a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/dataExtension.js\":\"dffae12952261131\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/frameAnnotations.js\":\"a4f293838998956d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/frameDocument.js\":\"c0a5c8b805730315\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/frameTheme.js\":\"a4706199167a41d1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/index.js\":\"7ac33307cb6c8efe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/scriptConsent.js\":\"6642b598a6bd717e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/sourceMap.js\":\"65ea4db7fa043445\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/html-document/useDocumentScripts.js\":\"bc6337d5d9adadac\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/index.js\":\"05b7e486bea116fa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/record.js\":\"4fd94c62dc6dc7ee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/recordStore.js\":\"c8c5d2e18bc39345\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/responsiveness.js\":\"f3babd9fbf7e9719\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/schedule.js\":\"9cb79796cb903674\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/interaction-metrics/sessionContext.js\":\"5edc0b4fcb44554d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"50c6515886cc93a7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"89b2e20a4bb403e5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/actions.js\":\"aeda9aeb05b6fcb9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/config.js\":\"ad42be5afd4244ad\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/dataExtension.js\":\"a7ef40cd66d242c1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/effect.js\":\"00ec7819eb47f0a8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/index.js\":\"2173165383fbdf71\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/keyCapture.js\":\"e04687d65cb57594\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/overrideStore.js\":\"aace9e8099f3b62b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"dbedad6b6b4c65b1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/HeaderItem.js\":\"cc875e36ff488521\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/LeftSidebar.js\":\"bf3731ea67ad934a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/actions.js\":\"e58838b26b26b993\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/facet.js\":\"ed5e813c628f24b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/index.js\":\"5859f9f85d0e5ea4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/shortcuts.js\":\"a43e9aa0616e8f91\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/left-sidebar/toggleStore.js\":\"e247c75dc98748bf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/MergePicker.js\":\"4018bab46bbd78d7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/index.js\":\"347ff60a230b0587\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/mergeAction.js\":\"0b434aacc6b84fbf\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/merge-blocks/strategy.js\":\"d60b5a373a57144d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/Button.js\":\"d182b270a13fdbee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6cf8c50a47434f8e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/defaultItems.js\":\"345b5c9c7c99a5e3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/facet.js\":\"808c65b53a3fe4ca\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-bottom-nav/index.js\":\"29fa342e0344a362\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d5614fc3829684ec\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/actions.js\":\"00540a6683ccc390\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ba05a79d47b7cab0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/facet.js\":\"02e12285adbf0bfb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/mobile-keyboard-toolbar/index.js\":\"23cc5760170689d0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/MoveDestinationPicker.js\":\"9f9d019becc7486c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/blockSubtreeMembership.js\":\"736de4a06b902c12\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/contextMenuItem.js\":\"53415c5c7abcd1fd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/index.js\":\"a8cb05b5b2e067fa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/moveAction.js\":\"fa6067115ebb708f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/moveBlocks.js\":\"c2f82eede90779c3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/move-blocks/selectionAfterMove.js\":\"f989be81e56bb09b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/TutorialBanner.js\":\"85dc7bc2e5aa4ec6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/action.js\":\"c9eb47bc2c61dc8b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/bannerDismissal.js\":\"8f2debb63a092315\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/documents/cheatSheet.js\":\"954ce27e0ce6c3cc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/index.js\":\"dd5bcfde2cf5a5d3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/keys.js\":\"0c9ef323898812e6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/landing.js\":\"f02d0aa8d13cc697\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/outline.js\":\"a700dd34adf9f55f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/onboarding/seed.js\":\"d538e77380bc8339\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/PerfTrendDialog.js\":\"108de4c88a2330fd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/analyze.js\":\"cbfd7b8ba46ca223\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/diagnosticsSource.js\":\"e2527b391d1a8a13\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/index.js\":\"6aa2a825d0c71154\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/load.js\":\"fd2f3b4599dee630\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/monitorRun.js\":\"d19d0d722cebe1f0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/schedule.js\":\"1498ec96f577eb21\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/series.js\":\"4d8ebc9f6a4c672a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/store.js\":\"bf70b24de20af660\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/trendAction.js\":\"fdacba7412f68980\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/perf-monitor/verdict.js\":\"733dccf8cc6d4627\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/plain-outliner/clickToEditAction.js\":\"55537e7fb299ee6e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/plain-outliner/index.js\":\"1519820a2c4380f2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/plain-outliner/interactions.js\":\"abae453c427c0f71\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c2b011c72e540875\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/MigrationGate.js\":\"4f86718a5dba19b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/MigrationGateDialog.js\":\"5f1141887ce90ebe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/action.js\":\"cb35b325e03bc2aa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/index.js\":\"8ff6c3a1830623b0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/localRunMessage.js\":\"2243e658b324c5f1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/plugin.js\":\"874edcf069364a30\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/progressReport.js\":\"ae9beb7ed259a02b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/properties-migration/sweepProgress.js\":\"c75221df2fcd8a69\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/FieldRowRenderer.js\":\"8fb3ca42e0fae0e6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/ValueRowRenderer.js\":\"ea1d49e4b217fc51\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/actions.js\":\"2c14a7d8c13800f8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/autocomplete.js\":\"3e88165f0a6e0f37\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/fieldRow.js\":\"7bb4adaeafe3914f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/index.js\":\"a84446cee4e52719\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/referenceWarning.js\":\"6db079e1cd7c90e5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/valueAutocomplete.js\":\"63640413ecd4627f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/property-rows/valueSchema.js\":\"78b94083083df67d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/HeaderItem.js\":\"9566740cde1fc388\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/QuickFind.js\":\"7e2da7c100f37ac4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/index.js\":\"e88aa64fd632ef78\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/recents.js\":\"955f96e94a87c316\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/resultItems.js\":\"c0299c8ae1369ba8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/selection.js\":\"670f6df0cebe3523\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/quick-find/toggleStore.js\":\"008ddbf22b40dd99\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/HeaderItem.js\":\"b283de7bdbcd65cd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e5f444f95dc0212a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/grouping.js\":\"cf404003cddc982e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/index.js\":\"9bbf3a3af04d9d14\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/recents/target.js\":\"3d49711c8b0bd0f4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/codeMirrorExtensions.js\":\"590f80fd37b1e13e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/contentPrefill.js\":\"5eb91fe6f8767dc5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/dataExtension.js\":\"c3bdbbd4cf6391d5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/index.js\":\"1d004dfe18320d0f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"285c6bc5a3514047\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/invalidation.js\":\"b9e61eeb5402aae1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/localSchema.js\":\"af9dcb6205ac5638\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/blockrefs/index.js\":\"946f90417ac4d58c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"bb32a9570d06c7d5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/index.js\":\"e712d3722121bc18\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/referenceNode.js\":\"f91702b0507ea09f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/remark-reference-occurrences.js\":\"3c5bc28030f51cc2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"20c7b1e855e821bc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/index.js\":\"8824e26ece126a2b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"1b95b01baa6639aa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c8189ef6af836370\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/mergeRetargetProcessor.js\":\"1d10e30778c55d70\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/parseFence.js\":\"86e47f5926d51f1d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/referenceParser.js\":\"8f261af773200421\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/referenceProjection.js\":\"ad1a7f8aba6222db\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/referencesProcessor.js\":\"6cc91576fc7427b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/renameProcessor.js\":\"2738b697713a6fd6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/references/spanReplacement.js\":\"9eb866882d3a3833\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/htmlToOutline.js\":\"ac2a5c742c7b2790\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/index.js\":\"1a528968f868ebd2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/normalizeClipboardDom.js\":\"13725527c3479325\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/rich-paste/pasteDecision.js\":\"7ab0c6caae147bf6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/action.js\":\"ab31fb6b46d76957\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/blockIds.js\":\"e728cbaa3fe3f0a2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/content.js\":\"1a11f46c8c7bc0e9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/effect.js\":\"bf8680926ab0e7f3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/ids.js\":\"ee710d230f26b36e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/import.js\":\"cd4333e942480dc2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/index.js\":\"cc1dbb3baea7c7d9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/plan.js\":\"c1c9e38c67826be0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/plugin.js\":\"0b0e0fe391be415c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/promotion.js\":\"cecfc443675063dc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/properties.js\":\"de03f7ad89e7bd4d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/references.js\":\"afbecbee714cffbd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/report.js\":\"3ae0407dbdb747a1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/roamMemo.js\":\"e006e889a36c9cff\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/runtime.js\":\"e0f8bb83e812d966\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/schemaReconciliation.js\":\"1da47f88ee9ae0ac\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/srsMarkers.js\":\"44cf6d0a0f3f6491\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/todo.js\":\"35f01a20ef35f38d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/typeCandidates.js\":\"658c6baa5c7adde6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/roam-import/types.js\":\"94876753ea72448c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/search-health/index.js\":\"1ecdda1234b9951d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/search-health/store.js\":\"69a73e308578732e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/HeaderItem.js\":\"e31617b7bf09af78\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ade1eebeecd519e1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/index.js\":\"eb32039ecce01151\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/model.js\":\"b5818e38651b10f4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/toggleStore.js\":\"666495b1f758c0e0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/shortcut-help/useKeyInspector.js\":\"77dbf411f79ad56f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c0494e8f259145a0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/ShellDecorator.js\":\"c9711045b3989376\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/actions.js\":\"5eb6908f307caa49\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/exclusionsFacet.js\":\"a90dcb147b8fdc48\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/index.js\":\"4c8075215be57b6f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/shell.js\":\"2d301be2e438a20c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/surface.js\":\"ae4b285954218383\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/spatial-navigation/walker.js\":\"760ef097489f778f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d600f23a4e844f1c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/dataExtension.js\":\"c05abe3b2e2cf0f7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/index.js\":\"ac17213f482a2a10\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/indicator.js\":\"f1da9cf0bb9ebb1e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/moveSrsState.js\":\"3ada679bf1093ddb\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"d8f988be6a64e6f1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/scheduler.js\":\"026afc39c689b1f4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/schema.js\":\"266b4a8a581e7d40\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"391a33ba17661dd9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/srsClipboard.js\":\"ad609e09652387ad\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6a1e4747d7907814\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/DailyNoteReviewHint.js\":\"61455f3c9d31a74d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/DeckPicker.js\":\"180da05ba6613dfd\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/ReviewControls.js\":\"56d4ba612a934162\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/ReviewDeckRenderer.js\":\"aef67d084aafcef8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/ReviewSession.js\":\"46835e4d64e8e311\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/actions.js\":\"8654a18cff583fb7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/archive.js\":\"246eaa3ce3154d7f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/dataExtension.js\":\"61113175e21519c8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/deck.js\":\"619efd2e9fe8e726\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/dueQuery.js\":\"5f204e744df9682c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/gradeDecision.js\":\"923fc383097febae\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/index.js\":\"ae8599425d791f32\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/keyHints.js\":\"5a6bd8d8e857fdc9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/reviewCardLayout.js\":\"283d10b250922c79\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/reviewProgress.js\":\"455d5560cf024f78\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/schema.js\":\"467c37c3af04b6b8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/srs-review/useDueCards.js\":\"cbd34b1e05f71370\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/startup-metrics/index.js\":\"863503855c5d2ec5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/startup-metrics/record.js\":\"10f3be22494f5ef5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/storage-persistence/index.js\":\"d950df43c90e28f8\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/storage-persistence/persistenceStatus.js\":\"e7652ad10064e137\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/storage-persistence/requestAction.js\":\"4c7149e32c3fdb36\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/TypeChipsDecorator.js\":\"f5d4736fe18b14ad\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/codeMirrorExtensions.js\":\"8666d8d633b2aee3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/index.js\":\"2f6f781942c73fcc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/supertags/typeAutocomplete.js\":\"685cde8997c86f49\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"38e0a6af8adfe151\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/actions.js\":\"4a8a3224dcb506d2\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/anchor.js\":\"84d73124c9382a11\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/events.js\":\"7fe59ef44db4cc4c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/gestureActions.js\":\"792b9867bef7865d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/index.js\":\"99eb6587fc20c833\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"959b397edcb99f08\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/sync-metrics/collect.js\":\"f3b72432a1038ca9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/sync-metrics/index.js\":\"015f13c50fe961d6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/sync-metrics/record.js\":\"1a6d579262782884\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/RejectionDialog.js\":\"0b9fdfc11dd9681e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/SystemStatusHeaderItem.js\":\"740ab16a8faae5aa\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/index.js\":\"4c2c87f6efd0633f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/model.js\":\"3e903debcbde7de1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/queueCounts.js\":\"25d87a218593fc46\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/rejectedHelpers.js\":\"c8dfe3573b5d5698\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/rematerializeAction.js\":\"0c4c8d12e4957db7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/system-status/useHysteresis.js\":\"9aff8d8e29416981\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/ColumnHeaders.js\":\"b29c85a6dae0f15e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/QueryUi.js\":\"479448de0e431bbc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/TableLayout.js\":\"04d3a3723601ad68\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/actions.js\":\"a705ebd6e3167691\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/cellEdits.js\":\"1fb5f47c1363678e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/childrenViews.js\":\"e145fe8d1c56c592\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/columns.js\":\"670ddc21c7233929\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/controller.js\":\"0b6e790094f6ca4b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/convert.js\":\"33dc1e2c5c935739\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/dataExtension.js\":\"e3a0ecf38008959b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/index.js\":\"e1745d380c03d58e\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/keys.js\":\"066d1b184c21dbbe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/model.js\":\"8b3b5317bb43ce43\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/QueryText.js\":\"b95f96461d919f35\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/backfill.js\":\"e4d3322e22d1087b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/completion.js\":\"16e261eda3d8a633\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/format.js\":\"fde1ad9d456a158d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/parse.js\":\"9bdbe41edebfd68c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/queryValue.js\":\"ff51ae6faf22fe2f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/registrations.js\":\"32e4ca2381ae0334\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/query/source.js\":\"7e05bde2ee13fbd9\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/registry.js\":\"168b24189b9e57ee\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/rowGutter.js\":\"2b91054b78cfe647\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/rowVerbs.js\":\"863d11138fe58fb6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/schema.js\":\"eaa1843b56dc28c0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/tables/sort.js\":\"77c3967148fc1e13\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/theme-toggle/effect.js\":\"b89d2255199c595a\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/theme-toggle/index.js\":\"52a26b5f339def24\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/theme-toggle/theme.js\":\"a2e0f31aa12fd805\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/actions.js\":\"e7c7452a0abdb2c0\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/dataExtension.js\":\"0306f0aa8fa7e83d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/index.js\":\"18ae29439c798207\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/todo/schema.js\":\"23cf07ec23680b10\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/TouchSelectionLayer.js\":\"6001e1a0d68e0585\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/actions.js\":\"519dadd1caee6571\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/defaultItems.js\":\"982b41705d6731b4\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/facet.js\":\"068f61b5c53eba1c\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/holdRecognizer.js\":\"6c30cf3011eff842\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/touch-selection/index.js\":\"8beee7c4d3cfb11b\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/update-indicator/UpdateIndicator.js\":\"46df7b25191f476f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/update-indicator/index.js\":\"f87aa9f9002bb4e1\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/update-indicator/loadTimes.js\":\"e9ffd5902001dc7f\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/VideoNotesRenderer.js\":\"6d5caa714c0724b7\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/VideoPlayerRenderer.js\":\"c00b97e5ac78d4b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/VideoTimeStamp.js\":\"7bbb96529feffb03\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/actions.js\":\"28b59466a347f2f6\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/index.js\":\"83d790f4f5a9850d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/markdown.js\":\"54e360656ee756fe\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/notes.js\":\"5a147bc41e989af3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/registry.js\":\"4cf5c895c6893478\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/remark-timestamps.js\":\"e925325a7ec46dbc\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/video-player/view.js\":\"68fb576d80e96218\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/LinkHints.js\":\"152543ad440ea8b5\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/index.js\":\"052b38331274b9ba\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/model.js\":\"fc78ed9be258be92\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-link-hints/settings.js\":\"8b92bec25194de1d\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-normal-mode/actions.js\":\"eb202b766db09ff3\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-normal-mode/index.js\":\"a454e4b9f3c99eca\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/vim-normal-mode/interactions.js\":\"4a55b0b6ce197847\",\"/knowledge-medium/pr-preview/pr-1906/src/plugins/workspace-header/index.js\":\"0ed99efe44c5a936\",\"/knowledge-medium/pr-preview/pr-1906/src/registerServiceWorker.js\":\"62383d857700b5df\",\"/knowledge-medium/pr-preview/pr-1906/src/requestPersistentStorage.js\":\"82762999231ace46\",\"/knowledge-medium/pr-preview/pr-1906/src/services/authRequestDeadline.js\":\"44db3063d5105af9\",\"/knowledge-medium/pr-preview/pr-1906/src/services/authStorage.js\":\"5aa52fc7022ea8f5\",\"/knowledge-medium/pr-preview/pr-1906/src/services/powersync.js\":\"fb5c9c7e974c1048\",\"/knowledge-medium/pr-preview/pr-1906/src/services/supabase.js\":\"d1c866ff0211b80d\",\"/knowledge-medium/pr-preview/pr-1906/src/services/uploadErrorClassifier.js\":\"21808f571b24c020\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/ActiveContexts.js\":\"b6a0a6908d978eba\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/HotkeyReconciler.js\":\"4a2532911cd7c257\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/WipeLocalDataDialog.js\":\"a2ac41bdffedf13c\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/actionDispatch.js\":\"eef40d8db92e3499\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/actionRefItems.js\":\"016cb845ea1db47f\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/applyKeybindingOverrides.js\":\"4bcdca1305e12c37\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/blockActions.js\":\"aff80ad82895a273\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/blockMergeGesture.js\":\"5e20f52cb7ec74a8\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/canonicalizeChord.js\":\"b0f32ac1c4aa7cfc\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/defaultContexts.js\":\"c6130c8b32bd6ae4\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/defaultShortcuts.js\":\"f6b2df32395f2df9\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/effectiveActions.js\":\"1665ca68e92c3a1b\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/gestureAction.js\":\"90f13ee4a2b6c64c\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/gestureBinding.js\":\"13e564b0174a00b9\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/holdRegistry.js\":\"a5e88eed44fc6ba9\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/keybindingConflicts.js\":\"0b84db37f44e9c71\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/keybindingOverrides.js\":\"294679473940f6bb\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/pointerAction.js\":\"0036cab5793a8953\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/resolve.js\":\"a26d0fe66fd17ef6\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/runAction.js\":\"da396d2a3943fa44\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/sequenceMatcher.js\":\"9f03c4ea5604e0be\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/types.js\":\"3f26f4610602b0a5\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/useActionContext.js\":\"e7fdd890e9c6d3d8\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/useActionDiscovery.js\":\"72f6b0ad3d8503ad\",\"/knowledge-medium/pr-preview/pr-1906/src/shortcuts/utils.js\":\"e7af7009171e0118\",\"/knowledge-medium/pr-preview/pr-1906/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1906/src/sw/bootStore.js\":\"9d43ea3b03051c6d\",\"/knowledge-medium/pr-preview/pr-1906/src/sw/previewDatabases.js\":\"755669c44150467c\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/byteTransform.js\":\"7d15f69d0c403403\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/attachmentCleaner.js\":\"1ad717f7703ade3f\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/attachmentParts.js\":\"36925a04621928ee\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/bundleParts.js\":\"512f646b77b2ebd7\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/bundleRecord.js\":\"c946c2c296ce0b91\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/manifest.js\":\"5dfdd2c9ee3a8ae1\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/takeBundle.js\":\"2aa4c6d2e79cd901\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/bundle/verifyBundle.js\":\"ee1f03a66fe5ded4\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/cleaningStage.js\":\"cf5d8e520fe1365f\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/conversionKey.js\":\"182ca058e25b4450\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/conversionServer.js\":\"189641da9c10f147\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/flip.js\":\"cda7635ee486d46c\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/flipAttempts.js\":\"221437113ea77aff\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/pages.js\":\"c83800a80b34849d\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/preflight.js\":\"f97f4a551cda4905\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/reseal.js\":\"c9246f9192158aac\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/runConversion.js\":\"0ddcde1ac275249a\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/runLock.js\":\"d31935f0d2534e90\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/sealing.js\":\"acac52bf65c94fba\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/sealingStage.js\":\"f175180fb4fac41f\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/stage.js\":\"267b0a66dc9054f3\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/conversion/verifyReseal.js\":\"6dde431193dae898\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/aad.js\":\"6476f6b9563a6c57\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/aead.js\":\"d80c06d4dfbb90b0\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/base32.js\":\"0a5878e1c4f71a18\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/base64url.js\":\"e6417ac421e0a852\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/binaryEnvelope.js\":\"43a415d72d98eac6\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/byteAead.js\":\"01d5a942f6e03f41\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/canary.js\":\"85cdee012ca3ce3e\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/contentHash.js\":\"0bcfda85c721b51f\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/contentKey.js\":\"4d3a40128d656075\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/derivedIdNamespace.js\":\"7d75675bda3d9135\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/envelope.js\":\"c73e3ca194aacd3f\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/hex.js\":\"40955636dca85c7f\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/sha256Hex.js\":\"1e0f6e26839db588\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/crypto/workspaceKey.js\":\"91ebfd49bb11f641\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/conversionState.js\":\"380abe712916d849\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/createEncryptedWorkspace.js\":\"fb0068d94063de1e\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/pastedKey.js\":\"ee7886d7a7e21ab0\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"1cbbbb81c7fcc64e\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/flows/upgradeWorkspacePin.js\":\"75f10922c1f8de52\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/keyStore.js\":\"93061893ce3f32b0\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/mintWorkspaceKey.js\":\"7814ec7a45f5296e\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/modePin.js\":\"5f821b7eec8fc8ea\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/openWorkspaceKeys.js\":\"b3871d4a89069473\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/resolveWorkspaceEntry.js\":\"5dbbba53467df70f\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/resolver.js\":\"712d6a5a9b66dd27\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/keys/workspaceAccess.js\":\"cd53753550af6541\",\"/knowledge-medium/pr-preview/pr-1906/src/sync/transform.js\":\"48df1249660c3ba2\",\"/knowledge-medium/pr-preview/pr-1906/src/themeBootDefaults.js\":\"06e730ff142e1551\",\"/knowledge-medium/pr-preview/pr-1906/src/types.js\":\"3313dd4bd4364231\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/ClientLocalSettings.js\":\"108d7debe42cd261\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/abortableSleep.js\":\"d6a9168192360063\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/array.js\":\"252176324180e8f4\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/backlinkAutocomplete.js\":\"6012b8ffc16a2200\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/blockCrumbs.js\":\"77388a9be00caa3e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/blockrefAutocomplete.js\":\"ee746adc56fdf475\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/cadencedIdleJob.js\":\"5f3e83f1379cc132\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/callbackSet.js\":\"41b21e1437cce63c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/clientId.js\":\"a7609945e0d6b7dc\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/codemirror.js\":\"ba2a0400320e181b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/codemirrorCompletion.js\":\"ee2ec6da57077af7\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/copy.js\":\"edfad3a5a53cb271\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dailyPage.js\":\"6368a9f176a5523d\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dbForensics.js\":\"d88b43e9ab77a011\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dbForensicsHooks.js\":\"0d376b385a33e721\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/deleteBlockThroughUi.js\":\"e6e922d8f297de08\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dialogs.js\":\"8aa1933ed6a8b2f4\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/dom.js\":\"1682da57bb22ab44\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/downloadBlob.js\":\"c2ff15f8f4b9eedc\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/drawnWalk.js\":\"250608b2dda366c2\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/exportSqliteDb.js\":\"b1256a21cef01cd5\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/fileSystemAccess.js\":\"66012f4d96019b6f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/flipSlide.js\":\"2b5f5018347e433a\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/fnv1a.js\":\"831f5666d68ddbf3\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/formatBytes.js\":\"6569bd11f301041f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/fuzzyRank.js\":\"06added009a61afb\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/idbKeyedStore.js\":\"0f9b89054fe543f8\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/idleCallbackPolyfill.js\":\"d8f980b4abc64ef5\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/keyboardAwareScroll.js\":\"73f3559328050aae\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/keyboardViewport.js\":\"7fe792fa44e363aa\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/lastWorkspace.js\":\"270bbb962bbacfa4\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/layoutColumns.js\":\"992721c00bf8eeeb\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/layoutSessionDom.js\":\"18d410f460b631f7\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/layoutSessionId.js\":\"ac856ddaf167ddb2\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/linkClickGestures.js\":\"f9e8ac8277f7aebb\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/linkTargetAutocomplete.js\":\"e26489d3a284fdd8\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/localDbCorruption.js\":\"21fdd65c09727aba\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/localDbRecovery.js\":\"a591db4ee1290c5b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/markdownParser.js\":\"99ae012627e7c027\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/memoize.js\":\"87025394b38d520c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/nameFieldCommit.js\":\"9518b9de0b30476b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/nameList.js\":\"d14c82f7db4a9d93\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/navigation.js\":\"d949ddc413f94bab\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/omnilinerNamespace.js\":\"6c503743da9840c2\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/opfsPageScan.js\":\"404629979c2bc26e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelClearance.js\":\"b601f4968a967730\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelHistory.js\":\"90800a079c8fae63\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelLanes.js\":\"ff4ecbeb66fa3d62\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelLayoutProjection.js\":\"b83863a8d70abef0\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelScrollAnchor.js\":\"595f890808b9c935\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/panelUrlFlags.js\":\"976517c80378a72f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/platform.js\":\"6d64223538d5732e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/pluralize.js\":\"924c6d22b305c88e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/propertyCreation.js\":\"1c76d6813805d6cf\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/propertyNavigation.js\":\"4408880b7a4dba19\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/propertyValueContext.js\":\"eb455a40c6f50fd1\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/react.js\":\"ee94bed57faaed48\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/relativeDate.js\":\"7f8dd9f0753468d4\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/relativeTime.js\":\"fac38ebec00f7804\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/renderScope.js\":\"fcc900d824e1e7cc\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/resolvedThenable.js\":\"dd29e7c66f478ceb\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/routing.js\":\"f7bf379a07c828b6\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/safeMode.js\":\"fd392c1a5d9e92fe\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/scheduleIdle.js\":\"145543e6e7a16d79\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/screenWakeLock.js\":\"14b8bd6d25d0624f\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/selection.js\":\"79b5ad43f89316f2\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/softKeyboardGrab.js\":\"ddc73d4ec80da5ce\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/startupTimeline.js\":\"9bede7a0896da049\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/state.js\":\"28e30649e11379a6\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/string.js\":\"0dcda97ac33eb6e7\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/surfaceZoom.js\":\"ba330bf623ae612b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/time.js\":\"92ac7a69476bc274\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/toast.js\":\"a91a85b747c38a57\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/toggleStore.js\":\"c441b9a50fd1bdfe\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/untilStopped.js\":\"dd5139b9b3c973c0\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/userActivity.js\":\"4575efc67777491b\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/viewTransition.js\":\"db5bdf1b0a09aa35\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/viewport.js\":\"1d62db6cee5d5196\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/webLock.js\":\"0033be29872c581e\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/workspaceRecovery.js\":\"97426ccf8034d41c\",\"/knowledge-medium/pr-preview/pr-1906/src/utils/workspaceSnapshotStore.js\":\"d23dbfb38b322bce\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-compiler-runtime.js\":\"4ba8cff6085aa2cd\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-client.js\":\"23a05305cf69f009\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-server-edge.js\":\"9fd8aea7dfdb7938\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-server.js\":\"a6116f80f4c881ef\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-static-edge.js\":\"1f7969fee449e719\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-static.js\":\"30235dc2547a30ab\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom-test-utils.js\":\"4d2bc90b27637436\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-dom.js\":\"792fdc03a49f193d\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react-jsx-runtime.js\":\"c02c2cc0db213954\",\"/knowledge-medium/pr-preview/pr-1906/src/vendor/react.js\":\"d0b33871335ff270\",\"/knowledge-medium/pr-preview/pr-1906/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1906/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1906/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
