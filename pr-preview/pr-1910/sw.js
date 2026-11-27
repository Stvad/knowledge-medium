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
		buildId: "68c2db475b17-6b8e2e85",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1910/\":\"2f855f1063e1ce78\",\"/knowledge-medium/pr-preview/pr-1910/index.html\":\"2f855f1063e1ce78\",\"/knowledge-medium/pr-preview/pr-1910/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1910/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1910/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1910/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1910/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1910/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1910/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1910/assets/FacadeVFS-DUXV8TgA.js\":\"8312075cc7508dbb\",\"/knowledge-medium/pr-preview/pr-1910/assets/OPFSCoopSyncVFS-CABfK6vr.js\":\"354bb2979229ddd0\",\"/knowledge-medium/pr-preview/pr-1910/assets/OPFSWriteAheadVFS-zrNTSjQd.js\":\"df2eadc5a17a2c04\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-CdZWCFtn.js\":\"6f7a124c2d546f30\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1910/assets/wa-sqlite-async-DkT7umTd.js\":\"4fc68f0ce9e08dac\",\"/knowledge-medium/pr-preview/pr-1910/assets/worker-DaQCP1fF.js\":\"92988096267295dd\",\"/knowledge-medium/pr-preview/pr-1910/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1910/chunks/app-BOLAAXfv.js\":\"59af869d41e06528\",\"/knowledge-medium/pr-preview/pr-1910/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1910/index.js\":\"ceb2729f52dcd39f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1910/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1910/assets/AccessHandlePoolVFS-FcA_XUwM.js\":\"0fc6c15b3e29d077\",\"/knowledge-medium/pr-preview/pr-1910/assets/IDBBatchAtomicVFS-Co7y4hq4.js\":\"3caca156e1149f8d\",\"/knowledge-medium/pr-preview/pr-1910/assets/MemoryVFS-DGMvGgAq.js\":\"785cc0f376fce43c\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-DC8dbU0t.js\":\"dc89b27963316515\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-async-CJSGxizO.js\":\"6c79739a503c5607\",\"/knowledge-medium/pr-preview/pr-1910/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1910/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1910/chunks/AccessHandlePoolVFS-Rfr-x9QK.js\":\"ed41159f49734eed\",\"/knowledge-medium/pr-preview/pr-1910/chunks/FacadeVFS-D8bG5NAz.js\":\"20f88d6d65b9a485\",\"/knowledge-medium/pr-preview/pr-1910/chunks/IDBBatchAtomicVFS-BHZ3f6gp.js\":\"431d41462dd9886d\",\"/knowledge-medium/pr-preview/pr-1910/chunks/MemoryVFS-QejgZzMZ.js\":\"71fd6d1eca3cd064\",\"/knowledge-medium/pr-preview/pr-1910/chunks/OPFSCoopSyncVFS-Bl9QYiqh.js\":\"291d38609c796a9d\",\"/knowledge-medium/pr-preview/pr-1910/chunks/OPFSWriteAheadVFS-Dro17KXn.js\":\"32126c7858ad1258\",\"/knowledge-medium/pr-preview/pr-1910/chunks/Preview-DlLv4dAm.js\":\"7a8c578d8364ada2\",\"/knowledge-medium/pr-preview/pr-1910/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1910/chunks/card-Djo27m5q.js\":\"5d5d53ee3c973496\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1910/chunks/dist-DpbQBOlP.js\":\"5409fe566b419d8c\",\"/knowledge-medium/pr-preview/pr-1910/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1910/chunks/mc-wa-sqlite-Bh-HPV2Q.js\":\"39b8097294abe8e5\",\"/knowledge-medium/pr-preview/pr-1910/chunks/mc-wa-sqlite-async-OgENU2Um.js\":\"1e973b04fd0381b8\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-B-1Z4D7u.js\":\"ba4d76d4e9171b8e\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-B-vtCC8r.js\":\"5964df57d4e58d20\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-BbeK_Cbw.js\":\"c02f0c0144802c1b\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-Bwq3GjaT.js\":\"3951f8d515409c48\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-CbJetEA9.js\":\"c96747e95a89fe54\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-DGAjIvL4.js\":\"59e3e9b3b74f6e9b\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-DscBk1_I.js\":\"9594cdecc433a23d\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-LHG-UZUh.js\":\"49ee13dcdb0feab4\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-dom-server-legacy.browser.production-CC-q5MfD.js\":\"ad99094335488972\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-dom-server.browser.production-CDvfnvEU.js\":\"b58fcaab16d18ee1\",\"/knowledge-medium/pr-preview/pr-1910/chunks/react-dom-server.edge.production-C3n0Q49M.js\":\"a3ef2868b04057e4\",\"/knowledge-medium/pr-preview/pr-1910/chunks/server.browser-DQW3y4_F.js\":\"45d853d3df88d33b\",\"/knowledge-medium/pr-preview/pr-1910/chunks/textarea-XwfRcVhB.js\":\"d030eed4a77ed234\",\"/knowledge-medium/pr-preview/pr-1910/chunks/ui-iGvE0iX-.js\":\"2df39979a4a52998\",\"/knowledge-medium/pr-preview/pr-1910/chunks/wa-sqlite-UaKQ-EbM.js\":\"65fa332e9ec5843b\",\"/knowledge-medium/pr-preview/pr-1910/chunks/wa-sqlite-async-MqdssqRV.js\":\"0b7d94ae2c15104e\",\"/knowledge-medium/pr-preview/pr-1910/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1910/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1910/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1910/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1910/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1910/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1910/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1910/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1910/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1910/src/App.js\":\"8443bf55295aac0f\",\"/knowledge-medium/pr-preview/pr-1910/src/appUpdate.js\":\"dc5f27a6dc1efabf\",\"/knowledge-medium/pr-preview/pr-1910/src/appVersion.js\":\"7d5ede05f407b281\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/initialLayout.js\":\"d9b2468aa7635f13\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/openWorkspaceData.js\":\"e8dcac46b0ffc776\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/resolveWorkspace.js\":\"91912c76035d399c\",\"/knowledge-medium/pr-preview/pr-1910/src/bootstrap/workspaceBootstrap.js\":\"8c284f90f908f5e3\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockComponent.js\":\"aaae12da02aa0d83\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockCrumbs.js\":\"e10006085fbe4c24\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockEditor.js\":\"3c284a18815160a6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockLoadingPlaceholder.js\":\"f8dcdb2756d8065b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockProperties.js\":\"82c8c8cf34111d86\",\"/knowledge-medium/pr-preview/pr-1910/src/components/BlockSearchPicker.js\":\"76da909ef1f3e975\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ConfirmBulkDeleteDialog.js\":\"a9fedd76e02abbb8\",\"/knowledge-medium/pr-preview/pr-1910/src/components/DividerHandle.js\":\"1f1a1e57b6de6ce0\",\"/knowledge-medium/pr-preview/pr-1910/src/components/DraftEditor.js\":\"bb1b3f874548ac74\",\"/knowledge-medium/pr-preview/pr-1910/src/components/GutterPill.js\":\"b20aab93be054e20\",\"/knowledge-medium/pr-preview/pr-1910/src/components/Header.js\":\"46e79c81548e87b6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/LazyBlockComponent.js\":\"357ff96cfa458ad2\",\"/knowledge-medium/pr-preview/pr-1910/src/components/Login.js\":\"38008abee81404c5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ZoomableSurface.js\":\"19045841cffbb4ae\",\"/knowledge-medium/pr-preview/pr-1910/src/components/editModeKeepalive.js\":\"54a17b762d6862a3\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a9f077e1c6f2610f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a9b7bf8f2de9890e\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/RefPropertyEditor.js\":\"50cd0dd19be044db\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/RefTargetTypePicker.js\":\"cb48936829474029\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/SelectPropertyEditor.js\":\"09f439be74999ec0\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/TypesPropertyEditor.js\":\"47b2790153737846\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/defaults.js\":\"8520f1205cf18319\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/kernelValuePresets.js\":\"be92a8e56126d092\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/selectablePresets.js\":\"f22a4bb48d04f707\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyEditors/typesPropertyUi.js\":\"56e7d5b808f8e977\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/AddPropertyForm.js\":\"0e2c8a9e43f49c53\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/PropertyPicker.js\":\"49ae92f97ee8e46f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/PropertyRow.js\":\"1cdbc84cfe5e18b7\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/Rows.js\":\"7a7a960427940817\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/actions.js\":\"2ac8e9bde44c0759\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/declarationOnly.js\":\"cc69391649713fc3\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/layout.js\":\"d679c33b9a020297\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/model.js\":\"20f823276af1bba5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/shapeUi.js\":\"4478ff8df04d22a5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/shapes.js\":\"3370fa5824722b39\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0211aef1e40b6858\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanel/visibility.js\":\"4b41d290b5aacbf3\",\"/knowledge-medium/pr-preview/pr-1910/src/components/propertyPanelSections.js\":\"3d348f6feb0dae7a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/BlockEmbed.js\":\"fa00a2147ceef6bd\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/BlockLink.js\":\"40aafc6ac4268a3d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/BlockRef.js\":\"5f2446715f46969d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/CompactReferenceLink.js\":\"b5dbcfe509e467ee\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/ReferenceLink.js\":\"85b444637bcbd8cf\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/cycleGuard.js\":\"9832edaee9db907a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/cycleGuardContext.js\":\"4ef428754c27b292\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/linkInteraction.js\":\"fc1ae7af63ad26cf\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/referenceLayout.js\":\"8523e5a0b7718ef7\",\"/knowledge-medium/pr-preview/pr-1910/src/components/references/useBlockRefAncestors.js\":\"f43f82d2e96cd49f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockGutter.js\":\"364bc9bdaa0fcdd8\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockInfoDialog.js\":\"10d47a29098f38eb\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockReadText.js\":\"3657e590feddb890\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BlockTypeBlockRenderer.js\":\"5fe3162388894bb5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/BulletHoverCard.js\":\"e14f7d9575dc3a90\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/CodeMirrorContentRenderer.js\":\"3e1f3f848ae3a383\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"68fc889661dd9953\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/ColumnResizeHandles.js\":\"d93d4594a7e44464\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bc403a03036a052e\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/DefaultBlockRenderer.js\":\"417a9ccfdd87464a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/LayoutRenderer.js\":\"7cab3eac9e4b2b1d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/MarkdownContentRenderer.js\":\"dd1156b14ccace7a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/MissingDataRenderer.js\":\"e6e5a15dc40112a0\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/PanelRenderer.js\":\"005e932edd918054\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/PropertySchemaBlockRenderer.js\":\"511513e4331fb60d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/TopLevelRenderer.js\":\"6d72d9c8b622145a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/blockGutterMode.js\":\"25af8c54bce89ae7\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/blockTitleText.js\":\"a4dba1366dfd00f1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/fieldCreationKeydown.js\":\"5753caf5936e139b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/renderer/layoutRootContext.js\":\"7160f308ae4436a1\",\"/knowledge-medium/pr-preview/pr-1910/src/components/typeChip/TypeChip.js\":\"beffea22b7fe1815\",\"/knowledge-medium/pr-preview/pr-1910/src/components/typeChip/chipStyle.js\":\"7a22e8ebe635e0e5\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/anchored-floating.js\":\"1a47a37761c0b6aa\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/button.js\":\"8723625d418efcac\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/card.js\":\"080236a5b9b400e6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/checkbox.js\":\"c34624ea8415602b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/collapsible.js\":\"2eb45286370d7960\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/command.js\":\"236548a234ffc734\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/context-menu.js\":\"83a18547339a677e\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/dialog.js\":\"9a0e8f921529fd0c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/dropdown-menu.js\":\"8667dc4eb06291da\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/floating-listbox.js\":\"091ba21eadf4b4d7\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/index.js\":\"64dc1afb9d96c64b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/input.js\":\"fd402918d1754519\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/kbd.js\":\"ec2e8b8c96a650b4\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/label.js\":\"4142aa2703c06ce6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/ui/textarea.js\":\"739711f4d54a5c18\",\"/knowledge-medium/pr-preview/pr-1910/src/components/useEditModeYieldKeepalive.js\":\"e4ef63139774a9ab\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/BootFallback.js\":\"71e732e448776bc8\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/FocusedRowLazyMount.js\":\"8a0361b4f7ce903d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/LazyViewportMount.js\":\"fd827f51387f3d0a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/LocalDbCorruptionFallback.js\":\"53aca7f054752aca\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/error.js\":\"0cf9c664199e4ec7\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/lazyMountRegistry.js\":\"f8d9796a8a6ba1c3\",\"/knowledge-medium/pr-preview/pr-1910/src/components/util/suspense.js\":\"ffaa81786cba7284\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/CreateWorkspaceDialog.js\":\"42d796ca39952d4f\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/PendingInvitations.js\":\"732231e6fe1f03c6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/SyncProgress.js\":\"c913f1c122958137\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/UnlockProgress.js\":\"152e2a141ef90baa\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceKeyGate.js\":\"8bf02f01d9b68cff\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceSettingsDialog.js\":\"6ea7dbbb1837999d\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceSwitcher.js\":\"4337ea0ada15b97b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/WorkspaceSyncGate.js\":\"0b648ad518a66c6b\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/ConversionFlow.js\":\"b48ce0b08dd06040\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/ConversionFlowHost.js\":\"4133b3331fe21083\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/EncryptionSection.js\":\"dfd3d7d31df6858a\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/attachmentPrompts.js\":\"e59e898e461544a6\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/bundleFolderPrompts.js\":\"dc698cf9f415a099\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/conversionFlowDeps.js\":\"f6eed70548a96f03\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/conversionFlowStore.js\":\"fc7b907f9ebee0cb\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/flowUi.js\":\"0732e66fe28b1155\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/conversion/useConversionRun.js\":\"46e00c02533ca664\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/keyUi.js\":\"4193151a13219b5c\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/useCloseOnKeyLoss.js\":\"847e04d28f40c388\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/useCloseOnServerE2ee.js\":\"3d9a684bc785b770\",\"/knowledge-medium/pr-preview/pr-1910/src/components/workspace/workspaceUnlocked.js\":\"069520a829b5ac40\",\"/knowledge-medium/pr-preview/pr-1910/src/context/backgroundSubtree.js\":\"3752a528cf2e8a24\",\"/knowledge-medium/pr-preview/pr-1910/src/context/block.js\":\"01c4274ebfd9a74c\",\"/knowledge-medium/pr-preview/pr-1910/src/context/layoutWsContext.js\":\"db66062375c374f8\",\"/knowledge-medium/pr-preview/pr-1910/src/context/propertyDisplay.js\":\"14065fe78b61239c\",\"/knowledge-medium/pr-preview/pr-1910/src/context/repo.js\":\"125c824dfff88b07\",\"/knowledge-medium/pr-preview/pr-1910/src/data/aliasClaim.js\":\"dfca8947e59e7dd7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/aliasSeatNamespace.js\":\"ea2ccd27cdf9c912\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/blockData.js\":\"2b708976aab78fd4\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/blockType.js\":\"b1a9787a4d2b7312\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/changeScope.js\":\"df36444e571ce17a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/codecs.js\":\"26bd459c2967a223\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/derivedData.js\":\"0eab7ca521b54bfb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/errors.js\":\"7f91342dec81b91a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/events.js\":\"9b074d534f9dc24f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/handle.js\":\"b402d6a5014b4533\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/index.js\":\"199e19fc22ec92d7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/mutator.js\":\"99785cc6cdf89ddd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/processor.js\":\"5f2c940039d40cfa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/propertySchema.js\":\"6e416179ae5c3931\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/query.js\":\"1169fc9cd936cbd5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/sameTxProcessor.js\":\"b34b255a392a02f3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/schema.js\":\"b402d6a5014b4533\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/tx.js\":\"b402d6a5014b4533\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/typedBlockQuery.js\":\"3349ed5326afbb2d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/user.js\":\"cb8405498a797d2e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/valuePresetCore.js\":\"c6c5becfcd8c9396\",\"/knowledge-medium/pr-preview/pr-1910/src/data/api/valuePresets.js\":\"bd3bce6e8acde58a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/attachmentCleanerIOVerb.js\":\"fbcc099f18f13fb5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/block.js\":\"73102719b654e540\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockCache.js\":\"20c3319d0d20dcfd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockId.js\":\"ce6e8965d30794cb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockLiveness.js\":\"72ac1fb2826516aa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockMerge.js\":\"b23348c010bcd4f2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockSchema.js\":\"36c66719fb46e5f4\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockTypeLookup.js\":\"5baef9d83ed2b280\",\"/knowledge-medium/pr-preview/pr-1910/src/data/blockTypes.js\":\"d804be4c902e38c2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/childrenView.js\":\"16e572945ed0699b\",\"/knowledge-medium/pr-preview/pr-1910/src/data/clientContext.js\":\"a2c68c44b4b0cc5c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/dbFileSiblings.js\":\"d8bd5ad082b68af9\",\"/knowledge-medium/pr-preview/pr-1910/src/data/definitionSeeds.js\":\"f4a9a70ac2217f34\",\"/knowledge-medium/pr-preview/pr-1910/src/data/derivedIds.js\":\"6e6fc8b23663bc45\",\"/knowledge-medium/pr-preview/pr-1910/src/data/drawnSubtree.js\":\"48a41255c4e65732\",\"/knowledge-medium/pr-preview/pr-1910/src/data/facetBridge.js\":\"d42258ee6d68a64a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/facets.js\":\"d6c35d07da1c9b5c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/globalState.js\":\"0f17d854a2338dbf\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/aliasClaimRederiveProcessor.js\":\"a7cd74f1bc37daa8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/ancestorBatch.js\":\"5cbf0ca75ae8576e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/blockTypeTypeifyProcessor.js\":\"770d245197a70106\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/clientSchema.js\":\"1dcce50e39b2847f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/commitPipeline.js\":\"5ed5064584cb2ab3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/devAssertions.js\":\"646dde495df26469\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/firstSync.js\":\"e8634d806797dfeb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/freshInitialLoad.js\":\"6e0c6fe615ed631a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/graphBackfillClaim.js\":\"43bb987d7e3b8258\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/handleStore.js\":\"aa96e99aeaaf86d0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/idleMarkerJobs.js\":\"87b94bf8d06688bb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/initialDownload.js\":\"e4cfdb68fad0abb0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/initializeClientDatabase.js\":\"bade0b8b0c9bb764\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/jsonCanonical.js\":\"8f21a9777bcd6689\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/kernelInvalidation.js\":\"c7607df59cb06796\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/kernelProcessors.js\":\"c4705436eddeabda\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/kernelQueries.js\":\"2b3b646e4452956f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/mergeTypeMembershipProcessor.js\":\"bd23c60e024d24cc\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/normalizeReferencesProcessor.js\":\"4b3e6a52c430964f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/poolInstrumentation.js\":\"0a487df8c74c0b98\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/processorRunner.js\":\"0ddf70ba6eb84bd5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyCellBackfill.js\":\"e6bbf9bb7b5475fa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyChildMint.js\":\"3a480e09de0963db\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyChildrenProcessor.js\":\"5c6a1e7922a3ac26\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0920615c38a7495c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyDefinitionSynthesis.js\":\"9f59ba66080441f3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyKeyScan.js\":\"5950347b31127ab5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertySchemaResolution.js\":\"7f8b4f4618bcca71\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/propertyValueEdits.js\":\"f4c9bae3ce8c7448\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/raiseProtocol.js\":\"8b31b30149755d12\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/readBatch.js\":\"4e3dc40c4dc4bdac\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/refProjection.js\":\"35dd2bf2c60ac7bb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/referenceTargetLookups.js\":\"ec85d12d763bb7d7\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/referenceTargetProcessor.js\":\"94fbe281eb467d77\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/replayMerge.js\":\"b4649bdd2739f999\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/sqlBinds.js\":\"4a4066c8d5aa15bf\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ea3515fe780b558f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/arrivalProcessors.js\":\"40385fa828ab67dc\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/invalidate.js\":\"71fd11217398df8d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/materialize.js\":\"3ef88339a074e055\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/observer.js\":\"fbda886bd2489c17\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/syncObserver/reconcile.js\":\"685e355c2b105578\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/timingMetrics.js\":\"16c35e939c05f4ed\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/treeQueries.js\":\"c1c50c653cf3a03e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/txEngine.js\":\"2e893e45f702cfdf\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/txSnapshots.js\":\"8dd98b4fc0c24b9e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/typedBlockQuery.js\":\"a49716ebe1a56102\",\"/knowledge-medium/pr-preview/pr-1910/src/data/internals/undoManager.js\":\"bd69d039032de8c3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/invalidation.js\":\"20408db117393472\",\"/knowledge-medium/pr-preview/pr-1910/src/data/kernelDataExtension.js\":\"23fb53f9cc82483e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/kernelPage.js\":\"55ee0a320bec19f4\",\"/knowledge-medium/pr-preview/pr-1910/src/data/kernelValuePresetCores.js\":\"38f73ebbf54767e1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localDbCorruptionSignal.js\":\"3001b67c0dfab483\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localDbStorage.js\":\"d2eb644ff15677fa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localDbVfs.js\":\"482c75fb2574fc90\",\"/knowledge-medium/pr-preview/pr-1910/src/data/localSchema.js\":\"0b284684add7e0af\",\"/knowledge-medium/pr-preview/pr-1910/src/data/maintenance.js\":\"76a79ad9c94cc3aa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/mergeProperties.js\":\"01e3cfde4a91067c\",\"/knowledge-medium/pr-preview/pr-1910/src/data/metricsConsoleHook.js\":\"8058ce37010088aa\",\"/knowledge-medium/pr-preview/pr-1910/src/data/migrationsPage.js\":\"0c46e64d9dd5bb7a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/mutators.js\":\"79a032f79674a0ce\",\"/knowledge-medium/pr-preview/pr-1910/src/data/orderKey.js\":\"de5e68a60467165e\",\"/knowledge-medium/pr-preview/pr-1910/src/data/orderKeyPlacement.js\":\"e01f7b648e53dd01\",\"/knowledge-medium/pr-preview/pr-1910/src/data/outlineSurface.js\":\"0d64a1a0b5fb4648\",\"/knowledge-medium/pr-preview/pr-1910/src/data/pendingEditorContent.js\":\"a12795197b99bec8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/pendingUploadsSql.js\":\"334c22231ff2abc1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/pluginStateExtensions.js\":\"751dceec52a421ee\",\"/knowledge-medium/pr-preview/pr-1910/src/data/powerSyncLogger.js\":\"1a07baddda24bc92\",\"/knowledge-medium/pr-preview/pr-1910/src/data/projectorRuntime.js\":\"98cd395cbd156149\",\"/knowledge-medium/pr-preview/pr-1910/src/data/properties.js\":\"2455b21432ae0cec\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertiesPage.js\":\"1658ba8a82a0bfde\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyChildren.js\":\"27d4737d468cf460\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDefinitionFanout.js\":\"5218c79b5344e33f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDefinitionMetadata.js\":\"37392616bf6cc755\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDefinitionRegistry.js\":\"2d8c3059b11290de\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyDisplayMode.js\":\"f9b2ff64bc0f8ea0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertyRowCreation.js\":\"8ad78602a8d6cdef\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertySchemaCreation.js\":\"d15ecbae0d323268\",\"/knowledge-medium/pr-preview/pr-1910/src/data/propertySeeds.js\":\"277b5c41701927b3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/recentsPage.js\":\"da1a2e860afe6967\",\"/knowledge-medium/pr-preview/pr-1910/src/data/refTargetComparableProperty.js\":\"aa90ef55148e40d1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/referenceBlock.js\":\"c9786e903083fad3\",\"/knowledge-medium/pr-preview/pr-1910/src/data/rejectedUploads.js\":\"082fbe7c5c2c59dd\",\"/knowledge-medium/pr-preview/pr-1910/src/data/releasePowerSyncConnection.js\":\"4db8b9473341670a\",\"/knowledge-medium/pr-preview/pr-1910/src/data/repo.js\":\"5c24dcc6e34cb5d8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/repoProvider.js\":\"728041bb9c9b1481\",\"/knowledge-medium/pr-preview/pr-1910/src/data/rowProperty.js\":\"a52afbbca1b3f3a0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/searchFilter.js\":\"7fc7ea9d3c59a47d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/seedIdentityLedger.js\":\"d9dd9d6df6be84f0\",\"/knowledge-medium/pr-preview/pr-1910/src/data/stateBlocks.js\":\"ccb53fcc0d80d0f5\",\"/knowledge-medium/pr-preview/pr-1910/src/data/structuralEditPolicy.js\":\"c0e6e02c6523df92\",\"/knowledge-medium/pr-preview/pr-1910/src/data/structuralInsert.js\":\"ce437a23bbd85cfe\",\"/knowledge-medium/pr-preview/pr-1910/src/data/subtreeDelete.js\":\"a4bcf9011c745c09\",\"/knowledge-medium/pr-preview/pr-1910/src/data/syncStreamLock.js\":\"fce202343e989b3d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/syncedTableSqlRecognizer.js\":\"9d6d90db267e7e21\",\"/knowledge-medium/pr-preview/pr-1910/src/data/syncedTableWriteGuard.js\":\"2ec3c153ce2df69f\",\"/knowledge-medium/pr-preview/pr-1910/src/data/targets.js\":\"95f3119a75c274ce\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeColors.js\":\"35edbbf4115c6342\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeDefinitionMetadata.js\":\"e8cb1535958d79ae\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeDefinitionRegistry.js\":\"d1556e340db68cf2\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeExtraction.js\":\"d41f63dec7aa9379\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeInitialValues.js\":\"924d9b029368abac\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typePropertyGroups.js\":\"7eda3190977875da\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeSeeds.js\":\"0d762e505f75e296\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typeTagger.js\":\"f3f32b0a841b7cef\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typedRecords.js\":\"178fd8f801644368\",\"/knowledge-medium/pr-preview/pr-1910/src/data/typesPage.js\":\"7e4d38ca1e6a9f39\",\"/knowledge-medium/pr-preview/pr-1910/src/data/userPrefs.js\":\"86c51aebf07ac4bb\",\"/knowledge-medium/pr-preview/pr-1910/src/data/userSchemasService.js\":\"4732c547fcada497\",\"/knowledge-medium/pr-preview/pr-1910/src/data/userTypesService.js\":\"4bd3c55ec646ff04\",\"/knowledge-medium/pr-preview/pr-1910/src/data/valuePresetRegistry.js\":\"7c48b0fb194185a1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/visibleChildren.js\":\"82a04d9563c01f0d\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceConversion.js\":\"5ec1131e00a8bfd8\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceFirstSync.js\":\"f8bbe69894864f56\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceIdNamespace.js\":\"fa8234dbb466a9e4\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaceSchema.js\":\"232d898ef98f1264\",\"/knowledge-medium/pr-preview/pr-1910/src/data/workspaces.js\":\"284011aabca22cf1\",\"/knowledge-medium/pr-preview/pr-1910/src/data/writeAheadLog.js\":\"90258e1967ee1e74\",\"/knowledge-medium/pr-preview/pr-1910/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/BlockPasteShellDecorator.js\":\"645a2ec5adad071c\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/atTrigger.js\":\"e53bb22322e33b32\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/autocomplete.js\":\"4aaa9661e0f2737f\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/codeMirrorExtensions.js\":\"cb6790332046bb19\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/contentFlush.js\":\"409d13b0d7d7012a\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/defaultInteractions.js\":\"eb433265976466e2\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/editSettleSignal.js\":\"3dfa4b28b99c4f49\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/insertImage.js\":\"3cd130c622876303\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/referenceCompletionRange.js\":\"39318dcc400bdb33\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/referenceTargetTypes.js\":\"cb42d59feb3eee1f\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/syntaxContext.js\":\"f8d1c50061a89bc2\",\"/knowledge-medium/pr-preview/pr-1910/src/editor/triggerMatch.js\":\"7362c3efb11a0f12\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/AppRuntimeProvider.js\":\"10eae61ae6d8169b\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/BlockFocusShellDecorator.js\":\"c7686d1aff81faab\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/ExtensionRenderBoundary.js\":\"8e245a87c742f799\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/PanelContentRecovery.js\":\"e16222170ae05b4e\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/apiCatalog.js\":\"f7b40d758cdeb0d4\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/approveExtensionHere.js\":\"1528f79d2ac918fe\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/armedCutAppMount.js\":\"d38fdaadb939a48c\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/batchableKeyedStore.js\":\"f81567702f866937\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/blockInteraction.js\":\"3b1f461d396d5061\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/blockSelectionAction.js\":\"cc7c67775535fdd0\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/compileExtensionModule.js\":\"7c45afa530be5008\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/compiledModuleCache.js\":\"433b06a2f09db328\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/continuousGestures.js\":\"05498a1e1b7ea9a2\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/core.js\":\"59dc16722f8a885d\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/defaultRenderers.js\":\"2bb7139b207d40f9\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/definitionFanoutAppMount.js\":\"74cbf2a8c7d0323e\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/dialogAppMount.js\":\"c690942e36b9fd4d\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/dynamicExtensionSeeds.js\":\"a4f5a8f9f75b558c\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/dynamicExtensions.js\":\"92f1b23960ce60e1\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/exampleExtensions.js\":\"84105c98563511a9\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionApprovalStatus.js\":\"464a52e1d29089d4\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionLoadErrorToast.js\":\"25517c754737a52a\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionLoadErrors.js\":\"ce72f6a21e9c30be\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionLookup.js\":\"93b88cd720325599\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionToggles.js\":\"9c37c2fb3c872453\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/extensionUtilitiesCss.js\":\"a8ba2982bf950db4\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/kernelPageDeletionGuard.js\":\"4ae4b8735052616e\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/liveRuntime.js\":\"8121b60a89a74716\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/openExtensionsSettings.js\":\"d714b485f96a3717\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/overridesCache.js\":\"cf385c5096bee6b2\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/pluginIds.js\":\"ae793f268fd5d045\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/processorRejectionToast.js\":\"d1ee066e780e59c3\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/runtimeActions.js\":\"e950cfdf413919ed\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/runtimeContext.js\":\"139ed62e74a96122\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/staticAppExtensions.js\":\"98185f361c338c4b\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/staticDataExtensions.js\":\"f11e1682c0abb672\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/toastAppMount.js\":\"7d937ee1322a070c\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/useOverrides.js\":\"cfecbd88e9076ccc\",\"/knowledge-medium/pr-preview/pr-1910/src/extensions/useShortcutSurfaceActivations.js\":\"274f8608a7ffbd1f\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/discoverToggleTree.js\":\"72c07805fe133f22\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/facet.js\":\"ef0035c93940412b\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/resolveAppRuntime.js\":\"84efdec8c5a91481\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/runtimeEvents.js\":\"ce6e9cdaf447e8a1\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/togglable.js\":\"7218e0ef64bf9692\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/variantFacet.js\":\"9597b51d53d23f7f\",\"/knowledge-medium/pr-preview/pr-1910/src/facets/verbFacet.js\":\"42bf9518ac5b828a\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/block.js\":\"2f24d9871665d189\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/focusedChild.js\":\"105fa01fa1acc0fe\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/propertySchemas.js\":\"9d3c2850dbe2938d\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/typeRegistry.js\":\"608ad9a05e230d4a\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useAncestorCrumbs.js\":\"4c634cf825095ab4\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useAutocompleteListbox.js\":\"ad93434aae22ce07\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useDebouncedSearch.js\":\"9d340dcbd5cb4b44\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useDebouncedValue.js\":\"984a558e2ed3867a\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useFacetValue.js\":\"1c31d6bf4c801ecf\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useIsFocalRender.js\":\"ffd299794612294a\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useIsReadOnly.js\":\"9060046f02eac35d\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useMaterializeBacklog.js\":\"4962ecb3ee760b5f\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useMinuteClock.js\":\"e53bacb9a8e89a76\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/usePanelLayoutProjection.js\":\"90a556454df5d6b2\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/usePendingInvitations.js\":\"1c3c62a0c927f39f\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useRendererRegistry.js\":\"a60242fe9d1aa94a\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useRetainedFieldRows.js\":\"8d0e64d024059d86\",\"/knowledge-medium/pr-preview/pr-1910/src/hooks/useWorkspaces.js\":\"86e2d52e1744adb4\",\"/knowledge-medium/pr-preview/pr-1910/src/lib/utils.js\":\"d16c78753be42184\",\"/knowledge-medium/pr-preview/pr-1910/src/main.js\":\"939c6221411f1b05\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/MarkdownImage.js\":\"28223d119d294636\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/blockSeparators.js\":\"520933124c0decdd\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/context.js\":\"61868d95b0d11771\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/defaultMarkdownExtension.js\":\"f900d2b201559f00\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/extensions.js\":\"d3f8c7236afdd98c\",\"/knowledge-medium/pr-preview/pr-1910/src/markdown/renderMarkdownHtml.js\":\"7ae64f362ee4ae5d\",\"/knowledge-medium/pr-preview/pr-1910/src/minimal-editor.js\":\"db6ac464c166ff0d\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/armedCut.js\":\"327f5dcfe50cc867\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/captureMediaVerb.js\":\"1ce0d366f9dd557b\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/clipboard.js\":\"8334c214613303df\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/decision.js\":\"c29329bdfb5152dd\",\"/knowledge-medium/pr-preview/pr-1910/src/paste/operations.js\":\"d27a9eb6594b470a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/account-header/AccountHeaderItem.js\":\"3abf5ae2d4036eca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/account-header/index.js\":\"ffd1ab41aa9026f5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"872d8c44b41582b4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/askAgent.js\":\"8023f3f2d79d85f7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/askedStore.js\":\"8f4a1b285a9a55be\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"8887b6bfd04672bf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/chipState.js\":\"bf8b453ac91b8f81\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/dataExtension.js\":\"9bbeb55fa43fa426\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/index.js\":\"b24ad58abd387fd3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"88d8776f10d6e5ad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-dispatch-companion/schema.js\":\"daac36435b8add1c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/AgentTokensDialog.js\":\"4ee8f2d64c018499\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/BridgePairingDialog.js\":\"49086ab89b7bf321\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/addMedia.js\":\"c5558f6c7045a270\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7ef5c778ea4c5124\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/block.js\":\"c142449c46f580e6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/context.js\":\"8dd23e7cdc00f387\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ffcc14a5437342d0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/index.js\":\"5bf3454f1565e4d3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/outline.js\":\"3c04b0e370ea5290\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/properties.js\":\"495e4704ef6175f4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/refs.js\":\"5a152df6debd7339\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2017ee6496d26831\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/search.js\":\"40686296dee9017e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/shared.js\":\"e2d82a060b673452\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d0394414ba6a60c1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentViews/text.js\":\"40c32656e68c54cf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/agentWrites.js\":\"c78208a2aacd12c0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/authoringCatalog.js\":\"465baae4606ae8f4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/blockRefTargets.js\":\"1979a7b4792f489a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/bridge.js\":\"7124487d2a2a63e7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/bridgeLoop.js\":\"221ffbbeb243cbe1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/changeHistory.js\":\"45767d245a7835af\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/commands.js\":\"c9a51b6cd296b121\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/commentsCommands.js\":\"bb82b9c20e3f6024\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/dataExtension.js\":\"f75547405e95baf8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/dataModelGuide.js\":\"4d376b0bfeb99489\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/dayPropertyInputs.js\":\"6d7555ac08e7f2e9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/describeRuntime.js\":\"df64dcd9ffc46b3d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/extensionLint.js\":\"277705deb2ec49d6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/grainAudit.js\":\"9a1d83d85c792d10\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/healthCommand.js\":\"643280ed4c6786b4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/index.js\":\"1a656fc5edfb059f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/presetIdentity.js\":\"7bf175544685c3e2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"79efebc6094f6df6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/readMedia.js\":\"50f6c9b8e0fdf0e8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/schema.js\":\"bc5a23d2e102e13a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/serialization.js\":\"7a2ff50ecbd60c43\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/targets.js\":\"f3afb97c6c881551\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/tokens.js\":\"bb29bedc10a22f4d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/watchEvents.js\":\"4ff64ff4b45be4f3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/workspaceGuard.js\":\"9628f62d79fabf38\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/agent-runtime/writeCommands.js\":\"eda55860800a98dc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/AliasCollisionToast.js\":\"35836447b2e81331\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/DuplicateNameBanner.js\":\"db39ae6dae9c5d09\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/collisionMerge.js\":\"800527b9a9a42bad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/dataExtension.js\":\"ca1e33b1f6410af2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/index.js\":\"131627c50c1ea9ba\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/mergeCollisionAction.js\":\"4e8ca8840726c4fd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/pageStyling.js\":\"ce3dc17b46148c89\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/rejectionToast.js\":\"181a12ad50c22c26\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/alias/syncProcessor.js\":\"a09ee55df81b18fe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/actions.js\":\"dcee4d595dc00ff9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/addComment.js\":\"d7841f2622fb0abe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/anchor.js\":\"d05c0f823e146073\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/anchorState.js\":\"51048f969b00995b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/commentLinks.js\":\"9fa10117414ae08d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/confirmThreadDeletion.js\":\"9f426c45963fae8e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/container.js\":\"136673420e52ad3e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/dataExtension.js\":\"d0ffe10797b1d24d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/deleteComment.js\":\"1537183cb8e1822e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/highlights.js\":\"190fbe5d79783950\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/index.js\":\"f54de9bb5524ade9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/linkedCommentsPill.js\":\"a3d261398ab41519\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/margin.js\":\"8de93ab2af9601ca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/marginAnchorLinks.js\":\"217f7118ac15156d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/marginSchema.js\":\"541d72484d1fd5e7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/newComment.js\":\"384cc3387cad0bce\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/ownThreadPicker.js\":\"5bc8dd795dafe35e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/placement.js\":\"79e6e85ae7b0c18f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/queries.js\":\"bc2495774f7c852e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/quotePosition.js\":\"e7370a1b870f33ab\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/quotedIn.js\":\"f6b0f53d156de26f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/quotedRange.js\":\"8e4184b487d3e989\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/rangeRefs.js\":\"cca0abbaf0c12fd5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/readHighlights.js\":\"10d571cff9602ac9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/readSelection.js\":\"05a968b8f9e68b1f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/readSelectionUi.js\":\"bcb3468eeeb51a0d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/reanchor.js\":\"383cc81931d82bc1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/schema.js\":\"31c83894c962f64f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/scope.js\":\"cb78963123103f52\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/scopeThreads.js\":\"473ff40a5e437aa3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/splitRetarget.js\":\"4822cce0aff2a07f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/suggestionCard.js\":\"6dafb08fbb92beb1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/suggestions.js\":\"3309a78fb0de1d81\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/summaries.js\":\"2f6d1ca6cacabd22\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/summaryBatch.js\":\"3b943b3f80dc1f57\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/surface.js\":\"9b3d3eec20f35888\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/threadNavigation.js\":\"711c89458881e3bc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/threads.js\":\"a05cf88001f2c21b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/ui.js\":\"4d4dfc413fdea20b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/annotations/uiStore.js\":\"09d4237e0758a1bb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-intents/appIntents.js\":\"9adaa83956b677d8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-intents/index.js\":\"5039d0fe0f82dbf3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-update-prompt/index.js\":\"5f3e91feecde1ad6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/app-update-prompt/status.js\":\"042d6333132e8c86\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"649b3bcf5d8d60a0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/MediaBlockRenderer.js\":\"9f0cdfbabcb0d1e0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d10ff1acc707f85c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/MediaUploadReconciler.js\":\"5fc53289ff642b4f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/assetDownLane.js\":\"228e32d9f3a5ce79\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/assetResolver.js\":\"cca090dd21ca74d9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/assetUpload.js\":\"ec9494a19993c91b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/attachmentCleanerIO.js\":\"26360adcb86d9028\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b88636cd4656e7fa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/blobStore.js\":\"246519e7dae4d5d3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/browserMedia.js\":\"d12f6c2c757bfe79\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/byteStore.js\":\"9a06275f9e9dec05\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/cleanerIO.js\":\"f4dfb1f52052fd8a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/cleanupAttachments.js\":\"57e64b141b32bace\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/dataExtension.js\":\"7c23aa6cadb744ab\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/downLane.js\":\"465bf18ff7e3dac1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/index.js\":\"c63203505fc10a2d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/insertImageContribution.js\":\"31ceb9e6bd0f2a64\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/laneArming.js\":\"688631f78df0fb39\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/laneLock.js\":\"66d03820989b139a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaBlock.js\":\"c43167765d5ad35a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaCapture.js\":\"873e69ebd187af8f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaLanes.js\":\"32341617b54098bf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaViewers.js\":\"2ede6b8f64be5444\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/mediaViewersFacet.js\":\"90219c270cc2e88d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/pasteCapture.js\":\"1b4c497dd23b5cdb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/resolver.js\":\"008e053f69089066\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/retryUploadsAction.js\":\"62ca0179f2c7aa77\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/storagePaths.js\":\"53088cb5ffda7f2f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadDrain.js\":\"fb61a4859f4e5316\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadLaneStatus.js\":\"b974cebb91b07d9f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadReconcile.js\":\"9647c4a8dd95a3b2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadRecovery.js\":\"f19d0b7877c2f713\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/uploadStore.js\":\"01d0d88d1c69c49c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/attachments/useAssetObjectUrl.js\":\"a7fcee8bce1504a4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"7b8e1ca9a233c8fa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d7f3c07dc4cb483d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/facet.js\":\"43d0edd3ff23f613\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/index.js\":\"7cf80f015d65534a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks-view/prop.js\":\"3415d29a23ce4bd7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/BacklinkFilters.js\":\"a7df3295b9c3e555\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d86dcc276e5f8147\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/BlockEntry.js\":\"5336883ab41c6fea\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/LinkedReferences.js\":\"55ec8831ce04ac82\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"d6d46c36d472716f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/dailyNoteDefaults.js\":\"6157eb3f4949e3d8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/dataExtension.js\":\"35053a3828b70a59\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/edgeExclusions.js\":\"9171c575ead78d19\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/filterProperty.js\":\"5227c2a9f5df3457\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/index.js\":\"b2186d04e6fed00b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"59c2e13abc577a36\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/applies.js\":\"f320851714d5ba5d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/countQuery.js\":\"91dbc653a942cf90\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/expansionStore.js\":\"95c3e5f813bc674f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/index.js\":\"ea754980f743fd5b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3a17145cfb1f3425\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/presentationInvalidation.js\":\"77f97478631701ac\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/propertyEditorOverride.js\":\"fa902680ad087a0b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/propertyFilter.js\":\"1705e2480dd367c8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/query.js\":\"4067d9b89b385a22\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/resolveFilter.js\":\"b633c0726b787f43\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/sourceBatch.js\":\"ab4b63dc52d4d6de\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/sources.js\":\"083e09fa2d76fe8e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/useBacklinks.js\":\"7fa50cef9f73049f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"eebe68b18664f9ee\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/BirthdayCelebration.js\":\"70b056ec53f7d766\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/BirthdayOverlay.js\":\"38dcf68b1d3d8da5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/gate.js\":\"bdd7650f9c12e2f0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/index.js\":\"59aeaa00a4e72cac\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/birthday/wolfTheme.js\":\"e818cc99595c244b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/BlockDragLayer.js\":\"383ebb6266092568\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/dragController.js\":\"2fca5bd04e01d98d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/dropTarget.js\":\"2316c5a23a393825\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/index.js\":\"d722f28f7a59537e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-drag/projection.js\":\"c7b025d89dcb1535\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-info/BlockMetaCard.js\":\"57bae03828be17cf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-info/index.js\":\"ce24b49a9db7dae1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/AddTagDialog.js\":\"953082d0a6e5fc9a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"fa072afdeb96c47f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/TagNameIssueHint.js\":\"4ee9c17d74456103\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/addTagAction.js\":\"8e81a9ed5033dbcc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/appendTag.js\":\"5ee8803fffde457b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/config.js\":\"45e8ae326b24f27c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/dataExtension.js\":\"24403db4762af1f2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/index.js\":\"03258c49f84b5d99\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/block-tagging/propertyEditorOverride.js\":\"ae377e28cf3503ab\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/BreadcrumbList.js\":\"14b91bfc2452ef83\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ae6cfe9c44472cb8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/Breadcrumbs.js\":\"08e0a6a31812769e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8e8f66375372ccd3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"856e615c75393d2c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/index.js\":\"40d33032371e4a8d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f32dbfab6146d259\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/CharacterCountItem.js\":\"a24fa58945eac288\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/ProfilePropertyEditor.js\":\"86627174e30efb3e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/actions.js\":\"ed81445a3e82c52b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/blockType.js\":\"8d92bfb9a1875f9b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/charCount.js\":\"10d1463e8b58bb36\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/dataExtension.js\":\"38debdd6f4832b72\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/index.js\":\"0dee51f0285ff6b3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/profiles.js\":\"f42774eae39b4853\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/properties.js\":\"adbb44e7d9c1d7d9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/subtree.js\":\"badac25529ed41de\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/character-counter/textCounts.js\":\"861656dc1cea7195\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/colemak-keybindings/index.js\":\"e4b58d67cbdcf948\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/CommandPalette.js\":\"f24c443c0cb52adc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/HeaderItem.js\":\"4060cf4f5f75c33e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/context.js\":\"cd02e9bb65e032c3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/index.js\":\"0c31e50fbcdd17a3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/selection.js\":\"da96245070529e6f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/toggleStore.js\":\"84f28f935896f662\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/command-palette/useCommandPaletteActions.js\":\"0c767a40849865ce\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/ContributorBadges.js\":\"f321c2e026c33129\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/ProfilePicture.js\":\"f558c1c3cca39f9d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/author.js\":\"e4d2cf58f873f75d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/codeMirrorExtensions.js\":\"acda7efeed592d2b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/dataExtension.js\":\"7623c610bc7ef700\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/index.js\":\"4f898f1926055db6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/mentionAutocomplete.js\":\"ef6a9ced79bf1c10\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/processor.js\":\"36f71b5d60bf269e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/profiles.js\":\"e69c4ee942cbed88\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/queries.js\":\"8f7d67d632054008\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/schema.js\":\"cf3a2ccb31db4c34\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/contributors/useCommentAuthor.js\":\"da0fc98dc5465c9b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8ce6bdcf398ef349\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/followOrigin.js\":\"77bf8fcdd797cb7b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/index.js\":\"3a48a9cba2d8a80d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"24ccb6dc847e84cb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"efb52d8b542e5241\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/CalendarGrid.js\":\"76006bd38cfd1b79\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DailyNotePicker.js\":\"626c68077db6099b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"55e98d71942e57ff\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DateNavDecorator.js\":\"8a2818d76f3676e2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DateScrubOverlay.js\":\"aa094cd1f7f718cc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DayPropertyControl.js\":\"2680f073ab6879f6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/DayValueReferenceControl.js\":\"97af2c4baf383434\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/HeaderItem.js\":\"8b8dc8e7f55ffebf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/ReschedulePicker.js\":\"ed6407cc903dbaa0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bda40a12cd806dc2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/actions.js\":\"175391a0ca128acf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/blockDateAdapter.js\":\"a8e50141ca321074\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/calendar.js\":\"f2abe92c20bc4d5f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dailyNotes.js\":\"715e185c99d9724d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dataExtension.js\":\"e79bdb49f7531bb9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubActions.js\":\"cbf36089ba55734f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubGesture.js\":\"4e2b631662eaee5c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubGestureActions.js\":\"9cbd826352e20bf5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dateScrubRecognizer.js\":\"13307a026bb72e7d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dayProperty.js\":\"fec384c8203b9b81\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"ef003fe95d6efca8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/deletionGuard.js\":\"13b40de668ec39a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/dueQuery.js\":\"de74948f498993ea\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/index.js\":\"fc55061fb2c7592e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/landing.js\":\"33b9646e151df703\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/localSchema.js\":\"4acc3925e123a0a3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/referenceDateAdapter.js\":\"4adb514e945155ad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/rescheduleAction.js\":\"7b37a7d40b357c10\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/schema.js\":\"c46af9d9db881367\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/spreadBlockDates.js\":\"ffd7ba6a5f1dde6f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/spreadDatesAction.js\":\"4aba6f3a68191ac1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/today.js\":\"1fbf7a25890495d3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"cd0fd3b9679b9162\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"50a181d8db6cb2d5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/audit.js\":\"16240ede6798f274\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/auditAction.js\":\"8e3dba11f3d0db89\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/auditRanges.js\":\"c5216e85cb8d42a5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/diagnosticsSource.js\":\"c2613d5693b6c200\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/divergenceScan.js\":\"76c68596df05b7ed\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/index.js\":\"6d729350c5f514b3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3028269e731f6299\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/referencesMirror.js\":\"35d04151e203ee83\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/rowJson.js\":\"65a473ec36deebbf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/schedule.js\":\"b4c7c25dfc31403f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/data-integrity/store.js\":\"c19e875cb73de171\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-maintenance/action.js\":\"4e7b0530236efa3a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-maintenance/index.js\":\"0b700866fbd00837\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-maintenance/plugin.js\":\"e6356c7b312e02d4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5f4634ebca1331b2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/actions.js\":\"08fd4b4a22caae06\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/changeMarker.js\":\"ec20ce41ea3fc46a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/diagnostics.js\":\"470f4abcebe968d1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/fileSystemAccess.js\":\"5cf19871beb4ab16\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/filenames.js\":\"a75e4ef7589acb7a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/index.js\":\"3c12653c51709aca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/mirror.js\":\"2e3eb4a0366235f0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/runLock.js\":\"4ef91b066c659836\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/runtimeHealth.js\":\"0583cde78b8340ba\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/schedule.js\":\"cb03347e2298aa6c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/db-mirror/store.js\":\"ed36cd374c5d07d7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/default-themes/index.js\":\"c8fac31dc2fa410b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/default-themes/themes.js\":\"a724976fc8e98206\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/diagnostics/facet.js\":\"c46652cb04d50f56\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/diagnostics/useDiagnostics.js\":\"8026ecfec28bf089\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/dismissals.js\":\"48bcb01340b572da\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/index.js\":\"e0e9045941be3c43\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/status.js\":\"1614ce8586614f9b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extension-prompts/store.js\":\"1843d185ae1d3dca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"494f2f3e9eba82af\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/ExtensionsSettings.js\":\"947cf41c114aec7b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/actions.js\":\"2cdd0573d97cccb8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/config.js\":\"4ae8a41125d8bb7b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/dataExtension.js\":\"07f96bd65a994377\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/effect.js\":\"c94ade24c7731521\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/index.js\":\"9f70c4bffb39aaea\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/propertyEditorOverride.js\":\"d2b9884d8a7e619f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extensions-settings/useToggleTree.js\":\"17d73b4b6847cb3e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/ExtractTypeDialog.js\":\"a3dc2a08ab559b26\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"a60bdf49c27af537\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/PropertyShapePicker.js\":\"9893c356c34c18ef\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/action.js\":\"141f8459d1e9c810\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/extract-type/index.js\":\"caf7679474f906f7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/FindReplaceDialog.js\":\"f0375ff79be18ece\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/HeaderItem.js\":\"dc38e97786c65d0c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/dataExtension.js\":\"0443ad2685b03f9e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/index.js\":\"8413b98887008175\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/search.js\":\"cdbb41069e424944\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/toggleStore.js\":\"d8e2db6a36318f29\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/LocationPropertyEditor.js\":\"c8b470109f8feab8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/MapView.js\":\"82895910ed5487b0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/blockTypes.js\":\"5f20cbb3588a5975\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/codeMirrorExtensions.js\":\"87e7188d2451bcc0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/createOrFindPlace.js\":\"d7fe39b13bf6e83a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/currentLocation.js\":\"cc0112520b35e00e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/dataExtension.js\":\"e8a29f32322656dd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/geoContentDecorator.js\":\"6d1663e550432208\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/googlePlacesClient.js\":\"c3b0fc94d416ee5d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/index.js\":\"3d745cbd7caaf53f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/locationsPage.js\":\"f5180edba2b06559\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/mapViewport.js\":\"0fee00b926be3b77\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/pickCurrentLocation.js\":\"14bb713177c52622\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/placeAutocomplete.js\":\"cebd739633570c67\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/placeNameCollision.js\":\"12ce7dbedc08a31d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/properties.js\":\"bad2a2de28e8c00f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/propertyEditorOverrides.js\":\"aac9cb163e985539\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/query.js\":\"b33368cf152f7f62\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/geo/usePlaceSearch.js\":\"ac1c557338987908\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"b6b0c4152cd85302\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"95c939c9a2b115f0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e133ee9342cf4497\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/config.js\":\"518cac2e063a40e0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/dataExtension.js\":\"091df65825309138\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/facet.js\":\"e6c1496b6c31b50b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/grouping.js\":\"523ed94b5b983d0b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/index.js\":\"888db0835723f1d8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"c236c80b8d97cd28\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/query.js\":\"8f0ecc162516fe70\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/resolveConfig.js\":\"3b7ad42e6771f4d7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9231550d20e20164\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4f45c224d7e4af6e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/HtmlDocumentContent.js\":\"a6b215d522c06883\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/HtmlFrame.js\":\"69c7f137be677151\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/actions.js\":\"5d209cf435ecfb6c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/blockType.js\":\"98eb8ec838b6237b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/confirmRunScripts.js\":\"6b233a1f929fde6e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/dataExtension.js\":\"87fe752086c0e666\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/frameAnnotations.js\":\"c5ac54d1933a9e72\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/frameDocument.js\":\"e1ebf52e6a60988b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/frameTheme.js\":\"f814952d13e9c444\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/index.js\":\"9500d78173d94658\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/scriptConsent.js\":\"0646955ccb09f169\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/sourceMap.js\":\"c6320b32088ea8a6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/html-document/useDocumentScripts.js\":\"8d0b609a5d174c9a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/index.js\":\"2d2caee8746cec45\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/record.js\":\"07013bf52762697e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/recordStore.js\":\"92f80790116a5e01\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/responsiveness.js\":\"93fbed2b4867bb95\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/schedule.js\":\"fcf8d3db75556d41\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/interaction-metrics/sessionContext.js\":\"daa5b212ac6de272\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"239bc4ee43653346\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f79d96d0abb4f180\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/actions.js\":\"9fee92b19e53bf1f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/config.js\":\"e7df6990d71d0a13\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/dataExtension.js\":\"6559a5726f33996d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/effect.js\":\"abc2eeaba1786186\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/index.js\":\"83c203804227696a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/keyCapture.js\":\"74c480cc740ea10f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/overrideStore.js\":\"2b204e3b6106c7f0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"48d9065d41132c81\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/HeaderItem.js\":\"d2012b893eb4f7fa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/LeftSidebar.js\":\"c2fd75ee1608a7da\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/actions.js\":\"a1313b82ed3af2b0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/facet.js\":\"944c28db9051086b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/index.js\":\"3cfa526cb6170391\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/shortcuts.js\":\"8107b840c45486c8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/left-sidebar/toggleStore.js\":\"8660e108a0b6e665\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/MergePicker.js\":\"38fc7e3f92a74fee\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/index.js\":\"63cda860755ce06c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/mergeAction.js\":\"51a1cfefa6d285fd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/merge-blocks/strategy.js\":\"bff531aa833f49b8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/Button.js\":\"812064e1a53e0ed9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"02aac0eab89a823c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4d39f907796a7088\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/facet.js\":\"f891c4b8d9eb249c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-bottom-nav/index.js\":\"d3deff73a7cfbb35\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"be61141862a60e54\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/actions.js\":\"b34d69f23c5c0b5f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"051228253756ac04\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/facet.js\":\"277dc61dfc54f073\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/mobile-keyboard-toolbar/index.js\":\"14961ac755edf52f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3960ac50432c4b73\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/blockSubtreeMembership.js\":\"62feda1679dca655\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/contextMenuItem.js\":\"9d761af49c63ff00\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/index.js\":\"9f86a6db411c6989\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/moveAction.js\":\"6a79e49f11683e8b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/moveBlocks.js\":\"80585c47f3c7a279\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/move-blocks/selectionAfterMove.js\":\"e279b5322aefe623\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/TutorialBanner.js\":\"1bb57c09e21ff69e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/action.js\":\"e0ad4ad16d7396ba\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/bannerDismissal.js\":\"2bce58cdb48682b9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/documents/cheatSheet.js\":\"6424391136c40d10\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/index.js\":\"ff71998c3890d59e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/keys.js\":\"a7f365295f3f0d9a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/landing.js\":\"a091be270f289ac4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/outline.js\":\"8fe864f6f5afdc43\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/onboarding/seed.js\":\"d91117521ab67cdd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/PerfTrendDialog.js\":\"332d80205b412a97\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/analyze.js\":\"84917d7ebc38c601\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/diagnosticsSource.js\":\"d405bc1921312a61\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/index.js\":\"f51cb4b03e7e8295\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/load.js\":\"dcf97bbcf2ec80ed\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/monitorRun.js\":\"9664992c941ca8b1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/schedule.js\":\"6f0edf396bd273b3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/series.js\":\"ce73e21db46cfffb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/store.js\":\"ebf64a98130b397a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/trendAction.js\":\"ea224d172d9f7813\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/perf-monitor/verdict.js\":\"578e0870e90400f0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/plain-outliner/clickToEditAction.js\":\"ac6e52cd9f7973dd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/plain-outliner/index.js\":\"6527a3c4e7a681c4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/plain-outliner/interactions.js\":\"6847f25dd089c502\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"cb6d06d0cf6793af\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/MigrationGate.js\":\"893b8ae7e0837e60\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/MigrationGateDialog.js\":\"90c2883761e9e26f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/action.js\":\"93c3bbe2c09752ad\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/index.js\":\"47963f6136ba2198\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/localRunMessage.js\":\"0b4dc6688564bc5c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/plugin.js\":\"75258b294e9c6460\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/progressReport.js\":\"9315192d5cc6e87a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/properties-migration/sweepProgress.js\":\"be8416bc038dae6c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/FieldRowRenderer.js\":\"9f1fba2e2d4a5e01\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/ValueRowRenderer.js\":\"21efb5c08289b97a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/actions.js\":\"f35eb1c45a1c74cd\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/autocomplete.js\":\"28e807cf05e0ffc8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/fieldRow.js\":\"69c273bd6ca39520\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/index.js\":\"e47973651ef5f370\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/referenceWarning.js\":\"12e4b642f74a841d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/valueAutocomplete.js\":\"03e17b5c1ced82c3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/property-rows/valueSchema.js\":\"a83febe008025ad4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/HeaderItem.js\":\"74a5742708498551\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/QuickFind.js\":\"ce5b5114c064011f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/index.js\":\"396a3d6ea5c3a4d7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/recents.js\":\"f72b0b58f0ea6d44\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/resultItems.js\":\"f01f15ba997f360e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/selection.js\":\"c705e5eaebc1ae68\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/quick-find/toggleStore.js\":\"8b7b156690f81a2f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/HeaderItem.js\":\"9740076f94dcc46e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/RecentsPageBlockRenderer.js\":\"053d33059b40a76f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/grouping.js\":\"1ea0f72898e19942\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/index.js\":\"3593e08327b56921\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/recents/target.js\":\"3df784b76fe0e7e1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/codeMirrorExtensions.js\":\"99a4e8df364cacf1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/contentPrefill.js\":\"e7bb1e426df28c50\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/dataExtension.js\":\"7d0a9e0f3659b6fb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/index.js\":\"6fa1369d075c44f2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"bc238ee318db7eef\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/invalidation.js\":\"f3ea293dc973faa2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/localSchema.js\":\"1d001aa81098f7cb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/blockrefs/index.js\":\"87faaa962d22bdd8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8e35cb0a25631195\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/index.js\":\"cb7b5a7bb420dd52\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/referenceNode.js\":\"8a594b426235fd7f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/remark-reference-occurrences.js\":\"84c3ad38b2d6ab69\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"12347bd50e688de6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/index.js\":\"a845eaa31e63b2ab\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"09bbadfee2739be6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1d9336c993c01a1b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/mergeRetargetProcessor.js\":\"99c7238f0c1b0d4b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/parseFence.js\":\"c4e368fa55255cf7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/referenceParser.js\":\"581a384ad5bf2983\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/referenceProjection.js\":\"6ac32a9cc9b218b6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/referencesProcessor.js\":\"c7bc4fbef0a87ce1\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/renameProcessor.js\":\"edcdc1c630c85ba2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/references/spanReplacement.js\":\"85e1499a50ad3ee9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/htmlToOutline.js\":\"eb49c527b70c2574\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/index.js\":\"5d7dc25aa7cae8c5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5138b271adc7b68d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/rich-paste/pasteDecision.js\":\"5942937aa2b0b348\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/action.js\":\"1298487ff548f3a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/blockIds.js\":\"5da69d7627b1162b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/content.js\":\"8eac440a41cffe3b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/effect.js\":\"b5e4a07eb3933cb5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/ids.js\":\"78de2fed89b10153\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/import.js\":\"6182597b379f07a5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/index.js\":\"dd098fa11df3b400\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/plan.js\":\"ab7a162db35d2d77\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/plugin.js\":\"279f64261e08d8f5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/promotion.js\":\"ac7cbaa5788585eb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/properties.js\":\"55d6fb7e4f8af250\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/references.js\":\"c171cf512e1b5044\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/report.js\":\"b96d70693f80eeee\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/roamMemo.js\":\"a59765f7ae75d97e\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/runtime.js\":\"444223d86801fe02\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/schemaReconciliation.js\":\"cd48364c1fac10e9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/srsMarkers.js\":\"95faf727abefadb9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/todo.js\":\"3e70ba870532407a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/typeCandidates.js\":\"711fde0266bdf7af\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/roam-import/types.js\":\"1f06d812e622d24a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/search-health/index.js\":\"f6b549a75df752e9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/search-health/store.js\":\"88a7b4e1b43771a5\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/HeaderItem.js\":\"f7829e890b26da38\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0035de0c7d4495ae\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/index.js\":\"7d7b9dffeb897963\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/model.js\":\"516e8189dfe7128c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/toggleStore.js\":\"a892b53ca763d366\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/shortcut-help/useKeyInspector.js\":\"71766c84f598f13a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5093a25b923d7cd6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/ShellDecorator.js\":\"4600312e82c40c39\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/actions.js\":\"57efbe8c068f1d16\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/exclusionsFacet.js\":\"800b4f665ce51746\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/index.js\":\"b4f093fb099e8419\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/shell.js\":\"1605a6196235187c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/surface.js\":\"8dadfd241cd60255\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/spatial-navigation/walker.js\":\"99493118990509c8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/RescheduleToast.js\":\"789a5775f810b47f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/dataExtension.js\":\"5df9360e56ddbcca\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/index.js\":\"e6782089b896f57c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/indicator.js\":\"d6fef7bb0ac51a7b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/moveSrsState.js\":\"d83bb4578f4a54e4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2b1e5f56b62ca436\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/scheduler.js\":\"79c11a1aa935968b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/schema.js\":\"76e5bc3444d7a854\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8d07ed89d2c5b9ba\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/srsClipboard.js\":\"0598e2a706994215\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"cbec2f6447c79594\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f6e1715e4335bae6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/DeckPicker.js\":\"bcf00cbd1ed482bf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/ReviewControls.js\":\"67d4e4e22f3ab3c2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e57dc33274b22d06\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/ReviewSession.js\":\"461ca336910a69a0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/actions.js\":\"9f0ea123fba14d35\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/archive.js\":\"8cfb7a358dc2c33b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/dataExtension.js\":\"bc8cdb04426c7991\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/deck.js\":\"6e8f51cfe5de3e14\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/dueQuery.js\":\"04377a7e00175a81\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/gradeDecision.js\":\"392315d51578df8a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/index.js\":\"b8722ede92b12091\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/keyHints.js\":\"f2eab41d4d1125a2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/reviewCardLayout.js\":\"b559641342a9475d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/reviewProgress.js\":\"3e6cee942b15e384\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/schema.js\":\"eca0ea8e8595ddfc\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/srs-review/useDueCards.js\":\"6164b66d9319fc00\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/startup-metrics/index.js\":\"110666d5fdacac9f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/startup-metrics/record.js\":\"e9dda6fdf9708782\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/storage-persistence/index.js\":\"7bcf21353869dfd6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/storage-persistence/persistenceStatus.js\":\"0dba49b9e8d9c434\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/storage-persistence/requestAction.js\":\"9d2daf7326c340ee\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/TypeChipsDecorator.js\":\"71a9f4922caac7da\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/codeMirrorExtensions.js\":\"f9bc51b12ba65549\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/index.js\":\"cd9693ac3fa28933\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/supertags/typeAutocomplete.js\":\"0f7162f5666ad68c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"5b26e58f611dd2e2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/actions.js\":\"ba98bc1eafec5be0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/anchor.js\":\"46f73175a8571214\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/events.js\":\"78da36f8c235e2ae\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/gestureActions.js\":\"68961318ed539805\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/index.js\":\"27c4b6ce907f8e77\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"98e0e58cab6788d3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/sync-metrics/collect.js\":\"c2aba198bb52217a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/sync-metrics/index.js\":\"4f3b793b6a8b4890\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/sync-metrics/record.js\":\"8bce50cfe23a20c4\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/RejectionDialog.js\":\"89cf53cd3d4331d2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/SystemStatusHeaderItem.js\":\"af0e20b7acdb7daa\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/index.js\":\"157c26dcffcf73f0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/model.js\":\"27eee60036ba1c7b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/queueCounts.js\":\"65c498986090f004\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/rejectedHelpers.js\":\"f3df981d47393459\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/rematerializeAction.js\":\"10f71102c2aebbe9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/system-status/useHysteresis.js\":\"dec564d1127f63fe\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/ColumnHeaders.js\":\"8c2848bd2ad2de39\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/QueryUi.js\":\"464b3b0eb0ad512a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/TableLayout.js\":\"eab9e27a7ef47aaf\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/actions.js\":\"321c92a5a239a772\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/cellEdits.js\":\"036359757598622a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/childrenViews.js\":\"0bb0c00904ee88e6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/columns.js\":\"7590d2095c0fc4ba\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/controller.js\":\"b6609df278f4726a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/convert.js\":\"7e6b7a7f3393c24d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/dataExtension.js\":\"68863681ffabff4f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/index.js\":\"eb0b8e5cd9f5a866\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/keys.js\":\"0754233aa9095197\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/model.js\":\"738e4a55c2b86278\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/QueryText.js\":\"18ea95c0ceb889ae\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/backfill.js\":\"94d19cc7613be726\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/completion.js\":\"5643a7d202af5aed\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/format.js\":\"dc75c1c60ec1056a\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/parse.js\":\"91bebd706407229d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/queryValue.js\":\"03787c270140a020\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/registrations.js\":\"bd244eec696ca2a0\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/query/source.js\":\"a3621cce0ce7243b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/registry.js\":\"75cd8d80c7af5267\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/rowGutter.js\":\"9cbf7a5d9b034078\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/rowVerbs.js\":\"5ecbcf743de0da31\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/schema.js\":\"b9489b767469a30f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/tables/sort.js\":\"5539100cfb1eb146\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/theme-toggle/effect.js\":\"5583e9c440448e9b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/theme-toggle/index.js\":\"7cb44ab367496533\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/theme-toggle/theme.js\":\"df1deba106f75253\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/actions.js\":\"7ad7bc58fa987401\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/dataExtension.js\":\"f74de6347c1a5dc6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/index.js\":\"30fe78b1f4ed5e2b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/todo/schema.js\":\"84be4b340b2bd793\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/TouchSelectionLayer.js\":\"6184ef8d619621ce\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/actions.js\":\"b12ff0e430d6c209\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/defaultItems.js\":\"5f51425e74d05fb9\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/facet.js\":\"0d8812916368f46b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/holdRecognizer.js\":\"9f3b5ed55e88eb17\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/touch-selection/index.js\":\"176b5db2781a8560\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/update-indicator/UpdateIndicator.js\":\"ba2003294ed4acd7\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/update-indicator/index.js\":\"ed43437c311fcf18\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/update-indicator/loadTimes.js\":\"8b9816bca78abcb2\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/VideoNotesRenderer.js\":\"d43314a01e81222d\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/VideoPlayerRenderer.js\":\"04cc204bedf1a1c6\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/VideoTimeStamp.js\":\"fe2247e4ac2bee59\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/actions.js\":\"83191c6c620a4852\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/index.js\":\"cfe6972053189d06\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/markdown.js\":\"bff4db60d1c23ec3\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/notes.js\":\"ea5c6d539a8d6a01\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/registry.js\":\"4eba86e474f55f65\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/remark-timestamps.js\":\"8d25f9e217974b0b\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/video-player/view.js\":\"39a3c6d764d92cf8\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/LinkHints.js\":\"8cee8c8247aab91f\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/index.js\":\"d94dde99eb5f4437\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/model.js\":\"3f49403c3dc34422\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-link-hints/settings.js\":\"4996fce750c6f536\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-normal-mode/actions.js\":\"4a21c127799c678c\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-normal-mode/index.js\":\"545cbcd450dff586\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/vim-normal-mode/interactions.js\":\"0958cd9068d029eb\",\"/knowledge-medium/pr-preview/pr-1910/src/plugins/workspace-header/index.js\":\"67830a9ee8dd3fd3\",\"/knowledge-medium/pr-preview/pr-1910/src/registerServiceWorker.js\":\"08a58f73f900ffd7\",\"/knowledge-medium/pr-preview/pr-1910/src/requestPersistentStorage.js\":\"b2c2614d1c260795\",\"/knowledge-medium/pr-preview/pr-1910/src/services/authRequestDeadline.js\":\"b62ecad0bdbc9f09\",\"/knowledge-medium/pr-preview/pr-1910/src/services/authStorage.js\":\"a6f219014a05325e\",\"/knowledge-medium/pr-preview/pr-1910/src/services/powersync.js\":\"567510307f4232c3\",\"/knowledge-medium/pr-preview/pr-1910/src/services/supabase.js\":\"3f0bd23ee3db577e\",\"/knowledge-medium/pr-preview/pr-1910/src/services/uploadErrorClassifier.js\":\"c564eaabdf77a3af\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/ActiveContexts.js\":\"f6bbecb4faec8831\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/HotkeyReconciler.js\":\"14ff8da80ab611c8\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/WipeLocalDataDialog.js\":\"34c31b143dd4dae9\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/actionDispatch.js\":\"f33aa5a4874049a6\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/actionRefItems.js\":\"3f8c11063d9a9a3c\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/applyKeybindingOverrides.js\":\"3f3e0162fac17c55\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/blockActions.js\":\"7e81d0d308f9b3d3\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/blockMergeGesture.js\":\"7d36a3ba4a253cdf\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/canonicalizeChord.js\":\"10ff004eb3c8ae46\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/defaultContexts.js\":\"b6faa3df861ede88\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/defaultShortcuts.js\":\"0b718d4b9a0bd53c\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/effectiveActions.js\":\"fd81841b5bc3ee77\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/gestureAction.js\":\"17eaff41e8fe3f3a\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/gestureBinding.js\":\"17852faa417f4a86\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/holdRegistry.js\":\"a144ca7cb394ea7b\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/keybindingConflicts.js\":\"9949d982203ec1d4\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/keybindingOverrides.js\":\"14ed728907a83c52\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/pointerAction.js\":\"18979de5d6052520\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/resolve.js\":\"a609fbaddbe35425\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/runAction.js\":\"1bf324fed7c4234a\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/sequenceMatcher.js\":\"168d90cfcf0d27c0\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/types.js\":\"eb022e07a239a883\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/useActionContext.js\":\"a989a53aad42c21e\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/useActionDiscovery.js\":\"819229dc0b294b77\",\"/knowledge-medium/pr-preview/pr-1910/src/shortcuts/utils.js\":\"58cd51af8f4af761\",\"/knowledge-medium/pr-preview/pr-1910/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1910/src/sw/bootStore.js\":\"8788c934cf1a1a47\",\"/knowledge-medium/pr-preview/pr-1910/src/sw/previewDatabases.js\":\"a47d01d9560e9ef2\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/byteTransform.js\":\"ff1a542408d8717f\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/attachmentCleaner.js\":\"b0b6e23372306942\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/attachmentParts.js\":\"9e1e1cf41d422dde\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/bundleParts.js\":\"c00427f201d86331\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/bundleRecord.js\":\"6553c032a70cf43e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/manifest.js\":\"e9ee3af5cb7da831\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/takeBundle.js\":\"f6b3815b2aa51b26\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/bundle/verifyBundle.js\":\"ece3aa144d0a9de5\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/cleaningStage.js\":\"d22189e6f0fbcb51\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/conversionKey.js\":\"4fb22d135c5d3c5e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/conversionServer.js\":\"3208c42c440dd488\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/flip.js\":\"d0891e6a15b28df5\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/flipAttempts.js\":\"2fc7427f1946c922\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/pages.js\":\"938d0ed7a1d530df\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/preflight.js\":\"cc63e7be485173d2\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/reseal.js\":\"3cda59ae2c3bf94a\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/runConversion.js\":\"7f9f678e6d638df9\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/runLock.js\":\"a13c9a85797a9ac5\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/sealing.js\":\"db9861e20a75e878\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/sealingStage.js\":\"36b428c2d491d73e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/stage.js\":\"2469d2a3dba3a06d\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/conversion/verifyReseal.js\":\"2610a8c64a75be01\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/aad.js\":\"fd7735f931066085\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/aead.js\":\"86c75a7046c298af\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/base32.js\":\"99748c607ee56d8c\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/base64url.js\":\"200a8f9c71d71741\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/binaryEnvelope.js\":\"77ba79e104cd626a\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/byteAead.js\":\"d5442371423f75ad\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/canary.js\":\"f48d8cfaa3e81e8d\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/contentHash.js\":\"466b2651459bf57e\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/contentKey.js\":\"23e407a56f83889d\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/derivedIdNamespace.js\":\"84cbffa10d128018\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/envelope.js\":\"f904003c34298f35\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/hex.js\":\"6121cd6e917bfc6b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/sha256Hex.js\":\"5d54d1f631a587ad\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/crypto/workspaceKey.js\":\"0b40b84a60f25b5b\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/conversionState.js\":\"4a0a0594299c51f1\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/createEncryptedWorkspace.js\":\"340229ccaaaa8105\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/pastedKey.js\":\"99ab1e59cf062f08\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3724c8737ee18794\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e4fb1312ef6f2c14\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/keyStore.js\":\"016eb42f57f9797d\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/mintWorkspaceKey.js\":\"b15bc89b05a7d743\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/modePin.js\":\"71c7bd641ac6a3ec\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/openWorkspaceKeys.js\":\"8878d8e9d1eb8f86\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/resolveWorkspaceEntry.js\":\"77a92a20da700eb8\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/resolver.js\":\"d5ed4c79958909f6\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/keys/workspaceAccess.js\":\"ee3571ba6ff71aa1\",\"/knowledge-medium/pr-preview/pr-1910/src/sync/transform.js\":\"18b4508384bea039\",\"/knowledge-medium/pr-preview/pr-1910/src/themeBootDefaults.js\":\"c87319b6ffaf8a5b\",\"/knowledge-medium/pr-preview/pr-1910/src/types.js\":\"d6aa075623c044d1\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/ClientLocalSettings.js\":\"34c03e36d2b6a5ac\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/abortableSleep.js\":\"9fe2b860e4ef6bbb\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/array.js\":\"f7468190c840cfb3\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/backlinkAutocomplete.js\":\"c9b7b4441bb05601\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/blockCrumbs.js\":\"2eedca85c7908ad1\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/blockrefAutocomplete.js\":\"512242e44f7da43b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/cadencedIdleJob.js\":\"a79065857c5c30be\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/callbackSet.js\":\"75db041d2cf73e41\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/clientId.js\":\"704867e89d76d7e1\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/codemirror.js\":\"55d4a440b5169aae\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/codemirrorCompletion.js\":\"14f7a04c3fee149b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/copy.js\":\"5737674453cfa107\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dailyPage.js\":\"b5f76a4a279c1edd\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dbForensics.js\":\"c932933812d640f5\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dbForensicsHooks.js\":\"be3f37f318a47c0d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/deleteBlockThroughUi.js\":\"face3a0f5eb344cd\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dialogs.js\":\"16ec15db51306266\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/dom.js\":\"eca7fc5d18cfcbbb\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/downloadBlob.js\":\"8ce7b92c5dc7da23\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/drawnWalk.js\":\"38520fe85da3f5dc\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/exportSqliteDb.js\":\"0169641c5c93477b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/fileSystemAccess.js\":\"04bab742bf795efa\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/flipSlide.js\":\"1ff21ed8e42018d4\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/fnv1a.js\":\"13506ca9feaf98a5\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/formatBytes.js\":\"e67edd7b4758d3a2\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/fuzzyRank.js\":\"719997104acc341c\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/idbKeyedStore.js\":\"7184d3322625d27b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/idleCallbackPolyfill.js\":\"f9925f0eff5fdcbc\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/keyboardAwareScroll.js\":\"85af2931a6427e2d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/keyboardViewport.js\":\"9754c79216405af7\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/lastWorkspace.js\":\"dd9e54d1a1df34fe\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/layoutColumns.js\":\"45779169215f6f43\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/layoutSessionDom.js\":\"fb944cd8e23ebcd0\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/layoutSessionId.js\":\"fd58a7524897aaa6\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/linkClickGestures.js\":\"d489467374996a0b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/linkTargetAutocomplete.js\":\"4b8c7fe600661100\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/localDbCorruption.js\":\"ae3ec27e8871d3a6\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/localDbRecovery.js\":\"13a27d787e8bab6b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/markdownParser.js\":\"84ddef396bc8997a\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/memoize.js\":\"71994cbf6d83e046\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/nameFieldCommit.js\":\"e542b1d84506a92b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/nameList.js\":\"adfa96d64aa6495d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/navigation.js\":\"2490c645bdc29a5e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/omnilinerNamespace.js\":\"01de76ae0dd70d93\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/opfsPageScan.js\":\"6569d70435522cc2\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelClearance.js\":\"90272b4713c3495e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelHistory.js\":\"4bc5e24c0f9c063a\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelLanes.js\":\"7af33d78400e767f\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelLayoutProjection.js\":\"ded54e5cd1e18858\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelScrollAnchor.js\":\"182ac5a5d74a8159\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/panelUrlFlags.js\":\"fe2d137c4dd8893e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/platform.js\":\"ce1a0d4bb1823dce\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/pluralize.js\":\"20d179140ae86553\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/propertyCreation.js\":\"1df79c4cb19963c2\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/propertyNavigation.js\":\"abb7db6d1c1c81ee\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/propertyValueContext.js\":\"b815d4d7184560c6\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/react.js\":\"fda706d787b78cbe\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/relativeDate.js\":\"25ed0f7a296eb3fc\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/relativeTime.js\":\"97188ba18a34bbad\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/renderScope.js\":\"f3413cf5b6857f7e\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/resolvedThenable.js\":\"df7823d600405d11\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/routing.js\":\"3f41db8a274204d0\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/safeMode.js\":\"30de5eebf9c63c5a\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/scheduleIdle.js\":\"c15e164d59ca4e10\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/screenWakeLock.js\":\"01e8f252c30c0915\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/selection.js\":\"b0349ce80867e923\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/softKeyboardGrab.js\":\"f9b206127fb9d1b9\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/startupTimeline.js\":\"4ffc18a579a38a93\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/state.js\":\"35722bed1d3d5df7\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/string.js\":\"6b70b96914e19624\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/surfaceZoom.js\":\"af2a5c1ac36f865f\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/time.js\":\"7938d0d67483ca81\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/toast.js\":\"dcef352d2130a72b\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/toggleStore.js\":\"96c2dc5d495d8322\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/untilStopped.js\":\"eb7ba2ed4d0936dc\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/userActivity.js\":\"5aa9361f47c9b1da\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/viewTransition.js\":\"10d2d1e28f482fde\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/viewport.js\":\"fc7d5cd6ebd9207d\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/webLock.js\":\"9a51dafa6abacecc\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/workspaceRecovery.js\":\"2d92e2134f3353e2\",\"/knowledge-medium/pr-preview/pr-1910/src/utils/workspaceSnapshotStore.js\":\"ae1dbc29a37e7b7e\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-compiler-runtime.js\":\"5aff05e6de4c2855\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-client.js\":\"f81a3983b4f52edc\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-server-edge.js\":\"8e7b4255ae092b4c\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-server.js\":\"ec7bbe2c16503d05\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-static-edge.js\":\"2b750dbd7166d3dc\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-static.js\":\"4df21c34c78c76ba\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom-test-utils.js\":\"ce682f3b586a2c51\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-dom.js\":\"cbc02743a043f89a\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react-jsx-runtime.js\":\"e846cb0740f1189a\",\"/knowledge-medium/pr-preview/pr-1910/src/vendor/react.js\":\"f34bd88234672ede\",\"/knowledge-medium/pr-preview/pr-1910/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1910/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1910/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
