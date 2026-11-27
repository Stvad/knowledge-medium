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
		buildId: "890e4242439c-69ebe6d8",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1910/\":\"bb82e378c9e4268f\",\"/knowledge-medium/pr-preview/pr-1910/index.html\":\"bb82e378c9e4268f\",\"/knowledge-medium/pr-preview/pr-1910/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1910/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1910/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1910/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1910/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1910/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1910/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1910/assets/FacadeVFS-DUXV8TgA.js\":\"8312075cc7508dbb\",\"/knowledge-medium/pr-preview/pr-1910/assets/OPFSCoopSyncVFS-CABfK6vr.js\":\"354bb2979229ddd0\",\"/knowledge-medium/pr-preview/pr-1910/assets/OPFSWriteAheadVFS-zrNTSjQd.js\":\"df2eadc5a17a2c04\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-CdZWCFtn.js\":\"6f7a124c2d546f30\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-async-DkT7umTd.js\":\"4fc68f0ce9e08dac\",\"/knowledge-medium/pr-preview/pr-1910/assets/worker-DaQCP1fF.js\":\"92988096267295dd\",\"/knowledge-medium/pr-preview/pr-1910/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1910/chunks/app-DW9HC2_W.js\":\"1b7bfb01a0aefe4a\",\"/knowledge-medium/pr-preview/pr-1910/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1910/index.js\":\"629e64d2dd4c76e5\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1910/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1910/assets/AccessHandlePoolVFS-FcA_XUwM.js\":\"0fc6c15b3e29d077\",\"/knowledge-medium/pr-preview/pr-1910/assets/IDBBatchAtomicVFS-Co7y4hq4.js\":\"3caca156e1149f8d\",\"/knowledge-medium/pr-preview/pr-1910/assets/MemoryVFS-DGMvGgAq.js\":\"785cc0f376fce43c\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-DC8dbU0t.js\":\"dc89b27963316515\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-async-CJSGxizO.js\":\"6c79739a503c5607\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1910/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1910/chunks/AccessHandlePoolVFS-Dd7Wpuao.js\":\"fc8ea91f2f2922fa\",\"/knowledge-medium/pr-preview/pr-1910/chunks/FacadeVFS-B04tElb5.js\":\"e189f8ec0369d815\",\"/knowledge-medium/pr-preview/pr-1910/chunks/IDBBatchAtomicVFS-DmD83nlM.js\":\"b560d7f7ecb7550f\",\"/knowledge-medium/pr-preview/pr-1910/chunks/MemoryVFS-BU50Y4J0.js\":\"7025d7a46db07d3c\",\"/knowledge-medium/pr-preview/pr-1910/chunks/OPFSCoopSyncVFS-CpkR96sb.js\":\"6fd7a4e66486a925\",\"/knowledge-medium/pr-preview/pr-1910/chunks/OPFSWriteAheadVFS-B0ZvJ67V.js\":\"54ccfcd5e584cebe\",\"/knowledge-medium/pr-preview/pr-1910/chunks/Preview-B9LKAKj6.js\":\"6e02085e5f327e55\",\"/knowledge-medium/pr-preview/pr-1910/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1910/chunks/card-Bhq0i6vn.js\":\"640f2c95e8b879ee\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dist-hbzJ9gfm.js\":\"d890be8ab1007e5c\",\"/knowledge-medium/pr-preview/pr-1910/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1910/chunks/mc-wa-sqlite-Bh-HPV2Q.js\":\"39b8097294abe8e5\",\"/knowledge-medium/pr-preview/pr-1910/chunks/mc-wa-sqlite-async-OgENU2Um.js\":\"1e973b04fd0381b8\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-BSE2sF5h.js\":\"2d07492663aa936a\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-BWqoSiJl.js\":\"9449d4cae8cf7245\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-B_KCltrp.js\":\"5bedd674a1ea23ad\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-CN8Aa-hd.js\":\"22beffb6b6541fd9\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-CQkTxxOU.js\":\"e95d4f2165caf453\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-De4tX7qt.js\":\"92fa26977a412763\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-Dn7ELk6_.js\":\"599977154cea3bb9\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-ahWE3AEK.js\":\"bff9b083131df690\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-dom-server-legacy.browser.production-Dp_FXrJK.js\":\"5446947abc2ad0bd\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-dom-server.browser.production-DDiO7RB1.js\":\"8e326842f9421c75\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-dom-server.edge.production-diQG27cV.js\":\"c189310e33b58a45\",\"/knowledge-medium/pr-preview/pr-1910/chunks/server.browser-xVfjTTo0.js\":\"1a001edf1e3ba672\",\"/knowledge-medium/pr-preview/pr-1910/chunks/textarea-DTLQmq_8.js\":\"6d9019ac2a69bcb1\",\"/knowledge-medium/pr-preview/pr-1910/chunks/ui-f2EJuu4F.js\":\"02529adf5d465410\",\"/knowledge-medium/pr-preview/pr-1910/chunks/wa-sqlite-UaKQ-EbM.js\":\"65fa332e9ec5843b\",\"/knowledge-medium/pr-preview/pr-1910/chunks/wa-sqlite-async-MqdssqRV.js\":\"0b7d94ae2c15104e\",\"/knowledge-medium/pr-preview/pr-1910/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1910/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1910/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1910/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1910/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1910/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1910/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1910/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1910/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1910/src/App.js\":\"c9ad5ff42441088b\",\"/knowledge-medium/pr-preview/pr-1910/src/appUpdate.js\":\"a441360e6e1afc38\",\"/knowledge-medium/pr-preview/pr-1910/src/appVersion.js\":\"a50168de6c223daf\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/initialLayout.js\":\"9841f001a0b1cb0b\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/openWorkspaceData.js\":\"2581ef538f6dbef2\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/resolveWorkspace.js\":\"2af457649ba0c14c\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/workspaceBootstrap.js\":\"d8e1f2101b2676a6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockComponent.js\":\"6e9b0c60668035d0\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockCrumbs.js\":\"954dbcf13a26d947\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockEditor.js\":\"1986d12232647896\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockLoadingPlaceholder.js\":\"b6b445e996113df5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockProperties.js\":\"01ff55cadb61ff42\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockSearchPicker.js\":\"d95fd5c81b3b8869\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ConfirmBulkDeleteDialog.js\":\"d3aa31fd4257cba2\",\"/knowledge-medium/pr-preview/pr-1910/src/components/DividerHandle.js\":\"67c940f7a1d91ca3\",\"/knowledge-medium/pr-preview/pr-1910/src/components/DraftEditor.js\":\"6477f360243b50b5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/GutterPill.js\":\"afff46a2501d8dd0\",\"/knowledge-medium/pr-preview/pr-1910/src/components/Header.js\":\"8485ea8857079145\",\"/knowledge-medium/pr-preview/pr-1910/src/components/LazyBlockComponent.js\":\"f6bef50303d59a21\",\"/knowledge-medium/pr-preview/pr-1910/src/components/Login.js\":\"85b9dc3f708b1527\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ZoomableSurface.js\":\"55c497f546e29a07\",\"/knowledge-medium/pr-preview/pr-1910/src/components/editModeKeepalive.js\":\"25cbd339b6336245\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9a9049f87ac96619\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"dbdc6699ac867638\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/RefPropertyEditor.js\":\"cd38d5f381ce3456\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/RefTargetTypePicker.js\":\"e66fe32214a3f1e5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/SelectPropertyEditor.js\":\"a09316861246fbdf\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/TypesPropertyEditor.js\":\"1781f08e898b4b30\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/defaults.js\":\"36799852be71b142\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/kernelValuePresets.js\":\"ce9a6831cb42ce77\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/selectablePresets.js\":\"7641349155112f92\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/typesPropertyUi.js\":\"53e0b70229660a60\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/AddPropertyForm.js\":\"0403108ee4e5d9ae\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/PropertyPicker.js\":\"4a49e1a89f744faf\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/PropertyRow.js\":\"d874aeef9776b36c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/Rows.js\":\"52d44e6ccc139440\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/actions.js\":\"7bc418527914e700\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/declarationOnly.js\":\"aad2ca5cb45f1322\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/layout.js\":\"a2555ac18d73ad67\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/model.js\":\"88cf97745f25178a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/shapeUi.js\":\"b0e7247268210b71\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/shapes.js\":\"c6e5e0223e0db729\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0cea8e1eddff29ee\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/visibility.js\":\"8523612574748e6b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanelSections.js\":\"99e7a915b0fd6102\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/BlockEmbed.js\":\"12c3e0c64e6b29d8\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/BlockLink.js\":\"552db039fee61ad8\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/BlockRef.js\":\"637dcfe27c0d241a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/CompactReferenceLink.js\":\"6a6faaf7fa8b5844\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/ReferenceLink.js\":\"3f1497bfc0f49af4\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/cycleGuard.js\":\"d45c1c97abd2dee9\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/cycleGuardContext.js\":\"9548f5727c0b4a1b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/linkInteraction.js\":\"a1c0a9c8dc163b3b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/referenceLayout.js\":\"18fe72238bb593be\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/useBlockRefAncestors.js\":\"383df357a98781ee\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockGutter.js\":\"9ca1cf0ebdde8b64\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockInfoDialog.js\":\"3bb7bfc25f3773c1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockReadText.js\":\"5a808879f3c39ccd\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockTypeBlockRenderer.js\":\"ae735ad890cec20d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BulletHoverCard.js\":\"dd6e4caa054bc2d5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/CodeMirrorContentRenderer.js\":\"17d79c638155223f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ada41acf80d7d45b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/ColumnResizeHandles.js\":\"d7fddcd3f271da23\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f085768aa69f7e54\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/DefaultBlockRenderer.js\":\"b6b4ed3dbda9a178\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/LayoutRenderer.js\":\"240740d62c8e234c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/MarkdownContentRenderer.js\":\"7c7988b5bc246653\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/MissingDataRenderer.js\":\"be527dd596d289ec\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/PanelRenderer.js\":\"26d3ff9cf555be54\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2d272f5de9984547\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/TopLevelRenderer.js\":\"fceaebc4d4506cb1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/blockGutterMode.js\":\"345c832daeced84f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/blockTitleText.js\":\"4ef432dadc4f471e\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/fieldCreationKeydown.js\":\"0117056ccc088f93\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/layoutRootContext.js\":\"7f0d490c95906e65\",\"/knowledge-medium/pr-preview/pr-1910/src/components/typeChip/TypeChip.js\":\"b7efcf52af3553fb\",\"/knowledge-medium/pr-preview/pr-1910/src/components/typeChip/chipStyle.js\":\"c5562f81c78b6cd9\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/anchored-floating.js\":\"e56360d78e2c72c5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/button.js\":\"e382e9f3deb10cda\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/card.js\":\"d538addc8c128bde\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/checkbox.js\":\"dc04f1863b49e33a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/collapsible.js\":\"bb82b8f8b9650ef1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/command.js\":\"0670d188d6cd644a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/context-menu.js\":\"0a52fa1539a83075\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/dialog.js\":\"09fb019e0ee84d98\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/dropdown-menu.js\":\"fb41bf9f5505e4d5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/floating-listbox.js\":\"731e5b958308a405\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/index.js\":\"ba9ca919f43c30c1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/input.js\":\"9ee04eb1ff0846e5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/kbd.js\":\"f0924c843157b905\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/label.js\":\"0d1c0a80d93366f5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/textarea.js\":\"2666fcce28a50852\",\"/knowledge-medium/pr-preview/pr-1910/src/components/useEditModeYieldKeepalive.js\":\"9ec58e27679e384d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/BootFallback.js\":\"7d4388127857061c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/FocusedRowLazyMount.js\":\"73d81b93d70abb5b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/LazyViewportMount.js\":\"961dccabfcfbbea3\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/LocalDbCorruptionFallback.js\":\"7376e56e506215e1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/error.js\":\"991d17677a68f5e6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/lazyMountRegistry.js\":\"04026c80ac6bb907\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/suspense.js\":\"70675595252af8fb\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/CreateWorkspaceDialog.js\":\"287ef4a54f024fad\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/PendingInvitations.js\":\"efb9e528936c41d8\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/SyncProgress.js\":\"8b746dbc5ab9814c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/UnlockProgress.js\":\"019a9b67e4dbf931\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceKeyGate.js\":\"ff9d62a3bca5aa22\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceSettingsDialog.js\":\"43de6fa256232785\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceSwitcher.js\":\"a2ee676ad694ce39\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceSyncGate.js\":\"a22a9ffdfe8650da\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/ConversionFlow.js\":\"b599b677da1641f6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/ConversionFlowHost.js\":\"ef765b89ebd570d7\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/EncryptionSection.js\":\"526fac61c7629a89\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/attachmentPrompts.js\":\"1c80914371517757\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f7acc4fc09d2016b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/conversionFlowDeps.js\":\"564c220223331100\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/conversionFlowStore.js\":\"888cdea5ac2e1955\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/flowUi.js\":\"7010c24454b33dad\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/useConversionRun.js\":\"2e88ff6069671dd1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/keyUi.js\":\"ed21ad527abd8d17\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/useCloseOnKeyLoss.js\":\"ddaae70c409e293f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/useCloseOnServerE2ee.js\":\"9a96bf1251f3bd0e\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/workspaceUnlocked.js\":\"e366b03508253fe9\",\"/knowledge-medium/pr-preview/pr-1910/src/context/backgroundSubtree.js\":\"aa377da76f8b89bc\",\"/knowledge-medium/pr-preview/pr-1910/src/context/block.js\":\"2429bc3806bee19d\",\"/knowledge-medium/pr-preview/pr-1910/src/context/layoutWsContext.js\":\"460764af1d5e201a\",\"/knowledge-medium/pr-preview/pr-1910/src/context/propertyDisplay.js\":\"b04a4a76ae251e54\",\"/knowledge-medium/pr-preview/pr-1910/src/context/repo.js\":\"c1f35f56de8c7713\",\"/knowledge-medium/pr-preview/pr-1910/src/data/aliasClaim.js\":\"2b5b6fd9b663de0d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/aliasSeatNamespace.js\":\"b3107c9112a43f7f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/blockData.js\":\"84bfb91efa442c86\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/blockType.js\":\"54623b8e83e5779e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/changeScope.js\":\"7ded61e0727312fa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/codecs.js\":\"f6ee5908b6afbdad\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/derivedData.js\":\"8305a7efd0dc90a1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/errors.js\":\"f07e35615e2259b2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/events.js\":\"c9d6eb4ab68698f2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/handle.js\":\"65aee314d0500cc8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/index.js\":\"f067cee547122246\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/mutator.js\":\"2e38ed1b408e3234\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/processor.js\":\"19309d652887dcdd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/propertySchema.js\":\"31596cb1aba8af3c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/query.js\":\"4fdc4a44c8c8e88e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/sameTxProcessor.js\":\"35e84641b1b74120\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/schema.js\":\"65aee314d0500cc8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/tx.js\":\"65aee314d0500cc8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/typedBlockQuery.js\":\"5cb8f8e9ea6e8d46\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/user.js\":\"79326f76602535da\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/valuePresetCore.js\":\"7ebd3eeedf7ef735\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/valuePresets.js\":\"a50d11777da71907\",\"/knowledge-medium/pr-preview/pr-1910/src/data/attachmentCleanerIOVerb.js\":\"689f3730f06c8ace\",\"/knowledge-medium/pr-preview/pr-1910/src/data/block.js\":\"7bd994910bac0b58\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockCache.js\":\"39ef22746ed024ce\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockId.js\":\"2e74619f69f37bf9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockLiveness.js\":\"db7fd453b7944ca8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockMerge.js\":\"9f9c397d3970a2c4\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockSchema.js\":\"5044e8cf9e468365\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockTypeLookup.js\":\"8f6508dd9d4cf026\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockTypes.js\":\"c5c79c48871050a3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/childrenView.js\":\"e351e81d94138ef8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/clientContext.js\":\"e01b190148de62a0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/dbFileSiblings.js\":\"adf790b7cd740a04\",\"/knowledge-medium/pr-preview/pr-1910/src/data/definitionSeeds.js\":\"f967fc4d4a3dcc12\",\"/knowledge-medium/pr-preview/pr-1910/src/data/derivedIds.js\":\"74bf4270b6b38fe2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/drawnSubtree.js\":\"07663733cb83e1fc\",\"/knowledge-medium/pr-preview/pr-1910/src/data/facetBridge.js\":\"63ffc9cf942788ff\",\"/knowledge-medium/pr-preview/pr-1910/src/data/facets.js\":\"b3d151c75a70548f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/globalState.js\":\"e21510c97373a4ce\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/aliasClaimRederiveProcessor.js\":\"f37fca30c8a6b365\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/ancestorBatch.js\":\"2dfdc66c10e2142a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/blockTypeTypeifyProcessor.js\":\"00e0a28a28c61121\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/clientSchema.js\":\"6588a8ef81249648\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/commitPipeline.js\":\"b728e618df48cad7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/devAssertions.js\":\"4c8a87a081694c21\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/firstSync.js\":\"ebfab56a87bcbfc7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/freshInitialLoad.js\":\"070214b66b641ae8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/graphBackfillClaim.js\":\"1c5ce527e0cbdd45\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/handleStore.js\":\"3c43aa4a4c0459cb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/idleMarkerJobs.js\":\"0f27dbe12f5f0b67\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/initialDownload.js\":\"36a95b9df4180068\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/initializeClientDatabase.js\":\"a0865a4a36141903\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/jsonCanonical.js\":\"b7331477c812faac\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/kernelInvalidation.js\":\"2985f541f78a6bed\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/kernelProcessors.js\":\"7ef3822e1d77d546\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/kernelQueries.js\":\"8a88d424d0d3a63d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/mergeTypeMembershipProcessor.js\":\"1e10d07ce357381c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/normalizeReferencesProcessor.js\":\"3aed554a201a4e87\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/poolInstrumentation.js\":\"c5a0644774684c3e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/processorRunner.js\":\"8bf8bebd08f20796\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyCellBackfill.js\":\"f8092e13d8bdc9f9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyChildMint.js\":\"bd88192ee2f51d14\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyChildrenProcessor.js\":\"128f3f9741ecba5b\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyDefinitionChangeProcessor.js\":\"998a1963727f04e3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyDefinitionSynthesis.js\":\"d3c9790a97286a21\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyKeyScan.js\":\"e39a832c8a9939d3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertySchemaResolution.js\":\"4cccf7d174139dcc\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyValueEdits.js\":\"f250e522ee67a710\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/raiseProtocol.js\":\"6dd8b74a24d96cf6\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/readBatch.js\":\"5c6b924ce756ba56\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/refProjection.js\":\"dbb586bbfc49a7c2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/referenceTargetLookups.js\":\"b7f698fc0b60f3b4\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/referenceTargetProcessor.js\":\"367226f6c44f47a7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/replayMerge.js\":\"60cfd453ba9a492a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/sqlBinds.js\":\"94ccacd20db958f1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"7d3df977285124cc\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/arrivalProcessors.js\":\"af0e1d503798be9f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/invalidate.js\":\"9b85ee65aedcbd1e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/materialize.js\":\"bb722a15bf0575d1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/observer.js\":\"e2cdc4f5e02bc674\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/reconcile.js\":\"eece9e48f5b6b725\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/timingMetrics.js\":\"6826fd8dfbed83f0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/treeQueries.js\":\"4a8727cfca0356f7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/txEngine.js\":\"fe71b303f345540f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/txSnapshots.js\":\"b0e1a954ca581292\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/typedBlockQuery.js\":\"5e6753822017b10f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/undoManager.js\":\"5580a0e1774a1521\",\"/knowledge-medium/pr-preview/pr-1910/src/data/invalidation.js\":\"723dd75064d79c15\",\"/knowledge-medium/pr-preview/pr-1910/src/data/kernelDataExtension.js\":\"3c6d9c053abb6aba\",\"/knowledge-medium/pr-preview/pr-1910/src/data/kernelPage.js\":\"cbc0087c18ae3fb1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/kernelValuePresetCores.js\":\"46602a798dd6facc\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localDbCorruptionSignal.js\":\"2740d8c74267d2ac\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localDbStorage.js\":\"60a04ad790725138\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localDbVfs.js\":\"0a5f69d309adc0f9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localSchema.js\":\"56b50d9674c4e2df\",\"/knowledge-medium/pr-preview/pr-1910/src/data/maintenance.js\":\"7ccd42ee9c72f8fa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/mergeProperties.js\":\"020551c1fbc21abb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/metricsConsoleHook.js\":\"7b46fac13919d144\",\"/knowledge-medium/pr-preview/pr-1910/src/data/migrationsPage.js\":\"e68e8561ac299406\",\"/knowledge-medium/pr-preview/pr-1910/src/data/mutators.js\":\"2225aa48b5c3b045\",\"/knowledge-medium/pr-preview/pr-1910/src/data/orderKey.js\":\"974e8add205d109b\",\"/knowledge-medium/pr-preview/pr-1910/src/data/orderKeyPlacement.js\":\"9f29eebf6ab11648\",\"/knowledge-medium/pr-preview/pr-1910/src/data/outlineSurface.js\":\"bb7d67368b267271\",\"/knowledge-medium/pr-preview/pr-1910/src/data/pendingEditorContent.js\":\"345abdd7bfbc4c96\",\"/knowledge-medium/pr-preview/pr-1910/src/data/pendingUploadsSql.js\":\"ec55c8332888c2e4\",\"/knowledge-medium/pr-preview/pr-1910/src/data/pluginStateExtensions.js\":\"b9d6c76fe0556b78\",\"/knowledge-medium/pr-preview/pr-1910/src/data/powerSyncLogger.js\":\"40f0a1d8d2233450\",\"/knowledge-medium/pr-preview/pr-1910/src/data/projectorRuntime.js\":\"5aec93e9f3a0e73d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/properties.js\":\"7f6bfc32914889c8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertiesPage.js\":\"c799a5b41b383989\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyChildren.js\":\"512a89c5e35630ef\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDefinitionFanout.js\":\"9dda2f2dc24fa88c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDefinitionMetadata.js\":\"7ef5d1e5b44c0820\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDefinitionRegistry.js\":\"91b8432048e238ae\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDisplayMode.js\":\"a79b7062776aeebd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyRowCreation.js\":\"d68f3b60248bc54e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertySchemaCreation.js\":\"068b76136dfe6210\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertySeeds.js\":\"9027afef4d458679\",\"/knowledge-medium/pr-preview/pr-1910/src/data/recentsPage.js\":\"e843c281e73e0437\",\"/knowledge-medium/pr-preview/pr-1910/src/data/refTargetComparableProperty.js\":\"b272e9176f21bb75\",\"/knowledge-medium/pr-preview/pr-1910/src/data/referenceBlock.js\":\"bd6c534822e45bd2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/rejectedUploads.js\":\"397c67fb356a71af\",\"/knowledge-medium/pr-preview/pr-1910/src/data/releasePowerSyncConnection.js\":\"5d7f8e0f6bf1c91a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/repo.js\":\"7fd7cab0cc0a7783\",\"/knowledge-medium/pr-preview/pr-1910/src/data/repoProvider.js\":\"3163e1d30725e062\",\"/knowledge-medium/pr-preview/pr-1910/src/data/rowProperty.js\":\"4c13ed2a77ad21d1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/searchFilter.js\":\"128dd7ac63066eac\",\"/knowledge-medium/pr-preview/pr-1910/src/data/seedIdentityLedger.js\":\"00c68535c7ba769f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/stateBlocks.js\":\"6805574b0264d1c5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/structuralEditPolicy.js\":\"b431b3a7871d73b9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/structuralInsert.js\":\"cc88c9fca9fc275e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/subtreeDelete.js\":\"acbd9ae452dfa6bd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/syncStreamLock.js\":\"53e27faead90b8f2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/syncedTableSqlRecognizer.js\":\"60b30c89861626d5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/syncedTableWriteGuard.js\":\"6c51e863d0befb30\",\"/knowledge-medium/pr-preview/pr-1910/src/data/targets.js\":\"6bfd91d94ce64382\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeColors.js\":\"06b1558b685a7b82\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeDefinitionMetadata.js\":\"9c9f902272a8d001\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeDefinitionRegistry.js\":\"44a4a0ffad182978\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeExtraction.js\":\"462893be2908ccda\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeInitialValues.js\":\"55de1381a91187df\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typePropertyGroups.js\":\"a30e8553ec6fd565\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeSeeds.js\":\"181d9c82416df25d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeTagger.js\":\"c55913d6b3e33240\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typedRecords.js\":\"d0e555f9dc3a5e03\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typesPage.js\":\"ae12c82531d783f4\",\"/knowledge-medium/pr-preview/pr-1910/src/data/userPrefs.js\":\"850ab4b6865a7cab\",\"/knowledge-medium/pr-preview/pr-1910/src/data/userSchemasService.js\":\"1cf631d15e1119be\",\"/knowledge-medium/pr-preview/pr-1910/src/data/userTypesService.js\":\"68c69a81c6b242e7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/valuePresetRegistry.js\":\"5abc4583193199de\",\"/knowledge-medium/pr-preview/pr-1910/src/data/visibleChildren.js\":\"d43fe987ec09d883\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceConversion.js\":\"be3c7fc4971451da\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceFirstSync.js\":\"2f0f8e7f8af9a825\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceIdNamespace.js\":\"8dba0eeb92545193\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceSchema.js\":\"a66946eb29140bd1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaces.js\":\"e381ea928c65a9bb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/writeAheadLog.js\":\"c8f10c498a0d5407\",\"/knowledge-medium/pr-preview/pr-1910/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/BlockPasteShellDecorator.js\":\"647fff8f3f89d843\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/atTrigger.js\":\"054f6ab589caf06b\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/autocomplete.js\":\"7883a36e285a82c9\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/codeMirrorExtensions.js\":\"543c37e00cd23387\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/contentFlush.js\":\"a5a264b139b51e84\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/defaultInteractions.js\":\"3b5db4b8d9e06a59\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/editSettleSignal.js\":\"1a577f422433c07e\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/insertImage.js\":\"7688e8a33c58fdde\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/referenceCompletionRange.js\":\"e2949a092cb5a212\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/referenceTargetTypes.js\":\"0bd8d94028e5873d\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/syntaxContext.js\":\"aaabdd07c93bbdb7\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/triggerMatch.js\":\"0f022e82a5eb1b61\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/AppRuntimeProvider.js\":\"d167aeede0e49c40\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/BlockFocusShellDecorator.js\":\"c5192407fdfa71db\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/ExtensionRenderBoundary.js\":\"7bc7635caf482188\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/PanelContentRecovery.js\":\"251e2afa04c868c9\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/apiCatalog.js\":\"3b547925ba325764\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/approveExtensionHere.js\":\"eaed8fd6a83c09ef\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/armedCutAppMount.js\":\"ff3649a92a189b71\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/batchableKeyedStore.js\":\"46b0498b2324dbca\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/blockInteraction.js\":\"06d0ac1dafe6c516\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/blockSelectionAction.js\":\"f256728ec19b12aa\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/compileExtensionModule.js\":\"19ef5c746dc01ba0\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/compiledModuleCache.js\":\"ed967f41a71fb877\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/continuousGestures.js\":\"1cb12a2fa9b96756\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/core.js\":\"7281b45b7172d328\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/defaultRenderers.js\":\"19b45f05bd31ea5a\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/definitionFanoutAppMount.js\":\"766fc40efb9fc9dc\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/dialogAppMount.js\":\"8848ef02a2c90ba9\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/dynamicExtensionSeeds.js\":\"d522621357baa79f\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/dynamicExtensions.js\":\"96375dfa86493155\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/exampleExtensions.js\":\"f7f20cecac62b9ce\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionApprovalStatus.js\":\"439d0bd30013f9ed\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionLoadErrorToast.js\":\"84788ae93258d797\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionLoadErrors.js\":\"f8a2cc5761f57709\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionLookup.js\":\"48692f7a32d082e4\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionToggles.js\":\"d9e4338c64b92c33\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionUtilitiesCss.js\":\"8f6e695ee2f0a53e\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/kernelPageDeletionGuard.js\":\"ebc46ad6f48359ad\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/liveRuntime.js\":\"a76c3039f30dcfc3\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/openExtensionsSettings.js\":\"574ade2bfa6348df\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/overridesCache.js\":\"97af1c00e63fa6f3\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/pluginIds.js\":\"aef2f8a603071e53\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/processorRejectionToast.js\":\"aa7a2ba0c5561bbc\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/runtimeActions.js\":\"88a6540c9da1b37b\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/runtimeContext.js\":\"4ea6d4aae066d41d\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/staticAppExtensions.js\":\"59ad264698df28d3\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/staticDataExtensions.js\":\"c0425d749e773f95\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/toastAppMount.js\":\"6baae87836749876\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/useOverrides.js\":\"62c07c956a95f08a\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/useShortcutSurfaceActivations.js\":\"ec9878cf23f224ca\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/discoverToggleTree.js\":\"f844030ef2c4d5a9\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/facet.js\":\"21144d832f518976\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/resolveAppRuntime.js\":\"5b729513cc98d1ba\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/runtimeEvents.js\":\"8c02ed3c1bb93a5b\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/togglable.js\":\"3e3efad6a7fcb2a7\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/variantFacet.js\":\"7b313e5e7e9b4c0b\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/verbFacet.js\":\"f22ab10a292054b7\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/block.js\":\"6b615f24aa4ea5ce\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/focusedChild.js\":\"c8f30f5c815be924\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/propertySchemas.js\":\"99674061f7ec36cc\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/typeRegistry.js\":\"d674e58a9a2e5b66\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useAncestorCrumbs.js\":\"8305ae70fe65ea93\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useAutocompleteListbox.js\":\"f8419158f39a8f13\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useDebouncedSearch.js\":\"4a1cc0a6102cc086\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useDebouncedValue.js\":\"ba821eb61840b28c\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useFacetValue.js\":\"3be5001919c6b7cc\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useIsFocalRender.js\":\"ece9408d98cbe3e0\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useIsReadOnly.js\":\"d61150991675ed91\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useMaterializeBacklog.js\":\"cd3de9c2d73d93ab\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useMinuteClock.js\":\"c1c69dbbf2754123\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/usePanelLayoutProjection.js\":\"c310ab5f88ac8c91\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/usePendingInvitations.js\":\"017b147972031940\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useRendererRegistry.js\":\"7b00fd6680e3729b\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useRetainedFieldRows.js\":\"40f1ffdff5ebd184\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useWorkspaces.js\":\"5ac7b2cd9ddcb746\",\"/knowledge-medium/pr-preview/pr-1910/src/lib/utils.js\":\"3a33cd2feea1cdd7\",\"/knowledge-medium/pr-preview/pr-1910/src/main.js\":\"5fb78f8becc95c3c\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/MarkdownImage.js\":\"d4db447cd91e1256\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/blockSeparators.js\":\"52f58b53418833e1\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/context.js\":\"c827b35fca9dc340\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/defaultMarkdownExtension.js\":\"52f9fb4a65d40dd8\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/extensions.js\":\"5635166676273590\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/renderMarkdownHtml.js\":\"b508a898a2c99be2\",\"/knowledge-medium/pr-preview/pr-1910/src/minimal-editor.js\":\"074c3b8837839e78\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/armedCut.js\":\"7855073d341bf2af\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/captureMediaVerb.js\":\"d3158e48ba8f4079\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/clipboard.js\":\"b4f5a0ed0973fa73\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/decision.js\":\"1110dd142c71ae9c\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/operations.js\":\"1387c8734bc1a167\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/account-header/AccountHeaderItem.js\":\"db4a7e1e266261bb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/account-header/index.js\":\"92f097c4f0a6b521\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9ea46318c68484c6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/askAgent.js\":\"0e936bfb10930f47\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/askedStore.js\":\"fa4a54fd7ebd3303\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6f6be6837415f26a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/chipState.js\":\"26154ef1707de309\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/dataExtension.js\":\"19b957ce4e6131b2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/index.js\":\"f01dfc8effda0d1c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"831d88cb3dcdce16\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/schema.js\":\"85fd4b6ade624f24\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e3888f3548ea2ec1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/BridgePairingDialog.js\":\"8457fd18a8547851\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/addMedia.js\":\"07779e185df1645e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/backlinks.js\":\"925e3b009e03efe0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/block.js\":\"c6fab97dfd668a8d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/context.js\":\"f02e934754da5438\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/displayIds.js\":\"cc9a410af3836361\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/index.js\":\"7eda01fc7c3dac3c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/outline.js\":\"8772396988b5cfd3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/properties.js\":\"24bbd68229ff5ddf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/refs.js\":\"d3c791a487513622\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"df9e33189a5a32a3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/search.js\":\"9fd7cb41b08cf82f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/shared.js\":\"c8e26d6389616a1a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"5abd9b2a28fa3339\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/text.js\":\"12c2ff1a5b7b54f1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentWrites.js\":\"058291fda19613ca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/authoringCatalog.js\":\"f00bb446fedc86ef\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/blockRefTargets.js\":\"860af68b8dc84d10\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/bridge.js\":\"bdd97bef32e4a74e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/bridgeLoop.js\":\"06b49959097934db\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/changeHistory.js\":\"d3f94a7aed70ccd2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/commands.js\":\"cf77231fa4072d6e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/commentsCommands.js\":\"d26e8da29d660c43\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/dataExtension.js\":\"677b5b74046f6f3a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/dataModelGuide.js\":\"4d660b7bf1ecdb0b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/dayPropertyInputs.js\":\"f7583a06a59df362\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/describeRuntime.js\":\"455108d0f525debc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/extensionLint.js\":\"1a47de64725ae44b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/grainAudit.js\":\"5b4186b8880e5d57\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/healthCommand.js\":\"fcecb3dcba3438be\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/index.js\":\"286400681d4d4dc7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/presetIdentity.js\":\"dec481e59daf47ab\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"6dfb4f012e35a62b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/readMedia.js\":\"ec228fd9ad0e5c30\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/schema.js\":\"c1f9e4678dd273ea\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/serialization.js\":\"7be77b7a19b89768\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/targets.js\":\"017f4c7b1026505a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/tokens.js\":\"f2380e03e33c6fca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/watchEvents.js\":\"f5c9f6b2940ee718\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/workspaceGuard.js\":\"94ebbab28eb168aa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/writeCommands.js\":\"a42ea186cc564c08\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/AliasCollisionToast.js\":\"272e4ab0debbe0db\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/DuplicateNameBanner.js\":\"b187db03b1bea4e4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/collisionMerge.js\":\"157cf8294d60ae92\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/dataExtension.js\":\"b83eec3a81493b17\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/index.js\":\"a5a6954e62f4a93d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/mergeCollisionAction.js\":\"967392aeec99bd67\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/pageStyling.js\":\"2b39cb996a8667d8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/rejectionToast.js\":\"b109f37436f67894\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/syncProcessor.js\":\"434bdd3d2d66a455\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/actions.js\":\"26b5c53ec221308f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/addComment.js\":\"ed1a5ace5af6bfe4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/anchor.js\":\"16c4110aa1db835c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/anchorState.js\":\"3b79c99a3863680d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/commentLinks.js\":\"a92a7e9a2230ff1e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/confirmThreadDeletion.js\":\"ca6b88a76cffeddb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/container.js\":\"9a4ce03b9682dffe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/dataExtension.js\":\"685ca14ec2684e0d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/deleteComment.js\":\"476afa0e1a093875\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/highlights.js\":\"8ce5161b234d1945\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/index.js\":\"3f3fe76a37d4ed92\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/linkedCommentsPill.js\":\"4ed80381d0087fa4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/margin.js\":\"6eaf1c926a42cbda\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/marginAnchorLinks.js\":\"c42fda4d5b2c410f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/marginSchema.js\":\"d4bf1e654c366d6c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/newComment.js\":\"6cf23cdc166ced2f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/ownThreadPicker.js\":\"5782c6188acac4bc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/placement.js\":\"ccdbf57edc762353\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/queries.js\":\"913a998b124c79b0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/quotePosition.js\":\"e75ac93116fa805c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/quotedIn.js\":\"1a8922b6f5530b93\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/quotedRange.js\":\"c0065a5eca7acb48\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/rangeRefs.js\":\"7a7d1816969bbf0b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/readHighlights.js\":\"365b663bba94d54b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/readSelection.js\":\"3a2d71fc7d16b794\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/readSelectionUi.js\":\"33ce3fb169de4b4a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/reanchor.js\":\"82e583eab31f6302\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/schema.js\":\"36f2c15b8779dbc7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/scope.js\":\"40673c54eeeb9a84\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/scopeThreads.js\":\"51589d301f7b930e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/splitRetarget.js\":\"523ed6f2daf01b95\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/suggestionCard.js\":\"088e2dbc55adc144\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/suggestions.js\":\"9438e55af4653cee\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/summaries.js\":\"31e6052f1af522e2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/summaryBatch.js\":\"b5746633ca9d92f3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/surface.js\":\"14d6ef2f1152cdaa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/threadNavigation.js\":\"e5e4e47b8baf484e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/threads.js\":\"e0654acf115ff75e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/ui.js\":\"8d5cedb593f9b176\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/uiStore.js\":\"e008ddb2754fec5e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-intents/appIntents.js\":\"6cd76949878d5c75\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-intents/index.js\":\"3fe03c189a89a908\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-update-prompt/index.js\":\"1491d587dda1a649\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-update-prompt/status.js\":\"a745f2fa3d641e98\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5bd78da7ba292c9e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/MediaBlockRenderer.js\":\"b02b8c8eaff0d6e7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0df82a58895942ce\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/MediaUploadReconciler.js\":\"381c8858ffaf69b4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/assetDownLane.js\":\"49f3eb9351be22a8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/assetResolver.js\":\"cfdb2f71c7192e0c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/assetUpload.js\":\"1375c2d99bb31e02\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/attachmentCleanerIO.js\":\"1ce29e665d7b903e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/supabaseAuditIO.js\":\"572c8a4f98b78245\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/blobStore.js\":\"d783696af62bf845\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/browserMedia.js\":\"2a26141eac7a072e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/byteStore.js\":\"55ddf05e102c6f90\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/cleanerIO.js\":\"426df90aed4f29d4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/cleanupAttachments.js\":\"29e3286507457930\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/dataExtension.js\":\"e9e75169f34f6447\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/downLane.js\":\"49ee3584dc4553ef\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/index.js\":\"cf792a651af2a01f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/insertImageContribution.js\":\"b242c7ab4b958930\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/laneArming.js\":\"9d1a098fd84fb843\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/laneLock.js\":\"d1075625a6591f00\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaBlock.js\":\"21ae86a3473b1ed1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaCapture.js\":\"2a5f9c7338793f5c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaLanes.js\":\"0dcab7d54e963633\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaViewers.js\":\"b123ad1febe41228\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaViewersFacet.js\":\"405c2fbf14386493\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/pasteCapture.js\":\"8121f36fc30587ce\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/resolver.js\":\"6fc2a0b37dfb1012\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/retryUploadsAction.js\":\"5e00032568438ead\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/storagePaths.js\":\"431ae2dad28e8827\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadDrain.js\":\"09d5a2b284f30b5b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadLaneStatus.js\":\"9f04a221d7b89e41\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadReconcile.js\":\"b25322846fecd862\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadRecovery.js\":\"a7a91e0e86ec4784\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadStore.js\":\"cccbd76a80729260\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/useAssetObjectUrl.js\":\"d2b7d21fc0b99687\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"535a60a141d1916b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b50b884c2e86cc8b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/facet.js\":\"abac5775693d2224\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/index.js\":\"7c3f9d59840c72b7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/prop.js\":\"bfd56fb9b0566be9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/BacklinkFilters.js\":\"ca51bdb7bca5793e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"8f8c5154f3f5c371\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/BlockEntry.js\":\"ed029a3bc282e8db\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/LinkedReferences.js\":\"cd005467b54865e1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3ea3c1104ecfb136\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/dailyNoteDefaults.js\":\"d5e90cedf7874ff8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/dataExtension.js\":\"37203087c2797558\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/edgeExclusions.js\":\"b7945e9043a11974\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/filterProperty.js\":\"c4d9acf64fe6fce8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/index.js\":\"02a4b69fd09604a3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e6d1c91ed2b6863c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/applies.js\":\"6e3e5bdcc47f2eaf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/countQuery.js\":\"839b13ea23dfb0ca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1eb2693ba8aa2b98\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/index.js\":\"641c798b70847cd6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"15576b30d76a9ed8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/presentationInvalidation.js\":\"4f6487f2ac92bf82\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/propertyEditorOverride.js\":\"1aadd1e3af142f71\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/propertyFilter.js\":\"d628913a33270983\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/query.js\":\"07b0aa970856fb03\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/resolveFilter.js\":\"ab34bc309cba5de1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/sourceBatch.js\":\"1c8dc93994f51412\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/sources.js\":\"2c18f87d9cdb4518\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/useBacklinks.js\":\"863ff8e427893619\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"57b8e8528b310d73\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/BirthdayCelebration.js\":\"2b4b26fe3b7db52f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/BirthdayOverlay.js\":\"de720a86bedd3020\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/gate.js\":\"efb7e3e27e528f0d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/index.js\":\"01a146089de700fd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/wolfTheme.js\":\"4b5c9c60d65b8df0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/BlockDragLayer.js\":\"90ddb0e670f99798\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/dragController.js\":\"e71978bb765cd325\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/dropTarget.js\":\"95bb3b4922024832\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/index.js\":\"f43697052ab618d1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/projection.js\":\"fd390b32adf61ab0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-info/BlockMetaCard.js\":\"12d01df0ff2d5f48\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-info/index.js\":\"5306800170ee1b38\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/AddTagDialog.js\":\"0d2fb3f264749f3d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"50ba06be2dcc7bbe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/TagNameIssueHint.js\":\"98af99e1b624a8c9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/addTagAction.js\":\"48001632dfb59bfa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/appendTag.js\":\"20024221dfbad291\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/config.js\":\"d3f58e18f8907757\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/dataExtension.js\":\"001f7e42fcd68ce7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/index.js\":\"cfbf464bdd951330\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/propertyEditorOverride.js\":\"ce80c4c50005b977\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6b46e666fca19ff2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ebc6f67c56b55772\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/Breadcrumbs.js\":\"6d0b38679b17f2e3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8b3f5481adc3a549\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c16f7ed87bb5e94f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/index.js\":\"b0ecb1f6ba378b80\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"504c1a2add39ae7b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/CharacterCountItem.js\":\"00916bd8394a77cc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/ProfilePropertyEditor.js\":\"82496800b4431e42\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/actions.js\":\"27624e38a91b6ae1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/blockType.js\":\"966d6184a4cbc647\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/charCount.js\":\"3a22471c8c310503\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/dataExtension.js\":\"9f862cdec03471c2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/index.js\":\"ed5b5821a5029a6a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/profiles.js\":\"b78854fde566fe19\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/properties.js\":\"91710716ed5b0e70\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/subtree.js\":\"ae442e5a059aa852\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/textCounts.js\":\"4e0a0616c25f0e15\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/colemak-keybindings/index.js\":\"53a2ac4d9ed71970\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/CommandPalette.js\":\"1f4e4aa65c8b9359\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/HeaderItem.js\":\"e9174fb43c274c1f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/context.js\":\"5ffe5ceb28c6df52\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/index.js\":\"fec86b5a135eddd2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/selection.js\":\"d518efb45b6d91fe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/toggleStore.js\":\"17622c3743bee400\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/useCommandPaletteActions.js\":\"c5554832b53bc534\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/ContributorBadges.js\":\"942b989871dc5c60\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/ProfilePicture.js\":\"593f165da133ccee\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/author.js\":\"434a66760817e535\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/codeMirrorExtensions.js\":\"62a11076f61ebc76\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/dataExtension.js\":\"4eea5bdd3a4b3ecf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/index.js\":\"9df97c023c51b255\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/mentionAutocomplete.js\":\"4c1c13f76b503f86\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/processor.js\":\"df9bc672f3300edd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/profiles.js\":\"1c8971afc4d627b0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/queries.js\":\"a2c6d5b3cbf692c4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/schema.js\":\"8c2751138a36a454\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/useCommentAuthor.js\":\"68ae7f84d465170c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7aa1146be191719a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/followOrigin.js\":\"421e0e41db736ba1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/index.js\":\"8752766dd5418ed9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a56fa0b7bb6758ff\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f35dbd9b3b76ca28\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/CalendarGrid.js\":\"c34a1fa8afe0cbc7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DailyNotePicker.js\":\"a28fea4e60438e7c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9e087734aebbd766\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DateNavDecorator.js\":\"0bff19070c3ad903\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DateScrubOverlay.js\":\"8707edd3d7c60818\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DayPropertyControl.js\":\"d111cf909a5f3ff8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DayValueReferenceControl.js\":\"178c909c0769f17b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/HeaderItem.js\":\"78c4efbb886be812\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/ReschedulePicker.js\":\"f2eee03bbcbe9faa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d0bfdb61da0ea13f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/actions.js\":\"f50f99c2ae1a1bb5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/blockDateAdapter.js\":\"e45a646f30b767f7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/calendar.js\":\"a8150fbe1124adfd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dailyNotes.js\":\"6c272b8a63f9da61\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dataExtension.js\":\"bb145e72d117e0f5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubActions.js\":\"4c1aad508c0373f6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubGesture.js\":\"6037813987eab7b8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubGestureActions.js\":\"466b6a37e35999dc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1548ae82e6e47e65\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dayProperty.js\":\"decadddb10d27b1c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"58ab64fc8fbcc2e9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/deletionGuard.js\":\"3ad6129a6a01219e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dueQuery.js\":\"a0d05c5c513a10d9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/index.js\":\"7289ebe81cecf854\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/landing.js\":\"dd20679115d25deb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/localSchema.js\":\"f3c9357ba44e3fa1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/referenceDateAdapter.js\":\"652b7c05ab556cc0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/rescheduleAction.js\":\"bc23acf02cbba6b3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/schema.js\":\"215afaeacf43d30b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/spreadBlockDates.js\":\"b5a21b3be8021b99\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/spreadDatesAction.js\":\"4f4691b08db3f391\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/today.js\":\"9a2cae9ff55739cb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"192ec83d00a3b08b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ebe872210776d61d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/audit.js\":\"7f9f3c667716c1d5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/auditAction.js\":\"6fb30c9c48d86b82\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/auditRanges.js\":\"749070a08a7473ca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/diagnosticsSource.js\":\"cf42ca4134d48806\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/divergenceScan.js\":\"ad6399fe2f4312e0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/index.js\":\"769d0e43f080c59d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/propertyChildrenChecks.js\":\"89c270ea2ea7fc05\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/referencesMirror.js\":\"8b4679939fbf6ed8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/rowJson.js\":\"82987205ea63fde7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/schedule.js\":\"916ad56673df54e0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/store.js\":\"14b4f60319ddb8ec\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-maintenance/action.js\":\"8bb653642e9f8524\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-maintenance/index.js\":\"b3184f7a850c49c1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-maintenance/plugin.js\":\"a69d062004ec5492\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"8d2c2be33c334ccd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/actions.js\":\"32883995a401510b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/changeMarker.js\":\"f380fd83f6141a0c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/diagnostics.js\":\"c582d9aca5beda23\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/fileSystemAccess.js\":\"72a736264f7a3f68\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/filenames.js\":\"5948dd5ec173ae04\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/index.js\":\"9b0c9b13f2fd3418\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/mirror.js\":\"ba30faa197d90d1c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/runLock.js\":\"f0cae9955508302d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/runtimeHealth.js\":\"1c2770177246d745\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/schedule.js\":\"727f392a703286e0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/store.js\":\"a58fc51b2adb9be1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/default-themes/index.js\":\"0e7f0977c100d393\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/default-themes/themes.js\":\"747687367168894c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/diagnostics/facet.js\":\"a22e07dca2f262ad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/diagnostics/useDiagnostics.js\":\"ec9c74dc03e0368d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/dismissals.js\":\"b537498c079506be\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/index.js\":\"f31ce81f25b99823\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/status.js\":\"3286c5215c446c9c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/store.js\":\"8cced8006561d0e2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"f85b72eb40957387\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2b03a111b549ec74\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/actions.js\":\"6c05a2c4a92861d6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/config.js\":\"a44328a080ba1f55\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/dataExtension.js\":\"62a4e504a8029c8b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/effect.js\":\"1671a7cba1183348\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/index.js\":\"5c946df7b3b6e99c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/propertyEditorOverride.js\":\"6a244c62935d0abc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/useToggleTree.js\":\"6f8cd78cf8c59f66\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/ExtractTypeDialog.js\":\"c7dc8595fe4b7dc6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"ad68cd90647aa80b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/PropertyShapePicker.js\":\"dbe5d2d517beda00\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/action.js\":\"53f172bc27d9ea3f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/index.js\":\"13b142b11126898c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/FindReplaceDialog.js\":\"9742caf43f911a2d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/HeaderItem.js\":\"c11a8d2063346620\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/dataExtension.js\":\"4bc170916205d1bb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/index.js\":\"e5116e1472add1ad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/search.js\":\"65e12a26ea658b0c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/toggleStore.js\":\"611ba13103d6ab6f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/LocationPropertyEditor.js\":\"d47bb9a3f4fb2986\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/MapView.js\":\"6ad545e8f0d9dc6a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/blockTypes.js\":\"393c83b3f99d6f99\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/codeMirrorExtensions.js\":\"d615528cc5f5a9b7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/createOrFindPlace.js\":\"67e0c262e4d4604c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/currentLocation.js\":\"ef9cd85f94eb84a8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/dataExtension.js\":\"481310694f8897eb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/geoContentDecorator.js\":\"dfed1f8adcd6c2ed\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/googlePlacesClient.js\":\"482c977040a7d801\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/index.js\":\"054bff10a7e16f7d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/locationsPage.js\":\"721832c80ddc8d78\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/mapViewport.js\":\"af781b729e5d08d3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/pickCurrentLocation.js\":\"0ac9d5593616da1b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/placeAutocomplete.js\":\"f04ee5eabb2d7e38\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/placeNameCollision.js\":\"42c343536333cc5e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/properties.js\":\"ea1938599f1684e5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/propertyEditorOverrides.js\":\"11b6ea326347508c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/query.js\":\"cfde7aa2ad14b063\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/usePlaceSearch.js\":\"28660994377b41a9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"aa0be56aa544940e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4da1cc130c32f44b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"68a362b3647b44e2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/config.js\":\"a05d11c10387d708\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/dataExtension.js\":\"60436821b77eb30b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/facet.js\":\"07d418329cfaabe3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/grouping.js\":\"f0d70f32e7c2d349\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/index.js\":\"aaf97feae4ae6f08\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e76327847638e5c5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/query.js\":\"d0a23cf38ff1d991\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/resolveConfig.js\":\"97d722d46c07d43f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"53a0ce09f59300ad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"eec16aad382d2c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/HtmlDocumentContent.js\":\"8b59a0ca69cfeded\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/HtmlFrame.js\":\"3b6578d1bc403817\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/actions.js\":\"e99d865d52a56869\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/blockType.js\":\"ee79b5ce77499ea6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/confirmRunScripts.js\":\"c244ad591511f83c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/dataExtension.js\":\"09abe0e68baaf309\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/frameAnnotations.js\":\"6b688afa6512832c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/frameDocument.js\":\"f2b4c7273668fb4a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/frameTheme.js\":\"7901576eef4e1dce\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/index.js\":\"5ebc4551273bc246\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/scriptConsent.js\":\"c73b8c0c6e9f780e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/sourceMap.js\":\"f15941d671c5881d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/useDocumentScripts.js\":\"6d1e1eb5c6afca46\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/index.js\":\"62547d79a3d634b4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/record.js\":\"ad0528683c26f493\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/recordStore.js\":\"9d629b2360a560fa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/responsiveness.js\":\"23dcd7e1cd84ffb5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/schedule.js\":\"194bfdf9e1dd8301\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/sessionContext.js\":\"e583ffec871110a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ab3d24cc257128e5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8a4c85e03c98ae07\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/actions.js\":\"332c70da25160cae\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/config.js\":\"74eafa807bafb13e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/dataExtension.js\":\"ab7c44cddce01738\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/effect.js\":\"346cdf0578785649\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/index.js\":\"e2018472da23cfdc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/keyCapture.js\":\"028dd103558e3400\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/overrideStore.js\":\"4292372b618bd7c8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5f151bfbaf629c71\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/HeaderItem.js\":\"db1e41493fc1755f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/LeftSidebar.js\":\"55c64a3696b33a4c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/actions.js\":\"66e3ea0ece2cf057\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/facet.js\":\"142a1edce54a1f9f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/index.js\":\"dddf5a62813ffba5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/shortcuts.js\":\"d813fb41651ec297\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/toggleStore.js\":\"7664cf0387680539\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/MergePicker.js\":\"59728925580ef8b1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/index.js\":\"a200fc8578fda464\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/mergeAction.js\":\"95a40c41ca14126c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/strategy.js\":\"b850abb9ddc06ad3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/Button.js\":\"1c067eeab42da47f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"9482c9e62541e510\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/defaultItems.js\":\"aee3f075fc6a060c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/facet.js\":\"c584d35702d8e372\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/index.js\":\"7758a2d6dc80af9e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"986216dcda9966a1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f8271bd58261514a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"c7dadc34c7835f3b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ffcee0c148e895ce\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/index.js\":\"f7a44dd187fdacf7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5e019c63ae041394\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/blockSubtreeMembership.js\":\"8e1aa80fe5989e52\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/contextMenuItem.js\":\"e2a1e21cb8389737\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/index.js\":\"650adb3103b9f26c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/moveAction.js\":\"6bbf128099c59daa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/moveBlocks.js\":\"f3dd95c12fedf77a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/selectionAfterMove.js\":\"4fcfd83f705514bd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/TutorialBanner.js\":\"9bb8a42ad2182fca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/action.js\":\"dd839f3e74fef64f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/bannerDismissal.js\":\"a0cda0942e2069a3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/documents/cheatSheet.js\":\"f058712e458ede57\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/index.js\":\"70bc3ea76386f076\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/keys.js\":\"ea1fa9d3f8c1b323\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/landing.js\":\"d6d0b7d95c8109f1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/outline.js\":\"97a00b85778c3dff\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/seed.js\":\"561fff3ccd0cc544\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/PerfTrendDialog.js\":\"242687506014bb82\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/analyze.js\":\"f095b5618f707e89\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/diagnosticsSource.js\":\"97aacef901bc8cfb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/index.js\":\"b6b21284f9eaf8ed\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/load.js\":\"fe1dd67508beb7dd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/monitorRun.js\":\"e65df8a7a1929b04\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/schedule.js\":\"cafd299ff26584b4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/series.js\":\"aad3227ba875e680\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/store.js\":\"a0d0b1e8b0d43884\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/trendAction.js\":\"37b4e9b4137c71d1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/verdict.js\":\"e4e39ff3e661b7e1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/plain-outliner/clickToEditAction.js\":\"8509e3cbcfe322c6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/plain-outliner/index.js\":\"96d5b04dfee1aac7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/plain-outliner/interactions.js\":\"02ba2861ebc4dd86\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ae94c7191341ccaa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/MigrationGate.js\":\"d474712c0b6ba1d8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/MigrationGateDialog.js\":\"16e5013c41414709\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/action.js\":\"b295bb223e0cca1d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/index.js\":\"6319df541b5888ff\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/localRunMessage.js\":\"27c5aae147244761\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/plugin.js\":\"fcfa926e81c2d9bf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/progressReport.js\":\"a1e0eb16b91749de\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/sweepProgress.js\":\"7d5f81861c32124f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/FieldRowRenderer.js\":\"f6a7a1840903a922\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/ValueRowRenderer.js\":\"f36e7e3bdd2abf3f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/actions.js\":\"9fbfc4e46f3323d6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/autocomplete.js\":\"d5d4f60d5675f582\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/fieldRow.js\":\"d3ab2c87134e71c6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/index.js\":\"ea16db3ea7f1648a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/referenceWarning.js\":\"b65d30e759283316\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/valueAutocomplete.js\":\"ee9e916c86302a63\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/valueSchema.js\":\"0b2cf04c701ffe3d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/HeaderItem.js\":\"1e3f12002c20ecbd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/QuickFind.js\":\"1136334dfbe6e398\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/index.js\":\"60044db0cf2be046\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/recents.js\":\"4caede727123424f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/resultItems.js\":\"f61804cfe0443b6e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/selection.js\":\"cd8fb632f4b4ebad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/toggleStore.js\":\"fdfa13aa59e8f89c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/HeaderItem.js\":\"b4d6a3cc335111ea\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0ddf94c148727a2d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/grouping.js\":\"8971216bc18bacbd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/index.js\":\"5842e30fa1f7bd5e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/target.js\":\"51f9c9e624a4878c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/codeMirrorExtensions.js\":\"2cc147b93d814b92\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/contentPrefill.js\":\"50cc5a3498e90da2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/dataExtension.js\":\"fc16d508c6aa6d8f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/index.js\":\"6a1cd67719638d4f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"db600edd5a8b8c9e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/invalidation.js\":\"7e188aae25cb7c1f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/localSchema.js\":\"94b2998c7523f2fc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/blockrefs/index.js\":\"18b44808004b8cb9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"9ac2b08fefe43273\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/index.js\":\"ef4f4bb2e2a34ffb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/referenceNode.js\":\"6da017c01811f7dc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0d505281eaa5a429\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"754be273b1b3b1de\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/index.js\":\"7172a2285b99a0c2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"83fb76753793067d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"005b3c1021c120ea\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/mergeRetargetProcessor.js\":\"5a8aae41f1e68b0b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/parseFence.js\":\"995414f0a75678db\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/referenceParser.js\":\"786168766e22b1a5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/referenceProjection.js\":\"1dcb003a4ad4e18a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/referencesProcessor.js\":\"c0e2c406e59d371e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/renameProcessor.js\":\"2c77eb92e74afa88\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/spanReplacement.js\":\"fd176d3a12649b54\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/htmlToOutline.js\":\"bfef140dfab2633d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/index.js\":\"398283d1f881ae21\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/normalizeClipboardDom.js\":\"ebb5156abc88c5a3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/pasteDecision.js\":\"32fac9066791c188\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/action.js\":\"fb8ca6f5d71ca686\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/blockIds.js\":\"cd4ee25e9825c54b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/content.js\":\"19101b794cbcfc9b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/effect.js\":\"e6ec5580c3c6debb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/ids.js\":\"b9c0f01473545e1c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/import.js\":\"37228ce43ba1e671\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/index.js\":\"3ebef637b9a68276\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/plan.js\":\"42dcd20087129278\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/plugin.js\":\"4020e2f836aa2fe8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/promotion.js\":\"53d11cce362db5eb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/properties.js\":\"e77a902bd94b9c71\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/references.js\":\"e5bceca79f609b7d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/report.js\":\"293338a4bfc7bde4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/roamMemo.js\":\"61249d209408d5fb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/runtime.js\":\"8f897a2326723f91\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/schemaReconciliation.js\":\"e734111bfc05e79c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/srsMarkers.js\":\"89744075898e660a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/todo.js\":\"bcfcfec3fd58aafc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/typeCandidates.js\":\"8cd6d3aaac6314bc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/types.js\":\"d5c08930a407a73c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/search-health/index.js\":\"4ec0e16dc509fe01\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/search-health/store.js\":\"dcf3fe63664b7c94\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/HeaderItem.js\":\"997096d278607cd7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"4f0f80dae5d9a9e1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/index.js\":\"977b4530b75eb9e7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/model.js\":\"9552afd65059e505\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/toggleStore.js\":\"dde98291f131c995\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/useKeyInspector.js\":\"edd7ec4cddd68cb8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8cd32395310d6e92\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/ShellDecorator.js\":\"b20c08cfa20c6685\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/actions.js\":\"32e627ccca04e6c2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/exclusionsFacet.js\":\"62cfeb08a8cc3864\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/index.js\":\"d763aa44bf628e2b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/shell.js\":\"0b2d202cd9f082a7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/surface.js\":\"a4b4e8472faac654\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/walker.js\":\"fbfddeeea289341c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ca5dc0af7b17cbb1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/dataExtension.js\":\"688214022721edfb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/index.js\":\"d8dfbb5609c421d1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/indicator.js\":\"86152da038963c54\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/moveSrsState.js\":\"94bf158cfdf9f203\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6a49a05fed8734df\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/scheduler.js\":\"510babf0bca74053\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/schema.js\":\"69af11f0860b6afe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8e4a0a19028a6ee3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/srsClipboard.js\":\"563f268dd3a4c2b6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"ff6dccc18d5a693c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1064af7303007cbf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/DeckPicker.js\":\"e010e1c42917f004\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/ReviewControls.js\":\"f4922a46622af318\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/ReviewDeckRenderer.js\":\"a06675145295df96\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/ReviewSession.js\":\"18f33e7e4b8ad276\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/actions.js\":\"7cb7591a1b0f015a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/archive.js\":\"b3e1a73e451b177b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/dataExtension.js\":\"517a4e6aa0862eab\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/deck.js\":\"070d1b094f72baf1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/dueQuery.js\":\"cc63032f390d3622\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/gradeDecision.js\":\"2ef4154525580a10\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/index.js\":\"8cec97f6d7551665\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/keyHints.js\":\"8ba3383eaec73253\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/reviewCardLayout.js\":\"b432cf9fd86abab6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/reviewProgress.js\":\"a497c9675381263b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/schema.js\":\"6c1cb3e096219c46\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/useDueCards.js\":\"f0e3a18908a282e5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/startup-metrics/index.js\":\"21def4166c07acc7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/startup-metrics/record.js\":\"8130c1b7f2407923\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/storage-persistence/index.js\":\"5f798170a9f7d3ed\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/storage-persistence/persistenceStatus.js\":\"ae1b7adc178bf559\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/storage-persistence/requestAction.js\":\"f865cf3170726613\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/TypeChipsDecorator.js\":\"506e99528663e788\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/codeMirrorExtensions.js\":\"e102aafafefd7494\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/index.js\":\"c8b03b20fb140df0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/typeAutocomplete.js\":\"6a7d5d02c089dc72\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"0eb04998dc9b0107\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/actions.js\":\"d5fb3d6d67045b46\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/anchor.js\":\"efb6338b88d6d2b1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/events.js\":\"9f8dfaebc0c9a11e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/gestureActions.js\":\"599078638ab97b05\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/index.js\":\"fe4ed95fe1699566\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"aeea3a468db42609\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/sync-metrics/collect.js\":\"ee4698a0e1757a93\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/sync-metrics/index.js\":\"9e03901cb916831c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/sync-metrics/record.js\":\"a3317ce5b85dde87\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/RejectionDialog.js\":\"154f5adb63e1cc95\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/SystemStatusHeaderItem.js\":\"23d4439a8b86c1b6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/index.js\":\"72d4fc8f52534ab7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/model.js\":\"b979647de415e79c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/queueCounts.js\":\"6a008e5cf8354268\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/rejectedHelpers.js\":\"5c05dd04a62d8dc1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/rematerializeAction.js\":\"11a79903fb778ea1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/useHysteresis.js\":\"afb4c8baa67d311a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/ColumnHeaders.js\":\"2f05e6956e9275ff\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/QueryUi.js\":\"88cd1e44bf018c3f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/TableLayout.js\":\"1dfc43110fecaff6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/actions.js\":\"59047b40fc89b4e3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/cellEdits.js\":\"a9623205511f7af0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/childrenViews.js\":\"32f6e2329de64bf2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/columns.js\":\"88acfdfe5753c474\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/controller.js\":\"696fb3ad765833ea\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/convert.js\":\"ed5fb5b0f2df2705\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/dataExtension.js\":\"91e1971ca1374645\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/index.js\":\"c1abd083ceb2a738\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/keys.js\":\"244c1ac647544af2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/model.js\":\"b005d23b95c8e83a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/QueryText.js\":\"73e20d7ef863affb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/backfill.js\":\"00f18c8990f56137\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/completion.js\":\"2e5bd70d0a3fd8dd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/format.js\":\"68243c5968eebbdb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/parse.js\":\"42111bd62ef4d697\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/queryValue.js\":\"9868d004b2ef9bf1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/registrations.js\":\"5cf5b4f573d5ca25\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/source.js\":\"88a71db20802bc6a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/registry.js\":\"f2b51ee2529064a4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/rowGutter.js\":\"89396c80c7b4be1b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/rowVerbs.js\":\"d570dd5a46d73b76\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/schema.js\":\"c8b1878b1dc68e14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/sort.js\":\"7aa745982db59547\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/theme-toggle/effect.js\":\"1779eba41b48d6b6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/theme-toggle/index.js\":\"ed6ca3cd1c28691b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/theme-toggle/theme.js\":\"d3255a07d361ad4e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/actions.js\":\"38258a57871c378e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/dataExtension.js\":\"84d4a39246712d29\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/index.js\":\"fa76b7e5b5b0b71b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/schema.js\":\"d189844d0212aa64\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5c893a50db1d11c5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/actions.js\":\"d5b46c094c5f7e36\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/defaultItems.js\":\"a5968b916db0bb49\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/facet.js\":\"2b887746fd308a7e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/holdRecognizer.js\":\"d30f8facc53088f1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/index.js\":\"95ad23e4fe6c7aa9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/update-indicator/UpdateIndicator.js\":\"836b35f763e09036\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/update-indicator/index.js\":\"bb2e2de9eee633a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/update-indicator/loadTimes.js\":\"a6551b63b59fded7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/VideoNotesRenderer.js\":\"bd78e8142db52515\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/VideoPlayerRenderer.js\":\"e28b3f3b02d37635\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/VideoTimeStamp.js\":\"2a2e38f47802925a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/actions.js\":\"b4cd53536a3230b9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/index.js\":\"023074ef54250006\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/markdown.js\":\"cb0bc2765d3b901f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/notes.js\":\"aa96891226e1ff3f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/registry.js\":\"3cc310a215e64f84\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/remark-timestamps.js\":\"4c534e8afe8ed509\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/view.js\":\"c5eed327b7a589ba\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/LinkHints.js\":\"ebfce4ad3411be52\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/index.js\":\"387bd215ba9cecae\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/model.js\":\"8abcedce19ea404d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/settings.js\":\"471148479ab44382\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-normal-mode/actions.js\":\"fb9b7fbf0ad6a298\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-normal-mode/index.js\":\"f672f982c146c41c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-normal-mode/interactions.js\":\"7e927e7e4106481c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/workspace-header/index.js\":\"4e2ab751ceffb4ec\",\"/knowledge-medium/pr-preview/pr-1910/src/registerServiceWorker.js\":\"5fa2d2987c341142\",\"/knowledge-medium/pr-preview/pr-1910/src/requestPersistentStorage.js\":\"b1163b85ece3e0dc\",\"/knowledge-medium/pr-preview/pr-1910/src/services/authRequestDeadline.js\":\"368cd4edcefb7115\",\"/knowledge-medium/pr-preview/pr-1910/src/services/authStorage.js\":\"c27eb3a7f69b98dd\",\"/knowledge-medium/pr-preview/pr-1910/src/services/powersync.js\":\"4077220d37846e6a\",\"/knowledge-medium/pr-preview/pr-1910/src/services/supabase.js\":\"e7c52114176d984d\",\"/knowledge-medium/pr-preview/pr-1910/src/services/uploadErrorClassifier.js\":\"08665ca82778ccaf\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/ActiveContexts.js\":\"03704288a429689a\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/HotkeyReconciler.js\":\"ecd518621bb1e753\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/WipeLocalDataDialog.js\":\"15ee800b6401c0a6\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/actionDispatch.js\":\"069166945e0742ae\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/actionRefItems.js\":\"4c06b452f5dca5a4\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/applyKeybindingOverrides.js\":\"0794bca56cdd51d4\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/blockActions.js\":\"a5d69e302989d128\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/blockMergeGesture.js\":\"a829626602d0c439\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/canonicalizeChord.js\":\"d2fcafadefc0891d\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/defaultContexts.js\":\"9a31a63993ea6da1\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/defaultShortcuts.js\":\"d25cc448440f2863\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/effectiveActions.js\":\"f23fce0db40d6a44\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/gestureAction.js\":\"82db4fd8c77f37c3\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/gestureBinding.js\":\"65253a218c505559\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/holdRegistry.js\":\"77bdc5c16160b0f7\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/keybindingConflicts.js\":\"4bc4eb1ac27baaf9\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/keybindingOverrides.js\":\"031aca3c71cbff02\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/pointerAction.js\":\"879816ec23dd2460\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/resolve.js\":\"2a23b92b7ebe5c5c\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/runAction.js\":\"87af58ccd6d04f63\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/sequenceMatcher.js\":\"f39520e530c253bb\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/types.js\":\"0083bcf41761cdad\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/useActionContext.js\":\"0f2d9c9fefa6da45\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/useActionDiscovery.js\":\"0a3185470dc50c5e\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/utils.js\":\"5a97902ca78fefce\",\"/knowledge-medium/pr-preview/pr-1910/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1910/src/sw/bootStore.js\":\"5b9bf1bad8d499fc\",\"/knowledge-medium/pr-preview/pr-1910/src/sw/previewDatabases.js\":\"e2e4f8a1c54fa4fa\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/byteTransform.js\":\"5bd2ad830b1ad37e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/attachmentCleaner.js\":\"71bf6b6613831a83\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/attachmentParts.js\":\"47ffd255aa387b9a\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/bundleParts.js\":\"e2ea05b88f7df5fa\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/bundleRecord.js\":\"e93f7dc738e8303e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/manifest.js\":\"39227ecbc005b89d\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/takeBundle.js\":\"10dfa8170dc57c28\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/verifyBundle.js\":\"1a1b0ce2a3be1dd7\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/cleaningStage.js\":\"a87f9dab217de8fa\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/conversionKey.js\":\"ff7a6d94b624e5b7\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/conversionServer.js\":\"5333afd1f3769d70\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/flip.js\":\"1e082d60afe39f48\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/flipAttempts.js\":\"e4cc44129ed80780\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/pages.js\":\"13929b5ad4178b1b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/preflight.js\":\"1124a24a870a348b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/reseal.js\":\"3f3e8d59a0ce7ce2\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/runConversion.js\":\"7221cf52ccd66d41\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/runLock.js\":\"1fcd0db2332073de\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/sealing.js\":\"e89d92f0d5ac90da\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/sealingStage.js\":\"0724f5f9e5a6aa0c\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/stage.js\":\"7d02fb8d1bfa021b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/verifyReseal.js\":\"3739dfb2e282278e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/aad.js\":\"ac31991fb7236ce4\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/aead.js\":\"c6bf42be982e9b37\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/base32.js\":\"ec945a56346a944b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/base64url.js\":\"be35df233043ad2e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/binaryEnvelope.js\":\"eede8d38b21adb85\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/byteAead.js\":\"996a9d2c6e72399f\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/canary.js\":\"1761fb45a4b3dac3\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/contentHash.js\":\"0b88b6f60cd3ef18\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/contentKey.js\":\"083a537263458774\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/derivedIdNamespace.js\":\"1de03f15b42a0b2a\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/envelope.js\":\"c983ee3e658e336a\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/hex.js\":\"a6a8387b799a571b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/sha256Hex.js\":\"291a6b77e8c2518c\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/workspaceKey.js\":\"0258ccca7dda54f5\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/conversionState.js\":\"bed27fece21c3d62\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0be5fd3e70bdb9a4\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/pastedKey.js\":\"f7041eef532a4355\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e8a41c31d3ad1e44\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/upgradeWorkspacePin.js\":\"410a26c296689575\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/keyStore.js\":\"3e77a6add4f0a698\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/mintWorkspaceKey.js\":\"8bd958e1d6f80a9b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/modePin.js\":\"0d801012f500610c\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/openWorkspaceKeys.js\":\"973b50358ac473bf\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/resolveWorkspaceEntry.js\":\"0e208c798fa2993e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/resolver.js\":\"a17905e5e8d57a28\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/workspaceAccess.js\":\"59dc8afa0b0d2a88\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/transform.js\":\"5b506eb51b8d7a10\",\"/knowledge-medium/pr-preview/pr-1910/src/themeBootDefaults.js\":\"9384a53a1df425dd\",\"/knowledge-medium/pr-preview/pr-1910/src/types.js\":\"eb2ab3c0d33d6ce2\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/ClientLocalSettings.js\":\"7c61df109d0b5480\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/abortableSleep.js\":\"da393610e98c63c2\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/array.js\":\"6dfcc6034aab7101\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/backlinkAutocomplete.js\":\"4adc49d9881d12d4\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/blockCrumbs.js\":\"0dfc01e3ff2e60e6\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/blockrefAutocomplete.js\":\"8a4e2a2bdadf1c8e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/cadencedIdleJob.js\":\"b556d4e9c34d1776\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/callbackSet.js\":\"65a27ef2f13c45cc\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/clientId.js\":\"94ddd0fc653263e5\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/codemirror.js\":\"a0a60fe389e00124\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/codemirrorCompletion.js\":\"f9e8ec06aa44f9d3\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/copy.js\":\"edf0891400c822ef\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dailyPage.js\":\"74fd466811851f90\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dbForensics.js\":\"a6794298b2d94a5b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dbForensicsHooks.js\":\"9b1419f3dfa3c97c\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/deleteBlockThroughUi.js\":\"0ec504ceb049f25b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dialogs.js\":\"57accddf03669491\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dom.js\":\"fa0e58684cd78ee6\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/downloadBlob.js\":\"b251d9b7a6f8bc3e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/drawnWalk.js\":\"0551f791b4fffae5\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/exportSqliteDb.js\":\"d09e89d3bc88ff64\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/fileSystemAccess.js\":\"adaf3d221d2ab4a0\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/flipSlide.js\":\"49331a11458ef114\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/fnv1a.js\":\"5d21f46994adbf9b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/formatBytes.js\":\"c841a11dd9f3defd\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/fuzzyRank.js\":\"eade4b01202c77d2\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/idbKeyedStore.js\":\"2968066b225bdde4\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/idleCallbackPolyfill.js\":\"99dc2c19aaf78842\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/keyboardAwareScroll.js\":\"bcd962502cc1d227\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/keyboardViewport.js\":\"d0e303d4b7326779\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/lastWorkspace.js\":\"a54c99c038780b96\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/layoutColumns.js\":\"4dbf6bb871e7205b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/layoutSessionDom.js\":\"f7a13737f2aff9dd\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/layoutSessionId.js\":\"7eeae356c5784a3e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/linkClickGestures.js\":\"412ef33f362b8ce0\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/linkTargetAutocomplete.js\":\"73e8e168ed079a08\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/localDbCorruption.js\":\"5816c78af6e98997\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/localDbRecovery.js\":\"5248c3bc5cb72c7e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/markdownParser.js\":\"d26cd0d8d5609116\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/memoize.js\":\"f04ce5170db0553f\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/nameFieldCommit.js\":\"961afdeaddfcf9da\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/nameList.js\":\"4a631b8a0902f726\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/navigation.js\":\"90c706c0c92580fe\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/omnilinerNamespace.js\":\"2b8bb3582b8428ae\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/opfsPageScan.js\":\"ec3e834ae8d91a6a\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelClearance.js\":\"8882c96f9e01eda5\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelHistory.js\":\"b9148197433c09be\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelLanes.js\":\"680aedc0e9d95acc\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelLayoutProjection.js\":\"17157b9035fb4066\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelScrollAnchor.js\":\"e8d9f99ab8dfe708\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelUrlFlags.js\":\"1b0a2ea223e4f7c5\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/platform.js\":\"d8f9a4b55fa97d3b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/pluralize.js\":\"1844e9f6e92dfe89\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/propertyCreation.js\":\"3c0e345aa2ae257c\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/propertyNavigation.js\":\"1e29b5cbdbb341a8\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/propertyValueContext.js\":\"2c7363f7586c8c65\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/react.js\":\"f3470d902e02df5d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/relativeDate.js\":\"bf6ef9fc03574096\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/relativeTime.js\":\"f8457d0210e8f8f1\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/renderScope.js\":\"74c5985ba17fd5e7\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/resolvedThenable.js\":\"48f883df43977768\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/routing.js\":\"506ad780b5cc51bb\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/safeMode.js\":\"c0cb3456c1add2de\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/scheduleIdle.js\":\"06dfd84decaeb1b4\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/screenWakeLock.js\":\"8180a1bf273fa421\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/selection.js\":\"08d8cd4a2dbd957b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/softKeyboardGrab.js\":\"3f2357ca4172368c\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/startupTimeline.js\":\"508f773d17371fe8\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/state.js\":\"526e8d77bfae130d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/string.js\":\"85ebae2241ba68d3\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/surfaceZoom.js\":\"0944233bc2ae581d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/time.js\":\"7490aefae0e550a8\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/toast.js\":\"0bc8cc1441b72b5b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/toggleStore.js\":\"73af5db99060403c\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/untilStopped.js\":\"1001c4b47dc7b93f\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/userActivity.js\":\"64ca8500d96d38ca\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/viewTransition.js\":\"566a79953ea6a573\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/viewport.js\":\"0dafb819efdc7466\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/webLock.js\":\"8902736345a8686b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/workspaceRecovery.js\":\"99453cb91865ad53\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/workspaceSnapshotStore.js\":\"8614b558815c312b\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-compiler-runtime.js\":\"305171d4afaec354\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-client.js\":\"0b5e1398dd255bef\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-server-edge.js\":\"c70eb4d2a0f39206\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-server.js\":\"b1b04aa1f3b2a3df\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-static-edge.js\":\"c6e528ea8763f2f8\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-static.js\":\"2caa21156cebcac6\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-test-utils.js\":\"ed24194bb9f45122\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom.js\":\"4cc28a734ad785e6\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-jsx-runtime.js\":\"a63959a3ce554064\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react.js\":\"243ebce704b483c1\",\"/knowledge-medium/pr-preview/pr-1910/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1910/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1910/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
