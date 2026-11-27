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
		buildId: "572f709d23ac-54edad18",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1909/\":\"a9aaea0d8843a553\",\"/knowledge-medium/pr-preview/pr-1909/index.html\":\"a9aaea0d8843a553\",\"/knowledge-medium/pr-preview/pr-1909/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1909/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1909/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1909/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1909/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1909/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1909/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1909/assets/FacadeVFS-BYG6hFNN.js\":\"8703b9fc08c7f8bd\",\"/knowledge-medium/pr-preview/pr-1909/assets/OPFSCoopSyncVFS-DrfjZxeL.js\":\"9302f77db7a9f934\",\"/knowledge-medium/pr-preview/pr-1909/assets/OPFSWriteAheadVFS-BNMtVWO9.js\":\"ad235577265f5d00\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-DIQBJ8c2.js\":\"4963aa318bd61438\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1909/assets/wa-sqlite-async-BjmK_6lG.js\":\"f70a240f927e6c02\",\"/knowledge-medium/pr-preview/pr-1909/assets/worker-DxjFgKKP.js\":\"f3e50a034194ce53\",\"/knowledge-medium/pr-preview/pr-1909/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1909/chunks/app-BH1XdjKv.js\":\"2e7ac198be2f7abe\",\"/knowledge-medium/pr-preview/pr-1909/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1909/index.js\":\"99ec1ed92ed3b305\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1909/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1909/assets/AccessHandlePoolVFS-Df5kh66x.js\":\"908971e8bc903d01\",\"/knowledge-medium/pr-preview/pr-1909/assets/IDBBatchAtomicVFS-B2HwPhTc.js\":\"6c4775fa42e30901\",\"/knowledge-medium/pr-preview/pr-1909/assets/MemoryVFS-CWt7eNSJ.js\":\"0c8190839777b2bb\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-BGmcFZMc.js\":\"63f06aeac077e213\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-async-Dm9b4O02.js\":\"03dcc88ed51d720a\",\"/knowledge-medium/pr-preview/pr-1909/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1909/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1909/chunks/AccessHandlePoolVFS-2LWg2wt_.js\":\"3d06296f86d70d07\",\"/knowledge-medium/pr-preview/pr-1909/chunks/FacadeVFS-BgpljWP6.js\":\"ecc11f246943d95c\",\"/knowledge-medium/pr-preview/pr-1909/chunks/IDBBatchAtomicVFS-CiCKblWP.js\":\"538f8e79839acdbd\",\"/knowledge-medium/pr-preview/pr-1909/chunks/MemoryVFS-By6wzkQF.js\":\"f9e79f008bc392c3\",\"/knowledge-medium/pr-preview/pr-1909/chunks/OPFSCoopSyncVFS-DmFXrIm5.js\":\"c0e0b6698608789a\",\"/knowledge-medium/pr-preview/pr-1909/chunks/OPFSWriteAheadVFS-Dgx7vYNc.js\":\"e086851db2748ab5\",\"/knowledge-medium/pr-preview/pr-1909/chunks/Preview-fIZS8shH.js\":\"ab7ebdb790d9b408\",\"/knowledge-medium/pr-preview/pr-1909/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1909/chunks/card-4Ehhs53w.js\":\"ff15f744342c2e7d\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1909/chunks/dist-CXsJhMrQ.js\":\"60d41c34619c9498\",\"/knowledge-medium/pr-preview/pr-1909/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1909/chunks/mc-wa-sqlite-CSq9d5Ra.js\":\"995faf7bb70065c1\",\"/knowledge-medium/pr-preview/pr-1909/chunks/mc-wa-sqlite-async-CIHLCvaJ.js\":\"2e88995fc6b8ce51\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-4RZOS1Lz.js\":\"21c67039ec5043f1\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-Bqo_BgwU.js\":\"ed8db230dcb0ab03\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-BwHdv27K.js\":\"6c36c61a1a9aa151\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-CPPH-nxx.js\":\"2616cc36ef3e9730\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-CktTHz9_.js\":\"b0b0a831719e71c1\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-CuFMF-M2.js\":\"3032ffbfe40e3239\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-DUml9NFV.js\":\"b9864c3566f82447\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-DdLDArcY.js\":\"62585b9ece841177\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-dom-server-legacy.browser.production-BvTqoHHv.js\":\"f2c65e12148bee8b\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-dom-server.browser.production-CkOgLKK3.js\":\"ad1095b4771195e9\",\"/knowledge-medium/pr-preview/pr-1909/chunks/react-dom-server.edge.production-C-y5lEcE.js\":\"b82e7d7278944e49\",\"/knowledge-medium/pr-preview/pr-1909/chunks/server.browser-Bj7i6h7_.js\":\"8491eab61bce80ca\",\"/knowledge-medium/pr-preview/pr-1909/chunks/textarea-C9a09ZS1.js\":\"26b9d6ea26bcaa5f\",\"/knowledge-medium/pr-preview/pr-1909/chunks/ui-75Aukaqs.js\":\"418e0b2c5e22d6bc\",\"/knowledge-medium/pr-preview/pr-1909/chunks/wa-sqlite-PGnhFjL6.js\":\"f8b8c0a4e7a92ab1\",\"/knowledge-medium/pr-preview/pr-1909/chunks/wa-sqlite-async-DuiqrMyw.js\":\"ad906e855f32b94a\",\"/knowledge-medium/pr-preview/pr-1909/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1909/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1909/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1909/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1909/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1909/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1909/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1909/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1909/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1909/src/App.js\":\"141d1f35476cec51\",\"/knowledge-medium/pr-preview/pr-1909/src/appUpdate.js\":\"1814326c990c18e2\",\"/knowledge-medium/pr-preview/pr-1909/src/appVersion.js\":\"5b6c6645dbf0691c\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/initialLayout.js\":\"91f480f773b249f8\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/openWorkspaceData.js\":\"4a6afe4ce6635ac8\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/resolveWorkspace.js\":\"b1faa1c4f07152fd\",\"/knowledge-medium/pr-preview/pr-1909/src/bootstrap/workspaceBootstrap.js\":\"8d284b8b39c47215\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockComponent.js\":\"ee6c70d2894b6fdb\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockCrumbs.js\":\"7f7c00d3984f074d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockEditor.js\":\"4a8c4d20e81818d3\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockLoadingPlaceholder.js\":\"946b491e53c46ec7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockProperties.js\":\"1329f1e99e991c62\",\"/knowledge-medium/pr-preview/pr-1909/src/components/BlockSearchPicker.js\":\"a2a1eca8662fc6f7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ConfirmBulkDeleteDialog.js\":\"fa6ade8b149ec2f3\",\"/knowledge-medium/pr-preview/pr-1909/src/components/DividerHandle.js\":\"7c440b7ab5205182\",\"/knowledge-medium/pr-preview/pr-1909/src/components/DraftEditor.js\":\"65303500e26fc9f0\",\"/knowledge-medium/pr-preview/pr-1909/src/components/GutterPill.js\":\"4c576bc33b54a88e\",\"/knowledge-medium/pr-preview/pr-1909/src/components/Header.js\":\"df0100c23a9e91e7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/LazyBlockComponent.js\":\"ee4a8589eb952631\",\"/knowledge-medium/pr-preview/pr-1909/src/components/Login.js\":\"2016d67ee0316c10\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ZoomableSurface.js\":\"145f276afba48fa7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/editModeKeepalive.js\":\"e47c0c8a86975a43\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyDisplay/PropertyDisplayScope.js\":\"3b4ab08b931ed37c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ff08a8f730cfba30\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/RefPropertyEditor.js\":\"8dc138627eafaf09\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/RefTargetTypePicker.js\":\"3a2e9029af9950a2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/SelectPropertyEditor.js\":\"839a1e7d4197bfe5\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/TypesPropertyEditor.js\":\"edb0f0f358803477\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/defaults.js\":\"222f576f795388cf\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/kernelValuePresets.js\":\"921706f9db7d2940\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/selectablePresets.js\":\"7a22fd24a0ba46b6\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyEditors/typesPropertyUi.js\":\"c01625c9f116b33b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/AddPropertyForm.js\":\"01f1f5ad64e386fd\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/PropertyPicker.js\":\"e26a5bd7da72a2f3\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/PropertyRow.js\":\"0723c8e7b0d9dfb7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/Rows.js\":\"a514c290c5d68d76\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/actions.js\":\"68536a54e33820af\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/declarationOnly.js\":\"aa2009352b171ec1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/layout.js\":\"67176c6cacd2967d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/model.js\":\"9c587f7f46b51bb8\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/shapeUi.js\":\"4e08e5171d095ae1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/shapes.js\":\"436b1d90dea6ed07\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b574b8c59805c916\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanel/visibility.js\":\"2097cad766685cd2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/propertyPanelSections.js\":\"119ace87f3e91610\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/BlockEmbed.js\":\"94073dd4aef7e3a0\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/BlockLink.js\":\"ccdd35660e979c96\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/BlockRef.js\":\"6e478410a181fa34\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/CompactReferenceLink.js\":\"2fedb8c60131ec36\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/ReferenceLink.js\":\"a2cc16390d7b403c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/cycleGuard.js\":\"c94a81f1addfff8d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/cycleGuardContext.js\":\"c0000653bc9bf2b5\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/linkInteraction.js\":\"b54da213c6b06933\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/referenceLayout.js\":\"8810e124e5e5eda7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/references/useBlockRefAncestors.js\":\"40f7a1681c6ec8d7\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockGutter.js\":\"dcf73e05723a0cdc\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockInfoDialog.js\":\"747b3d8a1c78733b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockReadText.js\":\"715a5bf397fdb13a\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BlockTypeBlockRenderer.js\":\"ceda5a7d05612e30\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/BulletHoverCard.js\":\"582e1705d53e7c44\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/CodeMirrorContentRenderer.js\":\"3b450ebc2c265701\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f9d7919e075521cb\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/ColumnResizeHandles.js\":\"a1e614a5da63e945\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c2e3b5ff61389185\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/DefaultBlockRenderer.js\":\"fd86cc3b034c3597\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/LayoutRenderer.js\":\"2fe1d90992fffe6c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/MarkdownContentRenderer.js\":\"0c920d82ff1eeffd\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/MissingDataRenderer.js\":\"423c00c8c7356bd1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/PanelRenderer.js\":\"998e469dfc09bcf1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0a01252a1cb2fb78\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/TopLevelRenderer.js\":\"8ba11974828023b1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/blockGutterMode.js\":\"3a46edf86496e88c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/blockTitleText.js\":\"3661e8ead4a99c47\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/fieldCreationKeydown.js\":\"35d3235115cecc17\",\"/knowledge-medium/pr-preview/pr-1909/src/components/renderer/layoutRootContext.js\":\"adb64b4505c66f16\",\"/knowledge-medium/pr-preview/pr-1909/src/components/typeChip/TypeChip.js\":\"cf2311b7235415a4\",\"/knowledge-medium/pr-preview/pr-1909/src/components/typeChip/chipStyle.js\":\"b5512dd4f3ddf536\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/anchored-floating.js\":\"134378d90ac3c9a3\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/button.js\":\"0a7429244cef948b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/card.js\":\"9eb4d9bfa7c8101c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/checkbox.js\":\"8ce427e758f58a62\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/collapsible.js\":\"e13abb82174a2bf1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/command.js\":\"cde5a8d2a890bdf1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/context-menu.js\":\"dd4bf683204268ab\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/dialog.js\":\"33c45076c3030bdb\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/dropdown-menu.js\":\"6304ac2bcd485c39\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/floating-listbox.js\":\"100fd34b8dc689a9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/index.js\":\"d40db656eee4d564\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/input.js\":\"760577e664554922\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/kbd.js\":\"d29568b10719fcd9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/label.js\":\"ce8a17abe85e63f8\",\"/knowledge-medium/pr-preview/pr-1909/src/components/ui/textarea.js\":\"6d8353cc52bc2ce8\",\"/knowledge-medium/pr-preview/pr-1909/src/components/useEditModeYieldKeepalive.js\":\"6a614bd3fd595b32\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/BootFallback.js\":\"95fcb061f0580d0d\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/FocusedRowLazyMount.js\":\"7ce558f085890f70\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/LazyViewportMount.js\":\"249f7353e93d97e1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/LocalDbCorruptionFallback.js\":\"3ec16c58b4d82fc4\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/error.js\":\"05f26b5b3f5d49ce\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/lazyMountRegistry.js\":\"76e9b2ce15ea29d6\",\"/knowledge-medium/pr-preview/pr-1909/src/components/util/suspense.js\":\"981154bd8031decd\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/CreateWorkspaceDialog.js\":\"c14ebd8d46a518e1\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/PendingInvitations.js\":\"73ffca5611c4faf9\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/SyncProgress.js\":\"0c9d92cd5ee46004\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/UnlockProgress.js\":\"cf1c5d4545db4e90\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceKeyGate.js\":\"b480a12c3fed35ba\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceSettingsDialog.js\":\"c07340067d135aa2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceSwitcher.js\":\"25b3e5de4e3af17c\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/WorkspaceSyncGate.js\":\"2136e99b48a3dae6\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/ConversionFlow.js\":\"5a7484b6b61888fd\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/ConversionFlowHost.js\":\"603abcff000b3fef\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/EncryptionSection.js\":\"f5ddbdd52c50ae8e\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/attachmentPrompts.js\":\"3b6d27423dbe07b2\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3d338af38b230608\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/conversionFlowDeps.js\":\"74528f3152a2ca9b\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/conversionFlowStore.js\":\"8cb84d4396553536\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/flowUi.js\":\"989b9e2ef5b6f472\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/conversion/useConversionRun.js\":\"45fc27128d1471fe\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/keyUi.js\":\"908c036dc6797495\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/useCloseOnKeyLoss.js\":\"388262b44b8ca09e\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/useCloseOnServerE2ee.js\":\"36f1debfe0465993\",\"/knowledge-medium/pr-preview/pr-1909/src/components/workspace/workspaceUnlocked.js\":\"469104adc51e659a\",\"/knowledge-medium/pr-preview/pr-1909/src/context/backgroundSubtree.js\":\"d25cfa7822f64124\",\"/knowledge-medium/pr-preview/pr-1909/src/context/block.js\":\"77be7f3affe4c0c9\",\"/knowledge-medium/pr-preview/pr-1909/src/context/layoutWsContext.js\":\"fa47407d2604c0d0\",\"/knowledge-medium/pr-preview/pr-1909/src/context/propertyDisplay.js\":\"f926bcac249a6ff1\",\"/knowledge-medium/pr-preview/pr-1909/src/context/repo.js\":\"8e061cfbb720dfbb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/aliasClaim.js\":\"aff6984ee66d9ccc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/aliasSeatNamespace.js\":\"58602082a83d78b0\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/blockData.js\":\"c1dab4083377e18e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/blockType.js\":\"cc433825a4d173a2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/changeScope.js\":\"fe3284fef15436b5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/codecs.js\":\"c82fc7d6820e5b2f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/derivedData.js\":\"238b6122bb4b349a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/errors.js\":\"8ea9f837b3c3edb8\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/events.js\":\"c401924b5572c318\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/handle.js\":\"f3d0ec0ae2b3ad70\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/index.js\":\"7dbbecee5c2297ed\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/mutator.js\":\"9c680041a46b95fd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/processor.js\":\"d3f32a74fc5f08df\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/propertySchema.js\":\"bc3552aa33f4ad93\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/query.js\":\"0b59d6533e4706b3\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/sameTxProcessor.js\":\"355060c6929612d8\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/schema.js\":\"f3d0ec0ae2b3ad70\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/tx.js\":\"f3d0ec0ae2b3ad70\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/typedBlockQuery.js\":\"5c70358830c28939\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/user.js\":\"d570a617198271dd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/valuePresetCore.js\":\"576a0ff9b5006b4e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/api/valuePresets.js\":\"b6dc7b5890687be7\",\"/knowledge-medium/pr-preview/pr-1909/src/data/attachmentCleanerIOVerb.js\":\"80fa217e2601a4a6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/block.js\":\"bbe68214a5bf1d0b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockCache.js\":\"45ed89ad283a2a4a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockId.js\":\"2669298924ad98cd\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockLiveness.js\":\"9542f1c058a3f9e6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockMerge.js\":\"87f541e352c8d01f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockSchema.js\":\"b6a7e7251b8a3b33\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockTypeLookup.js\":\"780603b742b5ed7c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/blockTypes.js\":\"c7fba4919321a74b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/childrenView.js\":\"ae3f3f049407bc2d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/clientContext.js\":\"af76de4ab3d31ab9\",\"/knowledge-medium/pr-preview/pr-1909/src/data/dbFileSiblings.js\":\"2a9de04b5ebb67d4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/definitionSeeds.js\":\"decbf2817f7a5114\",\"/knowledge-medium/pr-preview/pr-1909/src/data/derivedIds.js\":\"d3d8c9afd8a67982\",\"/knowledge-medium/pr-preview/pr-1909/src/data/drawnSubtree.js\":\"7244f5e6427b5cc6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/facetBridge.js\":\"c7be0a77333024c7\",\"/knowledge-medium/pr-preview/pr-1909/src/data/facets.js\":\"d93735b1a704cf89\",\"/knowledge-medium/pr-preview/pr-1909/src/data/globalState.js\":\"c328e15f680d7872\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/aliasClaimRederiveProcessor.js\":\"ed1113e0aa7127d1\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/ancestorBatch.js\":\"61e748433e2b0f48\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/blockTypeTypeifyProcessor.js\":\"25fc1b65f141a9b5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/clientSchema.js\":\"66e4ce4a5c65d2c3\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/commitPipeline.js\":\"0705667c5384bd9d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/devAssertions.js\":\"409e9c3299e8dc35\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/firstSync.js\":\"003df78ea01837bb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/freshInitialLoad.js\":\"390c3c0f85d4027d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/graphBackfillClaim.js\":\"1bf9793785c16f64\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/handleStore.js\":\"a3327acc951889e0\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/idleMarkerJobs.js\":\"f3893cbbe029c33b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/initialDownload.js\":\"b39f7da5a08969c5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/initializeClientDatabase.js\":\"266b18aaf8696183\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/jsonCanonical.js\":\"637d5168fc7e650e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/kernelInvalidation.js\":\"dab8a571d9908173\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/kernelProcessors.js\":\"c017283c75a2a8d4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/kernelQueries.js\":\"ff87cee00c68ca53\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/mergeTypeMembershipProcessor.js\":\"dd1c63119650b337\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/normalizeReferencesProcessor.js\":\"86ef2b9c375a0acf\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/poolInstrumentation.js\":\"fdfd8c1792408fa4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/processorRunner.js\":\"46e379779b26ebe2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyCellBackfill.js\":\"34994645b0a9c88e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyChildMint.js\":\"71b6fe427a792c8c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyChildrenProcessor.js\":\"ac40012ca528ba26\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyDefinitionChangeProcessor.js\":\"edab1cab4c9ede89\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyDefinitionSynthesis.js\":\"9f8db8ad75becfd6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyKeyScan.js\":\"60926ec3f64c8958\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertySchemaResolution.js\":\"34bc8eab9225f32c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/propertyValueEdits.js\":\"ed16082d1b6f909c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/raiseProtocol.js\":\"88bf33cf0f980db6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/readBatch.js\":\"6f2f1aa446b0fd36\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/refProjection.js\":\"71ae2efe0aab5b41\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/referenceTargetLookups.js\":\"562df1d6dae83ba2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/referenceTargetProcessor.js\":\"66c2a6149b0c7ddb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/replayMerge.js\":\"d5735f43d7401fce\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/sqlBinds.js\":\"c23a617e9367965f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"67a6ecde3447c4d4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/arrivalProcessors.js\":\"b501f5d8e6e0785f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/invalidate.js\":\"1e9886a193786ca5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/materialize.js\":\"c058a1374cdaf759\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/observer.js\":\"13ad32b56f1e1a20\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/syncObserver/reconcile.js\":\"59650012d12d1449\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/timingMetrics.js\":\"63b32b58c734910e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/treeQueries.js\":\"7e5b79ade10e45a2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/txEngine.js\":\"12f040c7b296f716\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/txSnapshots.js\":\"3e518dac12dc464b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/typedBlockQuery.js\":\"f0922f253389eeac\",\"/knowledge-medium/pr-preview/pr-1909/src/data/internals/undoManager.js\":\"9bb205063102704c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/invalidation.js\":\"6f17a72f18bd6538\",\"/knowledge-medium/pr-preview/pr-1909/src/data/kernelDataExtension.js\":\"abc03cc8d94fc70f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/kernelPage.js\":\"4caf8720a301b538\",\"/knowledge-medium/pr-preview/pr-1909/src/data/kernelValuePresetCores.js\":\"0f8de3aa253da870\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localDbCorruptionSignal.js\":\"1a812132fb8ebf90\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localDbStorage.js\":\"ac8f04afb30b060d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localDbVfs.js\":\"804855b3e54fbe24\",\"/knowledge-medium/pr-preview/pr-1909/src/data/localSchema.js\":\"516eac56180308ea\",\"/knowledge-medium/pr-preview/pr-1909/src/data/maintenance.js\":\"3d21243a9af7db39\",\"/knowledge-medium/pr-preview/pr-1909/src/data/mergeProperties.js\":\"d919d6edb9cfdf21\",\"/knowledge-medium/pr-preview/pr-1909/src/data/metricsConsoleHook.js\":\"cb76151c8f3d07bf\",\"/knowledge-medium/pr-preview/pr-1909/src/data/migrationsPage.js\":\"da1497a5c3b8fb16\",\"/knowledge-medium/pr-preview/pr-1909/src/data/mutators.js\":\"92dd47bc160a83e2\",\"/knowledge-medium/pr-preview/pr-1909/src/data/orderKey.js\":\"6dd5824afb5ece25\",\"/knowledge-medium/pr-preview/pr-1909/src/data/orderKeyPlacement.js\":\"6990f9d2d56ddf05\",\"/knowledge-medium/pr-preview/pr-1909/src/data/outlineSurface.js\":\"7217466c9bc5ee58\",\"/knowledge-medium/pr-preview/pr-1909/src/data/pendingEditorContent.js\":\"8ecba7a647cf7999\",\"/knowledge-medium/pr-preview/pr-1909/src/data/pendingUploadsSql.js\":\"46527e350d3c7fd7\",\"/knowledge-medium/pr-preview/pr-1909/src/data/pluginStateExtensions.js\":\"e976385fea84c350\",\"/knowledge-medium/pr-preview/pr-1909/src/data/powerSyncLogger.js\":\"bee37813d83a861d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/projectorRuntime.js\":\"7be1003e62d32fd4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/properties.js\":\"fff65c8eac848cff\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertiesPage.js\":\"0353cdf5fa64281c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyChildren.js\":\"184b1827788adeb6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDefinitionFanout.js\":\"8694aac65a78ccab\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDefinitionMetadata.js\":\"4914dba8ef5073c9\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDefinitionRegistry.js\":\"c364580c5dbf0aca\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyDisplayMode.js\":\"6a953c2c2da9a86c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertyRowCreation.js\":\"ea1ebc61647ad013\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertySchemaCreation.js\":\"688b13ea283357bb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/propertySeeds.js\":\"199010c32bacd3b6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/recentsPage.js\":\"2c8af7fbe7b89835\",\"/knowledge-medium/pr-preview/pr-1909/src/data/refTargetComparableProperty.js\":\"aebe1ae5064758db\",\"/knowledge-medium/pr-preview/pr-1909/src/data/referenceBlock.js\":\"ba8da36612ae987c\",\"/knowledge-medium/pr-preview/pr-1909/src/data/rejectedUploads.js\":\"2c313475ae971598\",\"/knowledge-medium/pr-preview/pr-1909/src/data/releasePowerSyncConnection.js\":\"f06245716a85798d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/repo.js\":\"1a77e3d21623f890\",\"/knowledge-medium/pr-preview/pr-1909/src/data/repoProvider.js\":\"07d9156f57ea2ac4\",\"/knowledge-medium/pr-preview/pr-1909/src/data/rowProperty.js\":\"acb653b655d90e72\",\"/knowledge-medium/pr-preview/pr-1909/src/data/searchFilter.js\":\"5e907e3e227614e3\",\"/knowledge-medium/pr-preview/pr-1909/src/data/seedIdentityLedger.js\":\"366cde07f8320682\",\"/knowledge-medium/pr-preview/pr-1909/src/data/stateBlocks.js\":\"af6f5e11bf6a5ae5\",\"/knowledge-medium/pr-preview/pr-1909/src/data/structuralEditPolicy.js\":\"c07be05d0f9f9872\",\"/knowledge-medium/pr-preview/pr-1909/src/data/structuralInsert.js\":\"6e76d06cb5b18b3e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/subtreeDelete.js\":\"1d3a3a0e7374f89e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/syncStreamLock.js\":\"af95892e91b64f2b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/syncedTableSqlRecognizer.js\":\"4d23e92173d3d934\",\"/knowledge-medium/pr-preview/pr-1909/src/data/syncedTableWriteGuard.js\":\"16556819db79da4e\",\"/knowledge-medium/pr-preview/pr-1909/src/data/targets.js\":\"b942eb79a733add8\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeColors.js\":\"b7cd5e5bb0fc66bc\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeDefinitionMetadata.js\":\"3cda18572bf42e0b\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeDefinitionRegistry.js\":\"85a741eb2fb43178\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeExtraction.js\":\"0d7425b33d02a706\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeInitialValues.js\":\"51fbd9b8439d1670\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typePropertyGroups.js\":\"4e5cd7ea39816b54\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeSeeds.js\":\"013ab33af79c929a\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typeTagger.js\":\"96ffb657b09a9a74\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typedRecords.js\":\"03cd49ac7f0c8e51\",\"/knowledge-medium/pr-preview/pr-1909/src/data/typesPage.js\":\"ad5b781f661632fb\",\"/knowledge-medium/pr-preview/pr-1909/src/data/userPrefs.js\":\"7da46d4df11dd1e6\",\"/knowledge-medium/pr-preview/pr-1909/src/data/userSchemasService.js\":\"3bb510fbe948c752\",\"/knowledge-medium/pr-preview/pr-1909/src/data/userTypesService.js\":\"c6d3204cdb342d17\",\"/knowledge-medium/pr-preview/pr-1909/src/data/valuePresetRegistry.js\":\"f3ea945dfbb78f0f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/visibleChildren.js\":\"19e10ae5f05d2b98\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceConversion.js\":\"390a8a520c535683\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceFirstSync.js\":\"e62f14f7198e805d\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceIdNamespace.js\":\"df38828cf47f1a06\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaceSchema.js\":\"847e096cc6d302c9\",\"/knowledge-medium/pr-preview/pr-1909/src/data/workspaces.js\":\"88aefb2f222bde32\",\"/knowledge-medium/pr-preview/pr-1909/src/data/writeAheadLog.js\":\"4697f4fdec19cf3f\",\"/knowledge-medium/pr-preview/pr-1909/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/BlockPasteShellDecorator.js\":\"302cc6100974b7fe\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/atTrigger.js\":\"812e8095dcd016d3\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/autocomplete.js\":\"247e0a7130350772\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/codeMirrorExtensions.js\":\"d44e89605b3886fc\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/contentFlush.js\":\"33473b979dd006f3\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/defaultInteractions.js\":\"2ab52bf3f50ac261\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/editSettleSignal.js\":\"c0673ba55bbf00c1\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/insertImage.js\":\"511f5240fb47e868\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/referenceCompletionRange.js\":\"30174f1269ed16ea\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/referenceTargetTypes.js\":\"822932c122a0df3c\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/syntaxContext.js\":\"601c454f1685ce86\",\"/knowledge-medium/pr-preview/pr-1909/src/editor/triggerMatch.js\":\"be9843d12253e24a\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/AppRuntimeProvider.js\":\"ad869a024777681d\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/BlockFocusShellDecorator.js\":\"bf10ad3e46696881\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/ExtensionRenderBoundary.js\":\"e0e90cd2a9c8aa87\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/PanelContentRecovery.js\":\"7915c79ad0d1d61c\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/apiCatalog.js\":\"34de561a14151c54\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/approveExtensionHere.js\":\"2691f30b1040c846\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/armedCutAppMount.js\":\"8a3494ea1856b5d8\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/batchableKeyedStore.js\":\"7ce6d1a8fb73d4b4\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/blockInteraction.js\":\"d46a6e4b612e77ca\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/blockSelectionAction.js\":\"0b225d714a49940f\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/compileExtensionModule.js\":\"a6bbe3a3e6117cc9\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/compiledModuleCache.js\":\"8455f12e17c97af3\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/continuousGestures.js\":\"43da5547804d3a26\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/core.js\":\"8021319da3934d17\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/defaultRenderers.js\":\"02e49751dd478411\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/definitionFanoutAppMount.js\":\"04767cfb529d007f\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/dialogAppMount.js\":\"c8799d3f6ef0ccf2\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/dynamicExtensionSeeds.js\":\"b5b3fe4ea920dcbd\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/dynamicExtensions.js\":\"5a231cf1cded160e\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/exampleExtensions.js\":\"3aac16fef07c256c\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionApprovalStatus.js\":\"20ada3109fb50f42\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionLoadErrorToast.js\":\"bc3b74dfe4918fa2\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionLoadErrors.js\":\"9fab52e8eb7439a3\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionLookup.js\":\"d603faba1ffc8970\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionToggles.js\":\"5ea12a674596414a\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/extensionUtilitiesCss.js\":\"eae124bb585b409d\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/kernelPageDeletionGuard.js\":\"14dcfdc6127e7e8c\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/liveRuntime.js\":\"d5993716c0c19c57\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/openExtensionsSettings.js\":\"493040febaa81f4e\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/overridesCache.js\":\"65b65d9e7f37600f\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/pluginIds.js\":\"008fcea4828785d6\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/processorRejectionToast.js\":\"93c027957ed9846c\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/runtimeActions.js\":\"321329390950e3ff\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/runtimeContext.js\":\"35ad0b58037cf991\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/staticAppExtensions.js\":\"9fdd10c3fa052a87\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/staticDataExtensions.js\":\"5f2279209ddf9074\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/toastAppMount.js\":\"65e065fa973497af\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/useOverrides.js\":\"39b926561aa335da\",\"/knowledge-medium/pr-preview/pr-1909/src/extensions/useShortcutSurfaceActivations.js\":\"92d6a9ffebe723bb\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/discoverToggleTree.js\":\"da2c97ac9983f533\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/facet.js\":\"7e5b4b48793616c8\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/resolveAppRuntime.js\":\"135b1daf7447d347\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/runtimeEvents.js\":\"73ce57ed0dd31f73\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/togglable.js\":\"125e8ac6451280ff\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/variantFacet.js\":\"2a60a05506e119cb\",\"/knowledge-medium/pr-preview/pr-1909/src/facets/verbFacet.js\":\"2719861ffae80560\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/block.js\":\"767f16e61351844c\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/focusedChild.js\":\"0a8fd8caf2cc0253\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/propertySchemas.js\":\"0db5808f879e04d5\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/typeRegistry.js\":\"b63340d68af8f8bd\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useAncestorCrumbs.js\":\"4a19de2f0b035357\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useAutocompleteListbox.js\":\"571445cba3c49408\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useDebouncedSearch.js\":\"b19898fb328ac6ea\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useDebouncedValue.js\":\"a74ce194a5fc1e89\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useFacetValue.js\":\"c86a8ea8b1d21f8c\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useIsFocalRender.js\":\"559e3aa37cbbb70a\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useIsReadOnly.js\":\"c6ade19240fea65f\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useMaterializeBacklog.js\":\"8e963ef1064a905e\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useMinuteClock.js\":\"0594e5084680a2b2\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/usePanelLayoutProjection.js\":\"af5897ae9c7758f3\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/usePendingInvitations.js\":\"3b3685c8b31ab817\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useRendererRegistry.js\":\"53e669b7fc0122cc\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useRetainedFieldRows.js\":\"242e9c8270270fd1\",\"/knowledge-medium/pr-preview/pr-1909/src/hooks/useWorkspaces.js\":\"3a988d312dc3a39b\",\"/knowledge-medium/pr-preview/pr-1909/src/lib/utils.js\":\"f466d2f3cc1af29c\",\"/knowledge-medium/pr-preview/pr-1909/src/main.js\":\"bfa5e944956f4e09\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/MarkdownImage.js\":\"27706323d6c88f05\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/blockSeparators.js\":\"bf4245dbf59c0d46\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/context.js\":\"fd16585951e65ec6\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/defaultMarkdownExtension.js\":\"bf276dcf570cbab7\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/extensions.js\":\"db64268a0819f48c\",\"/knowledge-medium/pr-preview/pr-1909/src/markdown/renderMarkdownHtml.js\":\"f80487e0264e694a\",\"/knowledge-medium/pr-preview/pr-1909/src/minimal-editor.js\":\"013ba18c132c3017\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/armedCut.js\":\"6770e8494cfbbbd2\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/captureMediaVerb.js\":\"ec49aa500472dd0d\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/clipboard.js\":\"e3ae6c17878dc722\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/decision.js\":\"3b4c44d7e42629b2\",\"/knowledge-medium/pr-preview/pr-1909/src/paste/operations.js\":\"b41e297dca89e087\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/account-header/AccountHeaderItem.js\":\"cf42d7725b6b20a7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/account-header/index.js\":\"9aacdbe62bfadc42\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4f1b51368c1778fb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/askAgent.js\":\"c6e699b01f3d2121\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/askedStore.js\":\"4431be77a2e37d56\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d3e71137bb66574a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/chipState.js\":\"f38a13a2631ef18a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4ce64d6387e3b107\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/index.js\":\"d6708c455872f209\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c6f633f46a108324\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-dispatch-companion/schema.js\":\"c71198e584c3aaaa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/AgentTokensDialog.js\":\"37489eab77968860\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/BridgePairingDialog.js\":\"33d00f737b62845f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/addMedia.js\":\"beb110098e666bf8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f1a48d894ac9c0a8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/block.js\":\"48cd5cd95a378384\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/context.js\":\"f6145e7bb87bae6b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e3e71fd300bc39fc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/index.js\":\"582becb244125dba\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/outline.js\":\"66ca8cd68813df56\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/properties.js\":\"d9afeace70af7467\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/refs.js\":\"8cc27fe378ec97a6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f1f6e2fca621039f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/search.js\":\"5e6a9ce4c91da4e4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/shared.js\":\"532cc4e3056d350a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c09787374f9c3568\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentViews/text.js\":\"846752cca36acda7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/agentWrites.js\":\"4955043e1dcbd0b2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/authoringCatalog.js\":\"8d6f88d14e9c6d8c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/blockRefTargets.js\":\"0a3f436d1273aae7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/bridge.js\":\"b34e65579eadc418\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/bridgeLoop.js\":\"f92dd468b1513bb7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/changeHistory.js\":\"a477b7f1f7d173d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/commands.js\":\"fd856acf1342b9da\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/commentsCommands.js\":\"c6289e88f75a5433\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/dataExtension.js\":\"217e9d84bcd6b2b9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/dataModelGuide.js\":\"8a6bb969b16914a7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/dayPropertyInputs.js\":\"f45381df8130b106\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/describeRuntime.js\":\"656f2c3b7be42e7b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/extensionLint.js\":\"7d0ee37562c48120\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/grainAudit.js\":\"002970a8342b1fe2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/healthCommand.js\":\"d037e9995f2b8175\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/index.js\":\"ba4fc1b95a23e34e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/presetIdentity.js\":\"2625f2f6bff33fd6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"478e90cfa7d28489\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/readMedia.js\":\"8d75960fe429fd82\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/schema.js\":\"89d067653fed724c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/serialization.js\":\"57f894daad4721bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/targets.js\":\"47a1244201b5f380\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/tokens.js\":\"01f676be7aac4be7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/watchEvents.js\":\"d04636cf4a53ace9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/workspaceGuard.js\":\"a5909ff029aef16d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/agent-runtime/writeCommands.js\":\"3a4432357637fd65\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/AliasCollisionToast.js\":\"55007c182fb18623\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/DuplicateNameBanner.js\":\"3033cbed0abf419c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/collisionMerge.js\":\"d1837f394079bc1f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/dataExtension.js\":\"7c922eea707f2690\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/index.js\":\"dd1a7836e7adcedf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/mergeCollisionAction.js\":\"fa8425f10bbb69b6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/pageStyling.js\":\"537a628fb30797f3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/rejectionToast.js\":\"b9faa3805f7d8c3b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/alias/syncProcessor.js\":\"755c6f0ce7566cc7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/actions.js\":\"38002e29b74880de\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/addComment.js\":\"142d23bf8c712a82\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/anchor.js\":\"44be9e506669704f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/anchorState.js\":\"44d8d70566019e49\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/commentLinks.js\":\"f28aa6b869837102\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/confirmThreadDeletion.js\":\"430abfaa14c51c54\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/container.js\":\"e8a336b11e247634\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/dataExtension.js\":\"d45c2342e4d4d820\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/deleteComment.js\":\"5ff583d62a28d547\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/highlights.js\":\"6bbd3dc876871c3f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/index.js\":\"11592d92777071dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/linkedCommentsPill.js\":\"cb6db5961afdc65e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/margin.js\":\"0ed9e5cfa8093e5f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/marginAnchorLinks.js\":\"705c0d0429e17b3c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/marginSchema.js\":\"a738440c542d30d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/newComment.js\":\"5dd79c759f37ed42\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/ownThreadPicker.js\":\"16a2b1d6939f8ccb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/placement.js\":\"50ae09d67f783a78\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/queries.js\":\"c9a9b60c8f2aa4ad\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/quotePosition.js\":\"39733fd93bde32c3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/quotedIn.js\":\"dbca7f6eb372f64d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/quotedRange.js\":\"4c35dce9d16db51f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/rangeRefs.js\":\"12dac3fc6cc66fad\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/readHighlights.js\":\"d4d36003698b410a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/readSelection.js\":\"a6718b34bff855be\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/readSelectionUi.js\":\"3e3142a866f1cc83\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/reanchor.js\":\"7dd92e59e81983e0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/schema.js\":\"b23014162f4468fa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/scope.js\":\"3c5047de3e952981\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/scopeThreads.js\":\"ef7665d68e9785a3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/splitRetarget.js\":\"afe5f8ef1412f717\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/suggestionCard.js\":\"dfc6d682ea5eaa21\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/suggestions.js\":\"edbe352cd44b6469\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/summaries.js\":\"ad1556dcfe66c1de\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/summaryBatch.js\":\"ae0e892afa995915\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/surface.js\":\"a206512f9857c3bb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/threadNavigation.js\":\"a18068ab91abf55a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/threads.js\":\"15a44624d73ddb14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/ui.js\":\"a169f64437b2f047\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/annotations/uiStore.js\":\"0e1f5aa45884ca39\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-intents/appIntents.js\":\"a4f0c32d224494a3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-intents/index.js\":\"8d171e63b20f54cd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-update-prompt/index.js\":\"606ef99f296df002\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/app-update-prompt/status.js\":\"e65e1a0c7f52b0f3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"87f47cf7eb605d51\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/MediaBlockRenderer.js\":\"cdcd9ba9357a1024\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e8ae030f77535ffb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/MediaUploadReconciler.js\":\"9ee51d9fdde937b6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/assetDownLane.js\":\"8f1ea93289f1caef\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/assetResolver.js\":\"2ac009eeabaf3339\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/assetUpload.js\":\"b4a7f1cfc6babec5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/attachmentCleanerIO.js\":\"8ef3a3ec64e26b1d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6d3749babb140901\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/blobStore.js\":\"fabb7418338deaab\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/browserMedia.js\":\"f4f889e78e0e1db3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/byteStore.js\":\"26363366c77fa87e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/cleanerIO.js\":\"7b89eb6d54ab55d4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/cleanupAttachments.js\":\"d230a6b680a83df3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/dataExtension.js\":\"f9d7ae54d0bcab64\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/downLane.js\":\"222ff810bf5ea7f6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/index.js\":\"34c13f807a5e990d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/insertImageContribution.js\":\"2ba70e0508345eb1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/laneArming.js\":\"1c1286d517880826\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/laneLock.js\":\"86dbaad3715e8594\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaBlock.js\":\"8fd85faa7335ef79\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaCapture.js\":\"aa88bff21c7b99b2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaLanes.js\":\"57529093b06e5ca8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaViewers.js\":\"7243accbf7480e71\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/mediaViewersFacet.js\":\"b715a8bb8430c218\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/pasteCapture.js\":\"514cc630203d0717\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/resolver.js\":\"6aa71ed58eb64932\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/retryUploadsAction.js\":\"246cba96d0c9774e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/storagePaths.js\":\"f5b3d25763d43627\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadDrain.js\":\"326ac528de2b02a1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadLaneStatus.js\":\"89fbdc84db2f437b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadReconcile.js\":\"a569b3b28a2a1a8f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadRecovery.js\":\"13d708443198e6b4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/uploadStore.js\":\"63d87964226c8b85\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/attachments/useAssetObjectUrl.js\":\"81868f92a103c4b5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"51404be1137a79bb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/BacklinksViewSection.js\":\"8bde5b57fc907ee8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/facet.js\":\"8f3a831df3755226\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/index.js\":\"30b1e4496ea76e6b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks-view/prop.js\":\"26de3dc5c50e696a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/BacklinkFilters.js\":\"6922add46a52cc3f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1da49c05aa894783\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/BlockEntry.js\":\"6141a7660f65fd4e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/LinkedReferences.js\":\"f234875ac1fdadc3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e158d8007162054c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/dailyNoteDefaults.js\":\"066aae667b4050bf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/dataExtension.js\":\"72100b0162fb035e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/edgeExclusions.js\":\"c7055cb513efb740\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/filterProperty.js\":\"a3092d40b771cc38\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/index.js\":\"f5b190b5202fe475\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"53450fc7ea02fe65\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/applies.js\":\"df0f9abb892d37ae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/countQuery.js\":\"1c97c49c3098d73c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/expansionStore.js\":\"bb12f19bc386d772\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/index.js\":\"2f65251da8938aac\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e3eecf901f8fb97c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/presentationInvalidation.js\":\"1211f12b69a8c7fa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/propertyEditorOverride.js\":\"f948813bf2d3a082\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/propertyFilter.js\":\"f50d7278d9f6a2ca\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/query.js\":\"5f6d48cce5ccc293\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/resolveFilter.js\":\"633c3eae9beaa5af\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/sourceBatch.js\":\"81a2c657bd34a7e1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/sources.js\":\"da17fb1bf237de99\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/useBacklinks.js\":\"a989053e38f4cc5f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"8c8a029b69c63cde\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/BirthdayCelebration.js\":\"3d369f40178e4ecf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/BirthdayOverlay.js\":\"0597b996cf0942b5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/gate.js\":\"c23c4b5da66a97b2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/index.js\":\"039aac068a130ff6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/birthday/wolfTheme.js\":\"b343e41bd106ead9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/BlockDragLayer.js\":\"62a98ad15d8f2b6b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/dragController.js\":\"bafd08509f5089ca\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/dropTarget.js\":\"998e599ecab7908a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/index.js\":\"1e578413aed4572e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-drag/projection.js\":\"9b26dc1605ea26d7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-info/BlockMetaCard.js\":\"67ea444248008631\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-info/index.js\":\"806271218a634082\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/AddTagDialog.js\":\"39aed19018247ee0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"c2098bc003968807\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/TagNameIssueHint.js\":\"33566b2cff7dcc8d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/addTagAction.js\":\"50af556bc2ef11c1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/appendTag.js\":\"0ac4cfd37ee1f3ae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/config.js\":\"e68b0a244f720eef\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/dataExtension.js\":\"035b38e2008945c4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/index.js\":\"1a07e5c21b844c9a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/block-tagging/propertyEditorOverride.js\":\"1369b253822b8386\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/BreadcrumbList.js\":\"c4d28fb1c5ac260d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"09e0b30edcaa40b0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/Breadcrumbs.js\":\"45226ea515fc0382\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"fe90a242b17dafd4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"27c5a39294e990fc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/index.js\":\"da0ad7d06ae2f3a4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4005b04a16a99b9d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/CharacterCountItem.js\":\"61cd69ae38220eb4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0568a3193e5332a3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/actions.js\":\"3b25a82d287cf552\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/blockType.js\":\"ad7142f9eee83dff\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/charCount.js\":\"52b4014c39276e66\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/dataExtension.js\":\"991380465a000b6d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/index.js\":\"70045f6373eb9a31\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/profiles.js\":\"321481534e28d736\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/properties.js\":\"7bc2bb99daefcb24\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/subtree.js\":\"e010f607ed25171c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/character-counter/textCounts.js\":\"70571aaede31a3f4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/colemak-keybindings/index.js\":\"c0e55aebf8b0d332\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/CommandPalette.js\":\"4ca72a0d77515d13\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/HeaderItem.js\":\"51a489d25d15caf2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/context.js\":\"12ece54660c0aa3e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/index.js\":\"cad5d73e5c2f9973\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/selection.js\":\"5458772baca598b3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/toggleStore.js\":\"2d1d4f3bdd9dd548\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/command-palette/useCommandPaletteActions.js\":\"f8977296e0d7466b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/ContributorBadges.js\":\"8e12fa9ec6edd420\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/ProfilePicture.js\":\"6cb92ea63847eed2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/author.js\":\"5c18a863bfc308da\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/codeMirrorExtensions.js\":\"dc2e4309cf460df0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/dataExtension.js\":\"51a49edb81070a07\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/index.js\":\"a6e18b0d2e10292e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/mentionAutocomplete.js\":\"cabca54365fc8ec0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/processor.js\":\"14860f5a43f8bc45\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/profiles.js\":\"4665d6fe410e48ec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/queries.js\":\"735853e287686001\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/schema.js\":\"0ef57ce35f033797\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/contributors/useCommentAuthor.js\":\"c5b828f280f65dad\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9eedec7d92e82599\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4ba9ba7d20749333\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/index.js\":\"99bbe0bc1a3bef1c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0810d4168cfdcca4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b831d59d648c4662\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/CalendarGrid.js\":\"1dbb557981fb4d6a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DailyNotePicker.js\":\"6e4ed31cc141c6f1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"67a88a535ec1469a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DateNavDecorator.js\":\"5646455ebc1cbf22\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DateScrubOverlay.js\":\"48afb91347428842\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DayPropertyControl.js\":\"40eb259a456ee898\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/DayValueReferenceControl.js\":\"e3ef5dad0fbe1728\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/HeaderItem.js\":\"73c8697819feb361\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/ReschedulePicker.js\":\"ccc43359889d821c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ac77deb1f400fa33\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/actions.js\":\"1b9eeb696ac4e489\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/blockDateAdapter.js\":\"e3f26570078c1e31\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/calendar.js\":\"3aa7253377271f74\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dailyNotes.js\":\"f4dd0d17e5b6c9c1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dataExtension.js\":\"7915d8e1f52e8b10\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubActions.js\":\"25a72e9ea4f3d150\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubGesture.js\":\"6ae93a01a9c12683\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubGestureActions.js\":\"162a4f333b41bdaa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dateScrubRecognizer.js\":\"025388c6787221cc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dayProperty.js\":\"5cc37a39584ebd27\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"86ebb8d8547ed57c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/deletionGuard.js\":\"2d08b71fe0804581\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/dueQuery.js\":\"c43adfb50b2f8b19\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/index.js\":\"a8cb3f5b14ad534e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/landing.js\":\"b3965ad9e59a5f2d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/localSchema.js\":\"219f8f939016bd0d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/referenceDateAdapter.js\":\"4fa46a5b65bca4de\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/rescheduleAction.js\":\"16b1e9c88e8e383c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/schema.js\":\"970739fa20ebe550\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/spreadBlockDates.js\":\"84926000a6277243\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/spreadDatesAction.js\":\"4dd639883203d2d0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/today.js\":\"a7198b8ab6e00271\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3d60a51a5d8cd3e6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"494776a523fd9cec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/audit.js\":\"324657da756c20d8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/auditAction.js\":\"74083feac5276be6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/auditRanges.js\":\"682db3e038fb23ce\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/diagnosticsSource.js\":\"5cbae9d1d0ed5fa1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/divergenceScan.js\":\"0180f8ebe3b2468a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/index.js\":\"b95097def6e76d57\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/propertyChildrenChecks.js\":\"7f9618bfe7bd2b72\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/referencesMirror.js\":\"5b3471074e5864ec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/rowJson.js\":\"df3c03db2e904c8c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/schedule.js\":\"8a6a6052597368d9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/data-integrity/store.js\":\"01a859a9150ef198\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-maintenance/action.js\":\"049296ed905efea8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-maintenance/index.js\":\"b35dd9816dfdc4fa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-maintenance/plugin.js\":\"4fae489ea063be25\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"fbbfcc1b9690cfcc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/actions.js\":\"0682b3307e24fa61\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/changeMarker.js\":\"95560790ff4e83ab\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/diagnostics.js\":\"5c15e7db66375156\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/fileSystemAccess.js\":\"a7ebb48483df7feb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/filenames.js\":\"2d2c008ad2dd64ae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/index.js\":\"da97452dc09decb3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/mirror.js\":\"75df7c69ff9bc381\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/runLock.js\":\"0b64a0c2938794fe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/runtimeHealth.js\":\"a97b99e602fcb696\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/schedule.js\":\"102b85482b6feeaa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/db-mirror/store.js\":\"1256cba0daf2c793\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/default-themes/index.js\":\"abdf2e8bf534d2a9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/default-themes/themes.js\":\"108715adac5f38cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/diagnostics/facet.js\":\"d2d65ec234e357ae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/diagnostics/useDiagnostics.js\":\"6307ffe6f25fd9bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/dismissals.js\":\"3885eacf2a86a0f7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/index.js\":\"3beaab29602adfe1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/status.js\":\"f09f86421775c29c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extension-prompts/store.js\":\"7aa98dcf4521f088\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3ac49e0e8848c86f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4854c866e6a6b520\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/actions.js\":\"d0f85ffb79cd19c1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/config.js\":\"a20e76fd742b2b0e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/dataExtension.js\":\"c43001a0268001b0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/effect.js\":\"f8cc47ef2ab1b064\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/index.js\":\"abc8c38799e44aa6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/propertyEditorOverride.js\":\"138cbac32094955d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extensions-settings/useToggleTree.js\":\"3cf1c30385b6c013\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/ExtractTypeDialog.js\":\"a82fd4b127584132\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"609841ab69513ee8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/PropertyShapePicker.js\":\"d377ad902dad3f34\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/action.js\":\"fd6d8f5c02775766\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/extract-type/index.js\":\"60d9b3450d5c82e7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/FindReplaceDialog.js\":\"59bd1b5f4bd8935c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/HeaderItem.js\":\"0043c4cf914fdd73\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/dataExtension.js\":\"9e02b64d727ed127\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/index.js\":\"bbe8aeb17e821bbc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/search.js\":\"be4d250b66bf5280\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/toggleStore.js\":\"efd40a529a169ccb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/LocationPropertyEditor.js\":\"903cdf6369be8398\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/MapView.js\":\"30c0371cb10992df\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/blockTypes.js\":\"d85d4311e5238206\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/codeMirrorExtensions.js\":\"0d255a16d2c41ac1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/createOrFindPlace.js\":\"126dbd5553898d7e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/currentLocation.js\":\"b133362466683020\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/dataExtension.js\":\"828cde92457776db\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/geoContentDecorator.js\":\"52bdfc7f3f0eb3fe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/googlePlacesClient.js\":\"edc7d8d03b2b835e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/index.js\":\"18a831812c74f1b1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/locationsPage.js\":\"6316463926d70fea\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/mapViewport.js\":\"4c7a17634fa042ae\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/pickCurrentLocation.js\":\"c87d789d27104ed2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/placeAutocomplete.js\":\"3b4897edaa0900df\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/placeNameCollision.js\":\"cfa004e803ac8a39\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/properties.js\":\"13ed9a162f68f3af\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/propertyEditorOverrides.js\":\"c648d16b19e18277\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/query.js\":\"43153c3167a81a07\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/geo/usePlaceSearch.js\":\"4243f161ba1e5fdb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"926b2d0ffbd8ec26\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"f33e36cd5e3a97be\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"736578f9ec8f67bf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/config.js\":\"5e681ff4cd332387\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/dataExtension.js\":\"5a7e8627a24b3998\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/facet.js\":\"dd32a68eab1b9656\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/grouping.js\":\"058cbd74e307d85f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/index.js\":\"6f1e1804da023757\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"eedf73c531c321b0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/query.js\":\"00464de25ae15cab\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/resolveConfig.js\":\"476e71ca644316dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d4dea0dd118b6447\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"90f8954fffa31963\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/HtmlDocumentContent.js\":\"39f6e802b38fe22c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/HtmlFrame.js\":\"ec798840f2feac1c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/actions.js\":\"999626300a96633a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/blockType.js\":\"7a21c1ed81cd0641\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/confirmRunScripts.js\":\"6bf6b128f0123906\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/dataExtension.js\":\"24eef8d042bd19ef\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/frameAnnotations.js\":\"f658914840bf9118\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/frameDocument.js\":\"7b4ff7e9e56a3517\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/frameTheme.js\":\"c29b142c916cd7d3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/index.js\":\"f907f7d1ec2853bc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/scriptConsent.js\":\"a3942786f9216768\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/sourceMap.js\":\"7fbf4d9aa803ab0a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/html-document/useDocumentScripts.js\":\"d41adc86cbe5ca90\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/index.js\":\"99e4af292a5b4267\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/record.js\":\"c6173b05e129c503\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/recordStore.js\":\"d0d29298c35cd371\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/responsiveness.js\":\"3d097dc0660c027f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/schedule.js\":\"37b68e6a2e375d5a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/interaction-metrics/sessionContext.js\":\"33c33ab503e99229\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"cf67f87e33c8fa05\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"d33ebbb350c8668d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/actions.js\":\"18051889256513c1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/config.js\":\"2b521aeb64490055\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/dataExtension.js\":\"051b31ec3034e616\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/effect.js\":\"32f967a871aefc65\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/index.js\":\"4bf3123b056d634e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/keyCapture.js\":\"d43e4916cd3281f6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/overrideStore.js\":\"729d8c6f9823539c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ddf6419142df3b68\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/HeaderItem.js\":\"1d6d4ffbd4986645\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/LeftSidebar.js\":\"113e30981e88dfe9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/actions.js\":\"c0538494e3b3f4bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/facet.js\":\"e4e3311b71567ccc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/index.js\":\"74746d67fe5684e0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/shortcuts.js\":\"24f9d771cf246d1f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/left-sidebar/toggleStore.js\":\"2604455629d34afc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/MergePicker.js\":\"3667277a74ac1dbe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/index.js\":\"61e07d76ea48237d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/mergeAction.js\":\"668a9bc84e5dcace\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/merge-blocks/strategy.js\":\"33445bcfbb7fcd4d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/Button.js\":\"c719a59b47e94a6e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"44124d3b14a84708\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f4b9a432099d64f2\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/facet.js\":\"4f33ad6e39fad3aa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-bottom-nav/index.js\":\"4bd5379fe9bd4d83\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"47b3d35bbe2442d7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6b88d8533579d924\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"12c00c9bbe157d55\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6d9044902fb6f6cc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/mobile-keyboard-toolbar/index.js\":\"fc5e1d66ff7e2044\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/MoveDestinationPicker.js\":\"450e9d3135bd6fa0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0bd62daf7791c141\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/contextMenuItem.js\":\"7b47db062b7e3e37\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/index.js\":\"7bb5daa9f14e08a5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/moveAction.js\":\"27e86b6b314e9c8e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/moveBlocks.js\":\"2bd716e1d6e521b1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/move-blocks/selectionAfterMove.js\":\"b80bc77b021a655d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/TutorialBanner.js\":\"5fce62b1c813900e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/action.js\":\"94514de5684f42bc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/bannerDismissal.js\":\"4027a0de059af88d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/documents/cheatSheet.js\":\"7cdb24ec9fd9b462\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/index.js\":\"171b4a9b37b5acf3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/keys.js\":\"79b2c1bd89d5160f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/landing.js\":\"b0d8aea03d31b878\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/outline.js\":\"59464e6446b64500\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/onboarding/seed.js\":\"17182acc09b47b8e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/PerfTrendDialog.js\":\"23e40c1901bdaf30\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/analyze.js\":\"8c65e56d5f1dce5a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/diagnosticsSource.js\":\"5c123cd988987278\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/index.js\":\"b7ebb02d03604640\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/load.js\":\"d3a6ea5727e831ab\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/monitorRun.js\":\"835f4b5487c0b56d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/schedule.js\":\"d3df766fc6598c24\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/series.js\":\"31ecc8a7621601bb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/store.js\":\"8594d54f4ae1c106\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/trendAction.js\":\"94eb390cb3dd7e88\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/perf-monitor/verdict.js\":\"82e075dfe095f184\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/plain-outliner/clickToEditAction.js\":\"e63de3c50a071f7e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/plain-outliner/index.js\":\"c2a74f935cd091cd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/plain-outliner/interactions.js\":\"e2996ca31712a97a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ecbab5d1cc4bc558\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/MigrationGate.js\":\"f31455be4550a215\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/MigrationGateDialog.js\":\"71a624b8add837d5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/action.js\":\"d170e972954ccd74\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/index.js\":\"032b2190f3d2a158\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/localRunMessage.js\":\"9af30fe70c0fe4bb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/plugin.js\":\"82ddc308ce1b435a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/progressReport.js\":\"9d830719ca09fa09\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/properties-migration/sweepProgress.js\":\"e3d9cfcd3b2468c0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/FieldRowRenderer.js\":\"9bc50331a9b19c74\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/ValueRowRenderer.js\":\"f470deac0e7d583e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/actions.js\":\"a9945a9c6284d041\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/autocomplete.js\":\"5b9ca25e53ab25cb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/fieldRow.js\":\"3a7fcbac01c69f4a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/index.js\":\"305e632decec5569\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/referenceWarning.js\":\"c7ae8e5ae5f703e3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/valueAutocomplete.js\":\"d94346977fb25f82\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/property-rows/valueSchema.js\":\"5a00626d6cde9e1c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/HeaderItem.js\":\"36b5ad25190dfcd9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/QuickFind.js\":\"7d30b8ac0017ae16\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/index.js\":\"67cb8e424e561ee7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/recents.js\":\"f4adb4929ac510dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/resultItems.js\":\"762190f20f425ba7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/selection.js\":\"dd233e292e15b742\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/quick-find/toggleStore.js\":\"363a463c3760a79b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/HeaderItem.js\":\"dd7c9485445eb0d4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/RecentsPageBlockRenderer.js\":\"ff26dde86b2aea2f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/grouping.js\":\"a6c8a53e2f138e16\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/index.js\":\"6214fa5aaa678cba\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/recents/target.js\":\"10c79bd595416e68\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/codeMirrorExtensions.js\":\"5c8f114387c77e7e\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/contentPrefill.js\":\"f2e1f1f00b1c8674\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/dataExtension.js\":\"d1ec88c39898cf46\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/index.js\":\"cdc3c01c577fde95\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cbab6cce5990e777\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/invalidation.js\":\"32ee78425251ecc5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/localSchema.js\":\"8423d746b2b76c19\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/blockrefs/index.js\":\"05a6d2ce865df391\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5ae369c3cae006b3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/index.js\":\"e59466cf643296cd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/referenceNode.js\":\"c832b4ad38c02c5b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cf1487db53e38c66\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"30e7d2c5300fbf50\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/index.js\":\"32faec313226aa5b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"374a6c4de86f33f7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e410ce8db59f4df3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/mergeRetargetProcessor.js\":\"01d5941c4a219c0a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/parseFence.js\":\"59f2144e958c7d18\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/referenceParser.js\":\"0aa00417b248e103\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/referenceProjection.js\":\"2b134126a13e1546\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/referencesProcessor.js\":\"52b3ea267df1e390\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/renameProcessor.js\":\"d396eb72d424735b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/references/spanReplacement.js\":\"97816a624aa84ddb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/htmlToOutline.js\":\"94cc1da67cca09c4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/index.js\":\"d662fb8a500d67ec\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/normalizeClipboardDom.js\":\"56f1bc09eab083f0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/rich-paste/pasteDecision.js\":\"6a19711cc25b9538\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/action.js\":\"423de7f2f5cdd5d7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/blockIds.js\":\"ca2c40c51450e3de\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/content.js\":\"3954a4aedf8ccf7f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/effect.js\":\"755217853cbf3f40\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/ids.js\":\"f772fb2694f5a883\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/import.js\":\"ca523aba02abe52b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/index.js\":\"61244ce247388bea\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/plan.js\":\"3325d65694a5a1d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/plugin.js\":\"dd1c2886c128f4e7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/promotion.js\":\"90ee0af7a3d99698\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/properties.js\":\"642c9a8c5bba7d62\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/references.js\":\"04bbe47d7924bf75\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/report.js\":\"98464520119e2913\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/roamMemo.js\":\"7f25b969fe23259a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/runtime.js\":\"8f9f176ba931afdf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/schemaReconciliation.js\":\"07776f01f13ca63c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/srsMarkers.js\":\"8f2c9795f5fe7308\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/todo.js\":\"a4e8a2593aeb4083\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/typeCandidates.js\":\"73e3362a50d654c4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/roam-import/types.js\":\"bac36f56ed3b7ed9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/search-health/index.js\":\"ad2f61fdc6af9b47\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/search-health/store.js\":\"2dd8344d6588d431\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/HeaderItem.js\":\"bc700baa18985625\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"582b1efaf64c9c52\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/index.js\":\"a39ea83a647f880b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/model.js\":\"04830fa12506f367\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/toggleStore.js\":\"3971770475914760\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/shortcut-help/useKeyInspector.js\":\"9655d3e99eae0e97\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8a22df512ac3f5bd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/ShellDecorator.js\":\"d48f1b182f9bba01\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/actions.js\":\"8cf31b89de4a0058\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/exclusionsFacet.js\":\"46db53beeaa0ea79\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/index.js\":\"5bbb8a718e66daee\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/shell.js\":\"60ec289016b831f7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/surface.js\":\"f23f688fd1d82745\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/spatial-navigation/walker.js\":\"0597b55b3fbfc1ef\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1d24cd4c04b34dbe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/dataExtension.js\":\"4bdabff341bc6bdb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/index.js\":\"f7a9673fe0078265\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/indicator.js\":\"11207fa2af14b823\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/moveSrsState.js\":\"61a60423c1810ecd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2a660609415fbd3a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/scheduler.js\":\"09e98145fc153a8b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/schema.js\":\"1d459a8697bca550\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"9b45f78ac3b96d68\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/srsClipboard.js\":\"f6169ae99ddded58\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"a5264d65e6ffa8a0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/DailyNoteReviewHint.js\":\"90a666990b8ba790\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/DeckPicker.js\":\"11828318f1e9ffca\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/ReviewControls.js\":\"cb309049ee83f723\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/ReviewDeckRenderer.js\":\"24ab119851725de1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/ReviewSession.js\":\"3e8a507cabf7d743\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/actions.js\":\"19c49bd303d83f3c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/archive.js\":\"ae1801f5eb08dbcd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/dataExtension.js\":\"9de0a18c8f52d43b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/deck.js\":\"78591320c0d6f435\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/dueQuery.js\":\"5484c3c22fbd55d8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/gradeDecision.js\":\"17ffe899944f1374\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/index.js\":\"14e6b4340dacbc96\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/keyHints.js\":\"dc827188f9bfcfff\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/reviewCardLayout.js\":\"2a1d7dc669ec03ed\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/reviewProgress.js\":\"af1f9c894fe5962f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/schema.js\":\"d073cbe931fa9be1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/srs-review/useDueCards.js\":\"e5e0485ef45cdc4f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/startup-metrics/index.js\":\"e34f66b455a842da\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/startup-metrics/record.js\":\"30ff262503194b75\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/storage-persistence/index.js\":\"286a65d57c575b4b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/storage-persistence/persistenceStatus.js\":\"c73d0b3b1d4a2a7a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/storage-persistence/requestAction.js\":\"c7b4782d8ad9b1bf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/TypeChipsDecorator.js\":\"3f378053313ddee8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/codeMirrorExtensions.js\":\"3cf0c91b40a9fe9a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/index.js\":\"474a2d0d9441aa15\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/supertags/typeAutocomplete.js\":\"e2be049bfd6fe75f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2ac6031f493e81a6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/actions.js\":\"2e7edecaf9822ef3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/anchor.js\":\"a98f16ed2baefdbe\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/events.js\":\"b876a0e2a500d8ff\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/gestureActions.js\":\"13908c82a8ffaa1d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/index.js\":\"6716c6035441f6dd\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"56efffd88273755b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/sync-metrics/collect.js\":\"ca186af7fa461697\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/sync-metrics/index.js\":\"f6893bc3910b49d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/sync-metrics/record.js\":\"658ca2c896bd921b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/RejectionDialog.js\":\"a7bcf2a0ff20c072\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9b7af32c8ccebbbf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/index.js\":\"bae430d7fad43f15\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/model.js\":\"d93958c616df2d32\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/queueCounts.js\":\"e1c2427c32658fe1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/rejectedHelpers.js\":\"9d316b55c0c19f04\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/rematerializeAction.js\":\"689d114904cf3e70\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/system-status/useHysteresis.js\":\"3171e2d13f950d47\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/ColumnHeaders.js\":\"c4945d81df47767b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/QueryUi.js\":\"f84de4fd70c3e5d6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/TableLayout.js\":\"477f2471e8059cfc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/actions.js\":\"74eadd8843868039\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/cellEdits.js\":\"a3e2ce129805d607\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/childrenViews.js\":\"79005d0a6944e281\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/columns.js\":\"2d66438773b0e7b3\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/controller.js\":\"0d8a0c63e34447b0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/convert.js\":\"7c77666c81a7d727\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/dataExtension.js\":\"67e8c0763ba25bf1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/index.js\":\"78a650d4fcb9a3e1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/keys.js\":\"a419f7d5adde1d12\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/model.js\":\"2f2c08f66f07677d\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/QueryText.js\":\"737fe8d17a6ee8c6\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/backfill.js\":\"7d0e6ee34b556521\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/completion.js\":\"dcb37e804ca38924\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/format.js\":\"3f8378eaa61b66c8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/parse.js\":\"98ecd342607585e9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/queryValue.js\":\"77d30b5d6144b033\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/registrations.js\":\"28b82db05e98d4c4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/query/source.js\":\"696156a930b7a0bb\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/registry.js\":\"b3da743b4ab81a43\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/rowGutter.js\":\"1d64d63ac20c74b9\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/rowVerbs.js\":\"b677104d53482753\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/schema.js\":\"3035cac6f571d427\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/tables/sort.js\":\"eaa6c57f756eacaf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/theme-toggle/effect.js\":\"b68564f7f0c058cf\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/theme-toggle/index.js\":\"d2bee8bd40a7361b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/theme-toggle/theme.js\":\"ce8c9d56e07ead80\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/actions.js\":\"b28e9a0900988e8f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/dataExtension.js\":\"a34824e44e2007df\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/index.js\":\"9d08dc48c6f8170f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/todo/schema.js\":\"457aaaa55683297c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/TouchSelectionLayer.js\":\"36ee3e9819ec093b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/actions.js\":\"43858da7bab17775\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/defaultItems.js\":\"c008fc16978a9c89\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/facet.js\":\"60dbc1981436425c\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/holdRecognizer.js\":\"ac7cafc7b713496a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/touch-selection/index.js\":\"c4e47d35027f30a0\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/update-indicator/UpdateIndicator.js\":\"5c4a487290f7bc99\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/update-indicator/index.js\":\"854a4fe5e0b5b825\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/update-indicator/loadTimes.js\":\"07d41143ffe1df4a\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/VideoNotesRenderer.js\":\"3787fe424a490a1f\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/VideoPlayerRenderer.js\":\"da214d9f26f9b41b\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/VideoTimeStamp.js\":\"cd348c2074e03d83\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/actions.js\":\"4be48cf2351662b4\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/index.js\":\"bae699a2417642d1\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/markdown.js\":\"e80190b04b8a4032\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/notes.js\":\"de0b25f983646b46\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/registry.js\":\"16668af4590f6570\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/remark-timestamps.js\":\"023007ea0ab50f71\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/video-player/view.js\":\"469d9f704bb85f37\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/LinkHints.js\":\"3ffaa6ce83a1f7b5\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/index.js\":\"7efc04b12bd48ee7\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/model.js\":\"1a3a8aa1f6cd03bc\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-link-hints/settings.js\":\"16a05adc5dc7ab97\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-normal-mode/actions.js\":\"4f63664524b9e669\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-normal-mode/index.js\":\"cb6d67f2bdd634fa\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/vim-normal-mode/interactions.js\":\"44f6331383d65ac8\",\"/knowledge-medium/pr-preview/pr-1909/src/plugins/workspace-header/index.js\":\"55b9f909cf94edc6\",\"/knowledge-medium/pr-preview/pr-1909/src/registerServiceWorker.js\":\"0cf8bfc45ef3117e\",\"/knowledge-medium/pr-preview/pr-1909/src/requestPersistentStorage.js\":\"14cdd1c6a13f4cf2\",\"/knowledge-medium/pr-preview/pr-1909/src/services/authRequestDeadline.js\":\"7c51438228ffdfca\",\"/knowledge-medium/pr-preview/pr-1909/src/services/authStorage.js\":\"afd0a5b6991f3551\",\"/knowledge-medium/pr-preview/pr-1909/src/services/powersync.js\":\"1e7c1c6dc5d61e09\",\"/knowledge-medium/pr-preview/pr-1909/src/services/supabase.js\":\"45b979a0ec601f06\",\"/knowledge-medium/pr-preview/pr-1909/src/services/uploadErrorClassifier.js\":\"ac5b44fdc2f06ec3\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/ActiveContexts.js\":\"d7328ddf8a4ac58a\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/HotkeyReconciler.js\":\"620088e95a69b4ff\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/WipeLocalDataDialog.js\":\"e0524159e7ace6eb\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/actionDispatch.js\":\"44dd71949b765f44\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/actionRefItems.js\":\"0c0dfb30f4a9e316\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/applyKeybindingOverrides.js\":\"0f27bbd5fc6ff627\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/blockActions.js\":\"e9515e53d09833ab\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/blockMergeGesture.js\":\"70d03ec2c7340280\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/canonicalizeChord.js\":\"be7dcb64e6b4d266\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/defaultContexts.js\":\"d2e7fdb2a94ec176\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/defaultShortcuts.js\":\"61824c87589864e5\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/effectiveActions.js\":\"a28f1a100dc0f2cb\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/gestureAction.js\":\"031aed1d70e3ce73\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/gestureBinding.js\":\"eeb0087a0add5d38\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/holdRegistry.js\":\"e4350b1b8536c8f5\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/keybindingConflicts.js\":\"1e7d500d2612af31\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/keybindingOverrides.js\":\"ba26ce2204999cdc\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/pointerAction.js\":\"55c5aab682f9085b\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/resolve.js\":\"bc26261ae467986d\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/runAction.js\":\"7815991b6d95fa91\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/sequenceMatcher.js\":\"602971fe9d6c58b4\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/types.js\":\"f4f0d35dc29c132e\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/useActionContext.js\":\"e5e0d11f20000c4c\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/useActionDiscovery.js\":\"a521cc8badd71016\",\"/knowledge-medium/pr-preview/pr-1909/src/shortcuts/utils.js\":\"a8c976b6e72b79d3\",\"/knowledge-medium/pr-preview/pr-1909/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1909/src/sw/bootStore.js\":\"21eb552664c6e579\",\"/knowledge-medium/pr-preview/pr-1909/src/sw/previewDatabases.js\":\"367828816ba35c26\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/byteTransform.js\":\"f42f61cc9cc2e63c\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/attachmentCleaner.js\":\"2175af8835182bef\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/attachmentParts.js\":\"2c91f0950ee5e38e\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/bundleParts.js\":\"90bc9bfe7eccf1a7\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/bundleRecord.js\":\"e55bfb351e56597c\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/manifest.js\":\"c14d903ede012f5b\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/takeBundle.js\":\"3cbb45a17e1d51d0\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/bundle/verifyBundle.js\":\"a9e3249532569c73\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/cleaningStage.js\":\"5b62d181b881a55e\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/conversionKey.js\":\"7daddaef011a16a4\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/conversionServer.js\":\"4840ee52d7ff4c61\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/flip.js\":\"84906d3a291fdef8\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/flipAttempts.js\":\"7f75e8012432fc3b\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/pages.js\":\"e359ea5ca29b2ef7\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/preflight.js\":\"2d9a292666e49761\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/reseal.js\":\"d06716fa0e942ce5\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/runConversion.js\":\"58d5a51df6f69d8d\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/runLock.js\":\"0aff2e3126f7c61a\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/sealing.js\":\"a277e002b26b2d51\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/sealingStage.js\":\"b13316b9ef399263\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/stage.js\":\"23a57c2cef371e73\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/conversion/verifyReseal.js\":\"a4b83ac399a12559\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/aad.js\":\"1b75dbd512d9d0b6\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/aead.js\":\"f13a5d22a165077a\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/base32.js\":\"9d941d936c3c77e3\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/base64url.js\":\"2482b88808568f66\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/binaryEnvelope.js\":\"50db16dff5f6a2b1\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/byteAead.js\":\"7daa2bb28f95e3ae\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/canary.js\":\"25b7f668adacc30c\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/contentHash.js\":\"775ff86372741238\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/contentKey.js\":\"3b2a334a5a599de8\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/derivedIdNamespace.js\":\"c193083db9e5d84f\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/envelope.js\":\"49c3078806b5e7bd\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/hex.js\":\"75593ebd701e15e0\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/sha256Hex.js\":\"67bbc9497b98ce11\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/crypto/workspaceKey.js\":\"73c83575aae4e9dc\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/conversionState.js\":\"4da8548f9c34f123\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/createEncryptedWorkspace.js\":\"b23c76e4f27c91d7\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/pastedKey.js\":\"0b123d6fa180abc1\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a794ec54cc0a8499\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1a6c50a2554a3d4c\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/keyStore.js\":\"d644461bde1e0365\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/mintWorkspaceKey.js\":\"96cb797149664181\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/modePin.js\":\"5ffb7c3037cb9d07\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/openWorkspaceKeys.js\":\"8ba31935938d8db0\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/resolveWorkspaceEntry.js\":\"99315dacdb23cd4b\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/resolver.js\":\"d3451456a31f6b29\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/keys/workspaceAccess.js\":\"a0fb2d0b5d54cd57\",\"/knowledge-medium/pr-preview/pr-1909/src/sync/transform.js\":\"19aeca388fbe6406\",\"/knowledge-medium/pr-preview/pr-1909/src/themeBootDefaults.js\":\"2cee603c729420f5\",\"/knowledge-medium/pr-preview/pr-1909/src/types.js\":\"b45e0e7ac6df4531\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/ClientLocalSettings.js\":\"ff56b21924f86a1c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/abortableSleep.js\":\"19c6ae5e29711fb3\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/array.js\":\"b1bb70cff18182d1\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/backlinkAutocomplete.js\":\"c7c3cea42feb2695\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/blockCrumbs.js\":\"1f6ead414e4d888c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/blockrefAutocomplete.js\":\"18238ee4dc3ecfc9\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/cadencedIdleJob.js\":\"7c4f4c57fbadc6be\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/callbackSet.js\":\"0704afecf4ecdb87\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/clientId.js\":\"67d4b14217acc9d9\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/codemirror.js\":\"8020c01eb669a7c2\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/codemirrorCompletion.js\":\"7184221a6ff3f9e3\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/copy.js\":\"dbc732496ab03783\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dailyPage.js\":\"4ca05a226af05352\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dbForensics.js\":\"21c88f285ecdd4f3\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dbForensicsHooks.js\":\"456c39dc4e323b79\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/deleteBlockThroughUi.js\":\"052f041b70074a33\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dialogs.js\":\"322cdddb16dbbc32\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/dom.js\":\"1132c4e55cc16705\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/downloadBlob.js\":\"5dca3e2014886fd1\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/drawnWalk.js\":\"635dba4ab0386b9e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/exportSqliteDb.js\":\"49ea1e1eb8779c50\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/fileSystemAccess.js\":\"252876d1b8070d68\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/flipSlide.js\":\"de3eca0548a9e613\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/fnv1a.js\":\"a1099c36bf6d5e05\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/formatBytes.js\":\"4a5e824232bf532f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/fuzzyRank.js\":\"608e67302a51a92a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/idbKeyedStore.js\":\"05d559aa05c15072\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/idleCallbackPolyfill.js\":\"68932223680038e5\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/keyboardAwareScroll.js\":\"1985c40117e5e035\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/keyboardViewport.js\":\"524a528e5e18795f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/lastWorkspace.js\":\"572ab51cdcf24594\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/layoutColumns.js\":\"51ac1b7876000e53\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/layoutSessionDom.js\":\"91f10d9ee3f0a67b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/layoutSessionId.js\":\"84902b018efa8852\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/linkClickGestures.js\":\"74688362acdc86ee\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/linkTargetAutocomplete.js\":\"1cf208b4045c9cf5\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/localDbCorruption.js\":\"94349e9e0ecee023\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/localDbRecovery.js\":\"977c4c807e31560f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/markdownParser.js\":\"3ea5da33fe598c4f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/memoize.js\":\"ec34598e3417948d\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/nameFieldCommit.js\":\"a403582154a384c5\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/nameList.js\":\"83e1cada48251bad\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/navigation.js\":\"bc7aa253a901cbf3\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/omnilinerNamespace.js\":\"c003aa531e1e207a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/opfsPageScan.js\":\"d0f6dee45cfb048a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelClearance.js\":\"976dcd868bf2dcf3\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelHistory.js\":\"c41e11bd2fc4b90f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelLanes.js\":\"4ff92a8c798017df\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelLayoutProjection.js\":\"bd1771aa89d54d8e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelScrollAnchor.js\":\"a1d1c47b25b35783\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/panelUrlFlags.js\":\"df1d92c7776b7d5e\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/platform.js\":\"a1321705c2f62eb2\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/pluralize.js\":\"58cc90c998ab37e0\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/propertyCreation.js\":\"c5c7aeaadcda40b6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/propertyNavigation.js\":\"dc5afc89e34c3b8a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/propertyValueContext.js\":\"ad40706e127bac24\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/react.js\":\"5638dfe85ab57933\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/relativeDate.js\":\"7ae19dfe4fe9c0f9\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/relativeTime.js\":\"eaee6030a165fce2\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/renderScope.js\":\"0d3ae744806c5d04\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/resolvedThenable.js\":\"d31c153655af3e7c\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/routing.js\":\"520e544adc607f91\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/safeMode.js\":\"81e1ade773a986d1\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/scheduleIdle.js\":\"10eb711e99b874fc\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/screenWakeLock.js\":\"62342d190954fea6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/selection.js\":\"3afef4ba7fc50a28\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/softKeyboardGrab.js\":\"f0cda542863f989d\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/startupTimeline.js\":\"34541a49c7cce428\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/state.js\":\"10b3f6cb625fba7f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/string.js\":\"b28c218a43cd36d1\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/surfaceZoom.js\":\"416a78c9e86b6f7b\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/time.js\":\"b68def7f900fdcd0\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/toast.js\":\"2f3cb1645bce75f0\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/toggleStore.js\":\"eb22cad50db89ee6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/untilStopped.js\":\"a080fc68a86d5f7d\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/userActivity.js\":\"f5d0ca2412997b2f\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/viewTransition.js\":\"5e32ccc75f3570ef\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/viewport.js\":\"9d5fe2ec884a4880\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/webLock.js\":\"42c07a9c84b9144a\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/workspaceRecovery.js\":\"c6aba00217bc2518\",\"/knowledge-medium/pr-preview/pr-1909/src/utils/workspaceSnapshotStore.js\":\"ca74f78b1881035f\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-compiler-runtime.js\":\"472494c549fa70b1\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-client.js\":\"ed378cd81a246b2f\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-server-edge.js\":\"6bc4b993a3bf7641\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-server.js\":\"da2415771ec93837\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-static-edge.js\":\"6d56def92c4b9ff6\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-static.js\":\"a7000ef150bcf663\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom-test-utils.js\":\"a815c90d0df39d3c\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-dom.js\":\"f843b442c7078fcf\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react-jsx-runtime.js\":\"bc93c77179f77b7a\",\"/knowledge-medium/pr-preview/pr-1909/src/vendor/react.js\":\"8b0b1186e94dd102\",\"/knowledge-medium/pr-preview/pr-1909/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1909/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1909/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
