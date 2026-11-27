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
		buildId: "afe545f5dc9f-70167af6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1909/\":\"43ffcf5719991db0\",\"/knowledge-medium/pr-preview/pr-1909/index.html\":\"43ffcf5719991db0\",\"/knowledge-medium/pr-preview/pr-1909/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1909/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1909/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1909/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1909/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1909/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1909/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1909/assets/FacadeVFS-BYG6hFNN.js\":\"8703b9fc08c7f8bd\",\"/knowledge-medium/pr-preview/pr-1909/assets/OPFSCoopSyncVFS-DrfjZxeL.js\":\"9302f77db7a9f934\",\"/knowledge-medium/pr-preview/pr-1909/assets/OPFSWriteAheadVFS-BNMtVWO9.js\":\"ad235577265f5d00\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-DIQBJ8c2.js\":\"4963aa318bd61438\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-async-BjmK_6lG.js\":\"f70a240f927e6c02\",\"/knowledge-medium/pr-preview/pr-1909/assets/worker-DxjFgKKP.js\":\"f3e50a034194ce53\",\"/knowledge-medium/pr-preview/pr-1909/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1909/chunks/app-DXy2t6tH.js\":\"c6cb25d5250ed842\",\"/knowledge-medium/pr-preview/pr-1909/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1909/index.js\":\"e340c04f1c0535ae\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1909/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1909/assets/AccessHandlePoolVFS-Df5kh66x.js\":\"908971e8bc903d01\",\"/knowledge-medium/pr-preview/pr-1909/assets/IDBBatchAtomicVFS-B2HwPhTc.js\":\"6c4775fa42e30901\",\"/knowledge-medium/pr-preview/pr-1909/assets/MemoryVFS-CWt7eNSJ.js\":\"0c8190839777b2bb\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-BGmcFZMc.js\":\"63f06aeac077e213\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-async-Dm9b4O02.js\":\"03dcc88ed51d720a\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1909/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1909/chunks/AccessHandlePoolVFS-Br5VV96c.js\":\"2aee672e1d6c95ad\",\"/knowledge-medium/pr-preview/pr-1909/chunks/FacadeVFS-B4TDNmLT.js\":\"db8be3c9b4b2df24\",\"/knowledge-medium/pr-preview/pr-1909/chunks/IDBBatchAtomicVFS-JASr1rKd.js\":\"00335b0042c02cae\",\"/knowledge-medium/pr-preview/pr-1909/chunks/MemoryVFS-Dy0zwPE5.js\":\"3dfa1c12500bedb0\",\"/knowledge-medium/pr-preview/pr-1909/chunks/OPFSCoopSyncVFS-CjUjh0Mo.js\":\"1100a43165c4605a\",\"/knowledge-medium/pr-preview/pr-1909/chunks/OPFSWriteAheadVFS-Bx9UWqUa.js\":\"b355c7e2450a1045\",\"/knowledge-medium/pr-preview/pr-1909/chunks/Preview-WamDBDKu.js\":\"8deb79f1ee723087\",\"/knowledge-medium/pr-preview/pr-1909/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1909/chunks/card-CbvjVkc2.js\":\"ab32a5713e0e8ff7\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dist-fC2RLkvH.js\":\"4819eaf1b906a8e7\",\"/knowledge-medium/pr-preview/pr-1909/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1909/chunks/mc-wa-sqlite-CSq9d5Ra.js\":\"995faf7bb70065c1\",\"/knowledge-medium/pr-preview/pr-1909/chunks/mc-wa-sqlite-async-CIHLCvaJ.js\":\"2e88995fc6b8ce51\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-B9OwADdC.js\":\"52d9be33e7c509b8\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-BAt3IEV7.js\":\"065e910399e631b9\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-BPWMsPFH.js\":\"36f16c340ea9c028\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-BYQlsxv6.js\":\"f0ca131497daa7ca\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-C5I4Irtv.js\":\"0006f370d464ef8a\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-D583z7HR.js\":\"bbade72b505dbc65\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-DlMtp3I3.js\":\"48ed724c7b8914e7\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-aKFnTZHE.js\":\"983f16c07b11b855\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-dom-server-legacy.browser.production-BPeFbtD6.js\":\"1d1bf98ffbc1451d\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-dom-server.browser.production-BpOm_0pr.js\":\"1d7374ecc289a280\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-dom-server.edge.production-BNZfUHvR.js\":\"623f59f8f8740768\",\"/knowledge-medium/pr-preview/pr-1909/chunks/server.browser-Boej5DWl.js\":\"c044f87f72799fda\",\"/knowledge-medium/pr-preview/pr-1909/chunks/textarea-BFf1mtsJ.js\":\"da6072941a4ffe9e\",\"/knowledge-medium/pr-preview/pr-1909/chunks/ui-Ch6i2Plu.js\":\"edd4f661f7bf5302\",\"/knowledge-medium/pr-preview/pr-1909/chunks/wa-sqlite-PGnhFjL6.js\":\"f8b8c0a4e7a92ab1\",\"/knowledge-medium/pr-preview/pr-1909/chunks/wa-sqlite-async-DuiqrMyw.js\":\"ad906e855f32b94a\",\"/knowledge-medium/pr-preview/pr-1909/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1909/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1909/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1909/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1909/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1909/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1909/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1909/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1909/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1909/src/App.js\":\"eb01f553792bee8d\",\"/knowledge-medium/pr-preview/pr-1909/src/appUpdate.js\":\"80f522144ca0fb81\",\"/knowledge-medium/pr-preview/pr-1909/src/appVersion.js\":\"ead8c6698ef7c6bc\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/initialLayout.js\":\"47c77e149899a69c\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/openWorkspaceData.js\":\"2249a54cff63c44c\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/resolveWorkspace.js\":\"195f89bb4f443458\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/workspaceBootstrap.js\":\"a82f624de24d8886\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockComponent.js\":\"9bad53e1c82f3189\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockCrumbs.js\":\"64fda6123a923fc7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockEditor.js\":\"00ccfbd79c1b033c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockLoadingPlaceholder.js\":\"c4a75dc0a12af4f4\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockProperties.js\":\"eb7fb0f53c4cb215\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockSearchPicker.js\":\"b2d6f5ce93fe97d4\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ConfirmBulkDeleteDialog.js\":\"a75161c5246b55b9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/DividerHandle.js\":\"5ea4dd6131135d2e\",\"/knowledge-medium/pr-preview/pr-1909/src/components/DraftEditor.js\":\"c663d8c77e9c1a80\",\"/knowledge-medium/pr-preview/pr-1909/src/components/GutterPill.js\":\"8537fbe61dfef4c2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/Header.js\":\"7d1bffa0423fbcd1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/LazyBlockComponent.js\":\"5c63caab454ab344\",\"/knowledge-medium/pr-preview/pr-1909/src/components/Login.js\":\"6b37c68c7ed96980\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ZoomableSurface.js\":\"43ea1592b63c4ba5\",\"/knowledge-medium/pr-preview/pr-1909/src/components/editModeKeepalive.js\":\"0f627c77e8ca8892\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyDisplay/PropertyDisplayScope.js\":\"f846f4a7051b4225\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"76bb4ea90b9de009\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/RefPropertyEditor.js\":\"a0096864e4809236\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/RefTargetTypePicker.js\":\"0f0b3c95c7ae1f7f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/SelectPropertyEditor.js\":\"18e8d176175fe884\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/TypesPropertyEditor.js\":\"84ca0c01ae14973a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/defaults.js\":\"7e7026888068e65a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/kernelValuePresets.js\":\"ed1f29e489252412\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/selectablePresets.js\":\"f855ddb6803681b7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/typesPropertyUi.js\":\"a3953f310c115b6f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/AddPropertyForm.js\":\"019b453249be831f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/PropertyPicker.js\":\"dd9c62f128ca91ff\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/PropertyRow.js\":\"4bd62048fefb9524\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/Rows.js\":\"2d3fe1835180c580\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/actions.js\":\"1d3f4ede513173f2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/declarationOnly.js\":\"81722c4cc1e8de84\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/layout.js\":\"3a61165d6d024b47\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/model.js\":\"721f8ab2ac87fc02\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/shapeUi.js\":\"d3f54849c4a85f64\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/shapes.js\":\"5c1aabefff0e47e9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/usePropertyEditingActivation.js\":\"634b0963d3fdb01a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/visibility.js\":\"18d1c97a3bbe10b7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanelSections.js\":\"b80410b2474e0967\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/BlockEmbed.js\":\"d4162bf9ebddb951\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/BlockLink.js\":\"a7021257c0d2ae4f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/BlockRef.js\":\"d9888abfcc76a702\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/CompactReferenceLink.js\":\"25fd54e051bc8263\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/ReferenceLink.js\":\"f359cff1dc06f2cd\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/cycleGuard.js\":\"39b0fa510450edc2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/cycleGuardContext.js\":\"cc604588640fab5f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/linkInteraction.js\":\"6db9c6f2ff7db10d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/referenceLayout.js\":\"1086312a3bd41b63\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/useBlockRefAncestors.js\":\"f6212585dc521370\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockGutter.js\":\"826937cdeeb956cf\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockInfoDialog.js\":\"f8fbcd2cd893d181\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockReadText.js\":\"dca2388e48a6c1bb\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockTypeBlockRenderer.js\":\"cdab4be382f0bee2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BulletHoverCard.js\":\"a2a8bec43283f8fc\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/CodeMirrorContentRenderer.js\":\"7e0fd8605b8dbe51\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"859b4a8b02905b57\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/ColumnResizeHandles.js\":\"9bc39ee88bc8a920\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"6416f2e7ff3954bf\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/DefaultBlockRenderer.js\":\"e7156386bd4a1642\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/LayoutRenderer.js\":\"ff21905a966cc471\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/MarkdownContentRenderer.js\":\"940444abc07d7ae4\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/MissingDataRenderer.js\":\"548cc76700ee7c3d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/PanelRenderer.js\":\"05234baed36e3a5b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ca7326a2ade8d478\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/TopLevelRenderer.js\":\"95710ca8346bea4d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/blockGutterMode.js\":\"f37ae1aa1e82e0b1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/blockTitleText.js\":\"8d31a0a2e7064e1e\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/fieldCreationKeydown.js\":\"978f436b929c8f8f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/layoutRootContext.js\":\"a3f713636350b67e\",\"/knowledge-medium/pr-preview/pr-1909/src/components/typeChip/TypeChip.js\":\"ae6fbeb5bc0a7481\",\"/knowledge-medium/pr-preview/pr-1909/src/components/typeChip/chipStyle.js\":\"495570bb1c746118\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/anchored-floating.js\":\"6da25ebb6d19f903\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/button.js\":\"4f3ee0a662ab7bbf\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/card.js\":\"9516673db9fa0fc1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/checkbox.js\":\"ab8ccd2463b9cbef\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/collapsible.js\":\"93d99ce2e977f45e\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/command.js\":\"c9f7309ade6e2611\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/context-menu.js\":\"e77ecfafc7e71890\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/dialog.js\":\"3f96945e006469d9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/dropdown-menu.js\":\"b756b1e461f70943\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/floating-listbox.js\":\"9e13eef5090a44ab\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/index.js\":\"ef7a90a77603b842\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/input.js\":\"9e121c50c36de647\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/kbd.js\":\"3ed2562302c599a9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/label.js\":\"1c7d49f9ccfd8b6a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/textarea.js\":\"6f3c3e228f644ff8\",\"/knowledge-medium/pr-preview/pr-1909/src/components/useEditModeYieldKeepalive.js\":\"490884d4b7a6f56c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/BootFallback.js\":\"4a63ac1d38df11dc\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/FocusedRowLazyMount.js\":\"547f42631c30bd6c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/LazyViewportMount.js\":\"c18d5076865e4bd7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/LocalDbCorruptionFallback.js\":\"e224254a22809f25\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/error.js\":\"582ffa8fffbcd422\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/lazyMountRegistry.js\":\"0d3c0d70a4625f57\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/suspense.js\":\"59196bfcb5e4d0d3\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/CreateWorkspaceDialog.js\":\"7fee850f274084c9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/PendingInvitations.js\":\"6e00db1e9ee243b7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/SyncProgress.js\":\"3164ae7cb69cd9bf\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/UnlockProgress.js\":\"af426d7cec910516\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceKeyGate.js\":\"e2de315a6069e8bb\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceSettingsDialog.js\":\"e72991ab07776a5e\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceSwitcher.js\":\"96321097c7afc7a2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceSyncGate.js\":\"2dc66190e66e43b5\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/ConversionFlow.js\":\"f7e6bf4e1037f128\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/ConversionFlowHost.js\":\"5e08903bc328d370\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/EncryptionSection.js\":\"d19f9aaac5cee222\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/attachmentPrompts.js\":\"44f34da42489ab4f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/bundleFolderPrompts.js\":\"944cf9e5199ca599\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/conversionFlowDeps.js\":\"d450e755631876b9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/conversionFlowStore.js\":\"13ac90418ca0b666\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/flowUi.js\":\"79565e2786297d47\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/useConversionRun.js\":\"370ddc64c88028f1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/keyUi.js\":\"ad055b1403d8dc33\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/useCloseOnKeyLoss.js\":\"8706ae26f25b2476\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/useCloseOnServerE2ee.js\":\"bb9192028f522d8a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/workspaceUnlocked.js\":\"3740cc1eabbc713e\",\"/knowledge-medium/pr-preview/pr-1909/src/context/backgroundSubtree.js\":\"090ea7acf45cc021\",\"/knowledge-medium/pr-preview/pr-1909/src/context/block.js\":\"b27263aba0c3e7bd\",\"/knowledge-medium/pr-preview/pr-1909/src/context/layoutWsContext.js\":\"2428b5f3527c2093\",\"/knowledge-medium/pr-preview/pr-1909/src/context/propertyDisplay.js\":\"e3acacea1247f5ad\",\"/knowledge-medium/pr-preview/pr-1909/src/context/repo.js\":\"89fba47fd4feab47\",\"/knowledge-medium/pr-preview/pr-1909/src/data/aliasClaim.js\":\"96c1f71f6b309065\",\"/knowledge-medium/pr-preview/pr-1909/src/data/aliasSeatNamespace.js\":\"42f7e4340cd61fb2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/blockData.js\":\"4e36f9cc3d192267\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/blockType.js\":\"04105bc40e9c97bc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/changeScope.js\":\"0241122bf0a9abbd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/codecs.js\":\"a1ae471390069fdc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/derivedData.js\":\"6de48dd938543192\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/errors.js\":\"d47b0bea2ae6bc55\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/events.js\":\"eab74ec6898cad8a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/handle.js\":\"38f9d1aad3df75b1\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/index.js\":\"c2631a1f18f078a4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/mutator.js\":\"334832665081c357\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/processor.js\":\"b4b8000225befd2a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/propertySchema.js\":\"315d945daf2d520e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/query.js\":\"36981563ded37a29\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/sameTxProcessor.js\":\"ef2f4a7202b9f2b3\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/schema.js\":\"38f9d1aad3df75b1\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/tx.js\":\"38f9d1aad3df75b1\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/typedBlockQuery.js\":\"d56ff6b12f8cea7e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/user.js\":\"e96c4e6f5aabe267\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/valuePresetCore.js\":\"76e9a95d08e4a729\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/valuePresets.js\":\"f57eb19ad249c72c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/attachmentCleanerIOVerb.js\":\"113b28c684f9f9fe\",\"/knowledge-medium/pr-preview/pr-1909/src/data/block.js\":\"1641be20bfaa0efa\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockCache.js\":\"4ac46b0acdfe514f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockId.js\":\"6b86123013dbd3a5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockLiveness.js\":\"8a5cff836e38315a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockMerge.js\":\"17ea08ceaedd8093\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockSchema.js\":\"e081aff31600fd2e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockTypeLookup.js\":\"19275a39bf9b034e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockTypes.js\":\"2c0969e1371e5222\",\"/knowledge-medium/pr-preview/pr-1909/src/data/childrenView.js\":\"4e9dc6ea05bcf64d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/clientContext.js\":\"33e2584e089c7c5c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/dbFileSiblings.js\":\"00c06659f4f035ae\",\"/knowledge-medium/pr-preview/pr-1909/src/data/definitionSeeds.js\":\"fb13b29fde70ca3a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/derivedIds.js\":\"c7939084020850ba\",\"/knowledge-medium/pr-preview/pr-1909/src/data/drawnSubtree.js\":\"806cbaddea7617ea\",\"/knowledge-medium/pr-preview/pr-1909/src/data/facetBridge.js\":\"5e91a032c0a7a89d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/facets.js\":\"43e22a25939ff7a5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/globalState.js\":\"ddb6a131c1a18764\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/aliasClaimRederiveProcessor.js\":\"9bf24f450097985f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/ancestorBatch.js\":\"6698f066cdbc2990\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/blockTypeTypeifyProcessor.js\":\"69ab9cedbc0def9c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/clientSchema.js\":\"fa795dd61e89d387\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/commitPipeline.js\":\"551d84a3fd3a3ada\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/devAssertions.js\":\"474cacdd520c47db\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/firstSync.js\":\"1d1f7964b60232cc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/freshInitialLoad.js\":\"3ff29a907b430fd7\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/graphBackfillClaim.js\":\"d61ae86d81ac17f2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/handleStore.js\":\"297344852593e72b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/idleMarkerJobs.js\":\"db1996f696e9c4eb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/initialDownload.js\":\"7be54da018bc3bbe\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/initializeClientDatabase.js\":\"bdf3416d5e5cf6eb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/jsonCanonical.js\":\"7fb456266caa0b89\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/kernelInvalidation.js\":\"2e06646b62fe53fc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/kernelProcessors.js\":\"049f2f4733084d23\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/kernelQueries.js\":\"94692af0fd4a5600\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/mergeTypeMembershipProcessor.js\":\"ec78c6c37c377401\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/normalizeReferencesProcessor.js\":\"90bb99308354861c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/poolInstrumentation.js\":\"ee26d29e89b628c3\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/processorRunner.js\":\"49b4bca3fb4c26e4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyCellBackfill.js\":\"636e07e37b359a45\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyChildMint.js\":\"9f6e72fd7fe994eb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyChildrenProcessor.js\":\"868eb8da9222b713\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9ab0821a3e3bd0cc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyDefinitionSynthesis.js\":\"bf6874cd4440071b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyKeyScan.js\":\"417bc7aecb223220\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertySchemaResolution.js\":\"84f3e5ebab739669\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyValueEdits.js\":\"375bddc16550b4de\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/raiseProtocol.js\":\"18fa8c40734acc0b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/readBatch.js\":\"bae751682fe57b07\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/refProjection.js\":\"5f444918ded43656\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/referenceTargetLookups.js\":\"4d530b4e01e92022\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/referenceTargetProcessor.js\":\"323704797bf4c6d2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/replayMerge.js\":\"351d9c73a8ab4d62\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/sqlBinds.js\":\"a2fdf3a7177ac2d7\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"f441df0ec214c6b9\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/arrivalProcessors.js\":\"08110543092d1ee1\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/invalidate.js\":\"5459d454de890b09\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/materialize.js\":\"2f4aada92b84e572\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/observer.js\":\"93894b4ef76d6604\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/reconcile.js\":\"0cb3ed26a2d1bc1d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/timingMetrics.js\":\"45c5271c59174101\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/treeQueries.js\":\"1ae5bbc39abdbc05\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/txEngine.js\":\"5b7cf4d8e21e6db2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/txSnapshots.js\":\"530a84b5e7c3275c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/typedBlockQuery.js\":\"6654aeabd8130950\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/undoManager.js\":\"31388be7c222c4c9\",\"/knowledge-medium/pr-preview/pr-1909/src/data/invalidation.js\":\"1d911df637ba7430\",\"/knowledge-medium/pr-preview/pr-1909/src/data/kernelDataExtension.js\":\"99ab5a61d2e29cd3\",\"/knowledge-medium/pr-preview/pr-1909/src/data/kernelPage.js\":\"87c0c13e33d66ae9\",\"/knowledge-medium/pr-preview/pr-1909/src/data/kernelValuePresetCores.js\":\"54755a50fef5cdda\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localDbCorruptionSignal.js\":\"e702e6601983e463\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localDbStorage.js\":\"781072a6650a1f36\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localDbVfs.js\":\"0911297c3511546b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localSchema.js\":\"01dae4cb00ccb9fe\",\"/knowledge-medium/pr-preview/pr-1909/src/data/maintenance.js\":\"3f85496275d654e8\",\"/knowledge-medium/pr-preview/pr-1909/src/data/mergeProperties.js\":\"66c1c1d73f15c3fb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/metricsConsoleHook.js\":\"f187cd596909c955\",\"/knowledge-medium/pr-preview/pr-1909/src/data/migrationsPage.js\":\"6b42699a7df1e067\",\"/knowledge-medium/pr-preview/pr-1909/src/data/mutators.js\":\"6cfc30601fc3c072\",\"/knowledge-medium/pr-preview/pr-1909/src/data/orderKey.js\":\"1843269983dd7fcf\",\"/knowledge-medium/pr-preview/pr-1909/src/data/orderKeyPlacement.js\":\"aa0cb24a496b449f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/outlineSurface.js\":\"68883d282b201489\",\"/knowledge-medium/pr-preview/pr-1909/src/data/pendingEditorContent.js\":\"c599a7bfed3a9b01\",\"/knowledge-medium/pr-preview/pr-1909/src/data/pendingUploadsSql.js\":\"085f1334c358082d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/pluginStateExtensions.js\":\"870ddf73868b9b7e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/powerSyncLogger.js\":\"5831272f93ae4161\",\"/knowledge-medium/pr-preview/pr-1909/src/data/projectorRuntime.js\":\"87d119a37791df0b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/properties.js\":\"14fbb4abe4c6e882\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertiesPage.js\":\"f1c01e2e50b9c061\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyChildren.js\":\"fd031cc396e8676a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDefinitionFanout.js\":\"b35eeeb119aa7bbb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDefinitionMetadata.js\":\"e9f1adfffc70fbf5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDefinitionRegistry.js\":\"f757d8f9ed28f301\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDisplayMode.js\":\"480ca18dc68c355c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyRowCreation.js\":\"b80f288ae2d518db\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertySchemaCreation.js\":\"ff2c716f36c451ff\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertySeeds.js\":\"8d58a627d5abf7cc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/recentsPage.js\":\"5b774b78b5f4ad74\",\"/knowledge-medium/pr-preview/pr-1909/src/data/refTargetComparableProperty.js\":\"f0add62eef029685\",\"/knowledge-medium/pr-preview/pr-1909/src/data/referenceBlock.js\":\"26a087ed952c7d0a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/rejectedUploads.js\":\"b0cde5e607299d06\",\"/knowledge-medium/pr-preview/pr-1909/src/data/releasePowerSyncConnection.js\":\"aa54dbc36ee9f175\",\"/knowledge-medium/pr-preview/pr-1909/src/data/repo.js\":\"5237d73ea0125066\",\"/knowledge-medium/pr-preview/pr-1909/src/data/repoProvider.js\":\"9a3f5b93dd2ac23f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/rowProperty.js\":\"9328afb392424e1b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/searchFilter.js\":\"3ce838b2a0a299f0\",\"/knowledge-medium/pr-preview/pr-1909/src/data/seedIdentityLedger.js\":\"4f7a1f803134dc36\",\"/knowledge-medium/pr-preview/pr-1909/src/data/stateBlocks.js\":\"4c49195bb81928a1\",\"/knowledge-medium/pr-preview/pr-1909/src/data/structuralEditPolicy.js\":\"8e4a92b047dbf679\",\"/knowledge-medium/pr-preview/pr-1909/src/data/structuralInsert.js\":\"23933099096d13a2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/subtreeDelete.js\":\"4735e21085e20da1\",\"/knowledge-medium/pr-preview/pr-1909/src/data/syncStreamLock.js\":\"319478aea7f98a2c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/syncedTableSqlRecognizer.js\":\"9f23f8c51a85ff4b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/syncedTableWriteGuard.js\":\"264cf70c44ee1efe\",\"/knowledge-medium/pr-preview/pr-1909/src/data/targets.js\":\"2b57ca5cc85bfb47\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeColors.js\":\"168e548ba12432ee\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeDefinitionMetadata.js\":\"7f74a9af6d27ed5d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeDefinitionRegistry.js\":\"ae1dd3bbdbaf9542\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeExtraction.js\":\"3fc28b30abeb153e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeInitialValues.js\":\"4db3faee24450deb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typePropertyGroups.js\":\"1e3d857c7c9a54fd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeSeeds.js\":\"3a3e90e2118ae47d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeTagger.js\":\"40f1a0283bb05f6d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typedRecords.js\":\"e58c2e1af9bc8f24\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typesPage.js\":\"706459e0a2ccb857\",\"/knowledge-medium/pr-preview/pr-1909/src/data/userPrefs.js\":\"ba6c2211cc961bbe\",\"/knowledge-medium/pr-preview/pr-1909/src/data/userSchemasService.js\":\"3c57896e9cb3b89d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/userTypesService.js\":\"ea11026718de19fd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/valuePresetRegistry.js\":\"53b512eb7ca9a0dd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/visibleChildren.js\":\"48ebacd05a7723a9\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceConversion.js\":\"7d805e88e88a610e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceFirstSync.js\":\"0b09b38b6dc9aaf0\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceIdNamespace.js\":\"1bf7cb58bbc99145\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceSchema.js\":\"dedd7a68bc252778\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaces.js\":\"99e057c560890e72\",\"/knowledge-medium/pr-preview/pr-1909/src/data/writeAheadLog.js\":\"10f42651f84561cb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/BlockPasteShellDecorator.js\":\"6b944ee5aa7d7bee\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/atTrigger.js\":\"db071e5030dcc1ee\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/autocomplete.js\":\"97b93ef78800a35a\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/codeMirrorExtensions.js\":\"f906ba04c39943ef\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/contentFlush.js\":\"baa1a6ea7e692563\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/defaultInteractions.js\":\"b9b5ab5c12868661\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/editSettleSignal.js\":\"2da99966ff874950\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/insertImage.js\":\"152a153b2e422d3b\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/referenceCompletionRange.js\":\"b6afd0014300f876\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/referenceTargetTypes.js\":\"3178b9922ef16cdb\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/syntaxContext.js\":\"5c54f0641af041de\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/triggerMatch.js\":\"1f0f311f9330cb21\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/AppRuntimeProvider.js\":\"d05fd5fc7b7b0636\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/BlockFocusShellDecorator.js\":\"8d425785ca901e82\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/ExtensionRenderBoundary.js\":\"aa860a3e8af689a8\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/PanelContentRecovery.js\":\"31e4901e6bb9f24b\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/apiCatalog.js\":\"c32707d193ff8794\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/approveExtensionHere.js\":\"89525c168890176f\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/armedCutAppMount.js\":\"79d47ac19dadc0b7\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/batchableKeyedStore.js\":\"8b0f83dc0c493056\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/blockInteraction.js\":\"d9a86ce95c5b93c8\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/blockSelectionAction.js\":\"e7f2ee7bb86ba583\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/compileExtensionModule.js\":\"67adfa1ba38f2b6f\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/compiledModuleCache.js\":\"7ceee7e3733ec10e\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/continuousGestures.js\":\"7ec29d2e25535420\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/core.js\":\"d6b884787617dc51\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/defaultRenderers.js\":\"4f2bceb7361b3c5c\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/definitionFanoutAppMount.js\":\"52642f7adc4014b7\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/dialogAppMount.js\":\"ab0ecabf3f19ed11\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/dynamicExtensionSeeds.js\":\"765ab521ed104cff\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/dynamicExtensions.js\":\"972a5e9ac60b689d\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/exampleExtensions.js\":\"b0a755e6dd403408\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionApprovalStatus.js\":\"f38c021c1789bd4e\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionLoadErrorToast.js\":\"3d0ab2effac3f34b\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionLoadErrors.js\":\"34db3c0d6381cb40\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionLookup.js\":\"0c682515bd4c3f02\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionToggles.js\":\"016fc796552a264f\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionUtilitiesCss.js\":\"b4496f820b3d9157\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/kernelPageDeletionGuard.js\":\"dbc3bb95a429fbda\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/liveRuntime.js\":\"ef37750b5ce9226d\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/openExtensionsSettings.js\":\"86251f4a7fe22fb8\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/overridesCache.js\":\"247e1799d4615b8e\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/pluginIds.js\":\"df52d267d079689b\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/processorRejectionToast.js\":\"3ee522cc37a0939c\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/runtimeActions.js\":\"bc0d1f16b17bd953\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/runtimeContext.js\":\"96fa51ef9b863d87\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/staticAppExtensions.js\":\"736e6494477bcc82\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/staticDataExtensions.js\":\"4925d190e9b47706\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/toastAppMount.js\":\"1fee827724042783\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/useOverrides.js\":\"40bfeff492b94911\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/useShortcutSurfaceActivations.js\":\"9bfb067c06c5e3eb\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/discoverToggleTree.js\":\"ecdb775f7adfae67\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/facet.js\":\"433ea642d1497d4e\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/resolveAppRuntime.js\":\"eee5d69eadf2f115\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/runtimeEvents.js\":\"8965ada817be27c2\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/togglable.js\":\"456f1d43849643a0\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/variantFacet.js\":\"af14c6027934d057\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/verbFacet.js\":\"06fcc77677d7b5c3\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/block.js\":\"a81c07bdbac23db6\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/focusedChild.js\":\"6b785151602a3716\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/propertySchemas.js\":\"b9d5bccc736e9c1a\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/typeRegistry.js\":\"0c06ec18195c0645\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useAncestorCrumbs.js\":\"bae3f9d7129035ea\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useAutocompleteListbox.js\":\"01933f1e92beb669\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useDebouncedSearch.js\":\"919fd1fe7f64b8a4\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useDebouncedValue.js\":\"e5e526ec8c6bfda9\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useFacetValue.js\":\"0d9b16e12c1cc3c0\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useIsFocalRender.js\":\"70a919f2898fcce5\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useIsReadOnly.js\":\"4a68f8d0d85492b7\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useMaterializeBacklog.js\":\"ab1298944d605645\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useMinuteClock.js\":\"fbfbaa479bffe3e8\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/usePanelLayoutProjection.js\":\"e09cccb6c242ae31\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/usePendingInvitations.js\":\"4167e6820a409570\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useRendererRegistry.js\":\"5c8444bb45212dd1\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useRetainedFieldRows.js\":\"f779e3a53c3e682d\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useWorkspaces.js\":\"bc5708c8f2cbc50a\",\"/knowledge-medium/pr-preview/pr-1909/src/lib/utils.js\":\"51097ef40b7c58dd\",\"/knowledge-medium/pr-preview/pr-1909/src/main.js\":\"e47a139b6b605a51\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/MarkdownImage.js\":\"0a3d918b0756f2c4\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/blockSeparators.js\":\"d71a3daa69f4ea6e\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/context.js\":\"371bd21824ec5876\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/defaultMarkdownExtension.js\":\"d66c42fdf484577e\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/extensions.js\":\"1e3cc34c3201d57e\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/renderMarkdownHtml.js\":\"e33a12caeee3781e\",\"/knowledge-medium/pr-preview/pr-1909/src/minimal-editor.js\":\"3226f119fb25dd82\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/armedCut.js\":\"888e362fea0ea191\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/captureMediaVerb.js\":\"c7fb9a0543b1547a\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/clipboard.js\":\"8a763cb7a8d3ddc2\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/decision.js\":\"83a2e9fdfd5f3593\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/operations.js\":\"4a7724b4bd1f3864\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/account-header/AccountHeaderItem.js\":\"79189e3dabb3d0ef\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/account-header/index.js\":\"a5b2b1143c93c903\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"149a04d82c058216\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/askAgent.js\":\"92d50729a2ed0569\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/askedStore.js\":\"8eb2dd5ed2cd919e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cc5eeb1d70cc2fb6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/chipState.js\":\"6f172e910eae9e0d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2570232392714045\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/index.js\":\"45e6188ccedd051c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"2b88f6d4cd24cc4b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/schema.js\":\"b93e5718950ed38b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/AgentTokensDialog.js\":\"4efe24e71519d8be\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b07fc0d8b08e6d73\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/addMedia.js\":\"ef407ecf5c420e71\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/backlinks.js\":\"0bfc1f9ab083f8a1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/block.js\":\"3c8eaf76177c3fa1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/context.js\":\"cf1962396fecde39\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/displayIds.js\":\"32ef78afaf9bee3a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/index.js\":\"37fe64856829fec0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/outline.js\":\"509858f7f4ea0fd4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/properties.js\":\"8cfb00b06cf8822a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/refs.js\":\"218655e77feb5cdd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3bf31807224157a0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/search.js\":\"a34efcbc9ba57f45\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/shared.js\":\"fa1db0199a85746d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6b7c5677e852405b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/text.js\":\"2780a9a9e16462c1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentWrites.js\":\"f019ae3f9cd4bc15\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/authoringCatalog.js\":\"dbffaa3c0e8e9cc0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/blockRefTargets.js\":\"a8992f57d9c0fa6e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/bridge.js\":\"162d1978debba8dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/bridgeLoop.js\":\"09e3a2cdc4dfea82\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/changeHistory.js\":\"ac03c8bf3380a79f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/commands.js\":\"838f083f9996fde7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/commentsCommands.js\":\"4ffe78d5983692b9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/dataExtension.js\":\"807c5b3dbce6ed95\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/dataModelGuide.js\":\"3fed489af6f3e628\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/dayPropertyInputs.js\":\"9f119e5c8d1c38ad\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/describeRuntime.js\":\"cf9faeb677401718\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/extensionLint.js\":\"5598a73ba20a9001\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/grainAudit.js\":\"7ce4f3c19e9752bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/healthCommand.js\":\"3e45fbc63b3b0200\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/index.js\":\"c6eee8eb3a940033\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/presetIdentity.js\":\"ac205dac4bce2e7f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7e88b751c01a36fb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/readMedia.js\":\"fbad5362858f7db7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/schema.js\":\"1cd467263804cede\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/serialization.js\":\"b29c6ce0cec69c85\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/targets.js\":\"a6c5db5e6fd37496\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/tokens.js\":\"e011b3a7d6daf331\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/watchEvents.js\":\"e883385505e01405\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/workspaceGuard.js\":\"866619fea8a04dca\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/writeCommands.js\":\"e78d54acfa2951c6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/AliasCollisionToast.js\":\"9be4b3c6453f8159\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/DuplicateNameBanner.js\":\"07d9ce00f82eb8a0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/collisionMerge.js\":\"23f9dfcc45d23884\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/dataExtension.js\":\"d853f62a56e0d010\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/index.js\":\"149e3851d8b5aec5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/mergeCollisionAction.js\":\"2ac06a0b2a4c7d36\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/pageStyling.js\":\"491bd9a4e11d4d15\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/rejectionToast.js\":\"8858643bc54b52f6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/syncProcessor.js\":\"5bede15e17b2aa54\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/actions.js\":\"6576f003410377c8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/addComment.js\":\"eecdb2155ee83fbe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/anchor.js\":\"34ec39123576761b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/anchorState.js\":\"898034fb1e6fed56\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/commentLinks.js\":\"1edda3db28bd55ed\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/confirmThreadDeletion.js\":\"c83caaf319e7b852\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/container.js\":\"fd18159ad03d95a0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/dataExtension.js\":\"1fd6dee64d30b664\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/deleteComment.js\":\"ab3c9444f0ff66ad\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/highlights.js\":\"d141838baa0e1b58\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/index.js\":\"314db262086147cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/linkedCommentsPill.js\":\"08080ae11899581f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/margin.js\":\"0b9e7858e8dd0b2f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/marginAnchorLinks.js\":\"eb188f2f103b18ce\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/marginSchema.js\":\"6c56a12feef919bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/newComment.js\":\"c962ee6e57f75d49\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/ownThreadPicker.js\":\"3cd398df1ade845e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/placement.js\":\"4b96a2597758d2b4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/queries.js\":\"8a6e8f64bafd543a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/quotePosition.js\":\"7fc71b5ec7270417\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/quotedIn.js\":\"f74e9e197d6889d5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/quotedRange.js\":\"1bfa86f323ca3d88\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/rangeRefs.js\":\"785c316dcc004f9c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/readHighlights.js\":\"9fb9e0f6a819e445\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/readSelection.js\":\"082860385878dc39\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/readSelectionUi.js\":\"beb154c0e1afaf48\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/reanchor.js\":\"646f693b2bbb5cd5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/schema.js\":\"ba970795b72d958f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/scope.js\":\"7adacaf732c0e8f4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/scopeThreads.js\":\"29c474d41683a68c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/splitRetarget.js\":\"7dd4b00f711d2756\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/suggestionCard.js\":\"edb94601f40aabf1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/suggestions.js\":\"88a81ab03ab684de\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/summaries.js\":\"1819803376199e82\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/summaryBatch.js\":\"6d8515d396cc322c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/surface.js\":\"3846d37940ad09c7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/threadNavigation.js\":\"98b36092a94d7496\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/threads.js\":\"dcf004c42eccf41e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/ui.js\":\"17494b2318aa215b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/uiStore.js\":\"41e85def81b64a68\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-intents/appIntents.js\":\"8ed32fc6f4c8aa7c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-intents/index.js\":\"40d13ea76d41dd81\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-update-prompt/index.js\":\"7f806429c65cb46b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-update-prompt/status.js\":\"a5e51558b9d035d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b60c9435b27f7d9d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/MediaBlockRenderer.js\":\"2ac8f44a676992d8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/MediaDownLaneReplicator.js\":\"56a5bce246e95939\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/MediaUploadReconciler.js\":\"9c38df6ff88026c3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/assetDownLane.js\":\"cd30699b60f33676\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/assetResolver.js\":\"1bdd49e80e6fd4c9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/assetUpload.js\":\"1305c04567f5e59c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/attachmentCleanerIO.js\":\"7afad92e205fd148\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d4d9e824acfc8d70\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/blobStore.js\":\"5707f7b734dd92db\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/browserMedia.js\":\"09f017d5e63f4407\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/byteStore.js\":\"828bb7a9a06ec101\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/cleanerIO.js\":\"03f880dd4e913010\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/cleanupAttachments.js\":\"ffdbab61af2abbbd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/dataExtension.js\":\"91f7f6cec015a061\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/downLane.js\":\"a7bd67a5ef9c9774\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/index.js\":\"cad70493f4cb7581\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/insertImageContribution.js\":\"c24dcee2de462d15\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/laneArming.js\":\"8ff6856770b91752\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/laneLock.js\":\"42d43f1993f3b885\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaBlock.js\":\"c6b635e00969565a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaCapture.js\":\"4fbd8fe28b402a13\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaLanes.js\":\"b497fee484ce56bb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaViewers.js\":\"05e2153fe12f8b1b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaViewersFacet.js\":\"bca5a78efafad0ce\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/pasteCapture.js\":\"451f1f2436f752f2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/resolver.js\":\"023da7dfe8409e98\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/retryUploadsAction.js\":\"00804e4727aa3376\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/storagePaths.js\":\"6e352b31fc4b9714\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadDrain.js\":\"7af03d46042cb4e8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadLaneStatus.js\":\"7f1e7613a1e08d8a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadReconcile.js\":\"0756ed2e5368b186\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadRecovery.js\":\"290ad01291f45470\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadStore.js\":\"04b3f0d85a588084\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/useAssetObjectUrl.js\":\"c9a84db72f3cf40c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d75b9ed15415d9d3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/BacklinksViewSection.js\":\"648060ecc444f671\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/facet.js\":\"5296da91e03b8c96\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/index.js\":\"f2750955d848803b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/prop.js\":\"a798570fa9b621bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/BacklinkFilters.js\":\"e0b7b05ee0fb6d34\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"af3f85c0a4d90d71\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/BlockEntry.js\":\"82cdb14e2e1dec96\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/LinkedReferences.js\":\"d38decafa4dc8691\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ab7e92a2a9ed6cb0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/dailyNoteDefaults.js\":\"8455c114bb8e0489\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/dataExtension.js\":\"3efe27769942cf5b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/edgeExclusions.js\":\"91369a9442e12dc0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/filterProperty.js\":\"19b95942bba5357f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/index.js\":\"41c7d25f1a5996e5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"239cea1b61531143\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/applies.js\":\"886100565c451e4c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/countQuery.js\":\"1e4a2736b35d9e93\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d2483476f29ad34f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/index.js\":\"0f6db45fdab1d4cc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"92593200acd6f2f1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/presentationInvalidation.js\":\"3767dd9b8f4f4cf4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/propertyEditorOverride.js\":\"6a8ffd14c963f759\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/propertyFilter.js\":\"f64d0196f96c4193\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/query.js\":\"aecfd17d9f98386b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/resolveFilter.js\":\"baf8e19231060170\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/sourceBatch.js\":\"d2dc0434770eee3d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/sources.js\":\"1811c8279f8935cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/useBacklinks.js\":\"a578bfc183dbc1e3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"69c68a667ec696fd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/BirthdayCelebration.js\":\"f1a14a526afd152e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/BirthdayOverlay.js\":\"fab127de1bdf09d7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/gate.js\":\"a06111cc60fb4b88\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/index.js\":\"f28c22f855d8b7cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/wolfTheme.js\":\"84462947adc0e69f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/BlockDragLayer.js\":\"bdcd546b8fb9f1d5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/dragController.js\":\"44d7e293a01a5a9c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/dropTarget.js\":\"78ffe32a15578bc1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/index.js\":\"130dc0d9397cd8d8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/projection.js\":\"df97062e17eeb8ba\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-info/BlockMetaCard.js\":\"b2b9d6588135cc4f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-info/index.js\":\"b33e875dde14f126\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/AddTagDialog.js\":\"0f367c694bfeea3d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"320cbce11f17c12d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/TagNameIssueHint.js\":\"09ac258c8c9d4155\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/addTagAction.js\":\"358ec82f97c9d6ce\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/appendTag.js\":\"47af16097ecdc618\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/config.js\":\"f8f7c078c14e7734\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/dataExtension.js\":\"0c4dba44a23d4ec4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/index.js\":\"4b37d9dc0213a4c8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/propertyEditorOverride.js\":\"3c17a978fb9826b8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/BreadcrumbList.js\":\"51df2af89dab24d9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"2f3c516f42cf4b16\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/Breadcrumbs.js\":\"cb2d0835f4ca56b7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ea333901a0901cfc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"b07674ddad0cdc7f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/index.js\":\"fda4cade8caffe83\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"a5bebb45f85378c6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/CharacterCountItem.js\":\"4bc7b44fed61511a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e6b9497d84964073\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/actions.js\":\"1ab42386c72b9b86\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/blockType.js\":\"e1a5e9b045ffd797\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/charCount.js\":\"a49a9e9af417a946\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/dataExtension.js\":\"82342544ada35f2c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/index.js\":\"ad6b16608c6ae5f1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/profiles.js\":\"62a49874b15e08ef\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/properties.js\":\"0136100636ed18ba\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/subtree.js\":\"2c7046e25d91adbd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/textCounts.js\":\"82ac436505a4ec94\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/colemak-keybindings/index.js\":\"5cd99fb51c07e406\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/CommandPalette.js\":\"3a5fe9a5fd3fdfec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/HeaderItem.js\":\"de72eaf16e5e4b81\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/context.js\":\"87ea610d3064207e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/index.js\":\"4356cb88f9fc40fe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/selection.js\":\"d7297131adb7d7c2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/toggleStore.js\":\"c730b4aad2a7e863\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/useCommandPaletteActions.js\":\"bfd0951660d11687\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/ContributorBadges.js\":\"1baab963e23cbad7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/ProfilePicture.js\":\"90e1728b69e5298d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/author.js\":\"b9cf953b45b62bc0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/codeMirrorExtensions.js\":\"a37eb91354939fdb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/dataExtension.js\":\"f6aef01c1fee55a8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/index.js\":\"c40da45f28650eb0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/mentionAutocomplete.js\":\"871bce7fc55792ee\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/processor.js\":\"b03c7b32e3399d85\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/profiles.js\":\"622112ba064f8da6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/queries.js\":\"88f5563752169c35\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/schema.js\":\"2cb6d5b21559fa32\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/useCommentAuthor.js\":\"a8f61d981d45f85e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3931b5eab31895f1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f16ed7468edc39df\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/index.js\":\"e7de0bc6b07960b0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"579e94c34ee559ab\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5107061f3c3e1f7e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/CalendarGrid.js\":\"c7de92d4e27269bc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DailyNotePicker.js\":\"30023480f5894a6d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"41a2b04158295de1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DateNavDecorator.js\":\"3c06f8969ac38271\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DateScrubOverlay.js\":\"59ab972b7eafa03e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DayPropertyControl.js\":\"bd9194113fd16fd3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DayValueReferenceControl.js\":\"d22ba2b8643d0646\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/HeaderItem.js\":\"565b5fc5ec906c79\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/ReschedulePicker.js\":\"7b9a41d29f9e7b5b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5a9145b05eb1ed8a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/actions.js\":\"1c503e40159aa6dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/blockDateAdapter.js\":\"4a91b7865a5115a7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/calendar.js\":\"7e1eebae8ba2f104\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dailyNotes.js\":\"529ab98e2800ef95\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dataExtension.js\":\"0ba673694ac78a69\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubActions.js\":\"4d3d7496fc0423c4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubGesture.js\":\"ecfecc1c79d5510b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0b41b955a71c5bc0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8f18820499b09cf7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dayProperty.js\":\"c8df07e798d57aa0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"08f97dc16c85d425\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/deletionGuard.js\":\"312a2ff13e28f1a8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dueQuery.js\":\"e487b6f844f169d3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/index.js\":\"1422c9aae658acde\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/landing.js\":\"1f9c60e5ded2e72d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/localSchema.js\":\"ebc6d5fa5b9c320f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/referenceDateAdapter.js\":\"da2a6211ae7da6e7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/rescheduleAction.js\":\"e5d63b74b8e4fbdd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/schema.js\":\"1dad9efc20459afa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/spreadBlockDates.js\":\"9f80a5d08000906a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/spreadDatesAction.js\":\"0d9d73fdf325a88c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/today.js\":\"e7994f6f5bebf2d5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a3d9ea9ca93af30c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"0f93029912bc0fc7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/audit.js\":\"3620597a78ac61e3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/auditAction.js\":\"4992de0dd0766271\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/auditRanges.js\":\"f3b34c4ed0b0c00e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/diagnosticsSource.js\":\"ed27dfe0b1d3ba07\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/divergenceScan.js\":\"9f9415cdbba31b59\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/index.js\":\"250497d347c72222\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/propertyChildrenChecks.js\":\"93ac78fe0638b9dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/referencesMirror.js\":\"25b60e4f6caecfb3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/rowJson.js\":\"24b0585dfe0d95c6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/schedule.js\":\"4d1cdbcd5f81ec4b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/store.js\":\"8f4fd963b1398f69\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-maintenance/action.js\":\"830885d30eb7c852\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-maintenance/index.js\":\"8e5da7059f2be0d3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-maintenance/plugin.js\":\"92e3eaccd135a0bb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"71116e275d263588\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/actions.js\":\"a11e207593455a69\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/changeMarker.js\":\"62be01e927ebd0c8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/diagnostics.js\":\"42805addd23a245c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/fileSystemAccess.js\":\"d8089d3b3d5c02f3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/filenames.js\":\"50d00fd87fa2a511\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/index.js\":\"0df73008bba7a3f1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/mirror.js\":\"4554c584b1e2b076\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/runLock.js\":\"7983a75c324f3833\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/runtimeHealth.js\":\"aff390db44f41a59\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/schedule.js\":\"4ed9111d33914f7e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/store.js\":\"f9c6cf948cea61ca\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/default-themes/index.js\":\"c356d9c14216c700\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/default-themes/themes.js\":\"de857dab31504859\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/diagnostics/facet.js\":\"914b25b2d22aded1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/diagnostics/useDiagnostics.js\":\"120e1fac8ee73731\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/dismissals.js\":\"2bb594679f9f31b4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/index.js\":\"572e6dc9d86252ae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/status.js\":\"31fdfa748fb0c826\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/store.js\":\"e7ce6b4a09cd1b9e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1632ffeb9d52880a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3a87ab7f30274a28\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/actions.js\":\"2af175e73fa50098\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/config.js\":\"dcef8a9fe408faaf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/dataExtension.js\":\"8683b7c1573e85e7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/effect.js\":\"cbb9627288ec5c36\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/index.js\":\"a362088c8530b747\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/propertyEditorOverride.js\":\"f63743a2c4dc3069\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/useToggleTree.js\":\"79a1205eabff27fc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/ExtractTypeDialog.js\":\"b60066fcec2888e5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"05ee5e3a907e56d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/PropertyShapePicker.js\":\"c145b76ffc72004f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/action.js\":\"3dad6c4d2d1679ad\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/index.js\":\"0cb1b9424340c066\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/FindReplaceDialog.js\":\"b8c816c82009995d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/HeaderItem.js\":\"1e9457e2bd7d3a64\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/dataExtension.js\":\"bc3fbc4251e96a18\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/index.js\":\"b03d2b6d6e4228e8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/search.js\":\"3ecff1d8fca7e41a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/toggleStore.js\":\"f53e8918f63bf9c5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/LocationPropertyEditor.js\":\"e8552e8241a59a42\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/MapView.js\":\"83d98bf1192e91fd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/blockTypes.js\":\"2246af0f98fb7bfd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/codeMirrorExtensions.js\":\"ff8eb1937149bf52\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/createOrFindPlace.js\":\"fcce72a3adbda0b4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/currentLocation.js\":\"8200827b2b517b3d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/dataExtension.js\":\"0b6c868c09b0f525\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/geoContentDecorator.js\":\"50f713166dbfc18c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/googlePlacesClient.js\":\"064c608a181bc9a5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/index.js\":\"524fec83fa8a1c3b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/locationsPage.js\":\"b84a0ff8c7b0fd35\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/mapViewport.js\":\"27468e3d12b77408\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/pickCurrentLocation.js\":\"897a2999126190e6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/placeAutocomplete.js\":\"905bd31478c54a54\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/placeNameCollision.js\":\"b06c850338be2c61\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/properties.js\":\"4267f43436dafdb1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/propertyEditorOverrides.js\":\"4e4d3f1d0de9fc56\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/query.js\":\"b61260583c607f5d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/usePlaceSearch.js\":\"2d5d0bc17984f986\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"e61aa6ce594610e7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"6ca9a3b017997441\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"8c0d2afee19925ba\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/config.js\":\"36ba73fe27267e73\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/dataExtension.js\":\"4b9be49c1b66b49e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/facet.js\":\"604e012fe2b4c394\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/grouping.js\":\"2a78da284d817105\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/index.js\":\"802ecf5f40365d87\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6ef5c20c0c366123\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/query.js\":\"a74075774a5564e5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/resolveConfig.js\":\"dbbf1d5e0bb79d6d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c6fc564c77ffe042\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"584e1a92a5556dd7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/HtmlDocumentContent.js\":\"42b1a78d18d8e627\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/HtmlFrame.js\":\"7fe819150e6fa0e0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/actions.js\":\"15b116bc584b168d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/blockType.js\":\"1ed41c5ea054dadf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/confirmRunScripts.js\":\"309ccdf08e6188e1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/dataExtension.js\":\"1d7e6b0e722c451f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/frameAnnotations.js\":\"9d22bb9d9e5ecf67\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/frameDocument.js\":\"0af5aed6b0e5d4a4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/frameTheme.js\":\"9cfd1fad7667a60d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/index.js\":\"fd12a89d9ea98e67\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/scriptConsent.js\":\"f9e0b7d0964d0795\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/sourceMap.js\":\"26c5b2ae44b2cfa0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/useDocumentScripts.js\":\"0a3e9eaadeb84135\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/index.js\":\"1019565fbe9f3dee\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/record.js\":\"afa575c11a622108\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/recordStore.js\":\"1e061ba212a69d52\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/responsiveness.js\":\"1ec5370d281d07b8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/schedule.js\":\"98cc5d350bad279e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/sessionContext.js\":\"7cb2f4062a37e869\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9d4fa29ce8d9ad00\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"db000c559014f782\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/actions.js\":\"2050a5f76155b2a0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/config.js\":\"3f0a7f26d6c84169\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/dataExtension.js\":\"e5993cea92e60e69\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/effect.js\":\"4cf6246b5a1bf850\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/index.js\":\"0ecc82a09d59cd74\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/keyCapture.js\":\"5ffa1e371fc5cdec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/overrideStore.js\":\"ff1415435a757fb4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0ea7f1a551ae7be6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/HeaderItem.js\":\"fa78f69144a79684\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/LeftSidebar.js\":\"b2037623da5951c2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/actions.js\":\"ce248b4e7bf8487c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/facet.js\":\"fada900d7aa95ea9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/index.js\":\"c33a2025cff01448\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/shortcuts.js\":\"e88565be46be687b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/toggleStore.js\":\"15c33ab5298da4f2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/MergePicker.js\":\"39417c28d0ee69b9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/index.js\":\"12cfa5c791d6b939\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/mergeAction.js\":\"4f96784a6618f433\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/strategy.js\":\"8e24274f0d0d940c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/Button.js\":\"7c52dbccf7f0da6a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"61dfabbfd9b94354\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/defaultItems.js\":\"56242b23c963e92a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/facet.js\":\"db84323b31ca88eb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/index.js\":\"cfc68a7e7444acf8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"671a0e4473bb9d12\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a7b46810bad697cd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5cb714e3b8a42045\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/facet.js\":\"569eb8faee5e9e5c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/index.js\":\"19d57d6d22a08895\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b99cc5b675023a30\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/blockSubtreeMembership.js\":\"fa9badaee6cca58d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/contextMenuItem.js\":\"156e5bd58d282573\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/index.js\":\"95485edaa8c1af10\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/moveAction.js\":\"4e16d967eabe5dd7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/moveBlocks.js\":\"64029c8436d455ec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/selectionAfterMove.js\":\"2c06fd6d736619c2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/TutorialBanner.js\":\"cd35728855752e84\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/action.js\":\"95d8e152b37c79e0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/bannerDismissal.js\":\"0575c88deefcaa92\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/documents/cheatSheet.js\":\"77bb1ff34febe2ff\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/index.js\":\"c284d95522ad62d7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/keys.js\":\"f5c24b8dfeeb7a42\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/landing.js\":\"4ced91b963aa0df1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/outline.js\":\"d57b2ff76bed7cad\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/seed.js\":\"cc466dc2f34e9b4a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8acd9f9ca499f840\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/analyze.js\":\"a43c019ce740a411\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/diagnosticsSource.js\":\"9e0a4c6c9ec48f90\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/index.js\":\"b12c36422ca616d9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/load.js\":\"e6393bab2659bb49\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/monitorRun.js\":\"3039e1e3bbb504dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/schedule.js\":\"f651a9ff95015314\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/series.js\":\"36490211e5ec70b4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/store.js\":\"03c8ef1c077d790f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/trendAction.js\":\"a97e8354fdde14c2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/verdict.js\":\"20d94026be10e4ec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/plain-outliner/clickToEditAction.js\":\"b2e98b87b95f8ee7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/plain-outliner/index.js\":\"9542759603910644\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/plain-outliner/interactions.js\":\"ca6515910b5e8c0a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2356019e9f1f57cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/MigrationGate.js\":\"74978d632813ec25\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/MigrationGateDialog.js\":\"4adc2a2cc83ff741\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/action.js\":\"ed9b80697985ebd1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/index.js\":\"3367d59a33e0db40\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/localRunMessage.js\":\"12eb47ce098d0c8d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/plugin.js\":\"ba4ead2d7b702178\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/progressReport.js\":\"33036175ec911f96\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/sweepProgress.js\":\"f2064397d8e22541\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/FieldRowRenderer.js\":\"630153c266df0e16\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/ValueRowRenderer.js\":\"1bdff3c5144ff630\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/actions.js\":\"296ad81c71882f7d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/autocomplete.js\":\"4539cee2b03fa00b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/fieldRow.js\":\"481f32d8eb8e6f6b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/index.js\":\"2ebec03a715a1d04\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/referenceWarning.js\":\"b80f6506992f3a56\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/valueAutocomplete.js\":\"12c4a721ad0ecc62\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/valueSchema.js\":\"ed301eb314bd953d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/HeaderItem.js\":\"c7df7da5c1be3a8b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/QuickFind.js\":\"30521270c62df7ea\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/index.js\":\"8658b20aa9734223\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/recents.js\":\"834d840edef83e19\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/resultItems.js\":\"4b3b4d59e57e559b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/selection.js\":\"edd0c8efa11f96a0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/toggleStore.js\":\"6006133cdeadb16f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/HeaderItem.js\":\"3cf235690ce087d0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d6011183876d5985\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/grouping.js\":\"dd5ab3c00bb7c04d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/index.js\":\"3a3291876908aa5c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/target.js\":\"efab94a7e65caafc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/codeMirrorExtensions.js\":\"0716d54152cfe818\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/contentPrefill.js\":\"03e48785868d0e01\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/dataExtension.js\":\"45026c1013a7b08a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/index.js\":\"02c4c5bf7dd1ed45\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"4451f622757560e8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/invalidation.js\":\"7499a40ff4f127f5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/localSchema.js\":\"64830728814d2843\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/blockrefs/index.js\":\"832355207616cf55\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"81dd9cb30c4d3275\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/index.js\":\"dacaeac20e617091\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/referenceNode.js\":\"3fff8051ff647915\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/remark-reference-occurrences.js\":\"78e57f28dbbf5077\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"60c2cf3109d9b575\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/index.js\":\"46f931a074a6de22\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7355ff997f0b2a15\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"63cf2ade294bafe9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/mergeRetargetProcessor.js\":\"cd09b6fe8330eadc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/parseFence.js\":\"92df3d524893a682\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/referenceParser.js\":\"b14d1c3524d920c9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/referenceProjection.js\":\"a2bd7a479cf49c8c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/referencesProcessor.js\":\"f84c69b31f3f0ec9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/renameProcessor.js\":\"ed299377d991e4c1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/spanReplacement.js\":\"01cb70e63884c796\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/htmlToOutline.js\":\"bf700dade82dbe05\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/index.js\":\"3fe6292d58c67690\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/normalizeClipboardDom.js\":\"71ca3cc9b2c736d9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/pasteDecision.js\":\"cc4b1edbfaf5fc7d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/action.js\":\"6a6b94cc80b29456\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/blockIds.js\":\"c28a53271ac3b4b7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/content.js\":\"9fe12c4ee6d922d2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/effect.js\":\"d1a16f9572fcc8c4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/ids.js\":\"d29c819310737c77\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/import.js\":\"bac08975400a8fe2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/index.js\":\"eab9a3dc8f6dd6c0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/plan.js\":\"d2487c8bb945a083\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/plugin.js\":\"154d8080b777c769\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/promotion.js\":\"f96fa99c5eac4fb4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/properties.js\":\"2547d95a56d8b0b1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/references.js\":\"6d5c099294c7d461\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/report.js\":\"61f8741eca5db1d5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/roamMemo.js\":\"6d0d127c9ec21aa0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/runtime.js\":\"11e65171900875b5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/schemaReconciliation.js\":\"716fbaa2abbf1092\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/srsMarkers.js\":\"b2b1fd44f8225cd0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/todo.js\":\"1bf34a8291b4e867\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/typeCandidates.js\":\"f0fbf11a283cb7ae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/types.js\":\"55def1678fd57a59\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/search-health/index.js\":\"e4034549d0b239fa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/search-health/store.js\":\"b7f79698b49d3f83\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/HeaderItem.js\":\"cbe1490a068e3cf6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"671a7c143766abc3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/index.js\":\"e731c66d765b9d6f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/model.js\":\"9fa78a6e6f750864\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/toggleStore.js\":\"35618f82dcbf83be\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/useKeyInspector.js\":\"167b3c1e32ebf5ff\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"18b2c918a392ad81\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/ShellDecorator.js\":\"f1f107b3556ca040\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/actions.js\":\"e7da785a56317197\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/exclusionsFacet.js\":\"60499cd2e7f45768\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/index.js\":\"911f703d20ecbf5d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/shell.js\":\"ed541cbb4360be6a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/surface.js\":\"c1264bc78cc404f9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/walker.js\":\"6422e26d0d5bd848\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8947311a150b29cd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/dataExtension.js\":\"d845682737c268d9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/index.js\":\"75293cba904e03e2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/indicator.js\":\"df7110a67023afce\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/moveSrsState.js\":\"6fb0743d20f06120\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"c73d1239e8729603\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/scheduler.js\":\"e19cfc24f279c947\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/schema.js\":\"84ae886547969caa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"cfbe2f7a31290c86\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/srsClipboard.js\":\"185acd48ce4cbf83\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"24c931ccb520689b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9c8ba63737782cea\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/DeckPicker.js\":\"bf7237012c46d004\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/ReviewControls.js\":\"079731fdf9bfaa6f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8b11a45409f13526\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/ReviewSession.js\":\"1332787813c4ff78\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/actions.js\":\"c5381c1eceebb344\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/archive.js\":\"894102b58e0f1963\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/dataExtension.js\":\"72ab687f79fe9926\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/deck.js\":\"8e13253270eb160e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/dueQuery.js\":\"b0fa9ff1342de716\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/gradeDecision.js\":\"80b628deebfdb5b5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/index.js\":\"819b32a65bfd3a7e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/keyHints.js\":\"1c865bb3e0853415\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/reviewCardLayout.js\":\"6a97cba65f126432\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/reviewProgress.js\":\"8961f7ad31668178\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/schema.js\":\"f53c24167edb96e7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/useDueCards.js\":\"e80be98a0e44b44d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/startup-metrics/index.js\":\"0eb4d857323c30f6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/startup-metrics/record.js\":\"fcec7e7e013589bf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/storage-persistence/index.js\":\"696967fb52bccc5d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/storage-persistence/persistenceStatus.js\":\"c7e0a30f2d0b5eae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/storage-persistence/requestAction.js\":\"177b3d90ccd1a239\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/TypeChipsDecorator.js\":\"1b637dedae4d88a0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/codeMirrorExtensions.js\":\"0269bb49ba340c1f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/index.js\":\"a781c29cc5a450d2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/typeAutocomplete.js\":\"967f1b9ad5fdc9c5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"7d1e596e21e81305\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/actions.js\":\"c44f177a9e2e8fe1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/anchor.js\":\"93be630e1cfbade3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/events.js\":\"5d26821fb5508a73\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/gestureActions.js\":\"461cbc5500d49c57\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/index.js\":\"7b570259176c7d8e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"cc313c8d9eaa9b68\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/sync-metrics/collect.js\":\"dc923fbd9cc43781\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/sync-metrics/index.js\":\"025129c3099afe7d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/sync-metrics/record.js\":\"fe563aec6abf27e7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/RejectionDialog.js\":\"4c486bafe3be4f61\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/SystemStatusHeaderItem.js\":\"910ffba6b569856f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/index.js\":\"35e85874aba54e9a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/model.js\":\"2a82858bc2bafcf8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/queueCounts.js\":\"cc1fb540ffd75e35\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/rejectedHelpers.js\":\"5658825021f81c9f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/rematerializeAction.js\":\"32ae871f377eb8fb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/useHysteresis.js\":\"5768f7bca732cdd8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/ColumnHeaders.js\":\"020ca300770d9573\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/QueryUi.js\":\"28b8a37df8921420\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/TableLayout.js\":\"39ad0507e7ebb8f4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/actions.js\":\"8ecc96da5df37c40\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/cellEdits.js\":\"0ba2e55744015aa1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/childrenViews.js\":\"807890650d854dbd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/columns.js\":\"d85c54ab811c081a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/controller.js\":\"1c29024eb49bd1a8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/convert.js\":\"6dea80d3b0d981aa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/dataExtension.js\":\"8e1dde4a17e7b511\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/index.js\":\"7c5322b5f3a255ec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/keys.js\":\"5c29f6abeeed03de\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/model.js\":\"b7c585a60d717063\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/QueryText.js\":\"e627f2b050a1fb64\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/backfill.js\":\"a614ed3c7a5bdcc6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/completion.js\":\"9550d5c79e373797\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/format.js\":\"83741340b0c498f1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/parse.js\":\"220b7c7d35eb4472\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/queryValue.js\":\"81d2e7abdca098ba\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/registrations.js\":\"4061366f49b4741d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/source.js\":\"c89f396318eda13b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/registry.js\":\"88a05b6f28534beb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/rowGutter.js\":\"f895ca2cde90175a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/rowVerbs.js\":\"c58f94a37fbfb3b9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/schema.js\":\"92815d45aa5f4fcc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/sort.js\":\"27c731ac0744b79f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/theme-toggle/effect.js\":\"27584b64292bc0d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/theme-toggle/index.js\":\"bff8b5da9c682340\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/theme-toggle/theme.js\":\"a0861a8d8413457b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/actions.js\":\"943b425847b5fc5c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/dataExtension.js\":\"814d3cdbc3bfd41a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/index.js\":\"b58e1049d23a1cb2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/schema.js\":\"0b245d37eafa8fbd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/TouchSelectionLayer.js\":\"58aaed79e5cd34a1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/actions.js\":\"4812bdda379d5622\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/defaultItems.js\":\"6fec7b2a39e084bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/facet.js\":\"35c540908501523c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/holdRecognizer.js\":\"909ff1b56a5d215b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/index.js\":\"12f8d63aa73398b1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/update-indicator/UpdateIndicator.js\":\"a164b25bd69c4c8d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/update-indicator/index.js\":\"c80d407a81ad9a85\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/update-indicator/loadTimes.js\":\"cbe72c35000493eb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/VideoNotesRenderer.js\":\"4f2e1175f5c85a54\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/VideoPlayerRenderer.js\":\"1fdf37a195cc6aa4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/VideoTimeStamp.js\":\"3b7a64bd3279073f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/actions.js\":\"53c3bfe9cd1fc6b1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/index.js\":\"0c3ccf3ecfe4253b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/markdown.js\":\"35b98016dccb7f2b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/notes.js\":\"ef5358b3c6c185e9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/registry.js\":\"1e906bbe7addb0ba\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/remark-timestamps.js\":\"991f883cbbc5d9c6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/view.js\":\"c82b403749d2e061\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/LinkHints.js\":\"f0a6db8f90f5eed9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/index.js\":\"423a032caabd0a25\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/model.js\":\"d1bda73436c8a9cd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/settings.js\":\"82b6a18e669da18d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-normal-mode/actions.js\":\"842caf97f02fee8e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-normal-mode/index.js\":\"6879b19fcbbe9e94\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-normal-mode/interactions.js\":\"1f5e2a1863113785\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/workspace-header/index.js\":\"9da1009be8ae8eaa\",\"/knowledge-medium/pr-preview/pr-1909/src/registerServiceWorker.js\":\"23b5c663de021612\",\"/knowledge-medium/pr-preview/pr-1909/src/requestPersistentStorage.js\":\"f6840ff733999e95\",\"/knowledge-medium/pr-preview/pr-1909/src/services/authRequestDeadline.js\":\"da952da9a49fb7ed\",\"/knowledge-medium/pr-preview/pr-1909/src/services/authStorage.js\":\"fc9efc19e665eaaa\",\"/knowledge-medium/pr-preview/pr-1909/src/services/powersync.js\":\"ff6579440f630c49\",\"/knowledge-medium/pr-preview/pr-1909/src/services/supabase.js\":\"9a892b1883163110\",\"/knowledge-medium/pr-preview/pr-1909/src/services/uploadErrorClassifier.js\":\"b4dd51acf01fe600\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/ActiveContexts.js\":\"d0bc9c2fe7e2a385\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/HotkeyReconciler.js\":\"7fa59ebaae5896d4\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/WipeLocalDataDialog.js\":\"fece14670b49d5b5\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/actionDispatch.js\":\"77de87099fe9346e\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/actionRefItems.js\":\"80117d7e86586d92\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/applyKeybindingOverrides.js\":\"65e085be163b28eb\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/blockActions.js\":\"cc095b1b50380a5e\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/blockMergeGesture.js\":\"14be77ef0655c03c\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/canonicalizeChord.js\":\"c229c43d81b2239d\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/defaultContexts.js\":\"2b69a947427270b4\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/defaultShortcuts.js\":\"eb42a58815cfc4af\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/effectiveActions.js\":\"8afb30ed6b874de2\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/gestureAction.js\":\"d213b40203a9a800\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/gestureBinding.js\":\"76c004d5ba531832\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/holdRegistry.js\":\"e144486a371eb162\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/keybindingConflicts.js\":\"58be4ee92acfc3a7\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/keybindingOverrides.js\":\"aff313fb0540ca1f\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/pointerAction.js\":\"821c216ff953a975\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/resolve.js\":\"2988079732de4a38\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/runAction.js\":\"0f94f94077071360\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/sequenceMatcher.js\":\"f9c8cd06124aec0c\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/types.js\":\"04b84b7ebf82cf2c\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/useActionContext.js\":\"9a2c18e1593a9c07\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/useActionDiscovery.js\":\"de5f897a3ed6f9d0\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/utils.js\":\"2c314b3c00365820\",\"/knowledge-medium/pr-preview/pr-1909/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1909/src/sw/bootStore.js\":\"f4dca8a3f928ad63\",\"/knowledge-medium/pr-preview/pr-1909/src/sw/previewDatabases.js\":\"68af1bb0ab690230\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/byteTransform.js\":\"1ceafd45d8e50956\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/attachmentCleaner.js\":\"1b7de50254a1a351\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/attachmentParts.js\":\"52c62aa15d1d4ab3\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/bundleParts.js\":\"a9fa82d7485d7af6\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/bundleRecord.js\":\"634915b9c5db6647\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/manifest.js\":\"f4e0cedfefca29ac\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/takeBundle.js\":\"528d0417b9f5c23e\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/verifyBundle.js\":\"c918f315bfb4903e\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/cleaningStage.js\":\"fc5d0a3603dd0cc4\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/conversionKey.js\":\"308d14976aef4351\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/conversionServer.js\":\"efdb694a44e5b42b\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/flip.js\":\"5ee6979ecabbcd6e\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/flipAttempts.js\":\"63067c818b24d550\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/pages.js\":\"9ed464292143ddbd\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/preflight.js\":\"44dc7d16aab99b30\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/reseal.js\":\"0829b76c87d33df5\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/runConversion.js\":\"0a5eada865f6033a\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/runLock.js\":\"ece1aecb4727b307\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/sealing.js\":\"de82876baae031ae\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/sealingStage.js\":\"f1b1227d3ae83903\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/stage.js\":\"f6f80e0dd2937dcb\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/verifyReseal.js\":\"ffec8d01c50490b9\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/aad.js\":\"9dfc5c56db7e92fe\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/aead.js\":\"79e9074321691b99\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/base32.js\":\"7626ac2d7871b111\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/base64url.js\":\"bdb9d930abf3cb0f\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/binaryEnvelope.js\":\"e3079e4df5af2aac\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/byteAead.js\":\"1958e94b5ac1699d\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/canary.js\":\"47c0e23747880194\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/contentHash.js\":\"ae4027944619fc09\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/contentKey.js\":\"4e8286fb8139aca4\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/derivedIdNamespace.js\":\"b0fc022397da0ebe\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/envelope.js\":\"7a2dd7c77eaaf9ab\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/hex.js\":\"1cbea0f7f7494018\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/sha256Hex.js\":\"6ca3846b3d626abb\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/workspaceKey.js\":\"ff4dd0733ba0736c\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/conversionState.js\":\"2f22c34fa7d396af\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a30b51f33639033d\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/pastedKey.js\":\"74df174b913548ff\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"55419312176f9a67\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/upgradeWorkspacePin.js\":\"18003ac64fd8306e\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/keyStore.js\":\"38f96bebff08ea4e\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/mintWorkspaceKey.js\":\"1f7c38e78105391c\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/modePin.js\":\"13452eab9fb2ab8b\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/openWorkspaceKeys.js\":\"320569ae6fe2d0fa\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/resolveWorkspaceEntry.js\":\"e4778ae2180c6520\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/resolver.js\":\"2a57a435e051058d\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/workspaceAccess.js\":\"5e31691a87701eb9\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/transform.js\":\"0db3e4106a81e2af\",\"/knowledge-medium/pr-preview/pr-1909/src/themeBootDefaults.js\":\"352edddb754f5e12\",\"/knowledge-medium/pr-preview/pr-1909/src/types.js\":\"b4e7a824c1f17ed8\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/ClientLocalSettings.js\":\"b6eb0a3a9923ec97\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/abortableSleep.js\":\"7b196089f444ccad\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/array.js\":\"7780aafb4ba1ee57\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/backlinkAutocomplete.js\":\"be84ee369cdcc3fa\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/blockCrumbs.js\":\"00107723fe796093\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/blockrefAutocomplete.js\":\"727692e56634d15e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/cadencedIdleJob.js\":\"34d018c5715b0434\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/callbackSet.js\":\"3101466231d4ae34\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/clientId.js\":\"6284c2e6671c9f5a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/codemirror.js\":\"2996122ac8c207f7\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/codemirrorCompletion.js\":\"bca1cd0a717965b6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/copy.js\":\"8cdbda87a251f261\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dailyPage.js\":\"8dc124adf6930f4b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dbForensics.js\":\"c3fb4fa3f56e07d9\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dbForensicsHooks.js\":\"5adf917533c35565\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/deleteBlockThroughUi.js\":\"39f11c5c2c27b7a6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dialogs.js\":\"0c2b80b31e138ab1\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dom.js\":\"635be57f6c11c9f5\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/downloadBlob.js\":\"60a3c7306e681cb5\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/drawnWalk.js\":\"59cbb3fe44d0b283\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/exportSqliteDb.js\":\"9c3526f7c8e07c85\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/fileSystemAccess.js\":\"dbbed252ccf1f11c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/flipSlide.js\":\"9268ef2b49a4cb2c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/fnv1a.js\":\"496e0b17b01a677e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/formatBytes.js\":\"f973aacc29b7ecff\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/fuzzyRank.js\":\"cccfe713c89a0873\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/idbKeyedStore.js\":\"580481b5b2529454\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/idleCallbackPolyfill.js\":\"408e654b75ec7a33\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/keyboardAwareScroll.js\":\"449e99b88b0c9e45\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/keyboardViewport.js\":\"7d076f542a460d1a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/lastWorkspace.js\":\"66c12b6ac1f584bd\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/layoutColumns.js\":\"768d7f90b3815c9c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/layoutSessionDom.js\":\"8d83603bc96243b0\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/layoutSessionId.js\":\"e9390e99e53c2f8e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/linkClickGestures.js\":\"340215ee56850e85\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/linkTargetAutocomplete.js\":\"6fb5126fae9bc3e2\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/localDbCorruption.js\":\"bd28a5e16232a6c8\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/localDbRecovery.js\":\"fc81890f587f36fc\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/markdownParser.js\":\"8dbcfce74cd78aaf\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/memoize.js\":\"a15227684f82a1a1\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/nameFieldCommit.js\":\"18e002899e02e9ae\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/nameList.js\":\"30d3c47433541c1f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/navigation.js\":\"5e3fc994d0e1f28b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/omnilinerNamespace.js\":\"3eca799e82d6b68d\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/opfsPageScan.js\":\"59aa274cef7652ca\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelClearance.js\":\"30d2d54a6a0aacd4\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelHistory.js\":\"b7d194b12d0f593c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelLanes.js\":\"c2d8b6693054448f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelLayoutProjection.js\":\"972bdd2bcf388948\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelScrollAnchor.js\":\"63e6699beea4f457\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelUrlFlags.js\":\"17ff4a7977b24295\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/platform.js\":\"964583459eabdff5\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/pluralize.js\":\"59047bf404a50cfe\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/propertyCreation.js\":\"db916b56c2bc0afd\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/propertyNavigation.js\":\"a0a7e0371e09dd51\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/propertyValueContext.js\":\"c37f3432aac49c5b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/react.js\":\"c1e5c540b8fb5ee0\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/relativeDate.js\":\"5d984e8b8c459ca7\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/relativeTime.js\":\"7ec6515a6400e377\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/renderScope.js\":\"ebcc827df3760f25\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/resolvedThenable.js\":\"051ddcf653260790\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/routing.js\":\"2c1094035c32ed0a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/safeMode.js\":\"4711042cebeaaf8f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/scheduleIdle.js\":\"35862e1122164ad6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/screenWakeLock.js\":\"9dbbc4807729afe9\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/selection.js\":\"9ca2dd2c1bde32b5\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/softKeyboardGrab.js\":\"897377b0351f9f7e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/startupTimeline.js\":\"0aab16df240a457f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/state.js\":\"7dc96b8cf3d86e89\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/string.js\":\"6d20c4ea02e4b5f3\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/surfaceZoom.js\":\"553d771a484b6187\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/time.js\":\"7cadcc59924c4d43\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/toast.js\":\"a15aabc146e97a75\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/toggleStore.js\":\"21e4a2b0fe8dcdbe\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/untilStopped.js\":\"5392699116087186\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/userActivity.js\":\"03acf19a4e037c84\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/viewTransition.js\":\"bfbf499948be6172\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/viewport.js\":\"ed8acc28b581c186\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/webLock.js\":\"e3e2142e48244e1a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/workspaceRecovery.js\":\"0dc315632d8473c6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/workspaceSnapshotStore.js\":\"f39657f9acf939d5\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-compiler-runtime.js\":\"6ec556d3c9a7fdf9\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-client.js\":\"15423f3bb6d8cf2e\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-server-edge.js\":\"27c1f7711144b51d\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-server.js\":\"3a6240be1d3e2c3e\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-static-edge.js\":\"819436180d305de6\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-static.js\":\"f56127dbb7c31243\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-test-utils.js\":\"cdda7b19104a691a\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom.js\":\"d3ddcf1108225589\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-jsx-runtime.js\":\"973fa09e902f656d\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react.js\":\"94de362b166d5741\",\"/knowledge-medium/pr-preview/pr-1909/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1909/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1909/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
