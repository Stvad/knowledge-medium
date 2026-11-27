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
		buildId: "c3b4f9714530-80d3c0ab",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1909/\":\"1f77a04372f411ea\",\"/knowledge-medium/pr-preview/pr-1909/index.html\":\"1f77a04372f411ea\",\"/knowledge-medium/pr-preview/pr-1909/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1909/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1909/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1909/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1909/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1909/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1909/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1909/assets/FacadeVFS-BYG6hFNN.js\":\"8703b9fc08c7f8bd\",\"/knowledge-medium/pr-preview/pr-1909/assets/OPFSCoopSyncVFS-DrfjZxeL.js\":\"9302f77db7a9f934\",\"/knowledge-medium/pr-preview/pr-1909/assets/OPFSWriteAheadVFS-BNMtVWO9.js\":\"ad235577265f5d00\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-DIQBJ8c2.js\":\"4963aa318bd61438\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-async-BjmK_6lG.js\":\"f70a240f927e6c02\",\"/knowledge-medium/pr-preview/pr-1909/assets/worker-DxjFgKKP.js\":\"f3e50a034194ce53\",\"/knowledge-medium/pr-preview/pr-1909/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1909/chunks/app-5hf2esN-.js\":\"2bb613ae2ec6308e\",\"/knowledge-medium/pr-preview/pr-1909/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1909/index.js\":\"e5613d491ae4ad61\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1909/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1909/assets/AccessHandlePoolVFS-Df5kh66x.js\":\"908971e8bc903d01\",\"/knowledge-medium/pr-preview/pr-1909/assets/IDBBatchAtomicVFS-B2HwPhTc.js\":\"6c4775fa42e30901\",\"/knowledge-medium/pr-preview/pr-1909/assets/MemoryVFS-CWt7eNSJ.js\":\"0c8190839777b2bb\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-BGmcFZMc.js\":\"63f06aeac077e213\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-async-Dm9b4O02.js\":\"03dcc88ed51d720a\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1909/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1909/chunks/AccessHandlePoolVFS-Ci4xy5AD.js\":\"5e3ff1129c6ceeda\",\"/knowledge-medium/pr-preview/pr-1909/chunks/FacadeVFS-DSygCnQw.js\":\"b3fac309b34ff25a\",\"/knowledge-medium/pr-preview/pr-1909/chunks/IDBBatchAtomicVFS-C6DASiUq.js\":\"e30558b9c4ead7fe\",\"/knowledge-medium/pr-preview/pr-1909/chunks/MemoryVFS-Dgffdaj3.js\":\"84068cb6c1705685\",\"/knowledge-medium/pr-preview/pr-1909/chunks/OPFSCoopSyncVFS-R3s-ewYo.js\":\"bea57b3a61d648ba\",\"/knowledge-medium/pr-preview/pr-1909/chunks/OPFSWriteAheadVFS-DKVxGdEZ.js\":\"d86f97930b528368\",\"/knowledge-medium/pr-preview/pr-1909/chunks/Preview-BeASm35h.js\":\"a9c4db8e22cc87de\",\"/knowledge-medium/pr-preview/pr-1909/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1909/chunks/card-hbL9Hs07.js\":\"b9b3d00a3c8f8c4e\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dist-DL7WPZ1f.js\":\"d91a928e3a10c86b\",\"/knowledge-medium/pr-preview/pr-1909/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1909/chunks/mc-wa-sqlite-CSq9d5Ra.js\":\"995faf7bb70065c1\",\"/knowledge-medium/pr-preview/pr-1909/chunks/mc-wa-sqlite-async-CIHLCvaJ.js\":\"2e88995fc6b8ce51\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-3YtlzNpg.js\":\"a8847b7fdd1783a8\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-7xLmmw4a.js\":\"46139c36c23e9365\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-8NsfkdOz.js\":\"8effa86cf10f9e48\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-BDJV7kCA.js\":\"b4736f92c3713738\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-BGmEjK8X.js\":\"845986c51a660b7b\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-C0mIp1C7.js\":\"3feb16fc7aa5e54d\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-DWRqKRWo.js\":\"0c52ec63d0f0c8dc\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-DgEm1vZM.js\":\"6be2d790476831c9\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-dom-server-legacy.browser.production-CtMNfT9r.js\":\"b56bf4885e92e1df\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-dom-server.browser.production-F3cF6tXf.js\":\"59308279c24d8739\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-dom-server.edge.production-DhiPVSd9.js\":\"3054445d6c4eac7d\",\"/knowledge-medium/pr-preview/pr-1909/chunks/server.browser-CPT62Yc0.js\":\"0117f6bb960deb59\",\"/knowledge-medium/pr-preview/pr-1909/chunks/textarea-BtUzz6FG.js\":\"450676b819eb98cb\",\"/knowledge-medium/pr-preview/pr-1909/chunks/ui-09oNBD5m.js\":\"c238ffd1222f60fe\",\"/knowledge-medium/pr-preview/pr-1909/chunks/wa-sqlite-PGnhFjL6.js\":\"f8b8c0a4e7a92ab1\",\"/knowledge-medium/pr-preview/pr-1909/chunks/wa-sqlite-async-DuiqrMyw.js\":\"ad906e855f32b94a\",\"/knowledge-medium/pr-preview/pr-1909/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1909/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1909/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1909/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1909/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1909/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1909/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1909/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1909/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1909/src/App.js\":\"f7f3e06687357382\",\"/knowledge-medium/pr-preview/pr-1909/src/appUpdate.js\":\"d77cecbbeacbbdee\",\"/knowledge-medium/pr-preview/pr-1909/src/appVersion.js\":\"0bfcc20c07a4122f\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/initialLayout.js\":\"d63f2f0c488ba951\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/openWorkspaceData.js\":\"c92013e6607728a8\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/resolveWorkspace.js\":\"32b976b9af1319fe\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/workspaceBootstrap.js\":\"492d47b761c68c16\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockComponent.js\":\"a17f00fba6890ff0\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockCrumbs.js\":\"6eb81006fd71344c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockEditor.js\":\"470ad2bf7443adba\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockLoadingPlaceholder.js\":\"9f2204f6a101f32f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockProperties.js\":\"be8a7b60b39d0362\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockSearchPicker.js\":\"ca9e0c6707f70ac9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ConfirmBulkDeleteDialog.js\":\"51f547d67c73759a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/DividerHandle.js\":\"5fb90b4d67cf3cac\",\"/knowledge-medium/pr-preview/pr-1909/src/components/DraftEditor.js\":\"ce9d8eff2dff88b7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/GutterPill.js\":\"6e482cb9763338fe\",\"/knowledge-medium/pr-preview/pr-1909/src/components/Header.js\":\"77ad6a254daaaf0b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/LazyBlockComponent.js\":\"827f9d4b03eeb168\",\"/knowledge-medium/pr-preview/pr-1909/src/components/Login.js\":\"9ae12fb6250ef1da\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ZoomableSurface.js\":\"c42c0bae8b7768fc\",\"/knowledge-medium/pr-preview/pr-1909/src/components/editModeKeepalive.js\":\"38fc4f0076fec54a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyDisplay/PropertyDisplayScope.js\":\"30ecb5ab42f65752\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"5b1198e765ba1586\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/RefPropertyEditor.js\":\"511e06d712dbfa76\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/RefTargetTypePicker.js\":\"0ee2eefed8e32389\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/SelectPropertyEditor.js\":\"c2e9279f81662569\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/TypesPropertyEditor.js\":\"5ca51592ae43a7bf\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/defaults.js\":\"1f91ad3a3e7a30e2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/kernelValuePresets.js\":\"c0c0ebdb2a418c74\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/selectablePresets.js\":\"29f7776974e83a82\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/typesPropertyUi.js\":\"e4557f6da3083672\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/AddPropertyForm.js\":\"8eb980eaf24b1947\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/PropertyPicker.js\":\"81fb621429aadee0\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/PropertyRow.js\":\"890ce876a58ff30f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/Rows.js\":\"ede54308c5d7f975\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/actions.js\":\"a5ebafaa48c6444b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/declarationOnly.js\":\"7c9167ed0fcb72ef\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/layout.js\":\"8ccddc530cce454f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/model.js\":\"68a17457accae107\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/shapeUi.js\":\"a91371190aa809a8\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/shapes.js\":\"e4fa7a4857eada64\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/usePropertyEditingActivation.js\":\"eb331e48f5cdcb34\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/visibility.js\":\"e2d9a90e72305ee3\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanelSections.js\":\"2235c9368afb6e8b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/BlockEmbed.js\":\"52b1942cbdbda6ee\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/BlockLink.js\":\"5da0945dca130887\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/BlockRef.js\":\"abe0a907e4797873\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/CompactReferenceLink.js\":\"ff1fb860159b68f9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/ReferenceLink.js\":\"48a63ea707d7b66d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/cycleGuard.js\":\"8dcfe33a762a778b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/cycleGuardContext.js\":\"16e790b909ad7e7a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/linkInteraction.js\":\"7c1a84f142d92125\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/referenceLayout.js\":\"1a9ba482d12350de\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/useBlockRefAncestors.js\":\"cc41b09fa70fb4e9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockGutter.js\":\"6650a034f3efbbeb\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockInfoDialog.js\":\"aaea8b4f997f32f4\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockReadText.js\":\"3550b7181cb5175c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockTypeBlockRenderer.js\":\"50985ac7548d08ee\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BulletHoverCard.js\":\"efe64a2a203f6db0\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/CodeMirrorContentRenderer.js\":\"022357fd12419421\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"a88f98e2fbc11168\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/ColumnResizeHandles.js\":\"bcf5af889319b8fd\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"0c158c5c3c05d7d3\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/DefaultBlockRenderer.js\":\"a02cc24e82d41ec7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/LayoutRenderer.js\":\"a14147d923f2d7a5\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/MarkdownContentRenderer.js\":\"9aa7ed89d1563e0a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/MissingDataRenderer.js\":\"b4b7712455ef042c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/PanelRenderer.js\":\"6a0ea748076508ac\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b7688dedf9bfc48d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/TopLevelRenderer.js\":\"ec66f012c3b43999\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/blockGutterMode.js\":\"fb65b09b93ff79d8\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/blockTitleText.js\":\"b421159e4f10f97f\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/fieldCreationKeydown.js\":\"bf18f8e71d54d12b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/layoutRootContext.js\":\"0bf801554b79c1c8\",\"/knowledge-medium/pr-preview/pr-1909/src/components/typeChip/TypeChip.js\":\"b9abc2b75cb5d754\",\"/knowledge-medium/pr-preview/pr-1909/src/components/typeChip/chipStyle.js\":\"f0e6e8f4fc69d485\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/anchored-floating.js\":\"2ae25162d1d32f30\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/button.js\":\"d8a760cd8cac83c3\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/card.js\":\"cfbca77dd0da2fea\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/checkbox.js\":\"8e4dee78f880a5ea\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/collapsible.js\":\"2e76ee2bec7f0cea\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/command.js\":\"9a13aa9386c84b56\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/context-menu.js\":\"19b9efe7b6547465\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/dialog.js\":\"8b8301b1a3977a22\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/dropdown-menu.js\":\"c7caaa5f09bc226c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/floating-listbox.js\":\"addd58bd0909dce2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/index.js\":\"e3ba6b8658f85aec\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/input.js\":\"adafcdc8e8f1517d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/kbd.js\":\"f87ec97f56633aea\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/label.js\":\"ea54f626b328579e\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/textarea.js\":\"20089f86a1496618\",\"/knowledge-medium/pr-preview/pr-1909/src/components/useEditModeYieldKeepalive.js\":\"2ba328c0efcb1cfd\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/BootFallback.js\":\"782156aee59bc009\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/FocusedRowLazyMount.js\":\"6065a2e1f1a3e2d8\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/LazyViewportMount.js\":\"28f6cb1c4c20ec6c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/LocalDbCorruptionFallback.js\":\"7a2e28e2b4e19290\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/error.js\":\"5649732e9901c6bd\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/lazyMountRegistry.js\":\"2e42e014a3b078fc\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/suspense.js\":\"768b059256323d54\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/CreateWorkspaceDialog.js\":\"83a25e522eb41831\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/PendingInvitations.js\":\"35f3481bc69d8a66\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/SyncProgress.js\":\"efa2585141231164\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/UnlockProgress.js\":\"40426b5c8bb9d216\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceKeyGate.js\":\"c2757702c0e6ae70\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceSettingsDialog.js\":\"5cfb5527708afac6\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceSwitcher.js\":\"6ab86d55de7e4f29\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceSyncGate.js\":\"065cac1ae41849ce\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/ConversionFlow.js\":\"9a83c1e1e9ab9e88\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/ConversionFlowHost.js\":\"18dec5e07a7c5be4\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/EncryptionSection.js\":\"28b7b67e10f33e4d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/attachmentPrompts.js\":\"2898d4c52080dd81\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/bundleFolderPrompts.js\":\"dbbe6ec417c3656b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/conversionFlowDeps.js\":\"0bf6b7ee5610da38\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/conversionFlowStore.js\":\"810b3b7ae92a0c4b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/flowUi.js\":\"98c72ff52b4056f9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/useConversionRun.js\":\"e697a9122f9e16b3\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/keyUi.js\":\"43f4bce142bbdc77\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/useCloseOnKeyLoss.js\":\"686f973c6e16eca1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/useCloseOnServerE2ee.js\":\"59ada10642b69574\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/workspaceUnlocked.js\":\"0076afb147ceaf69\",\"/knowledge-medium/pr-preview/pr-1909/src/context/backgroundSubtree.js\":\"837455a114567cc7\",\"/knowledge-medium/pr-preview/pr-1909/src/context/block.js\":\"573fc42a150f4600\",\"/knowledge-medium/pr-preview/pr-1909/src/context/layoutWsContext.js\":\"bf38deae2f82c36f\",\"/knowledge-medium/pr-preview/pr-1909/src/context/propertyDisplay.js\":\"3cd3b70cac5bc0e7\",\"/knowledge-medium/pr-preview/pr-1909/src/context/repo.js\":\"8f0ccc0aa71d6095\",\"/knowledge-medium/pr-preview/pr-1909/src/data/aliasClaim.js\":\"fc7ac6fa41bbf815\",\"/knowledge-medium/pr-preview/pr-1909/src/data/aliasSeatNamespace.js\":\"7c7b27f0bc0420a7\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/blockData.js\":\"9387dfc1e8ce0684\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/blockType.js\":\"ec7151d0a3b4673a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/changeScope.js\":\"d1fa288cf0a36958\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/codecs.js\":\"ac3c48af32f21f3f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/derivedData.js\":\"1c8d84c2761081fb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/errors.js\":\"a90d29d0bfac4c0b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/events.js\":\"bd134b6b400f3c03\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/handle.js\":\"e3a3b62494305c9a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/index.js\":\"c9c4c26de3010eae\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/mutator.js\":\"08272bac4fc487de\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/processor.js\":\"ec4a24ca49a78866\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/propertySchema.js\":\"ef9370e258c359b9\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/query.js\":\"e2358192c8ba87bd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/sameTxProcessor.js\":\"5e3d10f751f995b6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/schema.js\":\"e3a3b62494305c9a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/tx.js\":\"e3a3b62494305c9a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/typedBlockQuery.js\":\"554543c6db7dfefa\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/user.js\":\"488018d17eeb77ce\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/valuePresetCore.js\":\"d5a870b3f726e369\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/valuePresets.js\":\"9aca279024fa495a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/attachmentCleanerIOVerb.js\":\"1e16591346132fda\",\"/knowledge-medium/pr-preview/pr-1909/src/data/block.js\":\"4b1f832fa7cd6beb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockCache.js\":\"bf7c1ec1c2186ea0\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockId.js\":\"050344c24cb97e6c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockLiveness.js\":\"c4d3d66d6994f22a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockMerge.js\":\"932a18c30ae7ac3c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockSchema.js\":\"d5a4a03c91f4c680\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockTypeLookup.js\":\"08c5c6b77313a9db\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockTypes.js\":\"d0d30c40c05d70ec\",\"/knowledge-medium/pr-preview/pr-1909/src/data/childrenView.js\":\"10250a0f833a97bd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/clientContext.js\":\"1b798d1caac183ad\",\"/knowledge-medium/pr-preview/pr-1909/src/data/dbFileSiblings.js\":\"2f664d032ef9cfb6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/definitionSeeds.js\":\"20d22bd8681d6d26\",\"/knowledge-medium/pr-preview/pr-1909/src/data/derivedIds.js\":\"8d7303bda253980a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/drawnSubtree.js\":\"ffb28283142ce192\",\"/knowledge-medium/pr-preview/pr-1909/src/data/facetBridge.js\":\"b25aff5d6803f240\",\"/knowledge-medium/pr-preview/pr-1909/src/data/facets.js\":\"095ae374d0ce50fb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/globalState.js\":\"f6154230f7171289\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/aliasClaimRederiveProcessor.js\":\"dd2d94dc7fa225e7\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/ancestorBatch.js\":\"2a0752ff64c87414\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/blockTypeTypeifyProcessor.js\":\"c6435f5f83cda0a4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/clientSchema.js\":\"c9be49b1561eeeeb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/commitPipeline.js\":\"f5d969ef52abf1eb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/devAssertions.js\":\"9faf16940f6e1572\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/firstSync.js\":\"be5df31f4c70bae7\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/freshInitialLoad.js\":\"e15593103891c528\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/graphBackfillClaim.js\":\"a4ff648996d5c3be\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/handleStore.js\":\"b8c85f3f3d56271d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/idleMarkerJobs.js\":\"713c035f2636c0e4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/initialDownload.js\":\"9fca0469dbd4ddcb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/initializeClientDatabase.js\":\"767b47f572ffb437\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/jsonCanonical.js\":\"08c801cf0e217f1e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/kernelInvalidation.js\":\"fa215de2c2178c0a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/kernelProcessors.js\":\"1394e28a5c9ace53\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/kernelQueries.js\":\"8bc929fbb6e9a622\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/mergeTypeMembershipProcessor.js\":\"33c866a20f6c3206\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/normalizeReferencesProcessor.js\":\"8b910eef67a53592\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/poolInstrumentation.js\":\"6aa9b4a2476c835f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/processorRunner.js\":\"c5284709b882cb93\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyCellBackfill.js\":\"882991c7e0a75ff4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyChildMint.js\":\"17b6180b4878ecf8\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyChildrenProcessor.js\":\"08ccfbe59d309e3c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyDefinitionChangeProcessor.js\":\"38977757a2345e62\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyDefinitionSynthesis.js\":\"ae646fa1146a3b4c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyKeyScan.js\":\"14e1885805beff76\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertySchemaResolution.js\":\"82aea1861bf2ad10\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyValueEdits.js\":\"22fd8a97d5a190e5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/raiseProtocol.js\":\"35711f2c1293e03a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/readBatch.js\":\"7b3a1f13cc147333\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/refProjection.js\":\"b02c7c43e66693aa\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/referenceTargetLookups.js\":\"acd785f42e590473\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/referenceTargetProcessor.js\":\"b25b17821636ff5b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/replayMerge.js\":\"804d1d938e019270\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/sqlBinds.js\":\"316c4ba7d802b3fd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7bb004328c6e7a94\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/arrivalProcessors.js\":\"47ed017fe5f5a560\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/invalidate.js\":\"0c5750d5409b197a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/materialize.js\":\"399960319d10b24c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/observer.js\":\"d756fad6b2dde338\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/reconcile.js\":\"925e5b1005ebe2d4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/timingMetrics.js\":\"66518c643c8c5566\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/treeQueries.js\":\"5a761d4f3c5645a5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/txEngine.js\":\"4ac045e233cf3bee\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/txSnapshots.js\":\"d5d7dceca6a56181\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/typedBlockQuery.js\":\"a7d17d884986fd1f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/undoManager.js\":\"a5620581a0d72938\",\"/knowledge-medium/pr-preview/pr-1909/src/data/invalidation.js\":\"f08b158e4336f4d8\",\"/knowledge-medium/pr-preview/pr-1909/src/data/kernelDataExtension.js\":\"387da945c57aa104\",\"/knowledge-medium/pr-preview/pr-1909/src/data/kernelPage.js\":\"95d6db2f9f8bc027\",\"/knowledge-medium/pr-preview/pr-1909/src/data/kernelValuePresetCores.js\":\"a707d529230e7451\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localDbCorruptionSignal.js\":\"a7afd8e2ae2c3a21\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localDbStorage.js\":\"8a0d3b9c35a90078\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localDbVfs.js\":\"0468473249b98653\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localSchema.js\":\"cfcaaa9166c61831\",\"/knowledge-medium/pr-preview/pr-1909/src/data/maintenance.js\":\"2cb12a00fb68d519\",\"/knowledge-medium/pr-preview/pr-1909/src/data/mergeProperties.js\":\"5f1c2143674d1028\",\"/knowledge-medium/pr-preview/pr-1909/src/data/metricsConsoleHook.js\":\"d9699869794effb5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/migrationsPage.js\":\"10e3e7323a556d27\",\"/knowledge-medium/pr-preview/pr-1909/src/data/mutators.js\":\"f5199b826c30d45d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/orderKey.js\":\"c1dcfb17d9008c34\",\"/knowledge-medium/pr-preview/pr-1909/src/data/orderKeyPlacement.js\":\"eb73fe9011b7431b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/outlineSurface.js\":\"0e2a817832334263\",\"/knowledge-medium/pr-preview/pr-1909/src/data/pendingEditorContent.js\":\"49e0da2cd1ce0d71\",\"/knowledge-medium/pr-preview/pr-1909/src/data/pendingUploadsSql.js\":\"9f7b6267f76099a2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/pluginStateExtensions.js\":\"b4ffe9d5d7998b1d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/powerSyncLogger.js\":\"7fb52f1c22430e7c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/projectorRuntime.js\":\"b221c476759991f8\",\"/knowledge-medium/pr-preview/pr-1909/src/data/properties.js\":\"6e33f99aff567fe3\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertiesPage.js\":\"abbaa19f6527bf46\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyChildren.js\":\"cb83fffdcd853217\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDefinitionFanout.js\":\"9165fa556cb0c812\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDefinitionMetadata.js\":\"80f982b24a7ace33\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDefinitionRegistry.js\":\"4e0c779e32bccc4e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDisplayMode.js\":\"a47281ecfe5cd287\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyRowCreation.js\":\"1d4aa535b12d4d61\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertySchemaCreation.js\":\"b4a48e4bf574a131\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertySeeds.js\":\"a654b768c217b0d3\",\"/knowledge-medium/pr-preview/pr-1909/src/data/recentsPage.js\":\"aa5e6b968b0780fc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/refTargetComparableProperty.js\":\"26f9298f534b2284\",\"/knowledge-medium/pr-preview/pr-1909/src/data/referenceBlock.js\":\"e9a8a0c11f96e730\",\"/knowledge-medium/pr-preview/pr-1909/src/data/rejectedUploads.js\":\"0efaaf8a5db6e67e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/releasePowerSyncConnection.js\":\"9826075756fcf257\",\"/knowledge-medium/pr-preview/pr-1909/src/data/repo.js\":\"bbe5ad4a6850fdad\",\"/knowledge-medium/pr-preview/pr-1909/src/data/repoProvider.js\":\"e9a28dd2f9c35a7c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/rowProperty.js\":\"338f2964460e91e4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/searchFilter.js\":\"3df556f85e4874b5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/seedIdentityLedger.js\":\"2122b9fbfefc0429\",\"/knowledge-medium/pr-preview/pr-1909/src/data/stateBlocks.js\":\"eabef2bedd998f77\",\"/knowledge-medium/pr-preview/pr-1909/src/data/structuralEditPolicy.js\":\"37d0fe7142c74039\",\"/knowledge-medium/pr-preview/pr-1909/src/data/structuralInsert.js\":\"1ba5206929c37856\",\"/knowledge-medium/pr-preview/pr-1909/src/data/subtreeDelete.js\":\"cf8a33af32cd3878\",\"/knowledge-medium/pr-preview/pr-1909/src/data/syncStreamLock.js\":\"b5fd61cbe82f1cd2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/syncedTableSqlRecognizer.js\":\"67047adf1676179d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/syncedTableWriteGuard.js\":\"550827738c1890fb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/targets.js\":\"4da7c8afa1a00fbc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeColors.js\":\"c1525e0a8f0fc065\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeDefinitionMetadata.js\":\"227f77f7c02e4362\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeDefinitionRegistry.js\":\"ccddb50d2505eb70\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeExtraction.js\":\"dccf3200dd473d87\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeInitialValues.js\":\"2f1413d3dfef0404\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typePropertyGroups.js\":\"6236be1cc7a02be6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeSeeds.js\":\"acfa1eaae80cc11f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeTagger.js\":\"03beec222302ea8a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typedRecords.js\":\"1e49ebbb2438e66b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typesPage.js\":\"26545ded37a5ffd0\",\"/knowledge-medium/pr-preview/pr-1909/src/data/userPrefs.js\":\"7fe890f4503f5e55\",\"/knowledge-medium/pr-preview/pr-1909/src/data/userSchemasService.js\":\"57516bc0abe82ffd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/userTypesService.js\":\"dbd59bf9782a6d87\",\"/knowledge-medium/pr-preview/pr-1909/src/data/valuePresetRegistry.js\":\"a315f93aece571f7\",\"/knowledge-medium/pr-preview/pr-1909/src/data/visibleChildren.js\":\"fd3ec1a5f34cdf38\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceConversion.js\":\"342b38e1c7f7cdc8\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceFirstSync.js\":\"1d9e70f4bd3daf46\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceIdNamespace.js\":\"6460c30b22f4b0e4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceSchema.js\":\"2835e22ffabf8dcf\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaces.js\":\"d6e6ac8ed2d6a2f0\",\"/knowledge-medium/pr-preview/pr-1909/src/data/writeAheadLog.js\":\"60beff64fbe23b66\",\"/knowledge-medium/pr-preview/pr-1909/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/BlockPasteShellDecorator.js\":\"20169df1e1e8a647\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/atTrigger.js\":\"b01abe6d50bd57db\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/autocomplete.js\":\"4ff97c05e246b854\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/codeMirrorExtensions.js\":\"f9bd29cb390bab78\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/contentFlush.js\":\"b075bab7777d9eaa\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/defaultInteractions.js\":\"63eb6da3e2b796bd\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/editSettleSignal.js\":\"a96ac264dc491224\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/insertImage.js\":\"954f2b09611b487f\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/referenceCompletionRange.js\":\"b18b0878118f9a70\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/referenceTargetTypes.js\":\"17ff7983e4341d44\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/syntaxContext.js\":\"c0ce91cc2203a46d\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/triggerMatch.js\":\"472600c03294a83a\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/AppRuntimeProvider.js\":\"b9050e238250c288\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/BlockFocusShellDecorator.js\":\"9e39d998607a21b3\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/ExtensionRenderBoundary.js\":\"63f416877c0e5481\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/PanelContentRecovery.js\":\"04ec519eeea07585\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/apiCatalog.js\":\"64d1023c85b00b2d\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/approveExtensionHere.js\":\"f9023d18436cb056\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/armedCutAppMount.js\":\"9e0786f15d9de293\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/batchableKeyedStore.js\":\"62b74eb028ee571e\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/blockInteraction.js\":\"a94cfcade0db3784\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/blockSelectionAction.js\":\"3ed220a5bfb1ebb2\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/compileExtensionModule.js\":\"6e2027fe7db3feed\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/compiledModuleCache.js\":\"aa15ad211ccfd62d\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/continuousGestures.js\":\"d050847acefbea9a\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/core.js\":\"56cfe2d5a12d2f2e\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/defaultRenderers.js\":\"e7c4e3dea32d8163\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/definitionFanoutAppMount.js\":\"a75204a1395a2b81\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/dialogAppMount.js\":\"4ea1987bb95672b8\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/dynamicExtensionSeeds.js\":\"a1829699bd6be961\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/dynamicExtensions.js\":\"ed0fbd4c8adabe09\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/exampleExtensions.js\":\"4eba21fe6816fddf\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionApprovalStatus.js\":\"91c3de13a0dc85a3\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionLoadErrorToast.js\":\"c562959b818d7037\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionLoadErrors.js\":\"b65c49e80b74f58f\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionLookup.js\":\"edfd933b7f68c203\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionToggles.js\":\"f419d979c55f41b8\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionUtilitiesCss.js\":\"6e9b36899c805405\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/kernelPageDeletionGuard.js\":\"6696438876320ce0\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/liveRuntime.js\":\"bffd90b890e5e17c\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/openExtensionsSettings.js\":\"6fa73ca93fa1032b\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/overridesCache.js\":\"56ae93cb46ec0877\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/pluginIds.js\":\"ebbac3bf08bd9f37\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/processorRejectionToast.js\":\"d2b48f7661261497\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/runtimeActions.js\":\"c2d136c735beef77\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/runtimeContext.js\":\"3a7f7940595f2eb3\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/staticAppExtensions.js\":\"16ceaf3a74660b3d\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/staticDataExtensions.js\":\"85c09cb9fc5b2b4b\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/toastAppMount.js\":\"d6eb450946b8b5cc\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/useOverrides.js\":\"1954f67e16dde588\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/useShortcutSurfaceActivations.js\":\"24cc5d6b813428e0\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/discoverToggleTree.js\":\"86b3eeebfc55fda8\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/facet.js\":\"423f54e4a7a1f7f0\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/resolveAppRuntime.js\":\"3a6c04c129673189\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/runtimeEvents.js\":\"cac5c6c90bee1d9a\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/togglable.js\":\"1c05e60e047d38c7\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/variantFacet.js\":\"69265d49c43e9ab7\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/verbFacet.js\":\"72f66316d65b2c91\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/block.js\":\"a8d14ac884db8167\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/focusedChild.js\":\"ec1d6afc7332f4ab\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/propertySchemas.js\":\"1f48ec2c0e3a9dc9\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/typeRegistry.js\":\"8d0acd48772cf4ad\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useAncestorCrumbs.js\":\"46e6b18294434a43\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useAutocompleteListbox.js\":\"ae8e9227dce2ef2d\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useDebouncedSearch.js\":\"bef2bf34939ae2cc\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useDebouncedValue.js\":\"b4ce9ebca62f8640\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useFacetValue.js\":\"f911b4915eef2aed\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useIsFocalRender.js\":\"a5490d1c61f33ee9\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useIsReadOnly.js\":\"a77be7e6d35a2429\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useMaterializeBacklog.js\":\"9732ff7394ecc819\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useMinuteClock.js\":\"4417340b7c0e2822\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/usePanelLayoutProjection.js\":\"4fb5345aeda34c5f\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/usePendingInvitations.js\":\"5cc82cd22d0e016d\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useRendererRegistry.js\":\"8d180ddae11cc540\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useRetainedFieldRows.js\":\"2246bc845bf1c98c\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useWorkspaces.js\":\"931090cba558f823\",\"/knowledge-medium/pr-preview/pr-1909/src/lib/utils.js\":\"23a531b1d0a36364\",\"/knowledge-medium/pr-preview/pr-1909/src/main.js\":\"bfefac42ccf68bb8\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/MarkdownImage.js\":\"d0e68a4abef1ed1c\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/blockSeparators.js\":\"94e597674d378179\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/context.js\":\"745b9103f69d6d03\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/defaultMarkdownExtension.js\":\"1529f502df7ab8e3\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/extensions.js\":\"e5f0305ba1c18294\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/renderMarkdownHtml.js\":\"45651c77b2d827aa\",\"/knowledge-medium/pr-preview/pr-1909/src/minimal-editor.js\":\"9dc6f66324756508\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/armedCut.js\":\"57cd10c197d6b278\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/captureMediaVerb.js\":\"70a230a78d81ed5f\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/clipboard.js\":\"41ba7235f6054b85\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/decision.js\":\"275b7761a8789748\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/operations.js\":\"72908613d713ade2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/account-header/AccountHeaderItem.js\":\"ac67b89bc891886d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/account-header/index.js\":\"76cf4b4416b5721a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"83105488348f1982\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/askAgent.js\":\"72461191123314bf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/askedStore.js\":\"4550883c8630e261\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"99e955425bc9dc0d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/chipState.js\":\"372a54f908664c63\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/dataExtension.js\":\"498f7a64f2dfb024\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/index.js\":\"a1bfe51a114df86b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"82de07fa9418a334\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/schema.js\":\"f9eabe9ef86ffd1a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1f6f29318ca4cc97\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/BridgePairingDialog.js\":\"73a96c3ee76fc587\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/addMedia.js\":\"b2941b15f7f74960\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/backlinks.js\":\"49d27dafa9323b80\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/block.js\":\"5c6e667683a3f9f5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/context.js\":\"29bd2ae932a0bed3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/displayIds.js\":\"968420b7538c48d9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/index.js\":\"93fc70fcfc73bc18\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/outline.js\":\"e2654f65981f58f5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/properties.js\":\"c1f4961c422c102a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/refs.js\":\"7751cdc2cd9f0324\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"708cf9ed521d9e8e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/search.js\":\"79229137ba807bfa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/shared.js\":\"61953facd28b70b9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f14ca4e4b08fb1e0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/text.js\":\"1e2b0c99bc6e2f3d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentWrites.js\":\"ef8b0b72d6432b56\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/authoringCatalog.js\":\"f42ec1938bf87085\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/blockRefTargets.js\":\"f3426c36b9ff32b0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/bridge.js\":\"cde39210df0c805a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/bridgeLoop.js\":\"65980ba1c3ee21a6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/changeHistory.js\":\"f4c4f69e49e36c4f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/commands.js\":\"df9eb02fa1134bb8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/commentsCommands.js\":\"9fb7b93f3c5ada80\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/dataExtension.js\":\"fe1c3ba31d0e123d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/dataModelGuide.js\":\"4909afea0ef774de\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/dayPropertyInputs.js\":\"7a95b85d4c5bad8a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/describeRuntime.js\":\"7cec859ebf3df326\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/extensionLint.js\":\"b5651a2348eb2dfa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/grainAudit.js\":\"b48dc8a2ee230c2d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/healthCommand.js\":\"32b7875f8129f28a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/index.js\":\"897b3a5af4e86566\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/presetIdentity.js\":\"d229ead91ca3e8ca\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d97f0f1e6ab816c6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/readMedia.js\":\"7388d3672c8339f4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/schema.js\":\"af2233dc6ce7134a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/serialization.js\":\"88f00b7026332c8a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/targets.js\":\"456d7057cbaff00f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/tokens.js\":\"77ac1447ebf3a278\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/watchEvents.js\":\"23586dcea10d852c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/workspaceGuard.js\":\"c70a0f47a34b5504\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/writeCommands.js\":\"e6c159d61887c13a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/AliasCollisionToast.js\":\"c7d406f408320a17\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/DuplicateNameBanner.js\":\"4561586bf5346c66\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/collisionMerge.js\":\"100ed07d3c5ccd2b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/dataExtension.js\":\"788ad32ab8bafe90\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/index.js\":\"bad716b87539f8d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/mergeCollisionAction.js\":\"e351d575e2acaaa9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/pageStyling.js\":\"b05f647ba09d1e76\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/rejectionToast.js\":\"47ec400a7e6653b0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/syncProcessor.js\":\"df587a92dc3a8166\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/actions.js\":\"5a39054b132e087f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/addComment.js\":\"1599659067d038b2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/anchor.js\":\"ed3eb0ca7774e419\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/anchorState.js\":\"e6db4941cedefc7d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/commentLinks.js\":\"133f2daa205ec987\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/confirmThreadDeletion.js\":\"b8b1820d50f35414\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/container.js\":\"85dd2938c03612be\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/dataExtension.js\":\"df72cecae364d412\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/deleteComment.js\":\"bd109c9af4c8fb6c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/highlights.js\":\"104a626e4bec2d69\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/index.js\":\"95a8c87c30283d0b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/linkedCommentsPill.js\":\"77f368ca67da4014\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/margin.js\":\"6296e1e9978613cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/marginAnchorLinks.js\":\"1674e5e1d5d85115\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/marginSchema.js\":\"20f4cdd0cb303eb2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/newComment.js\":\"227086919f34fdf4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/ownThreadPicker.js\":\"c58ec382072b9045\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/placement.js\":\"d6806672538d6605\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/queries.js\":\"8654a0faf5061200\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/quotePosition.js\":\"b8d9e9f7e7ba0d74\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/quotedIn.js\":\"452f857ccaa12628\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/quotedRange.js\":\"d9685fa4dca02af4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/rangeRefs.js\":\"dde3d833c5f70ef5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/readHighlights.js\":\"de143dc51d8ad46e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/readSelection.js\":\"e1ac45625e045e54\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/readSelectionUi.js\":\"074820023cd5d403\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/reanchor.js\":\"dcaf00639de26ec0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/schema.js\":\"bedff6390e8da481\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/scope.js\":\"88bc27075a9aedb2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/scopeThreads.js\":\"27b2be7469cb86fa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/splitRetarget.js\":\"635ecb71c6d6249a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/suggestionCard.js\":\"f4201529dbc0bca0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/suggestions.js\":\"666d0527f7cdd3b0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/summaries.js\":\"53dac2fdf6dd4f40\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/summaryBatch.js\":\"098577b16cb0129c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/surface.js\":\"dbdb7a350f1dfad9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/threadNavigation.js\":\"06d368ab9606d6be\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/threads.js\":\"4bc290411f4f366d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/ui.js\":\"c352bec4391835c8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/uiStore.js\":\"8f36e8b85d7e524a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-intents/appIntents.js\":\"008e6c10951e52f9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-intents/index.js\":\"158f9656afa7427e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-update-prompt/index.js\":\"79fa27352ce2bf4e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-update-prompt/status.js\":\"abe02f8d8e46d745\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f7d8b96720a11ad0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/MediaBlockRenderer.js\":\"69300b257d35410f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/MediaDownLaneReplicator.js\":\"ef095aeb2af52ebd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/MediaUploadReconciler.js\":\"05e968cf3093d5e2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/assetDownLane.js\":\"7c1f7a059ee0a509\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/assetResolver.js\":\"c0f74e65eefa7fee\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/assetUpload.js\":\"9110ff676fc89ea6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/attachmentCleanerIO.js\":\"d76a88ed7416687b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b08d5eaff6a1502a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/blobStore.js\":\"69c7d6d237ec5ce2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/browserMedia.js\":\"35e85e78e7d2b690\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/byteStore.js\":\"53e9854a2a845f01\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/cleanerIO.js\":\"0205a4be4e0f5df3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/cleanupAttachments.js\":\"ba775013e8b497ed\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/dataExtension.js\":\"a24c0fd1877c20ae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/downLane.js\":\"8a06fc6046372f10\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/index.js\":\"062b6437f6f96c26\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/insertImageContribution.js\":\"9eecc1f36d4837f3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/laneArming.js\":\"86f180f68c0552b1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/laneLock.js\":\"3baf53f6c86e3411\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaBlock.js\":\"f9440be37de8fabc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaCapture.js\":\"cb2977fa2046fcf0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaLanes.js\":\"fc4c06068e19e96b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaViewers.js\":\"b433b2f3caf813de\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaViewersFacet.js\":\"33281ea25f3c7ce3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/pasteCapture.js\":\"c51efe405b32258c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/resolver.js\":\"85e90b286a68a039\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/retryUploadsAction.js\":\"63b1eca7fc783524\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/storagePaths.js\":\"71b7447439059926\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadDrain.js\":\"3804350c1d863150\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadLaneStatus.js\":\"43006404f2a5c999\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadReconcile.js\":\"715c550e3f1e8607\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadRecovery.js\":\"4774770c956ee6c3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadStore.js\":\"26590e327575d10d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/useAssetObjectUrl.js\":\"0ddfda21fb27321f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"3b5d82098018d868\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c5b5d378cd9f0c07\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/facet.js\":\"d48b43ca19538cf8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/index.js\":\"726cec06fd97b272\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/prop.js\":\"35aff5a9bd942514\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/BacklinkFilters.js\":\"ba6b26f3dc5233e0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"4ba766098a1be4c1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/BlockEntry.js\":\"8860bb923ed87fdd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/LinkedReferences.js\":\"3162766efe8d2d3f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8af31686b00fd4d8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/dailyNoteDefaults.js\":\"786ce388f87609f8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/dataExtension.js\":\"74708f971a7ba2d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/edgeExclusions.js\":\"cc8ec5f0035022fe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/filterProperty.js\":\"8a95181c08de337f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/index.js\":\"381ee93630729013\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"da1437d82bf3a81c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/applies.js\":\"8b34eb392bea4b6f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/countQuery.js\":\"f39a97804f3a8efe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a6fb63359e3d0fa3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/index.js\":\"e7d79f7e41a6782d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d3c039d687e4dc01\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/presentationInvalidation.js\":\"42b66b218c543faf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/propertyEditorOverride.js\":\"9bfb48698b44fbd3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/propertyFilter.js\":\"91d5f4d964966be0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/query.js\":\"44b9bcea6afa40ba\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/resolveFilter.js\":\"11f35941666e408a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/sourceBatch.js\":\"2f1842ab8df28736\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/sources.js\":\"6a904bd39c513688\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/useBacklinks.js\":\"e5af47184c6bb2d8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"4ba341b124a9f23d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/BirthdayCelebration.js\":\"d355151ee01b4137\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/BirthdayOverlay.js\":\"8865b47bbdd8f0e3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/gate.js\":\"9714093107360570\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/index.js\":\"ed16812ad71f5426\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/wolfTheme.js\":\"4b9b67b7bd82245e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/BlockDragLayer.js\":\"154f4c128d70bd90\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/dragController.js\":\"82db0e7075b3bcfc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/dropTarget.js\":\"a5f1bf68403d712e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/index.js\":\"23432dc31acd3a34\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/projection.js\":\"cc47987b2f357f30\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-info/BlockMetaCard.js\":\"2e835be1efc4b1a0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-info/index.js\":\"a76ce0d35b19934a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/AddTagDialog.js\":\"4d927fe94c7379c1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"84c9dd9e3ad980c8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/TagNameIssueHint.js\":\"156756c7559bd2b4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/addTagAction.js\":\"8311ef62e1314a8b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/appendTag.js\":\"886b33ef46f8b64e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/config.js\":\"436e940ef06879f5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/dataExtension.js\":\"e2ef0fbd90172c9e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/index.js\":\"3356a30f1434617f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/propertyEditorOverride.js\":\"4ff0d32aa0771e51\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/BreadcrumbList.js\":\"45a7620c4343183e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"cacce1fc0a1ff480\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/Breadcrumbs.js\":\"c65ecfce73581cad\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6517d9449462b110\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3d94ad1c3bc6f7bf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/index.js\":\"4d16abae6a689bcb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"eb81b65de27c5de2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/CharacterCountItem.js\":\"851233878ab51f66\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/ProfilePropertyEditor.js\":\"82f32f5be0f1ce51\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/actions.js\":\"3794d78868a523b9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/blockType.js\":\"16079eb6a92771c9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/charCount.js\":\"10994e2b4e8aaa62\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/dataExtension.js\":\"a5ed9412aebcb930\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/index.js\":\"06d8a0d70aa2c146\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/profiles.js\":\"a1b451930f9830d8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/properties.js\":\"4fe906c5de5c21d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/subtree.js\":\"223649a066a0f390\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/textCounts.js\":\"c8525fdac9616b8a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/colemak-keybindings/index.js\":\"4cd8554009f05a0e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/CommandPalette.js\":\"c4a3db6aa5b804e8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/HeaderItem.js\":\"442b37a5a9e846aa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/context.js\":\"b4a8798356d7769c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/index.js\":\"dddd7fee89336b71\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/selection.js\":\"5810c3c21e27834c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/toggleStore.js\":\"76c5bdcd0da26133\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/useCommandPaletteActions.js\":\"09ce7d9db3e26266\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/ContributorBadges.js\":\"a2615244ed1726de\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/ProfilePicture.js\":\"27cd9837af4ce015\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/author.js\":\"0862749e86006e7d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/codeMirrorExtensions.js\":\"12a3b9e01cf06825\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/dataExtension.js\":\"0225696cd3136a38\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/index.js\":\"71a5c7d93467933b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/mentionAutocomplete.js\":\"39e17ee146c92785\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/processor.js\":\"248bd7739d4c9f09\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/profiles.js\":\"5a49cc322f231161\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/queries.js\":\"443766e40b8cb07e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/schema.js\":\"4b6493b7fb8994e9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/useCommentAuthor.js\":\"8dc9c28be2519b72\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"2aec776d2d8c1c21\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/followOrigin.js\":\"9daa169c53d87cf5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/index.js\":\"74d1ac945177469a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0bed99194677c874\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"18d1aa7164791c31\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/CalendarGrid.js\":\"a9e8e63721692d4b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DailyNotePicker.js\":\"dbe49f9e1d57f6bf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"671d58117bb1d438\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DateNavDecorator.js\":\"fb31d74fb37fd6cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DateScrubOverlay.js\":\"580043a912bd8fe3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DayPropertyControl.js\":\"24a24e882284aae7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DayValueReferenceControl.js\":\"1d15589ae4307d1a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/HeaderItem.js\":\"2c557e30cece10b1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/ReschedulePicker.js\":\"36eafa2d6c88916d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/SpreadDatesDialog.js\":\"57f1101612002c67\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/actions.js\":\"fca7688e3243b479\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/blockDateAdapter.js\":\"3734f7dd1619f528\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/calendar.js\":\"2907381a4f89226d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dailyNotes.js\":\"441347553f4e2cf6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dataExtension.js\":\"c0d4915a9d27a279\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubActions.js\":\"3fbd91912bdcfb23\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubGesture.js\":\"c0a9a448f6d38437\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0204b55b6b8d8842\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ffab86ddc67d241f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dayProperty.js\":\"62ba1b0c058644bf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"27f88f26a9d63b80\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/deletionGuard.js\":\"1d3bd8468a779e37\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dueQuery.js\":\"9f017c80822fdaa7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/index.js\":\"a92bb2599ec47e94\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/landing.js\":\"c812770271a474f3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/localSchema.js\":\"85f3253c82760c66\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/referenceDateAdapter.js\":\"ebde67b9ce2435d1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/rescheduleAction.js\":\"5210b127175fc652\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/schema.js\":\"80fee8528cfdbf53\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/spreadBlockDates.js\":\"23e6f850b09cacfd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/spreadDatesAction.js\":\"09d583953030a36a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/today.js\":\"bccbcd9fdbc868f9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bea297a41d8dbaac\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e8a406f99343393f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/audit.js\":\"0a7410096f6c2048\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/auditAction.js\":\"46d040e9f27eb29f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/auditRanges.js\":\"b40ba928db83514a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/diagnosticsSource.js\":\"59771df0195638ce\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/divergenceScan.js\":\"eb1a063e42463019\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/index.js\":\"60cd5bd091def78c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/propertyChildrenChecks.js\":\"bc53703c70b34f8e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/referencesMirror.js\":\"a74088148cf4b601\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/rowJson.js\":\"f96d5f4e81592743\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/schedule.js\":\"4626d9f07556edcf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/store.js\":\"e57208086473f67d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-maintenance/action.js\":\"546dae9e0e6c12e1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-maintenance/index.js\":\"4bfc7650b2bcb0d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-maintenance/plugin.js\":\"49bb0a27806602aa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"7a5b1e3da161a850\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/actions.js\":\"f65c1b74cc35f601\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/changeMarker.js\":\"3ae3a25d168cb8d7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/diagnostics.js\":\"7b3c19018a18eea3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/fileSystemAccess.js\":\"c9eb8671ee4f869e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/filenames.js\":\"8754b8a5141e8c5a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/index.js\":\"b5f8fb66e8e4952e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/mirror.js\":\"616a07c8c4bd1673\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/runLock.js\":\"b0f52215800d7209\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/runtimeHealth.js\":\"ca43bb28b54229d9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/schedule.js\":\"f982e2d24e0e418b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/store.js\":\"0585bdd083582d7a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/default-themes/index.js\":\"6cb09c6f4483c254\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/default-themes/themes.js\":\"80d3bfa6f38e793e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/diagnostics/facet.js\":\"947f6f952131fbb8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/diagnostics/useDiagnostics.js\":\"d44dea3c87053ef5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/dismissals.js\":\"4e9bcedc7cc63379\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/index.js\":\"7008c644f8471d76\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/status.js\":\"1ba0731245a5cfe4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/store.js\":\"af95d8c0ba3ac2aa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"52990c712d691e61\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/ExtensionsSettings.js\":\"67061611ec2ca163\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/actions.js\":\"6069fbe88e6051df\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/config.js\":\"028be15e30023c36\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/dataExtension.js\":\"2b19cf6e95b87bf2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/effect.js\":\"2772644c300c79c7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/index.js\":\"d0d1cd61ff9e23d1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/propertyEditorOverride.js\":\"51afd8477bf62338\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/useToggleTree.js\":\"5b41a2b6885277f6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/ExtractTypeDialog.js\":\"19d88cafbc241374\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"59936e97a813affc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/PropertyShapePicker.js\":\"757fa527a94ded76\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/action.js\":\"a1f8346722edd411\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/index.js\":\"9395afc3dec2ebb8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/FindReplaceDialog.js\":\"32d43e3783b3a1dc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/HeaderItem.js\":\"9a33fa6fd422105d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/dataExtension.js\":\"d917364d582dea54\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/index.js\":\"9ba46ddebe410405\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/search.js\":\"135b9d6998ed7a6b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/toggleStore.js\":\"7d95fb7d5a05a4ba\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/LocationPropertyEditor.js\":\"94d7a21a064595dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/MapView.js\":\"9650aea6402e85e1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/blockTypes.js\":\"1023f9e46d8d2ac3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/codeMirrorExtensions.js\":\"a1c912e6204107ac\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/createOrFindPlace.js\":\"088e082d1497a090\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/currentLocation.js\":\"d5c8a71ee8f37c1e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/dataExtension.js\":\"33dfd0d617d175c7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/geoContentDecorator.js\":\"11923f97bae941bc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/googlePlacesClient.js\":\"91f54e1625b54e31\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/index.js\":\"86e4f58996f98467\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/locationsPage.js\":\"d70dfae635f658fb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/mapViewport.js\":\"ea9ee3dd7e57bc38\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/pickCurrentLocation.js\":\"6526a31288fa8c35\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/placeAutocomplete.js\":\"4cedccf396b8f909\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/placeNameCollision.js\":\"d418f6d4e7ddd378\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/properties.js\":\"57560523b7285658\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/propertyEditorOverrides.js\":\"761a92846221c326\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/query.js\":\"f200a5325cc47874\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/usePlaceSearch.js\":\"e44262bdbbcb9071\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a47e11cd799247e7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"60dfca4d35bf2d24\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d46d8432354d2646\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/config.js\":\"88d7ff444f78a3b1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/dataExtension.js\":\"924a49d8cbcc7cdc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/facet.js\":\"dc5e8705c5b57d21\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/grouping.js\":\"c75325ddbdb68a18\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/index.js\":\"d03d14e8ef2755c8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"0adeceaa14d3864d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/query.js\":\"bf1171865af53269\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/resolveConfig.js\":\"c449c3932d469a6f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"0ee57179c3c4834b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f9361d4a5d631a75\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/HtmlDocumentContent.js\":\"b07a3eae1a5368f6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/HtmlFrame.js\":\"77f617ba56438f66\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/actions.js\":\"8ed8e71ca7db269a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/blockType.js\":\"ce863c41c37e2e47\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/confirmRunScripts.js\":\"8d365d98cccc10d2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/dataExtension.js\":\"a180f9b0b1c0887b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/frameAnnotations.js\":\"02bbfa490b551130\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/frameDocument.js\":\"b36e1b91ac10e54b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/frameTheme.js\":\"142cf28da631de77\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/index.js\":\"2cb754e623a4088c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/scriptConsent.js\":\"0d0887f4609f134a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/sourceMap.js\":\"fd4345cec944a056\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/useDocumentScripts.js\":\"827386115528d75c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/index.js\":\"5865bf023d10f768\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/record.js\":\"ae8cb98b8a78d567\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/recordStore.js\":\"f13c3f72cbcd0ba3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/responsiveness.js\":\"f9ee596f78facb87\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/schedule.js\":\"5e2db9579919453f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/sessionContext.js\":\"a7bf79a1e2eb8cab\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c2594a7e477094fb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3b1950046d620f8a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/actions.js\":\"98078da453684719\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/config.js\":\"b75d643d3eebd1ef\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/dataExtension.js\":\"e66f00defbbff7eb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/effect.js\":\"2e3421f4a577b8bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/index.js\":\"dc2b6b9bb950cfd8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/keyCapture.js\":\"2f5c537c32ee8b6a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/overrideStore.js\":\"8a924411599e5da1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"7db2f336350e4b0f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/HeaderItem.js\":\"2876afd074566df6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/LeftSidebar.js\":\"b0f7200335dd89fe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/actions.js\":\"a7fb18b9b5c71567\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/facet.js\":\"52167d5f94951ef5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/index.js\":\"d0bf2fa02d8104bb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/shortcuts.js\":\"533ac1520d297f9f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/toggleStore.js\":\"5da5ee78dd4cdb88\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/MergePicker.js\":\"e52cc51db23b8b34\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/index.js\":\"9656161d48207be2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/mergeAction.js\":\"8464fc4d9497fee3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/strategy.js\":\"786c0b8bed28fb82\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/Button.js\":\"405bc0677a6a5455\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a3745ba7accdf03b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/defaultItems.js\":\"7868326097245f66\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/facet.js\":\"5b1aed9c31421fab\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/index.js\":\"9ab6bd682886cba2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"03660af5fbf1404a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e01fa585b2b28167\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5b0e6875188e7f89\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/facet.js\":\"00f40b1166a0aa6f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/index.js\":\"34b031b054f77a6f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1702794fa42ef8bc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ef2f7cc3ec0b1c6d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/contextMenuItem.js\":\"98b4aeb2c99576dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/index.js\":\"53507dfa35f4332e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/moveAction.js\":\"d465736506a1e309\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/moveBlocks.js\":\"1f802f42501d50eb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/selectionAfterMove.js\":\"bfec2acbcbef7c96\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/TutorialBanner.js\":\"5d9a38ea5a624dfe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/action.js\":\"caed6e4ba588d1f3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/bannerDismissal.js\":\"7139ae34241cec5d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/documents/cheatSheet.js\":\"7f47934c38500778\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/index.js\":\"07a1204c60961ee2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/keys.js\":\"599be4b96c0c5b25\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/landing.js\":\"701eb81db67fadaf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/outline.js\":\"7e0e6ca286bc8b1d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/seed.js\":\"f8aa5151717cacc1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/PerfTrendDialog.js\":\"82ee0f90c83cbefc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/analyze.js\":\"0d82d296b24e4e66\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/diagnosticsSource.js\":\"3c281b5b4245b584\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/index.js\":\"0edfa22c29cfb073\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/load.js\":\"bc06cfef89f1b78f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/monitorRun.js\":\"d266e3205c29faa3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/schedule.js\":\"5fbe3725aedb4f72\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/series.js\":\"619745c79555e315\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/store.js\":\"ac4df60813347368\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/trendAction.js\":\"815184d337076132\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/verdict.js\":\"8ee4db0cb2a4b525\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/plain-outliner/clickToEditAction.js\":\"a748116f43603f76\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/plain-outliner/index.js\":\"c240659a2c94c9f7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/plain-outliner/interactions.js\":\"4857b349c203b375\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1ba9161d7751003b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/MigrationGate.js\":\"be5a37f93d75d472\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/MigrationGateDialog.js\":\"fc724d01e1d3a055\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/action.js\":\"422c66c7400800bf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/index.js\":\"ea63594f5700d7d7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/localRunMessage.js\":\"6ae069e19c620733\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/plugin.js\":\"6d3f2cd5d536a3ed\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/progressReport.js\":\"e0322b8e95559a5a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/sweepProgress.js\":\"4a1443102a992322\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/FieldRowRenderer.js\":\"978b7e2cc80d02c4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/ValueRowRenderer.js\":\"8ae0834a97b2ac11\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/actions.js\":\"64f9098fa1ef3974\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/autocomplete.js\":\"3fb0ba5be50db7f4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/fieldRow.js\":\"6d8936328e5e6d36\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/index.js\":\"af58f7f99f18d90b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/referenceWarning.js\":\"35ecb9b19884ede9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/valueAutocomplete.js\":\"c1ffe19eeda1a76a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/valueSchema.js\":\"87d2e170253ee70a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/HeaderItem.js\":\"f7d587e44a8ad642\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/QuickFind.js\":\"84241e9840533e5c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/index.js\":\"79c7d12d7c9006e8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/recents.js\":\"90a9f860ceb35b48\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/resultItems.js\":\"047a30b98b40147f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/selection.js\":\"c8e5b6d9049a853a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/toggleStore.js\":\"7c781630c4ffbf58\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/HeaderItem.js\":\"6b91cbf69b2babe6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b029e199fd382952\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/grouping.js\":\"7408260e1a6d5241\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/index.js\":\"5d6ac4334f21152c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/target.js\":\"6eaf1111caaeec4b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/codeMirrorExtensions.js\":\"9ab679feaf87ce21\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/contentPrefill.js\":\"966bb36467a0c0a4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/dataExtension.js\":\"2ea3dbafc823d306\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/index.js\":\"f2ad99c81882a789\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a99078f2e9ba0f64\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/invalidation.js\":\"4cc1d8682042500f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/localSchema.js\":\"5b533725a4323923\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/blockrefs/index.js\":\"26da1571f6c519b2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1e7c3d646a2b5323\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/index.js\":\"b66ed576a0744709\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/referenceNode.js\":\"555c467867f8c589\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a751501af8046177\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7379ec50da011083\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/index.js\":\"6507eabaf3b3bd9f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7924ae2edf90a6b9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"482fbd283b98232d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/mergeRetargetProcessor.js\":\"4e2768dcde64a4a4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/parseFence.js\":\"6be39602e003c948\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/referenceParser.js\":\"0469affb67286611\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/referenceProjection.js\":\"42c9fd051405f6af\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/referencesProcessor.js\":\"d5f3e624c7a79dc7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/renameProcessor.js\":\"6b99a2e7e80ddefc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/spanReplacement.js\":\"03d1341f13837b96\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/htmlToOutline.js\":\"0b03f2a8d819996c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/index.js\":\"bd0254a9c4b5516a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/normalizeClipboardDom.js\":\"fb24c34f8fea28ec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/pasteDecision.js\":\"f78ecc796dc09d1b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/action.js\":\"78d40afd7e58b0fb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/blockIds.js\":\"58b50e01a39d54b7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/content.js\":\"f0e8b99b39301cb6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/effect.js\":\"a930600e2ffc84bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/ids.js\":\"dfda6e2751686587\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/import.js\":\"c5af70a079e1ed23\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/index.js\":\"f2e36d6693c176ab\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/plan.js\":\"5da024a2b0345f40\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/plugin.js\":\"46a2f901d833b920\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/promotion.js\":\"a781ebb6bf52f459\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/properties.js\":\"28a1dc77bf4e8cfc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/references.js\":\"f98e53e1a86e31c7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/report.js\":\"199416eb237a0e79\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/roamMemo.js\":\"956b7ea646e5692e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/runtime.js\":\"3d93aa09cc14a142\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/schemaReconciliation.js\":\"8b4bf8a23275197b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/srsMarkers.js\":\"6301737161788335\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/todo.js\":\"1864360072ab9cb4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/typeCandidates.js\":\"852a27f8ed26643f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/types.js\":\"56606cf10c3326ed\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/search-health/index.js\":\"a92d9397134aeba6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/search-health/store.js\":\"52ae0a468bb26ccc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/HeaderItem.js\":\"89ebd26092b1a6b6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"11f708300ef706dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/index.js\":\"c50fe7970b0fc79a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/model.js\":\"810a09094036c8d7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/toggleStore.js\":\"1b95f287ed8f90c0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/useKeyInspector.js\":\"7f0046fcaa3937a3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"637eff2a8a66b0ee\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/ShellDecorator.js\":\"a736e99233ba287b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/actions.js\":\"a95bd4196ccfb154\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/exclusionsFacet.js\":\"7d4c582d243e0235\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/index.js\":\"786bb2c31ab416e3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/shell.js\":\"11f1b4b8cdebce24\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/surface.js\":\"1905aad0754030ea\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/walker.js\":\"1ed88128d8aacc68\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/RescheduleToast.js\":\"93e331840cbd41ae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/dataExtension.js\":\"ff29000255e8b620\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/index.js\":\"1963c13cec418978\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/indicator.js\":\"c1519364aa362602\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/moveSrsState.js\":\"c4f15ed5f9cd2eea\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8a5f18dde911acb7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/scheduler.js\":\"68bc0ebdb3e6f1a7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/schema.js\":\"f05957ddd0a4f2cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2c2ea8b189754cfb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/srsClipboard.js\":\"397bdfcea0e3f2a8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c397abde24fe4551\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1c73d20a1e6929cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/DeckPicker.js\":\"118661dbfb88cede\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/ReviewControls.js\":\"c01576a28e9fe8d1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/ReviewDeckRenderer.js\":\"747bbd50e2ea97ef\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/ReviewSession.js\":\"ea46f0dd9e7a6425\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/actions.js\":\"57bcce528a60c60b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/archive.js\":\"9ced8eaca8be21d0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/dataExtension.js\":\"e3ab51d368e3f4ad\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/deck.js\":\"ad9417cf6294bb34\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/dueQuery.js\":\"29bf208567441fbf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/gradeDecision.js\":\"73f008d98531e573\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/index.js\":\"efb6d8aca16ef0d3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/keyHints.js\":\"aadbef54dcd8b6b3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/reviewCardLayout.js\":\"ad35a174f5174e00\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/reviewProgress.js\":\"59ae25493d32ae48\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/schema.js\":\"1481073d1539beab\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/useDueCards.js\":\"ecebaee22b7d3d97\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/startup-metrics/index.js\":\"1cd2085a492d4cde\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/startup-metrics/record.js\":\"923881715b270f32\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/storage-persistence/index.js\":\"905a5fa9b258bcb1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/storage-persistence/persistenceStatus.js\":\"d20057341b827038\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/storage-persistence/requestAction.js\":\"5d4d4234d54943a8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/TypeChipsDecorator.js\":\"7496a5eb88900d61\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/codeMirrorExtensions.js\":\"d96b0a43a35f316c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/index.js\":\"56dab9b59ca72deb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/typeAutocomplete.js\":\"f86493a2e7b6d959\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"487d0f17fc34e078\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/actions.js\":\"c8b84158a7d428b6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/anchor.js\":\"b3245870f1b1908c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/events.js\":\"9ecdf853390507a2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/gestureActions.js\":\"3a643c1620863b8d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/index.js\":\"bff0a4128703a4d7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"23f4f3d39f0004d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/sync-metrics/collect.js\":\"eb42b52ac339e58d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/sync-metrics/index.js\":\"2ee028117b046f0e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/sync-metrics/record.js\":\"2491f7641594ce5b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/RejectionDialog.js\":\"5f232f859092ea6c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/SystemStatusHeaderItem.js\":\"cde4a7af11b08176\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/index.js\":\"a3e0dfd7afb2ff4c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/model.js\":\"7f6eb8b00a6e483d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/queueCounts.js\":\"6c39f27e54952461\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/rejectedHelpers.js\":\"0347fe11831151a5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/rematerializeAction.js\":\"6dd2ded0579de61f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/useHysteresis.js\":\"a4a2662993aead3c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/ColumnHeaders.js\":\"a397f41b9b1b4921\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/QueryUi.js\":\"da2e2e61fcc803e8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/TableLayout.js\":\"62cc4569288ac3fa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/actions.js\":\"0c7c9e7ac44e5ced\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/cellEdits.js\":\"efb8e80ab69d9a5b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/childrenViews.js\":\"0c37595cbf2bb8b7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/columns.js\":\"1730a64bef5ac623\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/controller.js\":\"05275680ca29d06e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/convert.js\":\"5183e72c4f3ea114\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/dataExtension.js\":\"c1461647c09d40f3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/index.js\":\"689144c394933774\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/keys.js\":\"8711cce061fa4dc0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/model.js\":\"7b7c520550ff9b7b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/QueryText.js\":\"a3f9df1c73e40cc3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/backfill.js\":\"1209ff792d1af700\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/completion.js\":\"6d394878b356aa4b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/format.js\":\"bd5160d0ba100c64\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/parse.js\":\"818dfa2c76afc9a4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/queryValue.js\":\"55a8b611e7f79b81\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/registrations.js\":\"7c03ebd17fe22d2e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/source.js\":\"4fd06577cff2553b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/registry.js\":\"fc4e2cec8ec5c4e7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/rowGutter.js\":\"2a0f1aeb12c8aea8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/rowVerbs.js\":\"1e275859c6b828a1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/schema.js\":\"b9e84ed7c18209f2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/sort.js\":\"83af91cb7fcf0662\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/theme-toggle/effect.js\":\"3e19e7eca432cfb2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/theme-toggle/index.js\":\"3ad23372a2616263\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/theme-toggle/theme.js\":\"65ccb03eff49552d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/actions.js\":\"295c7fb28ca7b320\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/dataExtension.js\":\"208862e5fff0774c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/index.js\":\"9be0ce78cd40142f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/schema.js\":\"015783b0fb8e62a7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/TouchSelectionLayer.js\":\"478af9e2494c88fb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/actions.js\":\"798fd63078cd2df3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/defaultItems.js\":\"d7b082e50024f0f4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/facet.js\":\"3099e91a47e0be2b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/holdRecognizer.js\":\"492d75c4ce86f722\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/index.js\":\"c393014b3db69609\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/update-indicator/UpdateIndicator.js\":\"d286e171e2741b2c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/update-indicator/index.js\":\"936a67401daf7cb2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/update-indicator/loadTimes.js\":\"73fee3483ebd1b8b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/VideoNotesRenderer.js\":\"6d4e452efdbdae65\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/VideoPlayerRenderer.js\":\"35c55bad8ac73921\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/VideoTimeStamp.js\":\"af9ab79ea2b78dfb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/actions.js\":\"a00a19931f165a0a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/index.js\":\"b3c566cab9c40ea9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/markdown.js\":\"9337c9d15ce10cf2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/notes.js\":\"74c38957c9938e38\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/registry.js\":\"8c746cecd87b19ff\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/remark-timestamps.js\":\"a7e5512fcc89f124\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/view.js\":\"cbf5d53e68090a23\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/LinkHints.js\":\"f0c7a36a6d513237\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/index.js\":\"00c643c07c7e9932\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/model.js\":\"dac543eaf5490e93\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/settings.js\":\"f26bae7390bd1a7e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-normal-mode/actions.js\":\"4e92eefb90c14335\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-normal-mode/index.js\":\"601403390b37a1dc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-normal-mode/interactions.js\":\"c8c7900d7e7fc762\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/workspace-header/index.js\":\"e82881b2d5d61c56\",\"/knowledge-medium/pr-preview/pr-1909/src/registerServiceWorker.js\":\"c93cb424e8350747\",\"/knowledge-medium/pr-preview/pr-1909/src/requestPersistentStorage.js\":\"6d29f42eb6c415ea\",\"/knowledge-medium/pr-preview/pr-1909/src/services/authRequestDeadline.js\":\"3e57dfd573838f28\",\"/knowledge-medium/pr-preview/pr-1909/src/services/authStorage.js\":\"2a692011275c4ad9\",\"/knowledge-medium/pr-preview/pr-1909/src/services/powersync.js\":\"f6b69252b623243f\",\"/knowledge-medium/pr-preview/pr-1909/src/services/supabase.js\":\"d44938abfc802d9f\",\"/knowledge-medium/pr-preview/pr-1909/src/services/uploadErrorClassifier.js\":\"6ee6abcf49234b73\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/ActiveContexts.js\":\"eca7793d29d59bfc\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/HotkeyReconciler.js\":\"0a7cdcdaf0c28d25\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/WipeLocalDataDialog.js\":\"f79e6477b5b8847c\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/actionDispatch.js\":\"4d4c4e5bbe58dd69\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/actionRefItems.js\":\"e5054b1873150c1d\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/applyKeybindingOverrides.js\":\"2a8ec0014dc3fa09\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/blockActions.js\":\"18593a0b5e2957be\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/blockMergeGesture.js\":\"7844a2744edb4f9b\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/canonicalizeChord.js\":\"6ab9ccf2364ebfb1\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/defaultContexts.js\":\"dc80c2a3b9ec2beb\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/defaultShortcuts.js\":\"209ecc1944c3d7fa\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/effectiveActions.js\":\"cc279327ce724ecc\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/gestureAction.js\":\"127f6eaef5e5bb38\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/gestureBinding.js\":\"458ac05adbc988cd\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/holdRegistry.js\":\"39f55a17ac74dbf3\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/keybindingConflicts.js\":\"abeeefee6634eb91\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/keybindingOverrides.js\":\"3124bbe8380a4d27\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/pointerAction.js\":\"5a8e7b247fbbf758\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/resolve.js\":\"9d184e6b3972d975\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/runAction.js\":\"cca6c0eb799f259b\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/sequenceMatcher.js\":\"68024e4117d9a65c\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/types.js\":\"bfd3952162c6b806\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/useActionContext.js\":\"b3c733ad456ffc2e\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/useActionDiscovery.js\":\"438902e6a09bc9af\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/utils.js\":\"da301d7fcf01f574\",\"/knowledge-medium/pr-preview/pr-1909/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1909/src/sw/bootStore.js\":\"373a683001124d82\",\"/knowledge-medium/pr-preview/pr-1909/src/sw/previewDatabases.js\":\"dc409dda16a0ec42\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/byteTransform.js\":\"6ca93210bfd3f033\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/attachmentCleaner.js\":\"536c99e71a45a425\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/attachmentParts.js\":\"b9a8945a10496f9a\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/bundleParts.js\":\"1d8db4a4992b9e70\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/bundleRecord.js\":\"927e58539bc3e81b\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/manifest.js\":\"a2b2b4d2190a4907\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/takeBundle.js\":\"86f5a4395d062371\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/verifyBundle.js\":\"54584e5404666fd6\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/cleaningStage.js\":\"0ddc69d3795501d5\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/conversionKey.js\":\"8a4a54ac1055eea8\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/conversionServer.js\":\"a4a52d90371550cd\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/flip.js\":\"3917f041ada58d15\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/flipAttempts.js\":\"57ab0fadad51e6f0\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/pages.js\":\"42343fb379f61219\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/preflight.js\":\"9d5e976b5334a2c1\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/reseal.js\":\"4bb2b01acda1f5c1\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/runConversion.js\":\"fa85362027d43780\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/runLock.js\":\"9e69d309e5f8c4a9\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/sealing.js\":\"85e50ff41e8b2f6e\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/sealingStage.js\":\"d93ed6ccd1a9a84c\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/stage.js\":\"97a71ed74499e5d9\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/verifyReseal.js\":\"fd4d592d70e3b4ef\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/aad.js\":\"c07931df55fe9b24\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/aead.js\":\"ea07e2041d9c2725\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/base32.js\":\"6c69309e30d88ee4\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/base64url.js\":\"d2065393896d424d\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/binaryEnvelope.js\":\"104174fc437a27b3\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/byteAead.js\":\"fd4ccf0da5eb10c1\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/canary.js\":\"8250f6c2bb7aa45f\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/contentHash.js\":\"81290aab6355d3c2\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/contentKey.js\":\"b89dbc3e59c52cb1\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/derivedIdNamespace.js\":\"3d43c88c1a788ef0\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/envelope.js\":\"b7a8ec82dafd6d1f\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/hex.js\":\"1dd4cbadb03c97b0\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/sha256Hex.js\":\"dc69865d3d071330\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/workspaceKey.js\":\"b90285518ed2d668\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/conversionState.js\":\"94548b82ca59ad57\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/createEncryptedWorkspace.js\":\"98a79a5c2d8deb97\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/pastedKey.js\":\"f53a162d7996c758\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"fb86c4e808cdb85d\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/upgradeWorkspacePin.js\":\"687432bb320ce4f3\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/keyStore.js\":\"92b10af0cb5df970\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/mintWorkspaceKey.js\":\"1ac5784354aba8f7\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/modePin.js\":\"0c42a05973c8aa79\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/openWorkspaceKeys.js\":\"de94ff142d128491\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/resolveWorkspaceEntry.js\":\"bdc06d61a5982255\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/resolver.js\":\"e4f100d94eec60b1\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/workspaceAccess.js\":\"2c91db66de840d01\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/transform.js\":\"5b4a7194a6fe630b\",\"/knowledge-medium/pr-preview/pr-1909/src/themeBootDefaults.js\":\"fa4ec49e1d87a10f\",\"/knowledge-medium/pr-preview/pr-1909/src/types.js\":\"c0cc5414ca27fa90\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/ClientLocalSettings.js\":\"e2b2667c9f6012ac\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/abortableSleep.js\":\"c190b8128649d8d5\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/array.js\":\"18150fe3b188378c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/backlinkAutocomplete.js\":\"e6ad8273b1090c3e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/blockCrumbs.js\":\"c74e5f80d6ec188e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/blockrefAutocomplete.js\":\"4f9b7ab585cc08fe\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/cadencedIdleJob.js\":\"024ba46257c7ac2b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/callbackSet.js\":\"836820ee86c6d258\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/clientId.js\":\"70802c74e6db5fc1\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/codemirror.js\":\"5d7ae22162e72eeb\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/codemirrorCompletion.js\":\"e608c82a9eded60e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/copy.js\":\"86df373a4b80c031\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dailyPage.js\":\"c334240472f438be\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dbForensics.js\":\"827e727ac1cb94c4\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dbForensicsHooks.js\":\"a915e37186df6b76\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/deleteBlockThroughUi.js\":\"9ea0621710f0d6e7\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dialogs.js\":\"1b54b9bf78570a86\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dom.js\":\"78cafc84dc12d780\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/downloadBlob.js\":\"526dd4c309e733c7\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/drawnWalk.js\":\"975f1be2676ea823\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/exportSqliteDb.js\":\"1a4adc65b540a4ce\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/fileSystemAccess.js\":\"086926832a1240de\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/flipSlide.js\":\"68b43ec11b9d3394\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/fnv1a.js\":\"b5d4716ecd930229\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/formatBytes.js\":\"ceb099c2b5b923e5\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/fuzzyRank.js\":\"abbce710fe1b5395\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/idbKeyedStore.js\":\"fa2c204f4c35c369\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/idleCallbackPolyfill.js\":\"91ae860f020733f9\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/keyboardAwareScroll.js\":\"72c03ae9ff1eb98e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/keyboardViewport.js\":\"f23c4be8757d6346\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/lastWorkspace.js\":\"83e6ee136d834677\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/layoutColumns.js\":\"5907b7cc6bf3e763\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/layoutSessionDom.js\":\"6ee3d24e1e83b94e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/layoutSessionId.js\":\"1d3a4000c8e2e071\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/linkClickGestures.js\":\"d27a5e611fb37de9\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/linkTargetAutocomplete.js\":\"182881bd48c2f78b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/localDbCorruption.js\":\"c7867506eaaf618b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/localDbRecovery.js\":\"5e79fb8fd7323d0f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/markdownParser.js\":\"4963db53f3bdb682\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/memoize.js\":\"7635494b07e02059\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/nameFieldCommit.js\":\"085a312000ce2c83\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/nameList.js\":\"40b25cca47a49c72\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/navigation.js\":\"dbd62105a2849026\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/omnilinerNamespace.js\":\"62a5a4368a206879\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/opfsPageScan.js\":\"a40f2f6a75e690e9\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelClearance.js\":\"db66e8972eca709f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelHistory.js\":\"2ed126b04323cbde\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelLanes.js\":\"69c1ee0b9fa78c27\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelLayoutProjection.js\":\"8c1448954e75f611\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelScrollAnchor.js\":\"7e49e96293d005bd\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelUrlFlags.js\":\"b0d14f392f458174\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/platform.js\":\"6025cf4be1bc140c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/pluralize.js\":\"200a8ab43e012308\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/propertyCreation.js\":\"65e45718e851afdd\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/propertyNavigation.js\":\"0e11f0023c95d529\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/propertyValueContext.js\":\"0fefe47daa86638b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/react.js\":\"eb1dd00c574a831c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/relativeDate.js\":\"bf141c2e6cdffc1b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/relativeTime.js\":\"50003353eae065a7\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/renderScope.js\":\"6f8d16d2c6932fa6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/resolvedThenable.js\":\"142fe4518bb3f708\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/routing.js\":\"95576d654c582df0\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/safeMode.js\":\"2ee644252642d08c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/scheduleIdle.js\":\"784fca93a4a04a22\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/screenWakeLock.js\":\"d5ed26c4c6a3f19e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/selection.js\":\"706e48bc0e663c4a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/softKeyboardGrab.js\":\"aa30931647791854\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/startupTimeline.js\":\"11c50f14493ff1f4\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/state.js\":\"cac4f4b943895913\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/string.js\":\"76b42708ee85fdac\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/surfaceZoom.js\":\"1c371ae6ccf7c17d\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/time.js\":\"300c9b49d231faef\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/toast.js\":\"9ea7a469fbe81669\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/toggleStore.js\":\"6a2b43bbd31182cf\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/untilStopped.js\":\"952de7ea1fd0b17f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/userActivity.js\":\"cd83acb673867450\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/viewTransition.js\":\"ddb525fd245e9954\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/viewport.js\":\"903118bef5cf4056\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/webLock.js\":\"772c32c9b5ccd425\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/workspaceRecovery.js\":\"c1c5a95a1064e102\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/workspaceSnapshotStore.js\":\"6022030daa14cf6c\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-compiler-runtime.js\":\"60f2a6465ad9ce2a\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-client.js\":\"353f0c1b5b1e3e95\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-server-edge.js\":\"7226dd03578a068c\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-server.js\":\"71a9efb413eb1f9c\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-static-edge.js\":\"d345dc9d4d48a4ba\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-static.js\":\"b8535d19377e8beb\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-test-utils.js\":\"4a4736f6dc6088f6\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom.js\":\"868ddfb941fbfe21\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-jsx-runtime.js\":\"b72c89de25f1b8d0\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react.js\":\"853bea246a4c7b28\",\"/knowledge-medium/pr-preview/pr-1909/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1909/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1909/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
