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
		buildId: "5ed6517073d7-3ab2cf36",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1910/\":\"039b994740aac28f\",\"/knowledge-medium/pr-preview/pr-1910/index.html\":\"039b994740aac28f\",\"/knowledge-medium/pr-preview/pr-1910/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1910/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1910/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1910/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1910/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1910/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1910/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1910/assets/FacadeVFS-DUXV8TgA.js\":\"8312075cc7508dbb\",\"/knowledge-medium/pr-preview/pr-1910/assets/OPFSCoopSyncVFS-CABfK6vr.js\":\"354bb2979229ddd0\",\"/knowledge-medium/pr-preview/pr-1910/assets/OPFSWriteAheadVFS-zrNTSjQd.js\":\"df2eadc5a17a2c04\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-CdZWCFtn.js\":\"6f7a124c2d546f30\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-async-DkT7umTd.js\":\"4fc68f0ce9e08dac\",\"/knowledge-medium/pr-preview/pr-1910/assets/worker-DaQCP1fF.js\":\"92988096267295dd\",\"/knowledge-medium/pr-preview/pr-1910/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1910/chunks/app-Ct5BOFD1.js\":\"2286d4e7572fd7af\",\"/knowledge-medium/pr-preview/pr-1910/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1910/index.js\":\"f10e1b5cdcc452af\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1910/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1910/assets/AccessHandlePoolVFS-FcA_XUwM.js\":\"0fc6c15b3e29d077\",\"/knowledge-medium/pr-preview/pr-1910/assets/IDBBatchAtomicVFS-Co7y4hq4.js\":\"3caca156e1149f8d\",\"/knowledge-medium/pr-preview/pr-1910/assets/MemoryVFS-DGMvGgAq.js\":\"785cc0f376fce43c\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-DC8dbU0t.js\":\"dc89b27963316515\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-async-CJSGxizO.js\":\"6c79739a503c5607\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1910/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1910/chunks/AccessHandlePoolVFS-C590r_BR.js\":\"34949968f2873605\",\"/knowledge-medium/pr-preview/pr-1910/chunks/FacadeVFS-DfIthkhM.js\":\"e69869a7dbd03e6d\",\"/knowledge-medium/pr-preview/pr-1910/chunks/IDBBatchAtomicVFS-CvP3s5H6.js\":\"4bc1637cac18ca57\",\"/knowledge-medium/pr-preview/pr-1910/chunks/MemoryVFS-DOTwO3dp.js\":\"3f6fa19e7ae3dbce\",\"/knowledge-medium/pr-preview/pr-1910/chunks/OPFSCoopSyncVFS-8T9Jix-a.js\":\"bbf1d5fe004155ef\",\"/knowledge-medium/pr-preview/pr-1910/chunks/OPFSWriteAheadVFS-KbAmmf6b.js\":\"338c399ea6e7a0fc\",\"/knowledge-medium/pr-preview/pr-1910/chunks/Preview-Zt886ADh.js\":\"1671a717354aa2fa\",\"/knowledge-medium/pr-preview/pr-1910/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1910/chunks/card-BUiNP60N.js\":\"321d0d99d4eb810e\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dist-Br97bWun.js\":\"d6acfcc4dda33f4b\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1910/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1910/chunks/mc-wa-sqlite-Bh-HPV2Q.js\":\"39b8097294abe8e5\",\"/knowledge-medium/pr-preview/pr-1910/chunks/mc-wa-sqlite-async-OgENU2Um.js\":\"1e973b04fd0381b8\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-6CgQfWUs.js\":\"143693a2ee124f31\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-B4UHLLLh.js\":\"1ad5fda8a080fa65\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-B7kCwpxT.js\":\"141bb36f837a6882\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-BQXUioyz.js\":\"c9a27802bdd39cad\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-CymzIX-t.js\":\"bb3d91b8ebc6e0ea\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-CzIwNwYU.js\":\"6219071b5a61ea48\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-DxxPZs4v.js\":\"aec5665d33cbc21a\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-dom-server-legacy.browser.production-BIGIdDxC.js\":\"3cdd67fe780827a8\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-dom-server.browser.production-BRJyVt3B.js\":\"fe8e716beb13f510\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-dom-server.edge.production-BALDp6Rd.js\":\"4a78231393a204ba\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-l1OuQKUX.js\":\"3d60d1eaef85ca3d\",\"/knowledge-medium/pr-preview/pr-1910/chunks/server.browser-DJ3EIbOU.js\":\"a977bdc1f17a3236\",\"/knowledge-medium/pr-preview/pr-1910/chunks/textarea-GgsRyC3d.js\":\"68e5c57079440226\",\"/knowledge-medium/pr-preview/pr-1910/chunks/ui-zWZBJQXR.js\":\"cbca78e441b9f776\",\"/knowledge-medium/pr-preview/pr-1910/chunks/wa-sqlite-UaKQ-EbM.js\":\"65fa332e9ec5843b\",\"/knowledge-medium/pr-preview/pr-1910/chunks/wa-sqlite-async-MqdssqRV.js\":\"0b7d94ae2c15104e\",\"/knowledge-medium/pr-preview/pr-1910/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1910/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1910/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1910/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1910/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1910/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1910/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1910/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1910/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1910/src/App.js\":\"7b98c3492765f797\",\"/knowledge-medium/pr-preview/pr-1910/src/appUpdate.js\":\"d7bb4a0e65151ed8\",\"/knowledge-medium/pr-preview/pr-1910/src/appVersion.js\":\"1edff889cbe2ca7f\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/initialLayout.js\":\"9088d9e4214e51fa\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/openWorkspaceData.js\":\"c21f1ad210e0f517\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/resolveWorkspace.js\":\"e00c56bf84708e89\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/workspaceBootstrap.js\":\"d907e96371625386\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockComponent.js\":\"f36d6f3721473c6a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockCrumbs.js\":\"3d3c84acd9a65aec\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockEditor.js\":\"0cc9d00f5e3ac311\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockLoadingPlaceholder.js\":\"f9b6da30e8c3091a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockProperties.js\":\"53b4b5a319829eb0\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockSearchPicker.js\":\"0c7322a0073bea01\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ConfirmBulkDeleteDialog.js\":\"e71ff647acdc6072\",\"/knowledge-medium/pr-preview/pr-1910/src/components/DividerHandle.js\":\"7e3939f10177091b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/DraftEditor.js\":\"beda200e58ac5542\",\"/knowledge-medium/pr-preview/pr-1910/src/components/GutterPill.js\":\"e4f45867f3045b2d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/Header.js\":\"338769ee624f596b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/LazyBlockComponent.js\":\"a584821943f480ff\",\"/knowledge-medium/pr-preview/pr-1910/src/components/Login.js\":\"660278412a4c64c4\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ZoomableSurface.js\":\"0df98f2ca699e204\",\"/knowledge-medium/pr-preview/pr-1910/src/components/editModeKeepalive.js\":\"e3ebea582acc0c3f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6f6908205ab5d06d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b7416c8258b6adb6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/RefPropertyEditor.js\":\"c264b32cc67ffcad\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/RefTargetTypePicker.js\":\"850e76d5cea181ae\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/SelectPropertyEditor.js\":\"78831e544e719e11\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/TypesPropertyEditor.js\":\"3c2fbc3000abd2a3\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/defaults.js\":\"af3c55f962105647\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/kernelValuePresets.js\":\"d0d53c00c63b08e3\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/selectablePresets.js\":\"af3b954d1d5a2c6c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/typesPropertyUi.js\":\"ca146c28acb51453\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/AddPropertyForm.js\":\"e038626401bd6245\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/PropertyPicker.js\":\"764d7dbfe88a197d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/PropertyRow.js\":\"11cb171753a80ae8\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/Rows.js\":\"b6946afbc6949023\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/actions.js\":\"6461e5e36ad94dcd\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/declarationOnly.js\":\"75117de03765d2c7\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/layout.js\":\"b97248e5f7682c3a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/model.js\":\"848a5ac345f4c7a6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/shapeUi.js\":\"a3ef5921a43c1894\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/shapes.js\":\"46fe256f9002a40a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/usePropertyEditingActivation.js\":\"650fb2900ad2e39c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/visibility.js\":\"69531430bcce40a7\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanelSections.js\":\"a06e11f2aa4a4739\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/BlockEmbed.js\":\"e4249bfd523b366a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/BlockLink.js\":\"9104706034baa0a5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/BlockRef.js\":\"c368230d06f4b04a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/CompactReferenceLink.js\":\"4aaa387085e48d04\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/ReferenceLink.js\":\"5fc4d90f0c4dc2da\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/cycleGuard.js\":\"5a8ee102e4369d59\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/cycleGuardContext.js\":\"2c76a44c62da87c1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/linkInteraction.js\":\"920375a39977f99b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/referenceLayout.js\":\"243994f214f5d579\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/useBlockRefAncestors.js\":\"b91e67070c566a39\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockGutter.js\":\"99d15ea6f44d5833\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockInfoDialog.js\":\"8082c6d3db235c6f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockReadText.js\":\"d0390d8a700bcefb\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockTypeBlockRenderer.js\":\"ff8027d40bb5c8e0\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BulletHoverCard.js\":\"a62e33e175dd3400\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/CodeMirrorContentRenderer.js\":\"e2f994b2a25b035b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"893ec7a239207e85\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/ColumnResizeHandles.js\":\"7b93e16c18bfb280\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"270acd3df6708c82\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/DefaultBlockRenderer.js\":\"57b8930f546857d0\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/LayoutRenderer.js\":\"efd38f43efdc0aed\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/MarkdownContentRenderer.js\":\"108000882d1cc637\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/MissingDataRenderer.js\":\"3f2643b9a993f4ef\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/PanelRenderer.js\":\"694d523c9ce22a73\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b5a8317fdcacdc56\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/TopLevelRenderer.js\":\"82c13b70078d5327\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/blockGutterMode.js\":\"76d9bc3370ffed77\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/blockTitleText.js\":\"d79e78d46e67d1e0\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/fieldCreationKeydown.js\":\"99a26d41a9b3303d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/layoutRootContext.js\":\"905af2295d3dbfaf\",\"/knowledge-medium/pr-preview/pr-1910/src/components/typeChip/TypeChip.js\":\"29572e7cbb49f9e6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/typeChip/chipStyle.js\":\"b18a0f24075af882\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/anchored-floating.js\":\"d92625d26a98a12d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/button.js\":\"355360c8470447b5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/card.js\":\"f3d97385595c1396\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/checkbox.js\":\"c3c60d0c29b9257a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/collapsible.js\":\"29994f40da89e12f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/command.js\":\"d03acd4d98a27523\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/context-menu.js\":\"c243ef40a7d5c0ba\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/dialog.js\":\"1a00659467403789\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/dropdown-menu.js\":\"b50e45d8b1fa5226\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/floating-listbox.js\":\"386e4d30c907855a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/index.js\":\"192704d9f204408c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/input.js\":\"deaaf5431c679aaa\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/kbd.js\":\"f0aa167d594958dc\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/label.js\":\"30267823e69e3105\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/textarea.js\":\"784cbcbbfbefd9e2\",\"/knowledge-medium/pr-preview/pr-1910/src/components/useEditModeYieldKeepalive.js\":\"1c5ce7b4c2cd7e90\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/BootFallback.js\":\"357b6b587628d882\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/FocusedRowLazyMount.js\":\"8765e7244103a8af\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/LazyViewportMount.js\":\"0cf4f7abdbf6ff37\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/LocalDbCorruptionFallback.js\":\"922ab26c46082dac\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/error.js\":\"59b99dfcf0d8b8d2\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/lazyMountRegistry.js\":\"90af66fa6dbb59b1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/suspense.js\":\"1957868930e70ea5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/CreateWorkspaceDialog.js\":\"6c6e4496f3ab20fb\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/PendingInvitations.js\":\"c2b011f912b91560\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/SyncProgress.js\":\"ee2d75159c6921a9\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/UnlockProgress.js\":\"25088558891c7c6b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceKeyGate.js\":\"7f500ee484094ba8\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceSettingsDialog.js\":\"67c8092f8108c853\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceSwitcher.js\":\"7e3fcc266455412c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceSyncGate.js\":\"3b07c1a5434b67a9\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/ConversionFlow.js\":\"fba31df427e932cc\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/ConversionFlowHost.js\":\"55b26a236750c782\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/EncryptionSection.js\":\"4ad620ffc064d01a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/attachmentPrompts.js\":\"d266bb115289911a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ce8c8e0ec0422ab7\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/conversionFlowDeps.js\":\"16f07c7e6f33372e\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/conversionFlowStore.js\":\"dea5b4fdd16eadc8\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/flowUi.js\":\"0819070050722579\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/useConversionRun.js\":\"93a510c160e50015\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/keyUi.js\":\"f236704507a6e6fd\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/useCloseOnKeyLoss.js\":\"b7c887173af203b9\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/useCloseOnServerE2ee.js\":\"dfc322739b30a476\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/workspaceUnlocked.js\":\"fd9fcddba30b9ad4\",\"/knowledge-medium/pr-preview/pr-1910/src/context/backgroundSubtree.js\":\"0cadab0a7e766f41\",\"/knowledge-medium/pr-preview/pr-1910/src/context/block.js\":\"ec8f56e8d4f826ec\",\"/knowledge-medium/pr-preview/pr-1910/src/context/layoutWsContext.js\":\"c28b045ec8fc9036\",\"/knowledge-medium/pr-preview/pr-1910/src/context/propertyDisplay.js\":\"ff000323b94a04e3\",\"/knowledge-medium/pr-preview/pr-1910/src/context/repo.js\":\"c7d54e57f601c94f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/aliasClaim.js\":\"fa768f00e1b5d587\",\"/knowledge-medium/pr-preview/pr-1910/src/data/aliasSeatNamespace.js\":\"d74a0238096451a7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/blockData.js\":\"118864420de5c119\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/blockType.js\":\"f528a07b7c3b9bc2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/changeScope.js\":\"c8c507fee1a517c9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/codecs.js\":\"65d8afcec6f071f5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/derivedData.js\":\"1a19d88ee36d9940\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/errors.js\":\"e988d4cfb1f82df9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/events.js\":\"4ab8eec7e685505e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/handle.js\":\"10213df7e2bc59a6\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/index.js\":\"21c80f9ed31728df\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/mutator.js\":\"0f9b52ba7a0b1bc6\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/processor.js\":\"2d20ee2d5b8f00fc\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/propertySchema.js\":\"9569ae43c5384f52\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/query.js\":\"d5f4cc7de758dc3a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/sameTxProcessor.js\":\"8e785fd1337f4812\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/schema.js\":\"10213df7e2bc59a6\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/tx.js\":\"10213df7e2bc59a6\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/typedBlockQuery.js\":\"5eeca89e4d95af05\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/user.js\":\"9afa2065794c122f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/valuePresetCore.js\":\"6aa144c497c199a5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/valuePresets.js\":\"c6f5db9ad7e94276\",\"/knowledge-medium/pr-preview/pr-1910/src/data/attachmentCleanerIOVerb.js\":\"ae973f03fbc152aa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/block.js\":\"d10307e1cd15bf10\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockCache.js\":\"45372a162b9c07b2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockId.js\":\"382ebb754213d0c2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockLiveness.js\":\"d607c9803fb2af76\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockMerge.js\":\"5082c40015178d7c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockSchema.js\":\"dd296d336f9b4aa9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockTypeLookup.js\":\"49e93e22795209cb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockTypes.js\":\"f2cd0c7b4d62acfe\",\"/knowledge-medium/pr-preview/pr-1910/src/data/childrenView.js\":\"c6d6449919e9906a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/clientContext.js\":\"435cc43f1ccb892b\",\"/knowledge-medium/pr-preview/pr-1910/src/data/dbFileSiblings.js\":\"e3d8ec51a7cf2ea2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/definitionSeeds.js\":\"f945c1a72372f6fe\",\"/knowledge-medium/pr-preview/pr-1910/src/data/derivedIds.js\":\"6c4784a5d5ca1e91\",\"/knowledge-medium/pr-preview/pr-1910/src/data/drawnSubtree.js\":\"8966908769a9ebf3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/facetBridge.js\":\"69d35805276d251d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/facets.js\":\"745679096eab05cb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/globalState.js\":\"869d0f259a402aaa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/aliasClaimRederiveProcessor.js\":\"992fe090a49d5b4d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/ancestorBatch.js\":\"201dc5121e675748\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/blockTypeTypeifyProcessor.js\":\"c55507245de7a38e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/clientSchema.js\":\"3c25f60dd1948433\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/commitPipeline.js\":\"0dfad594fdcfdc43\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/devAssertions.js\":\"0f3fa2f1c3b731d6\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/firstSync.js\":\"5f2e7a3b263e9b6f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/freshInitialLoad.js\":\"4e163ea31c2424ab\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/graphBackfillClaim.js\":\"e3d12c06209a5ccd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/handleStore.js\":\"8573c3d51629dc79\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/idleMarkerJobs.js\":\"28ce6d600a66c89a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/initialDownload.js\":\"a5892942ec53e547\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/initializeClientDatabase.js\":\"f89ca50e4a3f9e6c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/jsonCanonical.js\":\"ec202286c7df13b1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/kernelInvalidation.js\":\"cd7c076be3a3ed6e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/kernelProcessors.js\":\"2277d92a295c7c93\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/kernelQueries.js\":\"8bad1901d5cecfc2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/mergeTypeMembershipProcessor.js\":\"4d4cf65d67c8a9fb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/normalizeReferencesProcessor.js\":\"833893e235af097f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/poolInstrumentation.js\":\"c4de7151d6c06b23\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/processorRunner.js\":\"434a91524a84d5a9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyCellBackfill.js\":\"6bbda5f0388aeb74\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyChildMint.js\":\"4986d29e8fcee4b0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyChildrenProcessor.js\":\"e86b28eead6442e1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c8e16a5b76b0beec\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyDefinitionSynthesis.js\":\"77bde51f41877341\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyKeyScan.js\":\"dab7acdf3da163ca\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertySchemaResolution.js\":\"06758895e7c3204c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyValueEdits.js\":\"52eed5cd51515dff\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/raiseProtocol.js\":\"0524f2c3bfd24336\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/readBatch.js\":\"848dc9344a790cad\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/refProjection.js\":\"58fce0e57af90e78\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/referenceTargetLookups.js\":\"7f4c62a8220cfd4c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/referenceTargetProcessor.js\":\"97d4dae3e284e145\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/replayMerge.js\":\"681eb50724c65336\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/sqlBinds.js\":\"34dc517e89e2dc1c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"56b6717dfce2553e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/arrivalProcessors.js\":\"a8d358701ed3f8dd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/invalidate.js\":\"1b4f01e0fbfdb6f3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/materialize.js\":\"ff643e5afc3d3637\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/observer.js\":\"404e92af8a81969d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/reconcile.js\":\"708d9a0e68d14d2d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/timingMetrics.js\":\"f12678a0db23cc5a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/treeQueries.js\":\"913d7fbf23caa1a6\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/txEngine.js\":\"a5a18b2687887c9e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/txSnapshots.js\":\"58c6cb296c54b348\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/typedBlockQuery.js\":\"eafa71ddaf54251f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/undoManager.js\":\"e1e006c6bca2f562\",\"/knowledge-medium/pr-preview/pr-1910/src/data/invalidation.js\":\"d0c0dab2c0ec504c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/kernelDataExtension.js\":\"af3f4092ac96d6b5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/kernelPage.js\":\"a2545785642bc3c7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/kernelValuePresetCores.js\":\"9c202296206e4543\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localDbCorruptionSignal.js\":\"5ee824ca9fd404b2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localDbStorage.js\":\"8a5a48b022206551\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localDbVfs.js\":\"6b99d7cd4b9f67ef\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localSchema.js\":\"0178c9353c1f407c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/maintenance.js\":\"5f769cc0d11a42f0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/mergeProperties.js\":\"b11fb7304b77f33d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/metricsConsoleHook.js\":\"0c8d12f38834144f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/migrationsPage.js\":\"d4690a737ab2efba\",\"/knowledge-medium/pr-preview/pr-1910/src/data/mutators.js\":\"de8aaab0a13c111f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/orderKey.js\":\"e18911cc416d27e5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/orderKeyPlacement.js\":\"d4385f07c30678a9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/outlineSurface.js\":\"6c63a884f02ca5bc\",\"/knowledge-medium/pr-preview/pr-1910/src/data/pendingEditorContent.js\":\"1a9239dcbb9643fb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/pendingUploadsSql.js\":\"4ba83d4201eabfb5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/pluginStateExtensions.js\":\"abcb475045ca5276\",\"/knowledge-medium/pr-preview/pr-1910/src/data/powerSyncLogger.js\":\"95a27cdd541f5e7d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/projectorRuntime.js\":\"de08f29a8f7da9fd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/properties.js\":\"099f0948724f5180\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertiesPage.js\":\"14b8e85e46c82604\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyChildren.js\":\"8a99e490dbb0f514\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDefinitionFanout.js\":\"080949d0124277fd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDefinitionMetadata.js\":\"1f3d0ecde25f94fb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDefinitionRegistry.js\":\"d912a1662058cbb3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDisplayMode.js\":\"c19fb9d7b318709b\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyRowCreation.js\":\"2061c9cdfd0edcef\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertySchemaCreation.js\":\"02a7048ed82a8730\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertySeeds.js\":\"497167c66137d547\",\"/knowledge-medium/pr-preview/pr-1910/src/data/recentsPage.js\":\"abd86b00b6164db9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/refTargetComparableProperty.js\":\"0097640602bb292b\",\"/knowledge-medium/pr-preview/pr-1910/src/data/referenceBlock.js\":\"f1b3971c3cbfe449\",\"/knowledge-medium/pr-preview/pr-1910/src/data/rejectedUploads.js\":\"132534eaadac7738\",\"/knowledge-medium/pr-preview/pr-1910/src/data/releasePowerSyncConnection.js\":\"8d3e01efe82fbd2d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/repo.js\":\"2ef05c131f48d34e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/repoProvider.js\":\"ed9b02635f5f2f47\",\"/knowledge-medium/pr-preview/pr-1910/src/data/rowProperty.js\":\"5c40577ec5e4e1f3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/searchFilter.js\":\"48777faae5ac0e5d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/seedIdentityLedger.js\":\"377b10fd76079e3d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/stateBlocks.js\":\"bf8d67c591e15729\",\"/knowledge-medium/pr-preview/pr-1910/src/data/structuralEditPolicy.js\":\"2312f7d19865824a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/structuralInsert.js\":\"01ceaa9d5caec086\",\"/knowledge-medium/pr-preview/pr-1910/src/data/subtreeDelete.js\":\"0a92cb10d910151b\",\"/knowledge-medium/pr-preview/pr-1910/src/data/syncStreamLock.js\":\"e697b22cafc3a2e2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/syncedTableSqlRecognizer.js\":\"fc73d80dc73ff7f4\",\"/knowledge-medium/pr-preview/pr-1910/src/data/syncedTableWriteGuard.js\":\"f22466034c81bdaf\",\"/knowledge-medium/pr-preview/pr-1910/src/data/targets.js\":\"3ef8c737b62caf25\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeColors.js\":\"efefc4d87c1a3bb8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeDefinitionMetadata.js\":\"820b4a65c7ca1345\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeDefinitionRegistry.js\":\"4aed09c99af1427f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeExtraction.js\":\"151003fa65bf877b\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeInitialValues.js\":\"e13c0ad33deaa1b5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typePropertyGroups.js\":\"ecc65e0ffaedf82d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeSeeds.js\":\"2561d88d272d8201\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeTagger.js\":\"2966f47e57afa8c2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typedRecords.js\":\"26bd14cbe72e1ddd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typesPage.js\":\"78ae21a18ad4a679\",\"/knowledge-medium/pr-preview/pr-1910/src/data/userPrefs.js\":\"100f48751ae85d1e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/userSchemasService.js\":\"87ee8dc6bc7538d0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/userTypesService.js\":\"36164e5b97c9f32f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/valuePresetRegistry.js\":\"a597fcaab876c536\",\"/knowledge-medium/pr-preview/pr-1910/src/data/visibleChildren.js\":\"a76814387dd7c005\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceConversion.js\":\"16f7f4987199b997\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceFirstSync.js\":\"ce5c816cd4e052bd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceIdNamespace.js\":\"0b76461fbf5f5d65\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceSchema.js\":\"5ade10ded4ff9440\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaces.js\":\"3f601af538079781\",\"/knowledge-medium/pr-preview/pr-1910/src/data/writeAheadLog.js\":\"bacdcaf5abdc7848\",\"/knowledge-medium/pr-preview/pr-1910/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/BlockPasteShellDecorator.js\":\"38bf8c1211e2592f\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/atTrigger.js\":\"305c312f6b7d6d55\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/autocomplete.js\":\"6a32a542a0e9ce71\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/codeMirrorExtensions.js\":\"1c1c246d68993bcd\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/contentFlush.js\":\"bc4869fdc2df50b3\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/defaultInteractions.js\":\"f3f8391bbeec4fb4\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/editSettleSignal.js\":\"e9b40f3d93610452\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/insertImage.js\":\"7d187b8cdc0564a5\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/referenceCompletionRange.js\":\"0cacaeefb27a92d2\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/referenceTargetTypes.js\":\"bef971a8a669b5ff\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/syntaxContext.js\":\"5120177947186402\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/triggerMatch.js\":\"52ce9e20f7f1e358\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/AppRuntimeProvider.js\":\"59c748383657b285\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/BlockFocusShellDecorator.js\":\"8aab76fe208abb49\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/ExtensionRenderBoundary.js\":\"f4e7a98154b4866f\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/PanelContentRecovery.js\":\"382446a6e8d75af1\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/apiCatalog.js\":\"4e3a60d7048c5d92\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/approveExtensionHere.js\":\"3fb9fa1fabfc26cc\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/armedCutAppMount.js\":\"2e3a1eed15d19eda\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/batchableKeyedStore.js\":\"d8852650b32d88a4\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/blockInteraction.js\":\"c1bb86d87f090893\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/blockSelectionAction.js\":\"821b912b74d89e77\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/compileExtensionModule.js\":\"af241fc177f7885c\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/compiledModuleCache.js\":\"ab9b6838690bb431\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/continuousGestures.js\":\"994fefe11e0bb741\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/core.js\":\"a3e58d72c4588345\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/defaultRenderers.js\":\"2bfa1c04aa4474f3\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/definitionFanoutAppMount.js\":\"f84229059b91286d\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/dialogAppMount.js\":\"da5e63a4b9848f1e\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/dynamicExtensionSeeds.js\":\"185fa2f4b475e054\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/dynamicExtensions.js\":\"c57eedd35484a75b\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/exampleExtensions.js\":\"055247a394dc6715\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionApprovalStatus.js\":\"4afbcc6d0ce5b74c\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionLoadErrorToast.js\":\"2388e1b9939de21b\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionLoadErrors.js\":\"3f301d20d2ce1a4e\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionLookup.js\":\"eb08ee2788ea772f\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionToggles.js\":\"e17544198d5236f4\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionUtilitiesCss.js\":\"4f9d1e7a154bb49f\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/kernelPageDeletionGuard.js\":\"59c4749e8671ea4f\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/liveRuntime.js\":\"c0015b1df5a19682\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/openExtensionsSettings.js\":\"956ebbc7d8cb51da\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/overridesCache.js\":\"48b99cea8fe9aa3a\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/pluginIds.js\":\"329464a846b9340b\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/processorRejectionToast.js\":\"59202f72a5b41090\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/runtimeActions.js\":\"ef1e23e3b26fe3d4\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/runtimeContext.js\":\"a856b8dd750abb06\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/staticAppExtensions.js\":\"bed1454ad95186b0\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/staticDataExtensions.js\":\"e903bd173ba666bd\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/toastAppMount.js\":\"2821ff27fe367246\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/useOverrides.js\":\"329013c3ef2980ba\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/useShortcutSurfaceActivations.js\":\"5bc3065c26ac924e\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/discoverToggleTree.js\":\"4a76ccdda754d7f5\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/facet.js\":\"1e53a4cda86423d8\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/resolveAppRuntime.js\":\"6b99514f6abb0467\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/runtimeEvents.js\":\"6dd77f39d7c1bfd4\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/togglable.js\":\"5d374436f794c097\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/variantFacet.js\":\"63aea07deb070957\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/verbFacet.js\":\"264ed5f5a79e3bef\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/block.js\":\"94be8819e993fc70\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/focusedChild.js\":\"68a3f0790ff8f88b\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/propertySchemas.js\":\"55511b54f99d3c05\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/typeRegistry.js\":\"4883a3a16f800f2f\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useAncestorCrumbs.js\":\"09b755b03f35b5bc\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useAutocompleteListbox.js\":\"224f741efcc30681\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useDebouncedSearch.js\":\"a05faf2fc9a0b64c\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useDebouncedValue.js\":\"3208c9e931894ffb\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useFacetValue.js\":\"a8769c0c47486542\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useIsFocalRender.js\":\"a3b2a25f8394b4a8\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useIsReadOnly.js\":\"b0cb801c1023d909\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useMaterializeBacklog.js\":\"cbf11cf42dab7b0b\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useMinuteClock.js\":\"6980914e791dd7a8\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/usePanelLayoutProjection.js\":\"fd4f0e4e7f70322a\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/usePendingInvitations.js\":\"6641d6aa89823626\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useRendererRegistry.js\":\"902a1de2e9aa1da9\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useRetainedFieldRows.js\":\"0c43171322f91f4c\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useWorkspaces.js\":\"8f113e627d91c8b8\",\"/knowledge-medium/pr-preview/pr-1910/src/lib/utils.js\":\"c109e187d7cff09c\",\"/knowledge-medium/pr-preview/pr-1910/src/main.js\":\"4463edc855c9ab18\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/MarkdownImage.js\":\"f0223bbe68f1e908\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/blockSeparators.js\":\"55b731aa741425ca\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/context.js\":\"db79bae3c40ae894\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/defaultMarkdownExtension.js\":\"07be4205d00d28c5\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/extensions.js\":\"5e884e367b7832d7\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/renderMarkdownHtml.js\":\"79bbcb3e5f2edd4f\",\"/knowledge-medium/pr-preview/pr-1910/src/minimal-editor.js\":\"8459ab526f266e71\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/armedCut.js\":\"74b2f7d984ef69c9\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/captureMediaVerb.js\":\"88e14a68a7db13aa\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/clipboard.js\":\"312cae96fc947418\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/decision.js\":\"102b47edf1d79f2d\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/operations.js\":\"ccb57dbb98fbc9d8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/account-header/AccountHeaderItem.js\":\"cdb5fb9a5e4f4bf5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/account-header/index.js\":\"a24105a025b585c6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"482b7edc14e63934\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/askAgent.js\":\"74e6a471189c51ef\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/askedStore.js\":\"f412477dbc322b90\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2e1ce462a43bcc11\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/chipState.js\":\"2d2cb51b6ade6e8a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8b96a06d3b614a85\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/index.js\":\"0fc80ef0c4bcd9b1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"d4358f3918ae0c76\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/schema.js\":\"8ae5999a17124829\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a6e5d1ab9599adfd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/BridgePairingDialog.js\":\"75ef5017e687b713\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/addMedia.js\":\"ab40dd7ffa14fa5a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/backlinks.js\":\"678a8fb243cc5a1d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/block.js\":\"864300be5fba3f5c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/context.js\":\"ac6976993160d077\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e2fa3a55ed126880\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/index.js\":\"9f80c2f1e3cab47c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/outline.js\":\"6f9a1b12b8c6c9b4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/properties.js\":\"0ed36457484406bc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/refs.js\":\"7787b1e7f1d73f9c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"dbda47a19d98c895\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/search.js\":\"d71a0c78c27cf36c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/shared.js\":\"14cd257e0efa5ec8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4d00ee0f9bf599bc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/text.js\":\"e64f2bdbfc402b1f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentWrites.js\":\"ed26280309f6f298\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/authoringCatalog.js\":\"53dd480f6a227716\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/blockRefTargets.js\":\"16a2c1de129b4dc3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/bridge.js\":\"2e91b063093ebec2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/bridgeLoop.js\":\"1866ee82fb58db23\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/changeHistory.js\":\"3df88bf7c40864b8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/commands.js\":\"c9b75de9270f03eb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/commentsCommands.js\":\"cc3c87042d7dd42f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/dataExtension.js\":\"ff9f1ac5d5723646\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/dataModelGuide.js\":\"ed6a458fad46dcc5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/dayPropertyInputs.js\":\"f91ca7a6527a4c74\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/describeRuntime.js\":\"0b09061f953a9fa5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/extensionLint.js\":\"2d6e4b6d32d77d56\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/grainAudit.js\":\"1ee81e6291d4c2b3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/healthCommand.js\":\"506cb222fbb6da67\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/index.js\":\"f95b0036fe79810d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/presetIdentity.js\":\"fcdd600af328d1a8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"5b4f26b643277643\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/readMedia.js\":\"3fc10dcfc53fc070\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/schema.js\":\"552f3daff88aaea3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/serialization.js\":\"ac6dda00c58ad73a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/targets.js\":\"c28ab37cb9cfa355\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/tokens.js\":\"731f7281b474265d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/watchEvents.js\":\"9a3d54aa6aa6fd3d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/workspaceGuard.js\":\"0fb762950dbe5191\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/writeCommands.js\":\"83a8dd538fd39b70\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/AliasCollisionToast.js\":\"09c216e4688cbce5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/DuplicateNameBanner.js\":\"599b3fae027d6784\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/collisionMerge.js\":\"d9c4f1eb555c0a6d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/dataExtension.js\":\"d30a535ca656aaaf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/index.js\":\"a86c23c9259baf7a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/mergeCollisionAction.js\":\"09f0a0e6eea43da7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/pageStyling.js\":\"74843a18d077fc9f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/rejectionToast.js\":\"0de25befd522b298\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/syncProcessor.js\":\"91e394d6e4d325b2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/actions.js\":\"13552e9756e21cf6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/addComment.js\":\"b60fba19c56603d0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/anchor.js\":\"919428ca2aac6201\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/anchorState.js\":\"88340d50e443f904\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/commentLinks.js\":\"e167352950986a62\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/confirmThreadDeletion.js\":\"df3c76ac26076c34\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/container.js\":\"ea421ed7c5ffc6d6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/dataExtension.js\":\"7597ef2f062ce0d7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/deleteComment.js\":\"dc786cafe9b4ba06\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/highlights.js\":\"ba23c9d959abd935\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/index.js\":\"f6d266570715c49d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/linkedCommentsPill.js\":\"517378e877c13389\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/margin.js\":\"72e6de2f442bb488\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/marginAnchorLinks.js\":\"a91f3d8b35094f04\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/marginSchema.js\":\"2514ed1264b4b54a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/newComment.js\":\"d985948ae5a0ac70\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/ownThreadPicker.js\":\"dce127370d7a5acd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/placement.js\":\"e4c306b0457b57c9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/queries.js\":\"b1434339bbbec737\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/quotePosition.js\":\"2374ddd443f047be\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/quotedIn.js\":\"81cb1544405d79c4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/quotedRange.js\":\"31449577ff364b72\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/rangeRefs.js\":\"33eb39d2f4214cb4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/readHighlights.js\":\"1d12e5f4ee50cca1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/readSelection.js\":\"64927ee5f997b3bc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/readSelectionUi.js\":\"28aecdf579767862\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/reanchor.js\":\"69af95f10d086815\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/schema.js\":\"82fe3ea81214577e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/scope.js\":\"28660f3b1ca86958\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/scopeThreads.js\":\"b319fab012775e94\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/splitRetarget.js\":\"24a5f1fbd6754473\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/suggestionCard.js\":\"a3eacf9b9fafb4e8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/suggestions.js\":\"7e46d587467b3c75\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/summaries.js\":\"bd53134d0199d498\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/summaryBatch.js\":\"88808de554c0ce46\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/surface.js\":\"3b57a5c136acbb22\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/threadNavigation.js\":\"6a8e4bbacab2e58d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/threads.js\":\"53a7d50ad634b27b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/ui.js\":\"87214f1f0b130b7b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/uiStore.js\":\"778e643811185d94\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-intents/appIntents.js\":\"9c791c5d4f55d12f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-intents/index.js\":\"d665666926023d6d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-update-prompt/index.js\":\"44cf0e9ddda4a876\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-update-prompt/status.js\":\"cde5cfe95f19e390\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"8130948f1c8c0230\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/MediaBlockRenderer.js\":\"29baf17e27a73c5d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/MediaDownLaneReplicator.js\":\"c318917e5d0eb6c6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/MediaUploadReconciler.js\":\"005687825e680e6d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/assetDownLane.js\":\"6c288cce8a729172\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/assetResolver.js\":\"86d167b99683db04\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/assetUpload.js\":\"f0ad8f850635efcf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/attachmentCleanerIO.js\":\"fb36212028b78f35\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/supabaseAuditIO.js\":\"53be81776a9e7e02\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/blobStore.js\":\"df93052a97294346\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/browserMedia.js\":\"842f8ac4291aacc2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/byteStore.js\":\"5ea1f09280baf8d6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/cleanerIO.js\":\"28ddc323d1c4f424\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/cleanupAttachments.js\":\"a912669a74a3d7b5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/dataExtension.js\":\"ecbbf7398eac9657\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/downLane.js\":\"ba0b2bf7e0eeced4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/index.js\":\"374fb289ffa2e75c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/insertImageContribution.js\":\"584655e0284bb4f9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/laneArming.js\":\"01af2548479534df\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/laneLock.js\":\"18c958486258f005\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaBlock.js\":\"11f0ced9cabdaddf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaCapture.js\":\"24d051c33af09b09\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaLanes.js\":\"712e94e415ddeee0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaViewers.js\":\"078c9e8693eaec70\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaViewersFacet.js\":\"a49cb5f5b1191a21\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/pasteCapture.js\":\"f15011a5d07e1895\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/resolver.js\":\"00ad1601fd3dc89a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/retryUploadsAction.js\":\"6914afcaa0a012f1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/storagePaths.js\":\"77f4d97325e2acfd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadDrain.js\":\"266f3628d2742b4f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadLaneStatus.js\":\"977fc08be1728407\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadReconcile.js\":\"39ff3e8a65e06a76\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadRecovery.js\":\"49295b6b40405e7e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadStore.js\":\"2e85e9a53b9f3e20\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/useAssetObjectUrl.js\":\"bd00a2f9cd21fdc3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4fbd3838ef0f46a8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c56566c270a2164d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/facet.js\":\"0903ab0f2e319c73\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/index.js\":\"23de138739dd73e2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/prop.js\":\"226b644a2f7d94c7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/BacklinkFilters.js\":\"6933890a51a31858\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9acdd062c620cac8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/BlockEntry.js\":\"297632df208940dd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/LinkedReferences.js\":\"62af9077f5e52754\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"0ee97e47f1652ef5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/dailyNoteDefaults.js\":\"1961851288840363\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/dataExtension.js\":\"66777dc3a0f82e32\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/edgeExclusions.js\":\"e0901682e0649791\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/filterProperty.js\":\"874c549e0bf73292\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/index.js\":\"c29bcd2ab3e51f65\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"8e84ad4115f3756d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/applies.js\":\"ee6372f246b42775\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/countQuery.js\":\"281f15c293b0883f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e9604f6ef90d2525\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/index.js\":\"ae29bb50adb8088b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c82c89da54de72bd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/presentationInvalidation.js\":\"813187b852ce04cf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/propertyEditorOverride.js\":\"8f75d8b6d79efb0b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/propertyFilter.js\":\"90d9eb9eea12eeeb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/query.js\":\"de16298c30e866c7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/resolveFilter.js\":\"c526f294d1975bc1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/sourceBatch.js\":\"b0ee91c8dbcdc18f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/sources.js\":\"758f85514b61000d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/useBacklinks.js\":\"2d86627bbc1b4e58\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"57bbfe4d3861a802\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/BirthdayCelebration.js\":\"e6a30c157011d2a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/BirthdayOverlay.js\":\"735653accee2d812\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/gate.js\":\"77452265b6d902a1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/index.js\":\"e14d503b30a90a1c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/wolfTheme.js\":\"8a650057ad62e0c0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/BlockDragLayer.js\":\"c71b1d6e584bc1a7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/dragController.js\":\"4603099dad341b70\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/dropTarget.js\":\"615519ade7245f14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/index.js\":\"d7308a584ecaedb0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/projection.js\":\"f3fa6bdee21ebed8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-info/BlockMetaCard.js\":\"7f3ffc825bf6baa2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-info/index.js\":\"56e908cb865dcd14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/AddTagDialog.js\":\"176b8cdafeb7c76d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7c2824f0695bd4b7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/TagNameIssueHint.js\":\"4385bd5e5ac3c1eb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/addTagAction.js\":\"ac92b053881af655\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/appendTag.js\":\"efb0a6cd0f4cbab0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/config.js\":\"2c736bcfe3c8d35c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/dataExtension.js\":\"462a84a4a89724d0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/index.js\":\"506ac257a824dd40\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/propertyEditorOverride.js\":\"70669cb665423942\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1b2386762ed55004\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"39b707ba2de0c4a0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/Breadcrumbs.js\":\"28c742f75a321088\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8f43777fd0d6c2d9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"063e759115598bcc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/index.js\":\"08a120c9c9a0ec7a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"49d700ba77145cb5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/CharacterCountItem.js\":\"3fa2831efe7161fb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/ProfilePropertyEditor.js\":\"67e73e7a91cb21ad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/actions.js\":\"4d8e328d063317de\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/blockType.js\":\"0c3b24b04d755bf7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/charCount.js\":\"0d9335a764b2177a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/dataExtension.js\":\"afd08fc7229112b4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/index.js\":\"5079db68810dc9e2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/profiles.js\":\"e50e15e18f5bc232\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/properties.js\":\"968e8e8cd4e84d9e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/subtree.js\":\"edd11db4c5bcdd14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/textCounts.js\":\"fb6e0c32099502a5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/colemak-keybindings/index.js\":\"41f4a67892a023b5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/CommandPalette.js\":\"af890c441010c1d2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/HeaderItem.js\":\"16d3585b186d4e92\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/context.js\":\"090c86f0dc2f6ff7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/index.js\":\"ed838468be4d0b1b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/selection.js\":\"feda5ba6502a6847\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/toggleStore.js\":\"d04057e888e2089b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/useCommandPaletteActions.js\":\"cb53e51ee5d179f9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/ContributorBadges.js\":\"2666f7a4e27c85df\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/ProfilePicture.js\":\"c580bda1d7206e21\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/author.js\":\"16b82b082890eea3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/codeMirrorExtensions.js\":\"ca70e22276ac0a8a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/dataExtension.js\":\"6defc582c0041054\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/index.js\":\"90d4bc5339379c46\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/mentionAutocomplete.js\":\"544067dacd285679\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/processor.js\":\"cfe8cf62038e0926\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/profiles.js\":\"d866eee6eb823574\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/queries.js\":\"ae84527005fd5f95\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/schema.js\":\"e8defcd2b4f662ea\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/useCommentAuthor.js\":\"c3e275b30950a2a6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"aabcba7e6f067f83\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/followOrigin.js\":\"3ce5c0bf7e8b438b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/index.js\":\"06d361acccd131ee\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c87f66262445b906\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"99b30788464ca204\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/CalendarGrid.js\":\"bb8916422897f3b1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DailyNotePicker.js\":\"1cfb919a1975e615\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f05eb610da6bcd64\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DateNavDecorator.js\":\"8c9cd19b6b06c3a7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DateScrubOverlay.js\":\"1b3bbccecad0a025\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DayPropertyControl.js\":\"82230688ef1ed0d2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DayValueReferenceControl.js\":\"d0673a5b7fb00ec4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/HeaderItem.js\":\"5713cee0f5dd2469\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/ReschedulePicker.js\":\"d3d35ef6b01e1937\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b17968e5c34e2fcf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/actions.js\":\"2e0a695bac339189\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/blockDateAdapter.js\":\"46a4386b16dbbc52\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/calendar.js\":\"32216328d5f92395\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dailyNotes.js\":\"8132746d0270972e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dataExtension.js\":\"500038e7e41fd6c1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubActions.js\":\"532e0eaf2729faa8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubGesture.js\":\"5bd56008d946b93b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6dcc407dee293f56\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubRecognizer.js\":\"142299ede75aea02\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dayProperty.js\":\"b68d7664adf58660\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"ed33cbc7b0010fba\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/deletionGuard.js\":\"5010e18617406e34\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dueQuery.js\":\"33c1f71a32626776\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/index.js\":\"6904fbffb6a92c6a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/landing.js\":\"cb4bdd3e0b604207\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/localSchema.js\":\"a39cee0785607063\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/referenceDateAdapter.js\":\"a75dcc7ea0ed031e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/rescheduleAction.js\":\"75ec85b5377652c4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/schema.js\":\"f0a604469938b03b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/spreadBlockDates.js\":\"e2703415a7b69af6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/spreadDatesAction.js\":\"f6c85c65e5b3f0eb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/today.js\":\"11d7a87923a00e7c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"cb551828d5541678\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"896b940b54541198\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/audit.js\":\"1dc4074777bd7a12\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/auditAction.js\":\"3592229250fced82\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/auditRanges.js\":\"f6f00675b6c1077b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/diagnosticsSource.js\":\"d221349387e2360f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/divergenceScan.js\":\"2046c772aaceff1a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/index.js\":\"8146c679909c5a70\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b3499683b19f4c2d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/referencesMirror.js\":\"508256227f2218d0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/rowJson.js\":\"8bfdccaddba7e1fb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/schedule.js\":\"b5f20d3bf63d23f3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/store.js\":\"a0b1a8e53afbe3e5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-maintenance/action.js\":\"ac51d698806e3878\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-maintenance/index.js\":\"65be5ce4f1d97f40\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-maintenance/plugin.js\":\"2f65a6ae3f7221e9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4df78a05b09c8b0c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/actions.js\":\"12f366bae5492772\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/changeMarker.js\":\"cc6dfdfabe81ad4b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/diagnostics.js\":\"2419948a561f9c6f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/fileSystemAccess.js\":\"22d1cd700a29b023\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/filenames.js\":\"627d9f8fc1071b06\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/index.js\":\"a0a2a0c0f17fe402\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/mirror.js\":\"7284915d24484cfb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/runLock.js\":\"cad9e0d3a11cb282\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/runtimeHealth.js\":\"c5c7fa253c5a77a7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/schedule.js\":\"8571849826f472ef\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/store.js\":\"58d63d88f4246c65\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/default-themes/index.js\":\"aed5dc44696ebedc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/default-themes/themes.js\":\"9beff8951d976579\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/diagnostics/facet.js\":\"1098dc9df17b0c8e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/diagnostics/useDiagnostics.js\":\"ef6176c914dcfe74\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/dismissals.js\":\"de2c5d636e601f8f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/index.js\":\"1a804d3ef1836daf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/status.js\":\"577334c796a4a020\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/store.js\":\"a14594ad2af60ea6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1552f9b99ef6976b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/ExtensionsSettings.js\":\"d83a6c5bf3a3d9aa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/actions.js\":\"e6bc3f82e37968af\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/config.js\":\"af788611104cf148\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/dataExtension.js\":\"7086190526078e44\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/effect.js\":\"5fc065272308b136\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/index.js\":\"25c443ef5f5e1e72\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/propertyEditorOverride.js\":\"87802ec1015a6fed\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/useToggleTree.js\":\"eeb87ad8dbd46cac\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/ExtractTypeDialog.js\":\"05d9135f3ce34a16\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c8b78dc89af10aeb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/PropertyShapePicker.js\":\"198a5168d6957f44\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/action.js\":\"3d6163c17bd71629\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/index.js\":\"0fc8623418c99939\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/FindReplaceDialog.js\":\"67542f34bc4c183a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/HeaderItem.js\":\"20316e73153a762d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/dataExtension.js\":\"1977ca168cc7b4a0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/index.js\":\"50459527b7b511c9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/search.js\":\"28eded20ec55d46c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/toggleStore.js\":\"a5b191f31e867507\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/LocationPropertyEditor.js\":\"6c76f43df2aa271d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/MapView.js\":\"d6e4731858c624c3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/blockTypes.js\":\"7dce30b9884ba5b8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/codeMirrorExtensions.js\":\"8438fc8d96b7b1c9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/createOrFindPlace.js\":\"b0c4fd9f06eced80\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/currentLocation.js\":\"cbcfc2c9afb36ad0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/dataExtension.js\":\"ac9aa946fd39fefc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/geoContentDecorator.js\":\"6bfd0b48571dc206\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/googlePlacesClient.js\":\"8d81042eac5fba9a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/index.js\":\"bc211d1116c51d07\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/locationsPage.js\":\"c87354e5f530e0a0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/mapViewport.js\":\"2b55ab25b49a83cc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/pickCurrentLocation.js\":\"8f3f1dcdee562b3b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/placeAutocomplete.js\":\"a39431fd63e0a1a9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/placeNameCollision.js\":\"1af03e78a5ae943b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/properties.js\":\"26e31d65db3a14f5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/propertyEditorOverrides.js\":\"3a5d5976e29a71a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/query.js\":\"3fb7ccac065f4219\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/usePlaceSearch.js\":\"ab969df19c18e3f8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6a2312ca297031a7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"af1d33c01562f02b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c8eb8ba6bca1d33c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/config.js\":\"5a8bc8914f6fd019\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/dataExtension.js\":\"646af513620ec1d6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/facet.js\":\"a5d74754aa3489ff\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/grouping.js\":\"5459558e2dcf0079\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/index.js\":\"92280da575dcae18\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c46a327a11ad61f4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/query.js\":\"2a8cdf8015e4c615\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/resolveConfig.js\":\"e6c7d4e7a4506579\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d35caa399f3fb0d4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"c2ae9ad64fff50b8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/HtmlDocumentContent.js\":\"66e2c05f4cd1fc91\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/HtmlFrame.js\":\"2ddf4a8c602f224c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/actions.js\":\"3657088e55821fe7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/blockType.js\":\"805a4e2d0abf80fb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/confirmRunScripts.js\":\"a6844d39954317c3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/dataExtension.js\":\"c19a7c8f41d36197\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/frameAnnotations.js\":\"faa23b16af32a34b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/frameDocument.js\":\"d76961b128a49783\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/frameTheme.js\":\"22d78cb50d5aa686\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/index.js\":\"61621988f1e05d12\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/scriptConsent.js\":\"d08a668bf8e4dada\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/sourceMap.js\":\"e0158c59e50f94f7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/useDocumentScripts.js\":\"f102247aaa4f5ab1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/index.js\":\"8a4bb44ed8c8d445\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/record.js\":\"15788fe214798600\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/recordStore.js\":\"c80698152879c255\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/responsiveness.js\":\"5aa2dcf179c43883\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/schedule.js\":\"3c5fd1e81f788fb6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/sessionContext.js\":\"efc8f0c03facaa8a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"3acbbaf4269bd9f8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"4f26f69d8e78cba2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/actions.js\":\"4c296429e8804bf8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/config.js\":\"624aa2b9cf06a4b4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/dataExtension.js\":\"1e9f3833b856a2b1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/effect.js\":\"0fc6deba2c6e7ec5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/index.js\":\"ea63b9afaca329c8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/keyCapture.js\":\"9100e16470e96594\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/overrideStore.js\":\"aa26c61924c1a967\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"088dfd0ef35de62a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/HeaderItem.js\":\"90aa2a13c08bd15b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/LeftSidebar.js\":\"3f13b3890cdb5920\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/actions.js\":\"ee9889ce42ebf567\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/facet.js\":\"088f9ee90c3baf24\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/index.js\":\"7a334a21d07fec51\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/shortcuts.js\":\"bcbb19d2e8064a08\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/toggleStore.js\":\"887a5f7f146a92af\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/MergePicker.js\":\"68dd2e11057146c9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/index.js\":\"c5f42ec485c1a516\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/mergeAction.js\":\"8a9c69a961cb79cb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/strategy.js\":\"fa36046724a3adb6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/Button.js\":\"8617e2c41c35603f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6defa76ccd0029ad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/defaultItems.js\":\"6ec1b159d4a55b6f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/facet.js\":\"88b1eaf1a83498d7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/index.js\":\"7b4606bd756cc8d8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"74658b38b6368474\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a18f68d6c78ca34d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"10077ae980e43380\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/facet.js\":\"a107bf08009dbfa8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/index.js\":\"59e3974349e68b42\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/MoveDestinationPicker.js\":\"261b301792e99cc7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e5197027e107c379\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/contextMenuItem.js\":\"bccbe365485a600c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/index.js\":\"310a8dd5950ad237\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/moveAction.js\":\"2ab4100b6ae1f68b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/moveBlocks.js\":\"10b8f7413dcfccbd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/selectionAfterMove.js\":\"db7338f93e8786c5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/TutorialBanner.js\":\"e25ca9eddcf759e2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/action.js\":\"154706e6a88023b3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/bannerDismissal.js\":\"17abb6afb41edfe1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/documents/cheatSheet.js\":\"e510bf2db5615e27\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/index.js\":\"856a07b7178e0243\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/keys.js\":\"3619360575031c47\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/landing.js\":\"88d0e4dc87f2a01d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/outline.js\":\"071e70a7b83d1151\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/seed.js\":\"13d9ea83cf9a2850\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/PerfTrendDialog.js\":\"33f4d2224b3e4934\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/analyze.js\":\"5680ae3651aa3eb3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/diagnosticsSource.js\":\"67b8325f863ec098\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/index.js\":\"331a6cd029f0dcb3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/load.js\":\"38d19722f4db0e75\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/monitorRun.js\":\"caa3e81ecb61ca29\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/schedule.js\":\"12549055105767dc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/series.js\":\"81bf5423297276e5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/store.js\":\"e88a77899b57261a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/trendAction.js\":\"58281601c825c145\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/verdict.js\":\"f24b33c37a065cd1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/plain-outliner/clickToEditAction.js\":\"4b0e10d6f07d7c5d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/plain-outliner/index.js\":\"d63fca7d53f8854a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/plain-outliner/interactions.js\":\"36efbf2c4b030b16\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"b35ae998dd05e42a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/MigrationGate.js\":\"abbfccf22544b522\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/MigrationGateDialog.js\":\"15fe9fccee4c1cb1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/action.js\":\"36310056e8bf595b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/index.js\":\"e9656e510db48177\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/localRunMessage.js\":\"3511c6b388eb3c30\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/plugin.js\":\"947d7e6036c0bb5f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/progressReport.js\":\"66ebc9891e1773c2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/sweepProgress.js\":\"41b8e0a24bf35996\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/FieldRowRenderer.js\":\"44beda221b0ead0a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/ValueRowRenderer.js\":\"78691243e5576f57\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/actions.js\":\"c8fd48a40f4027d5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/autocomplete.js\":\"930c315d543e5516\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/fieldRow.js\":\"7803c6fb84c0b1c2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/index.js\":\"1ac9f9f8a911c6ff\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/referenceWarning.js\":\"7d2a5aec5d53c9ce\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/valueAutocomplete.js\":\"82824e6ba6bb01eb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/valueSchema.js\":\"7246efe1488fd644\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/HeaderItem.js\":\"52b0448cd30b8e4f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/QuickFind.js\":\"18916688d472adb6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/index.js\":\"1224957358c888cc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/recents.js\":\"c638d91ba15457c9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/resultItems.js\":\"87e98715ca79a6ac\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/selection.js\":\"f14af7517b89b276\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/toggleStore.js\":\"00bcb02ceb876636\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/HeaderItem.js\":\"7dd2da0979eb3a17\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/RecentsPageBlockRenderer.js\":\"510a5cbe089ce312\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/grouping.js\":\"5464263e7365cf6d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/index.js\":\"d6535b932668661a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/target.js\":\"47c52d750fa918d7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/codeMirrorExtensions.js\":\"a966f11d23e23890\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/contentPrefill.js\":\"08798f58ec533eee\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/dataExtension.js\":\"a0882444998d6d40\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/index.js\":\"b782706f90bbb781\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7f7a44f3ed6e8372\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/invalidation.js\":\"ec74e85f11b7e249\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/localSchema.js\":\"4fd848047cc9e2fc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/blockrefs/index.js\":\"58df58fdfd523ce1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"5b4f3ec364226838\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/index.js\":\"e4ad51719419dffa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/referenceNode.js\":\"c9df4a4e46616516\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cff74237157638d4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e17a6b68b3c04e55\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/index.js\":\"18f901c6d8174aa9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"ffe4f8a79c22edeb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2dcf131002bd906b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/mergeRetargetProcessor.js\":\"a6ef25ccf35afa72\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/parseFence.js\":\"f60ca42dce86bafa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/referenceParser.js\":\"1b5f8d353b875907\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/referenceProjection.js\":\"3d99df75ebf65817\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/referencesProcessor.js\":\"b73dbd968751b579\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/renameProcessor.js\":\"12ba40d049b2a46f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/spanReplacement.js\":\"8ea84bdb274587fe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/htmlToOutline.js\":\"4e51f686535b8119\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/index.js\":\"7418946e5698dfca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/normalizeClipboardDom.js\":\"e3f22dbb4997a15c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/pasteDecision.js\":\"4cff515ad4c3db77\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/action.js\":\"a127d5385933058b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/blockIds.js\":\"4d980b3289492d9d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/content.js\":\"727854700df48578\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/effect.js\":\"dc03f5c23d7ded32\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/ids.js\":\"8001b9123090b4fc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/import.js\":\"7df8161e79a3cdb5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/index.js\":\"370f957cb3a08871\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/plan.js\":\"86c18f28155e4f80\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/plugin.js\":\"558531c76a098a17\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/promotion.js\":\"6d16685c069ee679\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/properties.js\":\"503bee7d8cd62f87\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/references.js\":\"01242843d6b7bd7d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/report.js\":\"35cdce56c69f11d0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/roamMemo.js\":\"58fca39a9245eeb5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/runtime.js\":\"e7681e796e15829f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/schemaReconciliation.js\":\"83b8118f682de9e6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/srsMarkers.js\":\"e1c07b60d71b2b0f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/todo.js\":\"52b8a3279e76088b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/typeCandidates.js\":\"32eb54d01cb46217\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/types.js\":\"beefcf9e283e82d2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/search-health/index.js\":\"116aefbfba337323\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/search-health/store.js\":\"fdcba8ea42ed49fb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/HeaderItem.js\":\"c3e17bb6dc5371d6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"919bfb8613c677da\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/index.js\":\"9931d0e112708682\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/model.js\":\"138f13e4361282bc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/toggleStore.js\":\"6b0cb2df3b3dee0a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/useKeyInspector.js\":\"0afd7101baace4f9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0f8140e2a0b23533\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/ShellDecorator.js\":\"66465936330e1d9b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/actions.js\":\"f9c7f7eb243678d0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/exclusionsFacet.js\":\"ba6eb538e581f243\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/index.js\":\"50f0b7c8f0d6061e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/shell.js\":\"0e3c85bde9790db7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/surface.js\":\"f2a45ca61fa17703\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/walker.js\":\"ed6ebc7ae69ad479\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/RescheduleToast.js\":\"674888b6c442ad77\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/dataExtension.js\":\"ccfd656e67f3d045\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/index.js\":\"6018fa975a000454\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/indicator.js\":\"853d06fb25cbebd3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/moveSrsState.js\":\"c49d472b2c412d78\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8d07a853e2f50b4d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/scheduler.js\":\"1c47ed5be96e0487\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/schema.js\":\"76355c9e87215f92\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d13844b83d5700c2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/srsClipboard.js\":\"d6efc9ea52f64460\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"6fd28c63f115a4c4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/DailyNoteReviewHint.js\":\"b664650251cfabad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/DeckPicker.js\":\"8a3324b29c7d7b58\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/ReviewControls.js\":\"7bbb8febcd62331a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/ReviewDeckRenderer.js\":\"93a22ca32dbc7910\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/ReviewSession.js\":\"3d65d72af27b516b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/actions.js\":\"b304af381b0fa37b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/archive.js\":\"8c197bd53789f126\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/dataExtension.js\":\"9b5bc6c178a3c3fb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/deck.js\":\"c1cb8ab455be4afe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/dueQuery.js\":\"ab36520e0680888c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/gradeDecision.js\":\"355acb95e54f686d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/index.js\":\"7154f0ff9e4e867d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/keyHints.js\":\"d3b34e651a6a2ce9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/reviewCardLayout.js\":\"be710f386242cf7d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/reviewProgress.js\":\"63ed066b26514fce\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/schema.js\":\"53b16c69e17b20c1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/useDueCards.js\":\"bef9c979e24b1c6f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/startup-metrics/index.js\":\"70143d4b1d9e260d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/startup-metrics/record.js\":\"0057d07fa20fbdef\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/storage-persistence/index.js\":\"1f384afb58937c2f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/storage-persistence/persistenceStatus.js\":\"54e5219c97473bbf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/storage-persistence/requestAction.js\":\"f72983c54639126e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/TypeChipsDecorator.js\":\"c20202ffa37ee03c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/codeMirrorExtensions.js\":\"a35f653b616bed39\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/index.js\":\"3d0b619dc0bf9116\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/typeAutocomplete.js\":\"5570b84b9bc68f97\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"86ed8bdbaa528456\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/actions.js\":\"0ccc0549a0606d71\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/anchor.js\":\"9499627bafa856c9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/events.js\":\"eb25dd2edac64f09\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/gestureActions.js\":\"8f52225d134a9554\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/index.js\":\"ea32f50d5a2459d1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"eb050cae179ed771\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/sync-metrics/collect.js\":\"9752627538f8c539\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/sync-metrics/index.js\":\"0bf6935ca1145d51\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/sync-metrics/record.js\":\"76d81f632aa02a87\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/RejectionDialog.js\":\"74d8c74bd7e796f0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/SystemStatusHeaderItem.js\":\"23fe90b9dab077c8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/index.js\":\"4bab2655206bc921\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/model.js\":\"54c7c1881a1108a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/queueCounts.js\":\"c94e37a7a3200655\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/rejectedHelpers.js\":\"bb102146d2de8f2e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/rematerializeAction.js\":\"a1da28aaea38dc1d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/useHysteresis.js\":\"9fc5fe404e65e1e7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/ColumnHeaders.js\":\"b99bd56096c2a307\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/QueryUi.js\":\"74f9e51213ddc80e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/TableLayout.js\":\"c97a213e69693b68\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/actions.js\":\"2db253bd40b54fb4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/cellEdits.js\":\"da4abb1a8ef19363\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/childrenViews.js\":\"a1a86ed97ee64b36\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/columns.js\":\"6b24199bbd2f0dae\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/controller.js\":\"91cc8f8413cae3bd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/convert.js\":\"612de1b8a0706f41\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/dataExtension.js\":\"40962df9e7f59ed3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/index.js\":\"c1dc630756f6cd5f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/keys.js\":\"e7e9f4c9c4007358\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/model.js\":\"d90a4d353552c235\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/QueryText.js\":\"ca5e2a4e3b6a0cfe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/backfill.js\":\"add224d307d359a0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/completion.js\":\"ef07f441fc308c48\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/format.js\":\"9dcc9ddba3ee636c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/parse.js\":\"319844d844849c8c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/queryValue.js\":\"5dd395dba3f1bb3a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/registrations.js\":\"1158e77fd33a6cb0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/source.js\":\"8bc812cb9c7b300c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/registry.js\":\"001fff5d1e237aa4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/rowGutter.js\":\"4bb7807064a28498\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/rowVerbs.js\":\"e9ae4a5697a4f2a5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/schema.js\":\"8ab628c131625664\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/sort.js\":\"2181196a259766c6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/theme-toggle/effect.js\":\"54cbf6e89dbbe5c6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/theme-toggle/index.js\":\"38ccf60db985ee57\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/theme-toggle/theme.js\":\"ecc253d6f0cdf269\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/actions.js\":\"cc35a7caf102d307\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/dataExtension.js\":\"1b035917f3b7dfcd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/index.js\":\"f907d44baf37ce37\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/schema.js\":\"09e35dfe9b313249\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/TouchSelectionLayer.js\":\"d88dae8bf59b0154\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/actions.js\":\"d2a63b96d3687b62\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/defaultItems.js\":\"6db527b0db6b2034\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/facet.js\":\"2eca1e639c4918b5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/holdRecognizer.js\":\"68cce481a7cce371\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/index.js\":\"69d0dfb14baa53c2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/update-indicator/UpdateIndicator.js\":\"5b655cd8721aadf2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/update-indicator/index.js\":\"eea2fe071193b4d0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/update-indicator/loadTimes.js\":\"4ebfd305501a05a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/VideoNotesRenderer.js\":\"839a07d89188f2a4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/VideoPlayerRenderer.js\":\"f2f9404b07be3a64\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/VideoTimeStamp.js\":\"05008d67d3f1717f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/actions.js\":\"11e34fe6a968a941\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/index.js\":\"0694bb9e37c4a47c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/markdown.js\":\"bf0d96cc82f85bad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/notes.js\":\"6e87631577e565e4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/registry.js\":\"dd485db9621cbf95\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/remark-timestamps.js\":\"9bb1ef132bd79b6b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/view.js\":\"339e7cfbaefdf2a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/LinkHints.js\":\"d4d61acf96e3ca09\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/index.js\":\"babaf095d0248ed4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/model.js\":\"a1e74401f46e1e93\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/settings.js\":\"56be4e88ad688f5f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-normal-mode/actions.js\":\"4bcf40385a51796b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-normal-mode/index.js\":\"a150326137a0f7e1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-normal-mode/interactions.js\":\"b0add55b1593db61\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/workspace-header/index.js\":\"e78ddfe7fb5ab69a\",\"/knowledge-medium/pr-preview/pr-1910/src/registerServiceWorker.js\":\"c22927630ccb387c\",\"/knowledge-medium/pr-preview/pr-1910/src/requestPersistentStorage.js\":\"68e24003bcb3beea\",\"/knowledge-medium/pr-preview/pr-1910/src/services/authRequestDeadline.js\":\"2a14a625c690db1f\",\"/knowledge-medium/pr-preview/pr-1910/src/services/authStorage.js\":\"e0a45a75ac59ea2f\",\"/knowledge-medium/pr-preview/pr-1910/src/services/powersync.js\":\"9ba953f7b7e05ffe\",\"/knowledge-medium/pr-preview/pr-1910/src/services/supabase.js\":\"71d71799f730464f\",\"/knowledge-medium/pr-preview/pr-1910/src/services/uploadErrorClassifier.js\":\"3e487813d3ac79ae\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/ActiveContexts.js\":\"3eeb6fd8b8b3522f\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/HotkeyReconciler.js\":\"ab80f4a464a4b539\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/WipeLocalDataDialog.js\":\"86d5f1fb86ec4318\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/actionDispatch.js\":\"a747a4982b0b8ba2\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/actionRefItems.js\":\"5b677cddd8414ab5\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/applyKeybindingOverrides.js\":\"3068608eb34a9e0e\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/blockActions.js\":\"88aed18379c2f653\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/blockMergeGesture.js\":\"1ae5cf14af972d3e\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/canonicalizeChord.js\":\"0f18799a3df0a83d\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/defaultContexts.js\":\"956d9d5bcb4cd17a\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/defaultShortcuts.js\":\"cc7aded84f866821\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/effectiveActions.js\":\"b1e3f70c48059a5f\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/gestureAction.js\":\"7c7ae233d53178a1\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/gestureBinding.js\":\"7f81f419aabd6032\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/holdRegistry.js\":\"fc98c9350066f52c\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/keybindingConflicts.js\":\"2ddda488821b0fdb\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/keybindingOverrides.js\":\"2b33b027946cf73b\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/pointerAction.js\":\"b8574e360820be50\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/resolve.js\":\"06ff1e9e848cac76\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/runAction.js\":\"9bb5a6c636caca5a\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/sequenceMatcher.js\":\"9a7907f74c353812\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/types.js\":\"7521694a6945f9bd\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/useActionContext.js\":\"7516cc79279e95ef\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/useActionDiscovery.js\":\"51f8f19750242077\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/utils.js\":\"1928c44b4d2d482f\",\"/knowledge-medium/pr-preview/pr-1910/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1910/src/sw/bootStore.js\":\"5f2e0c468ca8b99e\",\"/knowledge-medium/pr-preview/pr-1910/src/sw/previewDatabases.js\":\"9a1d67d5d2b519d2\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/byteTransform.js\":\"545385f5fe0f7214\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/attachmentCleaner.js\":\"a68dba40c01c0ff6\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/attachmentParts.js\":\"2ddec8d659d58b78\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/bundleParts.js\":\"b6faa8745feade03\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/bundleRecord.js\":\"836717460f02480b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/manifest.js\":\"f90bfc3a4a1f86d7\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/takeBundle.js\":\"6380ad31125eecad\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/verifyBundle.js\":\"857a73b809997e9f\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/cleaningStage.js\":\"8a86df148e03c138\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/conversionKey.js\":\"1b1426d00c136002\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/conversionServer.js\":\"70706f37f837a8d2\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/flip.js\":\"937b8415a8e3317e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/flipAttempts.js\":\"2d6dfca121574004\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/pages.js\":\"4c6be5eca93e28bc\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/preflight.js\":\"3e9af0f0e38f1b70\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/reseal.js\":\"ffebb1ece2038dfa\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/runConversion.js\":\"26195e55afe24124\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/runLock.js\":\"1f027d9368449827\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/sealing.js\":\"023214e0666c180a\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/sealingStage.js\":\"b2694f503f294376\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/stage.js\":\"a7b8223d3e9f1035\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/verifyReseal.js\":\"84de604b02e8cd03\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/aad.js\":\"96fb485b0311354e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/aead.js\":\"98833a459caeee45\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/base32.js\":\"e86ae8c86d5737e1\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/base64url.js\":\"b5a303cb99d76a38\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/binaryEnvelope.js\":\"ac76df4adffaefd9\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/byteAead.js\":\"489b1649d27baff8\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/canary.js\":\"82b9a80b235d7ab2\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/contentHash.js\":\"62be88295765020d\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/contentKey.js\":\"544363401b5ee474\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/derivedIdNamespace.js\":\"89ef71cf68953881\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/envelope.js\":\"d2540b53ef3574ae\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/hex.js\":\"eb0f1cc186d54425\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/sha256Hex.js\":\"551d76256f3d4f0b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/workspaceKey.js\":\"d7a50782b1a36d50\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/conversionState.js\":\"d5d25340f589c652\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e67e7831d64a3ed5\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/pastedKey.js\":\"ecba82f1744351ee\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"efba7b91577e40b3\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/upgradeWorkspacePin.js\":\"993cfed744c32997\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/keyStore.js\":\"d5082750f062caa8\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/mintWorkspaceKey.js\":\"55a2e2136530cd9a\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/modePin.js\":\"c640dc7113d2ff32\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/openWorkspaceKeys.js\":\"151c8ce0b01922e6\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/resolveWorkspaceEntry.js\":\"8c524002b8823311\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/resolver.js\":\"44582497707e15cf\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/workspaceAccess.js\":\"321124f1b2f688e2\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/transform.js\":\"7f78c3afd2caf8de\",\"/knowledge-medium/pr-preview/pr-1910/src/themeBootDefaults.js\":\"103029e0514ab89c\",\"/knowledge-medium/pr-preview/pr-1910/src/types.js\":\"162531f1cdcb1997\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/ClientLocalSettings.js\":\"ffee6d1685c515bd\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/abortableSleep.js\":\"4daf0b9d0bf3acd9\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/array.js\":\"3e0475253f598965\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/backlinkAutocomplete.js\":\"fe3424731300f2fc\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/blockCrumbs.js\":\"ade6a3c2ecceae93\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/blockrefAutocomplete.js\":\"8455c6a766ccc630\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/cadencedIdleJob.js\":\"0745f7497013f948\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/callbackSet.js\":\"f2654fbe7ae8c280\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/clientId.js\":\"18c8f091a53a7043\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/codemirror.js\":\"2ae4cb6a703d2bbf\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/codemirrorCompletion.js\":\"d3196f5c3413d381\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/copy.js\":\"6124a090cf518eb1\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dailyPage.js\":\"e8dea45d9df33c7e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dbForensics.js\":\"a83835e4eea26206\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dbForensicsHooks.js\":\"7c82b3d6c561faa9\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/deleteBlockThroughUi.js\":\"197c9052a78452e1\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dialogs.js\":\"2f56661dbd267fb1\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dom.js\":\"6b54c2be5fc6e904\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/downloadBlob.js\":\"840f1207309d9dce\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/drawnWalk.js\":\"83f8d6ba5b4b2791\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/exportSqliteDb.js\":\"93e83fb8a2c4d4d6\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/fileSystemAccess.js\":\"88ae86b62c1337af\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/flipSlide.js\":\"9929b0a370ab3871\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/fnv1a.js\":\"c12a4c17d428dd5d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/formatBytes.js\":\"227efc8bf1cce415\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/fuzzyRank.js\":\"43372adbc035c453\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/idbKeyedStore.js\":\"29b0a45691b46e2a\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/idleCallbackPolyfill.js\":\"f3691de4f82df5c8\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/keyboardAwareScroll.js\":\"a61ac172147df1e8\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/keyboardViewport.js\":\"cfde8a6ee568edef\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/lastWorkspace.js\":\"0675c91a6d0ddca4\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/layoutColumns.js\":\"7143afbc603c8d09\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/layoutSessionDom.js\":\"b5e159d943dba071\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/layoutSessionId.js\":\"0c21a15640c85ccd\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/linkClickGestures.js\":\"9fd669e12b52082a\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/linkTargetAutocomplete.js\":\"87f435176761fb0d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/localDbCorruption.js\":\"5b4347add0624e7c\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/localDbRecovery.js\":\"de54de982e190301\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/markdownParser.js\":\"f8a0ecaefd524730\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/memoize.js\":\"92ca38117dd0246a\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/nameFieldCommit.js\":\"05712c7bc087538f\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/nameList.js\":\"c90db4decc798159\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/navigation.js\":\"dfcfc75736b72fa5\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/omnilinerNamespace.js\":\"fe48bf63c36f5b31\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/opfsPageScan.js\":\"0784efc924920214\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelClearance.js\":\"263fcb73c2dcd65f\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelHistory.js\":\"d036b0ef40b3d37f\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelLanes.js\":\"8ecb98665a235305\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelLayoutProjection.js\":\"4826268f7148d241\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelScrollAnchor.js\":\"f693beeb5b8c9413\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelUrlFlags.js\":\"0f07d57febe6deb4\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/platform.js\":\"04817e37f1550e14\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/pluralize.js\":\"3bb1a78583ecdfd3\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/propertyCreation.js\":\"65219eb4b05364c7\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/propertyNavigation.js\":\"1f4a03eb57646362\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/propertyValueContext.js\":\"7020a5ebde8c10ed\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/react.js\":\"ba8bc3d39a553f19\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/relativeDate.js\":\"d97d2cfe11803d65\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/relativeTime.js\":\"645f01eebd2a40bc\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/renderScope.js\":\"e1d4838b352b832c\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/resolvedThenable.js\":\"6d8dff40aa53a942\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/routing.js\":\"922e060ce5057f6a\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/safeMode.js\":\"ebfc281847c89d03\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/scheduleIdle.js\":\"424fed5b1471d25a\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/screenWakeLock.js\":\"cbdef5da4b42593e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/selection.js\":\"958330bed8cd9b62\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/softKeyboardGrab.js\":\"406286893bcb2926\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/startupTimeline.js\":\"65a59848acdbbabf\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/state.js\":\"186e1f91f830dd98\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/string.js\":\"b72e1d21e17abc0c\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/surfaceZoom.js\":\"b2949a48881e27a3\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/time.js\":\"a04fe253260ceae7\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/toast.js\":\"4424e79879ac218f\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/toggleStore.js\":\"ca1d55e48895544d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/untilStopped.js\":\"47c9dab48cf1f200\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/userActivity.js\":\"3dd6552d66d0cee9\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/viewTransition.js\":\"862b5e744cfc5548\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/viewport.js\":\"81d8d791749b1eba\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/webLock.js\":\"ff078069a0912d63\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/workspaceRecovery.js\":\"36b8f6610db77f05\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/workspaceSnapshotStore.js\":\"9f2235f594f4889d\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-compiler-runtime.js\":\"348a95846883f2e7\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-client.js\":\"6507dc58562f77b4\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-server-edge.js\":\"875d2fec197bb3c8\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-server.js\":\"9c28353f1123940c\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-static-edge.js\":\"d6f749a672dee296\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-static.js\":\"1f7942f361b87e8d\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-test-utils.js\":\"c3ca88ade06756e7\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom.js\":\"e7ab1d2f2804f5ef\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-jsx-runtime.js\":\"9d0f82eb50c23a60\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react.js\":\"da0dc8a8a0dd201b\",\"/knowledge-medium/pr-preview/pr-1910/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1910/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1910/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
