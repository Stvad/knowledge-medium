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
		buildId: "b8f9eabc43e2-aacd3016",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1911/\":\"da87277fec480d60\",\"/knowledge-medium/pr-preview/pr-1911/index.html\":\"da87277fec480d60\",\"/knowledge-medium/pr-preview/pr-1911/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1911/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1911/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1911/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1911/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1911/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1911/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1911/assets/FacadeVFS-DDPpiBH6.js\":\"66137dca2d28c6fc\",\"/knowledge-medium/pr-preview/pr-1911/assets/OPFSCoopSyncVFS-BRqjpT-8.js\":\"93125017fb0b44fe\",\"/knowledge-medium/pr-preview/pr-1911/assets/OPFSWriteAheadVFS-Vv1Buh2u.js\":\"074f504e0a7e4221\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-C1QtU6F6.js\":\"c117472a9a28a7dd\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-async-DYIs45a_.js\":\"c3d3ec2341b9d81c\",\"/knowledge-medium/pr-preview/pr-1911/assets/worker-DthS8fUD.js\":\"b57b5cde39584cc0\",\"/knowledge-medium/pr-preview/pr-1911/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1911/chunks/app-65YW1UUl.js\":\"61f9c72ada3bddd6\",\"/knowledge-medium/pr-preview/pr-1911/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1911/index.js\":\"05fe9318811fb427\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1911/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1911/assets/AccessHandlePoolVFS-YxrvLNzn.js\":\"7e2b09a526ec8550\",\"/knowledge-medium/pr-preview/pr-1911/assets/IDBBatchAtomicVFS-DA3h_1jv.js\":\"73a724999ad03d9f\",\"/knowledge-medium/pr-preview/pr-1911/assets/MemoryVFS-Dmi06P4u.js\":\"ca7d8a756747edd8\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-BeRVHdbm.js\":\"67b3226de41b65f3\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-async-6OJ34hPF.js\":\"7565094b49d981ca\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1911/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1911/chunks/AccessHandlePoolVFS-UlJzYAyw.js\":\"8d1512e9e339a354\",\"/knowledge-medium/pr-preview/pr-1911/chunks/FacadeVFS-UOoCPInM.js\":\"dc4843b5d80fce56\",\"/knowledge-medium/pr-preview/pr-1911/chunks/IDBBatchAtomicVFS-CfbocGJL.js\":\"721cf81acf841606\",\"/knowledge-medium/pr-preview/pr-1911/chunks/MemoryVFS-D3HdNYb5.js\":\"f003a9fee6d7dcd3\",\"/knowledge-medium/pr-preview/pr-1911/chunks/OPFSCoopSyncVFS-BYfUkqfj.js\":\"dbd6a98ba23606bc\",\"/knowledge-medium/pr-preview/pr-1911/chunks/OPFSWriteAheadVFS-DDGDKETM.js\":\"84f4f160a6ebe0c9\",\"/knowledge-medium/pr-preview/pr-1911/chunks/Preview-DT-TbOGW.js\":\"97d84c04b85a94bf\",\"/knowledge-medium/pr-preview/pr-1911/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1911/chunks/card-BJV7ApRy.js\":\"b1f96b87e51b2053\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dist-DMZB0P1S.js\":\"ae0667aff3540da2\",\"/knowledge-medium/pr-preview/pr-1911/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1911/chunks/mc-wa-sqlite-aJ_EL5Na.js\":\"ddfc87b9c2549b59\",\"/knowledge-medium/pr-preview/pr-1911/chunks/mc-wa-sqlite-async-CkiEWOxA.js\":\"1e6da89155dc0b9a\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-BKI3qod0.js\":\"06c7bbc4f2525ceb\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-Bfl1rDyG.js\":\"df7c1227f50fe564\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-BzHw4mii.js\":\"fd4930ded4ded54b\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-CQs4ED1G.js\":\"c91fa5c4d97f94ad\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-CRp_KG9g.js\":\"0a8e608ec4986c3b\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-Cd0USlvW.js\":\"20c69cd428e7d898\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-DaMIXqDR.js\":\"07f8df26575b0bf9\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-dom-server-legacy.browser.production-ULO8xa9A.js\":\"fdceb1342f27dec1\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-dom-server.browser.production-DPKKi8zR.js\":\"807606486b790a8b\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-dom-server.edge.production-CVznErG6.js\":\"848c1372f719ebea\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-zmqm-Xdt.js\":\"275486931235ae40\",\"/knowledge-medium/pr-preview/pr-1911/chunks/server.browser-CF8eF617.js\":\"f7078f71bcd2422b\",\"/knowledge-medium/pr-preview/pr-1911/chunks/textarea-CAiHzeng.js\":\"8b88ecc3a42990db\",\"/knowledge-medium/pr-preview/pr-1911/chunks/ui-Djpn58pJ.js\":\"fb0eddf4dc861bf7\",\"/knowledge-medium/pr-preview/pr-1911/chunks/wa-sqlite-DAihVJhn.js\":\"e20843c5a8e46d80\",\"/knowledge-medium/pr-preview/pr-1911/chunks/wa-sqlite-async-bH-bXAXZ.js\":\"323a2ef51c9d4e9e\",\"/knowledge-medium/pr-preview/pr-1911/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1911/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1911/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1911/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1911/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1911/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1911/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1911/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1911/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1911/src/App.js\":\"c7d3b8d2209645ff\",\"/knowledge-medium/pr-preview/pr-1911/src/appUpdate.js\":\"d3a3fff59525eb3b\",\"/knowledge-medium/pr-preview/pr-1911/src/appVersion.js\":\"adf29a478453aab1\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/initialLayout.js\":\"dc4c3272fb995e6d\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/openWorkspaceData.js\":\"2cf5194c26a5851e\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/resolveWorkspace.js\":\"1b3ac705ebbe6b1a\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/workspaceBootstrap.js\":\"9acdf3f4c821d7ae\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockComponent.js\":\"2d33d17c1934a2d4\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockCrumbs.js\":\"7537524771be71b3\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockEditor.js\":\"72dd16ca35208aeb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockLoadingPlaceholder.js\":\"5d207e445e175e72\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockProperties.js\":\"219d94df44aaccb2\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockSearchPicker.js\":\"7c45d9fa0054d8b7\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ConfirmBulkDeleteDialog.js\":\"52f4f062ef439fe4\",\"/knowledge-medium/pr-preview/pr-1911/src/components/DividerHandle.js\":\"a6ec6236581c8a3c\",\"/knowledge-medium/pr-preview/pr-1911/src/components/DraftEditor.js\":\"6fd45749ce3f4f27\",\"/knowledge-medium/pr-preview/pr-1911/src/components/GutterPill.js\":\"6e6468971867ee98\",\"/knowledge-medium/pr-preview/pr-1911/src/components/Header.js\":\"5c8b5e235111c7d5\",\"/knowledge-medium/pr-preview/pr-1911/src/components/LazyBlockComponent.js\":\"2148b2ab411ee73b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/Login.js\":\"7c42dbf82d612493\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ZoomableSurface.js\":\"0b3772a35fe2b634\",\"/knowledge-medium/pr-preview/pr-1911/src/components/editModeKeepalive.js\":\"a609c7803ac7d87a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyDisplay/PropertyDisplayScope.js\":\"ae810eb4bebb7490\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"3960e9fa5d8319fb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/RefPropertyEditor.js\":\"d9c703662281ca4a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/RefTargetTypePicker.js\":\"48d950c8440de30d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/SelectPropertyEditor.js\":\"ab497d0b899c2afb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/TypesPropertyEditor.js\":\"37e8cd82a2f7b4af\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/defaults.js\":\"fe0f24e25f5b5ff4\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/kernelValuePresets.js\":\"55973a62df3b2081\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/selectablePresets.js\":\"678f6e4c269db126\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/typesPropertyUi.js\":\"5af98b4cb35c3bb0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/AddPropertyForm.js\":\"ea7685359110a788\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/PropertyPicker.js\":\"bd3ff5aea4e782d6\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/PropertyRow.js\":\"839885f61539af89\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/Rows.js\":\"f57611f9a765153f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/actions.js\":\"a789997248c664cf\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/declarationOnly.js\":\"f887f721ba8d9997\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/layout.js\":\"eca75ec4e5646ce9\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/model.js\":\"fd3a7476740c0162\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/shapeUi.js\":\"e08d3ad18f6b3de3\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/shapes.js\":\"db441a281f19c806\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/usePropertyEditingActivation.js\":\"57517df9f1c2460e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/visibility.js\":\"ec0f647986608db2\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanelSections.js\":\"c811da297a0e2721\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/BlockEmbed.js\":\"08e703e72fccf672\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/BlockLink.js\":\"74ebba815b4d80bf\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/BlockRef.js\":\"5f90756b2f74ce19\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/CompactReferenceLink.js\":\"c9e3bfdffaade480\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/ReferenceLink.js\":\"cb8d3ad485750880\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/cycleGuard.js\":\"f70384ebf1264d14\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/cycleGuardContext.js\":\"7cacd46956b41802\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/linkInteraction.js\":\"66aeafc35456233e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/referenceLayout.js\":\"13c832f4e776be07\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/useBlockRefAncestors.js\":\"e76310c4cf672c81\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockGutter.js\":\"fb5865babf9c179d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockInfoDialog.js\":\"82e66b1923fcfdc7\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockReadText.js\":\"9d73fd6a95ad10e7\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockTypeBlockRenderer.js\":\"2260007530675c8a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BulletHoverCard.js\":\"f22cd71348665b10\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/CodeMirrorContentRenderer.js\":\"c6eb672d58feaab8\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"fd6bad5bd9cff02b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/ColumnResizeHandles.js\":\"f8875d4af742611a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e9f6b3b3e4a6d80d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/DefaultBlockRenderer.js\":\"5b34495ea25f7122\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/LayoutRenderer.js\":\"ad7d49d928308a09\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/MarkdownContentRenderer.js\":\"90987194ca5f05c3\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/MissingDataRenderer.js\":\"96ef1de499f0b64a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/PanelRenderer.js\":\"ab05386d1ad76ff1\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/PropertySchemaBlockRenderer.js\":\"4dc92c02fdf1fbcf\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/TopLevelRenderer.js\":\"4ed1d063dc857bd9\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/blockGutterMode.js\":\"4eebc55dd6e591cd\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/blockTitleText.js\":\"590ab3412323553b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/fieldCreationKeydown.js\":\"a780e99e9eab1fec\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/layoutRootContext.js\":\"fdcd25d2e1a702e6\",\"/knowledge-medium/pr-preview/pr-1911/src/components/typeChip/TypeChip.js\":\"ca2f4aac7f5792e6\",\"/knowledge-medium/pr-preview/pr-1911/src/components/typeChip/chipStyle.js\":\"e86110fba1ed262b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/anchored-floating.js\":\"08073a1730c72aab\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/button.js\":\"3a9e21067574f8bf\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/card.js\":\"a68ca6aa109280d3\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/checkbox.js\":\"c216a2ef5debe1ba\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/collapsible.js\":\"0b35ff83a23661de\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/command.js\":\"2288fa9df615bbd5\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/context-menu.js\":\"b0b434c584d3cb70\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/dialog.js\":\"202633636a60004d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/dropdown-menu.js\":\"79438b429f786f4f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/floating-listbox.js\":\"6b1fac0a038443a7\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/index.js\":\"0e096ea1931a50fd\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/input.js\":\"4d5f4718d1e1ac91\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/kbd.js\":\"ce26af8ce53de2bd\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/label.js\":\"1e43eb064957a16f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/textarea.js\":\"ca13db18781835a0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/useEditModeYieldKeepalive.js\":\"5d4813d62d8c0c51\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/BootFallback.js\":\"8f39986ed8f7dd13\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/FocusedRowLazyMount.js\":\"2d99d7ec2723311f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/LazyViewportMount.js\":\"0885311feeeacd30\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/LocalDbCorruptionFallback.js\":\"3f7bacc008cfd857\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/error.js\":\"40118fc0fae08530\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/lazyMountRegistry.js\":\"4e55ff0603e1e42f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/suspense.js\":\"b21c57e496c428a3\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/CreateWorkspaceDialog.js\":\"193e0fc171901335\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/PendingInvitations.js\":\"91bb5fa4e12836ba\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/SyncProgress.js\":\"2725bd66c2ca1780\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/UnlockProgress.js\":\"ba5b1fb2b5993e65\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceKeyGate.js\":\"f893be22c450f490\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceSettingsDialog.js\":\"cdbe214caef67828\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceSwitcher.js\":\"efec899b37495d08\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceSyncGate.js\":\"affe8a4981e49ada\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/ConversionFlow.js\":\"d5f1a5f1b9f082ca\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/ConversionFlowHost.js\":\"cfc031da25a10bc7\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/EncryptionSection.js\":\"c8378b4594872ad6\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/attachmentPrompts.js\":\"36e640b51eb0e2a4\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1c8caa44ee4e5d34\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/conversionFlowDeps.js\":\"178896f7c9a4e9bb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/conversionFlowStore.js\":\"2129872934299eac\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/flowUi.js\":\"e07d2d06730718fc\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/useConversionRun.js\":\"cb4cd9cd9ee89e43\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/keyUi.js\":\"53c7c92d4739bcfb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/useCloseOnKeyLoss.js\":\"1ff38a16828ae1f1\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/useCloseOnServerE2ee.js\":\"129a321b97f41eaa\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/workspaceUnlocked.js\":\"c3128bfa92a01b0b\",\"/knowledge-medium/pr-preview/pr-1911/src/context/backgroundSubtree.js\":\"ec226197a785604c\",\"/knowledge-medium/pr-preview/pr-1911/src/context/block.js\":\"ea17d0fcd0c70f7a\",\"/knowledge-medium/pr-preview/pr-1911/src/context/layoutWsContext.js\":\"96a91bdb23db028f\",\"/knowledge-medium/pr-preview/pr-1911/src/context/propertyDisplay.js\":\"9e73eac1469d45f9\",\"/knowledge-medium/pr-preview/pr-1911/src/context/repo.js\":\"9abe7a0b894480ef\",\"/knowledge-medium/pr-preview/pr-1911/src/data/aliasClaim.js\":\"f72600f7ac360b00\",\"/knowledge-medium/pr-preview/pr-1911/src/data/aliasSeatNamespace.js\":\"5505a1bc50425012\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/blockData.js\":\"83e2c4927cef0d7d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/blockType.js\":\"cedd72e3cd1a22b8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/changeScope.js\":\"2d1f506f658b11aa\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/codecs.js\":\"3eb1441db675b8c2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/derivedData.js\":\"e132ffbd7b952cdf\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/errors.js\":\"408f31b038e02a34\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/events.js\":\"214417fbd841ac30\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/handle.js\":\"a5ba207b2d38c368\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/index.js\":\"717d89111c2449fe\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/mutator.js\":\"028d992b967e02a1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/processor.js\":\"0ee7fde8fd34bd49\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/propertySchema.js\":\"bd892d0e236cc36e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/query.js\":\"a2b870e8c6b49727\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/sameTxProcessor.js\":\"80912a9e6ef685c5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/schema.js\":\"a5ba207b2d38c368\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/tx.js\":\"a5ba207b2d38c368\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/typedBlockQuery.js\":\"b62b2924cc91ae75\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/user.js\":\"e16d40a41ada8cc5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/valuePresetCore.js\":\"6cdcfcbf08989819\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/valuePresets.js\":\"d8504324217a2688\",\"/knowledge-medium/pr-preview/pr-1911/src/data/attachmentCleanerIOVerb.js\":\"236a97ad5cd6e7e0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/block.js\":\"1eac3505555cfe26\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockCache.js\":\"36cda304839063ac\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockId.js\":\"4ab49fc0cd1c512e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockLiveness.js\":\"e8c4e7d9e72370b3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockMerge.js\":\"d9b7f1e7db1feb67\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockSchema.js\":\"bda74e93721970cc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockTypeLookup.js\":\"177c3b53f7661d96\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockTypes.js\":\"b225c9a77d9778dc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/childrenView.js\":\"c5faf50c9f65e309\",\"/knowledge-medium/pr-preview/pr-1911/src/data/clientContext.js\":\"570e607968270419\",\"/knowledge-medium/pr-preview/pr-1911/src/data/dbFileSiblings.js\":\"6cbaf5e256a228c5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/definitionSeeds.js\":\"9c351a48e3ae986d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/derivedIds.js\":\"60f01954f72d53a7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/drawnSubtree.js\":\"5324e786f31a32bc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/facetBridge.js\":\"55da8beb71312862\",\"/knowledge-medium/pr-preview/pr-1911/src/data/facets.js\":\"b9e00c6911dbf92d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/globalState.js\":\"929bb7d760cbf7ec\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/aliasClaimRederiveProcessor.js\":\"5b894711737b8e58\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/ancestorBatch.js\":\"ab039e017bd05515\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/blockTypeTypeifyProcessor.js\":\"e9d29093e7486fd4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/clientSchema.js\":\"8ec0ea60aae1a271\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/commitPipeline.js\":\"defd92e39a535e06\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/devAssertions.js\":\"6972866fbef41078\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/firstSync.js\":\"7ff2d2cdbf57a712\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/freshInitialLoad.js\":\"32f9112ef35757f0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/graphBackfillClaim.js\":\"7e892a2318db7603\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/handleStore.js\":\"3175eef41fbdc611\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/idleMarkerJobs.js\":\"130f738acb1b4a41\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/initialDownload.js\":\"da6a6327bbf909d9\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/initializeClientDatabase.js\":\"730c8ab93b1ede88\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/jsonCanonical.js\":\"d77fef4c1067ae32\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/kernelInvalidation.js\":\"91ade2b7bb242b7a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/kernelProcessors.js\":\"5882e69fe7461985\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/kernelQueries.js\":\"8d44a4586483c0ce\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/mergeTypeMembershipProcessor.js\":\"249fb630a8a51c7d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/normalizeReferencesProcessor.js\":\"06aa7d3db8567a0e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/poolInstrumentation.js\":\"4d12a21b0120bbcb\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/processorRunner.js\":\"204e2c9702cd2246\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyCellBackfill.js\":\"3ad66ee0fc94835d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyChildMint.js\":\"8d0f5151f20860ca\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyChildrenProcessor.js\":\"4382f7a9d238de4f\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyDefinitionChangeProcessor.js\":\"be0619c17ba60a01\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyDefinitionSynthesis.js\":\"1b65abdea6b4a47c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyKeyScan.js\":\"85123c1958b9c662\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertySchemaResolution.js\":\"b4c97603823df93c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyValueEdits.js\":\"e7bf58b6f67b20f3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/raiseProtocol.js\":\"46c66a34a98f5d83\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/readBatch.js\":\"1ebc6b9848b24a6c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/refProjection.js\":\"fa43a5712f254e07\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/referenceTargetLookups.js\":\"819db540d74f4251\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/referenceTargetProcessor.js\":\"5bb95363d15d81dd\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/replayMerge.js\":\"ca02025d941dff40\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/sqlBinds.js\":\"837aa520dd501fa8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5e6f489f246c2286\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/arrivalProcessors.js\":\"40d3ae4ff8b6a761\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/invalidate.js\":\"ac90f40e88356683\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/materialize.js\":\"f6124cdc20a6dbca\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/observer.js\":\"8e1a0e0367d98719\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/reconcile.js\":\"a15fab4f521c5609\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/timingMetrics.js\":\"c7335bc2a63b22df\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/treeQueries.js\":\"a48efa78e6ace3c1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/txEngine.js\":\"170b56c157e57e13\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/txSnapshots.js\":\"4a69c385d65638c2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/typedBlockQuery.js\":\"0899a79eef0c8c07\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/undoManager.js\":\"0c66bfef91e8b25e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/invalidation.js\":\"d55ab6fc7440e8dc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/kernelDataExtension.js\":\"219e1775d0c7d70d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/kernelPage.js\":\"9fc93cfd449bf173\",\"/knowledge-medium/pr-preview/pr-1911/src/data/kernelValuePresetCores.js\":\"7108cf490e08c73d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localDbCorruptionSignal.js\":\"cc4faa5e43a1e1e4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localDbStorage.js\":\"9fc1aeb1052f32ee\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localDbVfs.js\":\"8782c0ffb873233b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localSchema.js\":\"e2c81c5806930e63\",\"/knowledge-medium/pr-preview/pr-1911/src/data/maintenance.js\":\"3c7089b3ae0d361a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/mergeProperties.js\":\"512b26aeb728e62d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/metricsConsoleHook.js\":\"885687f9cc6e84bc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/migrationsPage.js\":\"1782bd7e6ef9dc57\",\"/knowledge-medium/pr-preview/pr-1911/src/data/mutators.js\":\"02037fd9ea3dc88e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/orderKey.js\":\"79928a2b60f872dc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/orderKeyPlacement.js\":\"8bc97b620f9f35ea\",\"/knowledge-medium/pr-preview/pr-1911/src/data/outlineSurface.js\":\"bcb84edf7ad79c35\",\"/knowledge-medium/pr-preview/pr-1911/src/data/pendingEditorContent.js\":\"0d3abac84bfec03f\",\"/knowledge-medium/pr-preview/pr-1911/src/data/pendingUploadsSql.js\":\"0221066f6c887a96\",\"/knowledge-medium/pr-preview/pr-1911/src/data/pluginStateExtensions.js\":\"54d5055643e45697\",\"/knowledge-medium/pr-preview/pr-1911/src/data/powerSyncLogger.js\":\"b56742f091abdae6\",\"/knowledge-medium/pr-preview/pr-1911/src/data/projectorRuntime.js\":\"566c4b6cb12d9138\",\"/knowledge-medium/pr-preview/pr-1911/src/data/properties.js\":\"992eb95fff9afa7a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertiesPage.js\":\"f447000df350ec7b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyChildren.js\":\"f47ca46ac1940d39\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDefinitionFanout.js\":\"52beba3306dacf6c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDefinitionMetadata.js\":\"ed5f011ea243d1b1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDefinitionRegistry.js\":\"0b121f25ca98b151\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDisplayMode.js\":\"c93400fb279cdbd1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyRowCreation.js\":\"36bdacfcb9e8323c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertySchemaCreation.js\":\"4bd314b8b54bc405\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertySeeds.js\":\"988e360594b4d554\",\"/knowledge-medium/pr-preview/pr-1911/src/data/recentsPage.js\":\"900c0984bdb07f5a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/refTargetComparableProperty.js\":\"0451bd9776515871\",\"/knowledge-medium/pr-preview/pr-1911/src/data/referenceBlock.js\":\"da97a29aaa237b4a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/rejectedUploads.js\":\"ae3e31083a3ac801\",\"/knowledge-medium/pr-preview/pr-1911/src/data/releasePowerSyncConnection.js\":\"9cdf1e2e014f4c4e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/repo.js\":\"488f99352f8cd1d9\",\"/knowledge-medium/pr-preview/pr-1911/src/data/repoProvider.js\":\"5b545bf8f162aced\",\"/knowledge-medium/pr-preview/pr-1911/src/data/rowProperty.js\":\"f562420c49ec53d2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/searchFilter.js\":\"ea497ea302e3208e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/seedIdentityLedger.js\":\"9f736acf3b7bfc73\",\"/knowledge-medium/pr-preview/pr-1911/src/data/stateBlocks.js\":\"6e2b2357c127318c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/structuralEditPolicy.js\":\"9b00dcc215210bb6\",\"/knowledge-medium/pr-preview/pr-1911/src/data/structuralInsert.js\":\"5f77e013f70dca75\",\"/knowledge-medium/pr-preview/pr-1911/src/data/subtreeDelete.js\":\"478598649a8f22ba\",\"/knowledge-medium/pr-preview/pr-1911/src/data/syncStreamLock.js\":\"bd2a2eeb4a4b055e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/syncedTableSqlRecognizer.js\":\"f7bc7f0b5fc0db50\",\"/knowledge-medium/pr-preview/pr-1911/src/data/syncedTableWriteGuard.js\":\"851ea87fe7b0701d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/targets.js\":\"e8a92aed2288eac5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeColors.js\":\"cd919e03025fd17f\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeDefinitionMetadata.js\":\"fe257c88a226e954\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeDefinitionRegistry.js\":\"13eaa23a08abc766\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeExtraction.js\":\"fa51bb91c4c44065\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeInitialValues.js\":\"1401b9eac1f3bf32\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typePropertyGroups.js\":\"aad2e4bf5760c240\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeSeeds.js\":\"d5028def3b2299d7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeTagger.js\":\"b60c3d1db7596deb\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typedRecords.js\":\"cecca957f85e405b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typesPage.js\":\"9e268b0d5285f8f8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/userPrefs.js\":\"3fe834ed417953ff\",\"/knowledge-medium/pr-preview/pr-1911/src/data/userSchemasService.js\":\"aeaa81307fc186e4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/userTypesService.js\":\"805acf92a3de7344\",\"/knowledge-medium/pr-preview/pr-1911/src/data/valuePresetRegistry.js\":\"23842581365d0193\",\"/knowledge-medium/pr-preview/pr-1911/src/data/visibleChildren.js\":\"fe53ad2acda36719\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceConversion.js\":\"7c3ab330c0e2c6ab\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceFirstSync.js\":\"7a5a472f3a3a263b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceIdNamespace.js\":\"178554b1f5329df1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceSchema.js\":\"d07dda96fdb6ca9d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaces.js\":\"449bc14fae4bb1b6\",\"/knowledge-medium/pr-preview/pr-1911/src/data/writeAheadLog.js\":\"e17df6983bf5f92e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/BlockPasteShellDecorator.js\":\"5fb4be233a5e00c0\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/atTrigger.js\":\"9d129d73936c604f\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/autocomplete.js\":\"3929c18d20c9a50d\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/codeMirrorExtensions.js\":\"bcbcfae23fc931f6\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/contentFlush.js\":\"7623943581a550d2\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/defaultInteractions.js\":\"382ec04288909860\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/editSettleSignal.js\":\"ab96138047a31bbe\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/insertImage.js\":\"0539b8666a6e7f6a\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/referenceCompletionRange.js\":\"d58cc40cf1aba6f2\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/referenceTargetTypes.js\":\"1dc7832ff2d29c39\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/syntaxContext.js\":\"5d41c0be1be814d7\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/triggerMatch.js\":\"01a745bdb211877f\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/AppRuntimeProvider.js\":\"8ea6d794f14241a1\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/BlockFocusShellDecorator.js\":\"1154668e566b93a2\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/ExtensionRenderBoundary.js\":\"4f82a8bbbf3aa820\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/PanelContentRecovery.js\":\"b8851bd34f09a05c\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/apiCatalog.js\":\"58cdd21bea2f6bd3\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/appRuntimeController.js\":\"4180ee7d982965ec\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/approveExtensionHere.js\":\"a2d5cf58550442b3\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/armedCutAppMount.js\":\"57ee7ec2d60695e4\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/batchableKeyedStore.js\":\"5e842e428180ba54\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/blockInteraction.js\":\"7717cf42beb016e1\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/blockSelectionAction.js\":\"9efa59285046996d\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/compileExtensionModule.js\":\"ffb967a78bf55ec5\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/compiledModuleCache.js\":\"cedc1363df77e4da\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/continuousGestures.js\":\"9e366e2f8b39dc2a\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/core.js\":\"eb7c98b63ac12f53\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/defaultRenderers.js\":\"6606fdfd7a664d08\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/definitionFanoutAppMount.js\":\"6e93edcbf76ef301\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/dialogAppMount.js\":\"8f6bf5ea1203b7cd\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/dynamicExtensionSeeds.js\":\"3a02935c0ec5a41b\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/dynamicExtensions.js\":\"f80fa6fd0ba67c81\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/exampleExtensions.js\":\"9423997e92809708\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionApprovalStatus.js\":\"a7ed19602d445040\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionLoadErrorToast.js\":\"7d78c620c3d912a7\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionLoadErrors.js\":\"9c1c35ff9e9befc4\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionLookup.js\":\"05e904a202a0948d\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionToggles.js\":\"143b3e08f3196889\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionUtilitiesCss.js\":\"c27670c7356f80da\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/kernelPageDeletionGuard.js\":\"40a4248b0349c7c8\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/liveRuntime.js\":\"2da57bd66cf9efa0\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/openExtensionsSettings.js\":\"7a2d680b86e43274\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/overridesCache.js\":\"a5e62923cddd36c4\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/pluginIds.js\":\"89a7ea0b2f8d5b58\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/processorRejectionToast.js\":\"5afad9e47954ea70\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/runtimeActions.js\":\"aa68199b018683aa\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/runtimeContext.js\":\"ff35d094aac0b4bd\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/staticAppExtensions.js\":\"e3faf05586a9caad\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/staticDataExtensions.js\":\"c1f19c11f2b4d2f5\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/toastAppMount.js\":\"e878b97094319727\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/useOverrides.js\":\"ba7888c4c344164d\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/useShortcutSurfaceActivations.js\":\"633e1345c949eda2\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/discoverToggleTree.js\":\"6d55a139cc78c718\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/facet.js\":\"f84b47a2af31d27d\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/resolveAppRuntime.js\":\"54f14bb4791abe6e\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/runtimeEvents.js\":\"ce670eaed40cab21\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/togglable.js\":\"f71982f91cebafdd\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/variantFacet.js\":\"5bf19c47dbc27d6b\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/verbFacet.js\":\"7f9aee0e9f47988e\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/block.js\":\"c87da4489288383e\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/focusedChild.js\":\"3d5bb552c1ebe028\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/propertySchemas.js\":\"a27a5de31d07f900\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/typeRegistry.js\":\"b5793df960862e87\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useAncestorCrumbs.js\":\"a1d2d5e9a931a6f3\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useAutocompleteListbox.js\":\"08eec39584e79321\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useDebouncedSearch.js\":\"8f0a134422a539ba\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useDebouncedValue.js\":\"0159fb004cb65ae2\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useFacetValue.js\":\"3e3d609183941f92\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useIsFocalRender.js\":\"ff9edd716cd3f1b3\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useIsReadOnly.js\":\"db652dfdfe495a55\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useMaterializeBacklog.js\":\"7a6dac79618fef06\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useMinuteClock.js\":\"c73eb628dbb5d30e\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/usePanelLayoutProjection.js\":\"ee0f954fdf90908f\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/usePendingInvitations.js\":\"65f706b945de5aea\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useRendererRegistry.js\":\"1689ab0a9c278556\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useRetainedFieldRows.js\":\"317dd78cda03875f\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useWorkspaces.js\":\"047b8f2f02511bee\",\"/knowledge-medium/pr-preview/pr-1911/src/lib/utils.js\":\"6ce89d5c3a74a4cf\",\"/knowledge-medium/pr-preview/pr-1911/src/main.js\":\"c15dff2029fb2228\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/MarkdownImage.js\":\"c43c6ea51e826e51\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/blockSeparators.js\":\"411185df2a69a12d\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/context.js\":\"f92cdd9c3e16d996\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/defaultMarkdownExtension.js\":\"6fdab22943ba1d3c\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/extensions.js\":\"7807c12e52a0ba6f\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/renderMarkdownHtml.js\":\"dcb9014df0f78b7f\",\"/knowledge-medium/pr-preview/pr-1911/src/minimal-editor.js\":\"fa5d8274c8cd9478\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/armedCut.js\":\"e22eafdd1938d254\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/captureMediaVerb.js\":\"6ced3a5fd0926d76\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/clipboard.js\":\"1d6238f722363b58\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/decision.js\":\"bc4352d4bb4f5eee\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/operations.js\":\"03fae0075156553b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/account-header/AccountHeaderItem.js\":\"aebf52ead907c7fb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/account-header/index.js\":\"6dc7b96c1ffa1c03\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"a759c3a346b59c09\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/askAgent.js\":\"e8ef83ebafd0ecc0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/askedStore.js\":\"8f9b66eccefb1f23\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"2f2e2ee340ab9a64\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/chipState.js\":\"4927bc07ed25ed2b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8b65b3abcb1ff797\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/index.js\":\"a1c70b0b18c7ac7f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b5b75782c5861557\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/schema.js\":\"605cdf3a14b682c7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/AgentTokensDialog.js\":\"90c446291e8ac5e9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4274bb4fd8b446b6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/addMedia.js\":\"fcf72c762fd1c57b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/backlinks.js\":\"acc46afe1f762ae4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/block.js\":\"2d2742387f5488bf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/context.js\":\"d934bc3a7d2d0e79\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e41dc9ca04c1600a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/index.js\":\"04a6c0a1e2fde87e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/outline.js\":\"9c1bc81ca3a632eb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/properties.js\":\"f601845a941b7a2e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/refs.js\":\"c134475983bf73ee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e0fbe2d62be62d67\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/search.js\":\"b36022f3525b3339\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/shared.js\":\"82140caab76e5712\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"644b9b293f8a7797\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/text.js\":\"b33e97e7a267f200\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentWrites.js\":\"ebee3290623e4039\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/authoringCatalog.js\":\"0ea1f84e00ee0b5e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/blockRefTargets.js\":\"a8b0482a7aa01260\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/bridge.js\":\"baca67c44a4a0840\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/bridgeLoop.js\":\"6817d80db6cc592f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/changeHistory.js\":\"1b0035896f584743\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/commands.js\":\"3ad1e069dd890604\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/commentsCommands.js\":\"dccbecc694ff10c2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/dataExtension.js\":\"681c57070fb59cf6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/dataModelGuide.js\":\"2c7f68ad6ae6658b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/dayPropertyInputs.js\":\"81497ccca6085211\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/describeRuntime.js\":\"03680606b3912bb7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/extensionLint.js\":\"e24215f0c3fa1aaf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/grainAudit.js\":\"261b2f4c080923e8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/healthCommand.js\":\"684591ed092e95fd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/index.js\":\"6d483ec187576612\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/presetIdentity.js\":\"225caa07edcad3d5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3e10fe9dcb4569bf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/readMedia.js\":\"770f62b36e548ba5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/schema.js\":\"a71dcbf25b8b2c9c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/serialization.js\":\"fd92604051b956f0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/targets.js\":\"5e54ba3314a7b894\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/tokens.js\":\"1f9173c54f9b4f7f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/watchEvents.js\":\"2cf9325d22ac0c71\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/workspaceGuard.js\":\"570a8e8922c03c85\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/writeCommands.js\":\"981a7571228fa65d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/AliasCollisionToast.js\":\"ee2e1e908203877c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/DuplicateNameBanner.js\":\"11248902c6b40805\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/collisionMerge.js\":\"49a06d217fcfa126\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/dataExtension.js\":\"d851f4561b154ad6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/index.js\":\"1025bb6aea0f402f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/mergeCollisionAction.js\":\"8cca22526ddbecb4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/pageStyling.js\":\"500bb447b529ff5f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/rejectionToast.js\":\"bec3b3eb9d9ca9bd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/syncProcessor.js\":\"b4021d94c980cd37\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/actions.js\":\"0350f71a0195ffed\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/addComment.js\":\"66a3668e8c8a20d9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/anchor.js\":\"578e1ad9fbfceb1f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/anchorState.js\":\"71913422a589f865\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/commentLinks.js\":\"36c224c3baf3dbef\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/confirmThreadDeletion.js\":\"a2df0d4c58d9440f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/container.js\":\"e9da7b90841bf743\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/dataExtension.js\":\"a6975e98cec76d32\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/deleteComment.js\":\"bfee02d00aa8921c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/highlights.js\":\"96c1bdf8cb2cb015\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/index.js\":\"437ebfbc647daf07\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/linkedCommentsPill.js\":\"88371c746e5233db\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/margin.js\":\"7ad490562c192c3c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/marginAnchorLinks.js\":\"dd0644b414e3f383\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/marginSchema.js\":\"997c8c81f477c4bb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/newComment.js\":\"d960211ac9fb65a0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/ownThreadPicker.js\":\"bb7050244fab22c7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/placement.js\":\"31235f867fc40856\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/queries.js\":\"315c228fd4b9800f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/quotePosition.js\":\"59dc6785bb011bc8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/quotedIn.js\":\"d91599fe1f08a405\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/quotedRange.js\":\"9a65f3d7465fd894\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/rangeRefs.js\":\"405ba17bef6c9da5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/readHighlights.js\":\"d81562621e98e0d0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/readSelection.js\":\"c7a70682f3c65aac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/readSelectionUi.js\":\"48c4d29fc9fa4859\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/reanchor.js\":\"40e825221f0309c9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/schema.js\":\"0c6e8f8851645bb9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/scope.js\":\"923826229d040301\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/scopeThreads.js\":\"4a845942f7501a9e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/splitRetarget.js\":\"835c885f27590019\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/suggestionCard.js\":\"3f464be5469af78c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/suggestions.js\":\"b7c2d6f0c50751d6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/summaries.js\":\"25c5777a04bc2781\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/summaryBatch.js\":\"97a95e6933f91ae9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/surface.js\":\"0ef9146dcfb7896f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/threadNavigation.js\":\"c4d8bcd2710344cd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/threads.js\":\"e1a579c37ee34d83\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/ui.js\":\"38bc911a47950949\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/uiStore.js\":\"a5921d41d4a75a0a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-intents/appIntents.js\":\"d0725033dc878051\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-intents/index.js\":\"6bf90b9e7caf788e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-update-prompt/index.js\":\"607f21e3bda8c1be\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-update-prompt/status.js\":\"eef0e160a4193eee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d0451b24204fc906\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/MediaBlockRenderer.js\":\"99a27d6a5046d736\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/MediaDownLaneReplicator.js\":\"45e53a697a20c079\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/MediaUploadReconciler.js\":\"6bde56f297d902fa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/assetDownLane.js\":\"70454c71ad185b68\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/assetResolver.js\":\"3448d48757087675\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/assetUpload.js\":\"08425e4fa6d07ac1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/attachmentCleanerIO.js\":\"2e16e2f6c73f7831\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0d1d52a2f8483513\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/blobStore.js\":\"fc6cafdb8205c8dd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/browserMedia.js\":\"9ff148d80991420d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/byteStore.js\":\"ebc7650ed2561d7f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/cleanerIO.js\":\"b098e91a40a711af\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/cleanupAttachments.js\":\"d851f71c16f053b6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/dataExtension.js\":\"8528d9b8c420ea2a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/downLane.js\":\"ab0f7c9145b78c55\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/index.js\":\"5bf5e7471c7ce7e0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/insertImageContribution.js\":\"3e0297773be8000f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/laneArming.js\":\"8f2329033580d32b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/laneLock.js\":\"5f905fef3d19d1e8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaBlock.js\":\"a2baaf2ad85e9d9d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaCapture.js\":\"2f3210571ca4adf5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaLanes.js\":\"0517153775c3a9a3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaViewers.js\":\"b21f6e8ce41d767b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaViewersFacet.js\":\"fd67abab0b31e71e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/pasteCapture.js\":\"655ab6706d27bbca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/resolver.js\":\"2227463e6a2176f7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/retryUploadsAction.js\":\"285fb9e24571f80c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/storagePaths.js\":\"4053d500e50ab9d7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadDrain.js\":\"6eecedf0b40c520c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadLaneStatus.js\":\"f82cebd6cd13be75\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadReconcile.js\":\"17c7acd6eac7f4a4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadRecovery.js\":\"79cac3e0d5414c0e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadStore.js\":\"1a0c0dbb253c29bc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/useAssetObjectUrl.js\":\"42b01f5f66af56a7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f464e0027f538086\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/BacklinksViewSection.js\":\"8158acceda5c06a8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/facet.js\":\"05cc3068f4ac471a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/index.js\":\"81b3515322d7f2d4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/prop.js\":\"c4c13bcc41b99a7c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/BacklinkFilters.js\":\"50f651954a225dd8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"2562adc74559fd7b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/BlockEntry.js\":\"b134620b62fa37e8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/LinkedReferences.js\":\"2275127e5a87c404\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"889ce57abea33de7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/dailyNoteDefaults.js\":\"225294998262f7f0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/dataExtension.js\":\"09be1af9458a4202\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/edgeExclusions.js\":\"e56e715f3747e20c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/filterProperty.js\":\"8701a2df1309a008\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/index.js\":\"f1f54efa3fd01d64\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a80d35557bc25e54\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/applies.js\":\"73fe2e7daf20ddbe\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/countQuery.js\":\"d78a735df88bbffa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d846471c369ffdb1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/index.js\":\"98e0b0589873728f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"2097ed19d0faf6f8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/presentationInvalidation.js\":\"9fcc02833ee17a8c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/propertyEditorOverride.js\":\"a09e27c935d3bee2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/propertyFilter.js\":\"ba16387e0114991c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/query.js\":\"a11419098e1de900\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/resolveFilter.js\":\"65e40ed5b128635a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/sourceBatch.js\":\"3e52384b0d65d5de\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/sources.js\":\"b6babcaeed27444e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/useBacklinks.js\":\"d5a0c356dd38e3cd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5b77573cef2d48f8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/BirthdayCelebration.js\":\"495ab397a6a47b16\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/BirthdayOverlay.js\":\"cb37a779584fa05d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/gate.js\":\"f04e30844cd2ff86\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/index.js\":\"031a138e1444a827\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/wolfTheme.js\":\"593cda5a334c69b0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/BlockDragLayer.js\":\"828f6cf258983931\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/dragController.js\":\"a8f3465c02be3843\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/dropTarget.js\":\"b7a6c80bf0ff3fb9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/index.js\":\"71a9a1194a56d093\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/projection.js\":\"f7bc5058af551910\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-info/BlockMetaCard.js\":\"dbbb2503a9a98d0d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-info/index.js\":\"654588ee5ea9a469\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/AddTagDialog.js\":\"0e97653c808d7cbc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b87f26d6c209c8b9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/TagNameIssueHint.js\":\"3de9ae001260f108\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/addTagAction.js\":\"2eea539bb937d922\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/appendTag.js\":\"74d794a6696757f9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/config.js\":\"4a292cb56003e612\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/dataExtension.js\":\"327a05c6549c6343\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/index.js\":\"44d2b6f00b860b21\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/propertyEditorOverride.js\":\"de4a4d13eabf1d5c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b99d0cfd16bdab63\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"7cea895049bb6553\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d0045c3efb0fcfef\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"76932a806b9cebc1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2aa5f7ba418087aa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/index.js\":\"42d78e9824df84bc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"63d14de50de10bb0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/CharacterCountItem.js\":\"a90d8eaac7038078\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/ProfilePropertyEditor.js\":\"64b9de183d983752\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/actions.js\":\"7c76708792927447\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/blockType.js\":\"2438695e276bf475\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/charCount.js\":\"3bb8558e28e13090\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/dataExtension.js\":\"e61d11440159b38e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/index.js\":\"19c2ee936443201d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/profiles.js\":\"4948f2700a77cc34\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/properties.js\":\"e6cb2b68fa854ea7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/subtree.js\":\"2552a05ef422b5fe\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/textCounts.js\":\"c4991f7d3d035021\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/colemak-keybindings/index.js\":\"df442c8bb8fcd953\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/CommandPalette.js\":\"9ca1561cfcec742c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/HeaderItem.js\":\"03842dbb939f7b55\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/context.js\":\"8f90758b5e5d0c8c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/index.js\":\"6657bf84aae0bd21\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/selection.js\":\"3aacbdc1b39953fd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/toggleStore.js\":\"7a42ac89ff41278e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/useCommandPaletteActions.js\":\"736fb3e6aee02e93\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/ContributorBadges.js\":\"fc9c072f32de7bac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/ProfilePicture.js\":\"9af5f8394d101123\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/author.js\":\"933400d44a8ee9cc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/codeMirrorExtensions.js\":\"dfb536e3dec9dacd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/dataExtension.js\":\"0bd1b358ff0f23f1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/index.js\":\"4d4fe9de197c03e4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/mentionAutocomplete.js\":\"ba899007e40bd2dd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/processor.js\":\"e60ada99f4efc882\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/profiles.js\":\"02b2ae37f071f35f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/queries.js\":\"3cb2ee856e7f2b72\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/schema.js\":\"8f0c6aa73a4d848a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/useCommentAuthor.js\":\"6f4d090916818563\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4ed17ccf015893db\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4d66b1f83f6f4c46\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/index.js\":\"c7cc79f81fa4ebac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5cc616b009f3d681\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"64c670ab364db5e4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/CalendarGrid.js\":\"150d5c54c20a5c2b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DailyNotePicker.js\":\"7e791502579d6965\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4ab255759570442e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DateNavDecorator.js\":\"ab0adb19e5bb4dde\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DateScrubOverlay.js\":\"d79f2be40a75a5e5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DayPropertyControl.js\":\"1ce3ad369c7d35b9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DayValueReferenceControl.js\":\"2a663b8620235f5f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/HeaderItem.js\":\"f5f4b7f899e63265\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/ReschedulePicker.js\":\"707594e6c9bd334f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2036f3c453dd0b2c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/actions.js\":\"df762d1c4b850c8c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/blockDateAdapter.js\":\"7b775aa927c19f0f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/calendar.js\":\"d956f71c28f11a4b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dailyNotes.js\":\"bc107e8e0531d50f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dataExtension.js\":\"35d00db252ff4ae7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubActions.js\":\"ac5f40da147f66c5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubGesture.js\":\"008f4dafdc9774d6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ac440950307b7e6a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubRecognizer.js\":\"c89eac6ef4d3feb2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dayProperty.js\":\"c748f7237ee07035\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"1c6f3bf235e23fba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/deletionGuard.js\":\"4a0bff5b7af8dc3b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dueQuery.js\":\"c2a3dcf11d027939\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/index.js\":\"be1cdbf31e9d26f5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/landing.js\":\"16bd43e446455175\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/localSchema.js\":\"0727950ee9b4a220\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/referenceDateAdapter.js\":\"51841a3f658b87a8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/rescheduleAction.js\":\"4eb37b4849fd2887\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/schema.js\":\"9f9c1ad30b683541\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/spreadBlockDates.js\":\"92dc01f127ce2d30\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/spreadDatesAction.js\":\"08657506ac58361f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/today.js\":\"c768c181f2bd2d2b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e77c2f6d902a390c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f81ef4d848fc308e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/audit.js\":\"1e5c60dff4e691d0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/auditAction.js\":\"29d5d342c94e39ea\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/auditRanges.js\":\"816fe0d9ab15d1da\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/diagnosticsSource.js\":\"a8c632c0b2befadd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/divergenceScan.js\":\"cebc74b8447a3ced\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/index.js\":\"c330223e58592aae\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/propertyChildrenChecks.js\":\"751bb10f048e1c05\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/referencesMirror.js\":\"74e85f4b5617911f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/rowJson.js\":\"2a7f4591de6d7561\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/schedule.js\":\"dfa17ff6620e63c9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/store.js\":\"52a48b900b42ac4a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-maintenance/action.js\":\"fa896868a5ff9e78\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-maintenance/index.js\":\"3f7fa7bc8f2a4ff3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-maintenance/plugin.js\":\"f43c4f0e59ce39bd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5dd9f7fa5332c2e8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/actions.js\":\"af427cc89d65003b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/changeMarker.js\":\"a39e641740907125\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/diagnostics.js\":\"0c02f307bf0d1a6d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/fileSystemAccess.js\":\"6777aed60d922553\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/filenames.js\":\"a65792539747b058\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/index.js\":\"2308ca9e4267e412\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/mirror.js\":\"d6a37f41681ac1cc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/runLock.js\":\"53856ec2c845ba46\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/runtimeHealth.js\":\"1c07d6acc116ae7a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/schedule.js\":\"a792729c307d3697\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/store.js\":\"b9b288c5940b057a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/default-themes/index.js\":\"cca95d89c53e72d3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/default-themes/themes.js\":\"8ad4bc48917e0d34\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/diagnostics/facet.js\":\"c9c57be936199c5a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/diagnostics/useDiagnostics.js\":\"c0f2ae9689978178\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/dismissals.js\":\"e90c58139be25097\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/index.js\":\"7dc1b7038120d445\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/status.js\":\"33b2945703c06871\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/store.js\":\"bf96481989f88c39\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9da293d06a1f5c55\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b7712d74efc0f2d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/actions.js\":\"4ece572b68096bcb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/config.js\":\"dc4f930417a09af5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/dataExtension.js\":\"8f08779fb6ac51c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/effect.js\":\"ee560a18b6743085\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/index.js\":\"3b05ef34e4476e7a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/propertyEditorOverride.js\":\"8e44738b94fc856f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/useToggleTree.js\":\"6ff6f5830208eea2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/ExtractTypeDialog.js\":\"d0aea35f41195bef\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"962ca6f9f939dab0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/PropertyShapePicker.js\":\"a189cc41bf637c71\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/action.js\":\"faaaa52414b0237f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/index.js\":\"70eef3bbbf0477ec\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/FindReplaceDialog.js\":\"1950f1d484a40342\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/HeaderItem.js\":\"619f8c50cf95c67a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/dataExtension.js\":\"1dd1e0948fb4e502\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/index.js\":\"9065892b517541d3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/search.js\":\"b3b63b49006010c9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/toggleStore.js\":\"bc26928c2232100a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/LocationPropertyEditor.js\":\"4d1bbaaacc772214\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/MapView.js\":\"8d0949541afeaf72\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/blockTypes.js\":\"862c4fa4f657806b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/codeMirrorExtensions.js\":\"acbdcdceec312a4a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/createOrFindPlace.js\":\"3ed601f1f1af241d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/currentLocation.js\":\"0e296b0a48b9b958\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/dataExtension.js\":\"b26e6ac81432f07e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/geoContentDecorator.js\":\"2a1d5aa84b17ad9d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/googlePlacesClient.js\":\"87cb0cd30950372d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/index.js\":\"340ffa8d62052d98\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/locationsPage.js\":\"34e26d331b571fcf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/mapViewport.js\":\"a428d58d65e340d5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/pickCurrentLocation.js\":\"d595f150172516cf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/placeAutocomplete.js\":\"b265d8944718ffc1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/placeNameCollision.js\":\"f3430ef2883e4d40\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/properties.js\":\"7b82c0b37e5f69cf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/propertyEditorOverrides.js\":\"e16d811111c0d2a0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/query.js\":\"58c182d2c26c1a1f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/usePlaceSearch.js\":\"f8896fc50d05dd0f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"8370975c019da024\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9ce7b65f7803fe24\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"c1102187a07fe429\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/config.js\":\"3345655345f9a0fb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/dataExtension.js\":\"eb6bae73ec8fcf4d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/facet.js\":\"c200bea77fb1c9dd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/grouping.js\":\"39cc6b1fccfbd6bd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/index.js\":\"75844dd8a15b1c01\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"87eb3e6a6dbf4bd2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/query.js\":\"a7812af5d340f550\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/resolveConfig.js\":\"be4f9b997cf1401a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"41088797ca399287\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"f6d1bee262bb7177\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/HtmlDocumentContent.js\":\"08136575792aadf4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/HtmlFrame.js\":\"5cf31f236f84af66\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/actions.js\":\"1dfd0802f9a68b63\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/blockType.js\":\"c5c4d9b6a2b5a8bd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/confirmRunScripts.js\":\"47decc7916bcc484\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/dataExtension.js\":\"00a44caf0622df33\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/frameAnnotations.js\":\"4d092224f55eccba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/frameDocument.js\":\"0aae123ff3b5b709\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/frameTheme.js\":\"b34d17311ee050f5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/index.js\":\"85b7aa16937d6d81\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/scriptConsent.js\":\"b0a53037078082f9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/sourceMap.js\":\"c243adf04b51d414\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/useDocumentScripts.js\":\"43447c1c4edf7ce8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/index.js\":\"1e37d794701b651b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/record.js\":\"9ecfae81f140a09a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/recordStore.js\":\"40da993d2c0b1f03\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/responsiveness.js\":\"8d7285794427da59\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/schedule.js\":\"b9eab5a962d40a60\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/sessionContext.js\":\"018b35d3ee4ff1a6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"edddc659422a08a0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"9acb393aeddea2c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/actions.js\":\"a6394032320d4588\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/config.js\":\"424008dea39b25d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/dataExtension.js\":\"081a588daa7327cf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/effect.js\":\"b80baeaa67af7f5e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/index.js\":\"fc7ec03263c46f65\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/keyCapture.js\":\"e3bd1dd3bd6b1162\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/overrideStore.js\":\"1e9620f1cd5aeee7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"4b491e3bd9a97162\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/HeaderItem.js\":\"002ed6e331de9686\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/LeftSidebar.js\":\"5e33fb049582037e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/actions.js\":\"5ac89c27411915a9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/facet.js\":\"f8ab5f9cd65b5d7d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/index.js\":\"506d0a84dc79a092\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/shortcuts.js\":\"ced04eceedb4adc7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/toggleStore.js\":\"a5821d93e78b81a6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/MergePicker.js\":\"380dc04132769c8b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/index.js\":\"e013d6601590e1b7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/mergeAction.js\":\"26072d06e03f7f8e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/strategy.js\":\"b80da18c51e95520\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/Button.js\":\"f667819f1094bc4d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"6e3b59b6d95781f7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/defaultItems.js\":\"65303f1c4a3d6a89\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/facet.js\":\"f345bce895c8cee0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/index.js\":\"e82409bb7056cad8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a2baae88ee103b7d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/actions.js\":\"89db4182b2c46545\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ffcaed1c8481b2b4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/facet.js\":\"4aef173073452ee4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/index.js\":\"46a0a6dacc46a0f6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/MoveDestinationPicker.js\":\"099af049055b7370\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/blockSubtreeMembership.js\":\"00f332b3eef1c5dd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/contextMenuItem.js\":\"111173af3f1c1856\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/index.js\":\"63fa09002357e8c7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/moveAction.js\":\"0b008f2b05b302be\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/moveBlocks.js\":\"96a2776237f4ad75\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/selectionAfterMove.js\":\"b0179fe9e1e892cc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/TutorialBanner.js\":\"bd76cf4c4c389903\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/action.js\":\"6b0a1a4a1b09d0c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/bannerDismissal.js\":\"ab95064a8d95a7d9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/documents/cheatSheet.js\":\"a818eefe8b59bb86\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/index.js\":\"3fa40114cce6c581\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/keys.js\":\"a10f4eadb54aa3ea\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/landing.js\":\"24fd8306f232d4d0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/outline.js\":\"8531731adf1d18fe\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/seed.js\":\"e499d756a0b5b4b2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/PerfTrendDialog.js\":\"cc0a64f777e87a6a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/analyze.js\":\"11c9b56fcdea6e2e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/diagnosticsSource.js\":\"145b48e3a7e22f82\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/index.js\":\"103cfd606f0d6d8c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/load.js\":\"605e09fddb8f63ca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/monitorRun.js\":\"0eba60a684d495e7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/schedule.js\":\"b72c477b8f704d49\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/series.js\":\"67f925b0c8b67614\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/store.js\":\"9ce4810b2cbb89d6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/trendAction.js\":\"013c0f4f6ee63037\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/verdict.js\":\"6b6bf932ba24e05b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/plain-outliner/clickToEditAction.js\":\"0ef9f78849b714cd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/plain-outliner/index.js\":\"08c12fd3e1ca1025\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/plain-outliner/interactions.js\":\"362cbb4669057762\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1c9cbdb9ec1c01fa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/MigrationGate.js\":\"73c3cace8f2da90f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/MigrationGateDialog.js\":\"482d0695f3ed738b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/action.js\":\"4669e94c30f230cc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/index.js\":\"127d1c6e2ce3ff2b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/localRunMessage.js\":\"9d9600f9f4c0f33d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/plugin.js\":\"751218ef9bc68dd3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/progressReport.js\":\"2bf2ccab3ca3a66f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/sweepProgress.js\":\"e201b0fd0072e462\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/FieldRowRenderer.js\":\"a5656729e5ede21b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/ValueRowRenderer.js\":\"63e9307c6871ac0c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/actions.js\":\"f44dcd7da8ec8d51\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/autocomplete.js\":\"4724b0317c1dec95\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/fieldRow.js\":\"8f3ed69e99c103df\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/index.js\":\"3fe14f1d5a45cc91\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/referenceWarning.js\":\"547cd4d6ad7dd331\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/valueAutocomplete.js\":\"058f0cfcf7755b4f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/valueSchema.js\":\"4b1ec77546abf2a9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/HeaderItem.js\":\"ae10ea40d64fb1d6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/QuickFind.js\":\"c0c6f29c6d197183\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/index.js\":\"1f8ac87b974a5a03\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/recents.js\":\"853e0623b34647d1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/resultItems.js\":\"94e95d8dcce78a7f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/selection.js\":\"a1b5838dace90ea4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/toggleStore.js\":\"d2828443f3ca23d4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/HeaderItem.js\":\"1bcf422a8014f9fe\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c3d57e25825a78ef\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/grouping.js\":\"225daedaa78dd22f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/index.js\":\"fc51628655f7f077\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/target.js\":\"c34c3174085da9a9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/codeMirrorExtensions.js\":\"6627c739ef5020d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/contentPrefill.js\":\"e724e59280ba72cd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/dataExtension.js\":\"d9f5775269bb620c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/index.js\":\"d0af154e6d165b61\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f9179b5ac43584b7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/invalidation.js\":\"7ce652f6eded8b02\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/localSchema.js\":\"fe948ac53633b6b9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/blockrefs/index.js\":\"f7488bbf300e1fba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"9338a3d9539af1df\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/index.js\":\"97e87bfd2c5a54f5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/referenceNode.js\":\"981a68f72dc916e3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0612b93c63bf01fd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3a8bf6215760f710\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/index.js\":\"f7e84e43ff049066\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"cd77f2a519e40d7e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ac25e54104c21ef5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/mergeRetargetProcessor.js\":\"e006dd9bc473b494\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/parseFence.js\":\"8dbcdd04965a4030\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/referenceParser.js\":\"7c3a8a797a6a01c6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/referenceProjection.js\":\"159039369ae2d7e6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/referencesProcessor.js\":\"75fdd6e2c18537c0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/renameProcessor.js\":\"50ee5a604ef5c276\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/spanReplacement.js\":\"ec5f322329a0e4b3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/htmlToOutline.js\":\"450157bcac1c65ce\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/index.js\":\"eb1c06feac35f607\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/normalizeClipboardDom.js\":\"1074b20f8afe3840\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/pasteDecision.js\":\"9b79bf057e7dc4e6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/action.js\":\"f2a76909fd08d9e0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/blockIds.js\":\"19cc8802912ca0d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/content.js\":\"4fa101a541eb3693\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/effect.js\":\"d8a8fede55441fa2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/ids.js\":\"1a385f0987601a14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/import.js\":\"527ad24357065de1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/index.js\":\"a86fb51a314fdb3d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/plan.js\":\"3d100aa9d46ba3ba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/plugin.js\":\"bcd5ada5618d35e9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/promotion.js\":\"e9304ccedea1372b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/properties.js\":\"b760e0502ae5ed75\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/references.js\":\"fa725131fbfc69d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/report.js\":\"bacb47165fa4742b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/roamMemo.js\":\"6ee97313db0a3389\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/runtime.js\":\"903c1132a08f1e4c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/schemaReconciliation.js\":\"9dace2ae0090f409\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/srsMarkers.js\":\"d3ba64ab044b515a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/todo.js\":\"3cf23fa412e90626\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/typeCandidates.js\":\"8cf9fa7171c933c8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/types.js\":\"65c59715ba8b2fe0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/search-health/index.js\":\"5f53fcbe65eb9c46\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/search-health/store.js\":\"d22f06111726b70c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/HeaderItem.js\":\"cb917d59aa12eb47\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"d43a511ebc13a97d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/index.js\":\"207ef7e0b04c9786\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/model.js\":\"518f03c12491cf95\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/toggleStore.js\":\"ee49f3a9943dd6bf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/useKeyInspector.js\":\"eac3ec9473d745c8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a1ef52c8e7e10461\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/ShellDecorator.js\":\"90480d5d38b907c4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/actions.js\":\"fcdb05b542e8165a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c82aa0daaeb0c041\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/index.js\":\"f23d1ca81d59f228\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/shell.js\":\"96f9deb02dc155a3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/surface.js\":\"527451edfb35cd02\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/walker.js\":\"9c542ced6e0fb7ce\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/RescheduleToast.js\":\"b85dd7b0fcb6e749\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/dataExtension.js\":\"26afdc36b54333dc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/index.js\":\"10604255a38c9807\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/indicator.js\":\"59c12d74124d88ac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/moveSrsState.js\":\"a0ab54805ed1db5b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"628cb9acd9d2244d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/scheduler.js\":\"1d73c0f477b2ba7b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/schema.js\":\"dd04de5e0de36dcb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a58146b51d46b446\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/srsClipboard.js\":\"32bbd93abd7e70ba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"dd65f6c9e211d083\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/DailyNoteReviewHint.js\":\"559d5e65c10ee477\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/DeckPicker.js\":\"adda6b5790215d6c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/ReviewControls.js\":\"8c59f90f1aa4360a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4b628c0b7aa04d71\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/ReviewSession.js\":\"9063c759dd58d6c4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/actions.js\":\"9f8aff6ff92c216c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/archive.js\":\"3e7758316aacc835\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/dataExtension.js\":\"c4cec43030fb18e1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/deck.js\":\"773c0e526487c927\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/dueQuery.js\":\"dabd61067c4a05e5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/gradeDecision.js\":\"e216c8cd7737032d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/index.js\":\"356bdf0bac8b6d83\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/keyHints.js\":\"d79830efa3242de1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/reviewCardLayout.js\":\"4ea382460fb231dc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/reviewProgress.js\":\"eff2ec029ee82c5e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/schema.js\":\"d9dd7581e008565b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/useDueCards.js\":\"7c620d5eb34f121c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/startup-metrics/index.js\":\"39bae0b1ba5d8894\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/startup-metrics/record.js\":\"b17beebe7ba97002\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/storage-persistence/index.js\":\"1e7635eb50d4607a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/storage-persistence/persistenceStatus.js\":\"8eb420d175708dee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/storage-persistence/requestAction.js\":\"8e012742b9c4f5ee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/TypeChipsDecorator.js\":\"25765ce6fc0407c9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/codeMirrorExtensions.js\":\"178ee2feed7dffe2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/index.js\":\"1d637308e7d73bc1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/typeAutocomplete.js\":\"2c12198e5fc483a6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f7cdf725d90126e9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/actions.js\":\"f98a1122fafe314f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/anchor.js\":\"5b9f2c631fe3897a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/events.js\":\"cb836b914d6df8bf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/gestureActions.js\":\"8c5641cc6b6cf278\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/index.js\":\"6dff561bcacb3f3b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9681506ca8edb67d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/sync-metrics/collect.js\":\"ad00432ab6c4f510\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/sync-metrics/index.js\":\"e7dae26f04320458\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/sync-metrics/record.js\":\"4a55b175dc427727\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/RejectionDialog.js\":\"9872e6b110364cbf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/SystemStatusHeaderItem.js\":\"0bfd5dc4e881d46f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/index.js\":\"9cb845806e79396b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/model.js\":\"d7d5865534eafc7a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/queueCounts.js\":\"938414b9a7071864\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/rejectedHelpers.js\":\"0816801d49251eb6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/rematerializeAction.js\":\"3a1b0eeb5e6d364a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/useHysteresis.js\":\"2f93862dead08d70\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/ColumnHeaders.js\":\"2440156b27588b81\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/QueryUi.js\":\"a95fce15ded97890\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/TableLayout.js\":\"6ad9b9b3e0af93a4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/actions.js\":\"b37ef47ee581a92b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/cellEdits.js\":\"a72616e6ae35dc9f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/childrenViews.js\":\"fc1a5d83d8511dc3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/columns.js\":\"c8aaccac4a990f6d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/controller.js\":\"f995218e6bd0274c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/convert.js\":\"05700f73c1ab6b0e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/dataExtension.js\":\"0230a64e0315b282\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/index.js\":\"0cc43a1c189264f2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/keys.js\":\"a12b427295c00a7b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/model.js\":\"740fd7eadfc76b69\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/QueryText.js\":\"f2fda255b4e85c35\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/backfill.js\":\"22d1458e3f5e7b38\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/completion.js\":\"1336a3f3cad86679\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/format.js\":\"9c9d5fb085087d94\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/parse.js\":\"9dd962d7dba08f9d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/queryValue.js\":\"e24a6d8dcfcb3c49\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/registrations.js\":\"307dc88cfdc824f6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/source.js\":\"279786b34086462f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/registry.js\":\"01603674e020a9e0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/rowGutter.js\":\"f25360d98c8bfb94\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/rowVerbs.js\":\"d599221837397da0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/schema.js\":\"154e389bb6d718aa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/sort.js\":\"2acb43bf83f594e8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/theme-toggle/effect.js\":\"e4d2614d4495ff2c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/theme-toggle/index.js\":\"66abf31e31eb9bb3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/theme-toggle/theme.js\":\"9adf70d9c29ad930\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/actions.js\":\"28f9131ad37ad2c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/dataExtension.js\":\"74f5d3b5816040d9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/index.js\":\"ce1c54d9bdee7325\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/schema.js\":\"0dc6b9d6b4ada1cf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/TouchSelectionLayer.js\":\"33ddb58f8ceb58be\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/actions.js\":\"54712de1a9a5ed7c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/defaultItems.js\":\"5f86c36fe8bf268a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/facet.js\":\"3e918e7cc26a7a68\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/holdRecognizer.js\":\"b0d9131560ee0b92\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/index.js\":\"77b3d78acdbd615d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/update-indicator/UpdateIndicator.js\":\"bbdc570de55a4c15\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/update-indicator/index.js\":\"c60fe42e4acdc487\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/update-indicator/loadTimes.js\":\"d2abe58c792acd5c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/VideoNotesRenderer.js\":\"2b292a6baa91848f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/VideoPlayerRenderer.js\":\"2472356fe16f98fc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/VideoTimeStamp.js\":\"f72f1775f4782f93\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/actions.js\":\"7d7cbcba0a8a5fb9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/index.js\":\"28a055754e7a441c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/markdown.js\":\"3317e3f74234d034\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/notes.js\":\"9754434e2bd40fff\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/registry.js\":\"0d2b657ab5cd8215\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/remark-timestamps.js\":\"53d110321bb57489\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/view.js\":\"a0da7c49ba4d4f81\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/LinkHints.js\":\"7d03a71d0120a805\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/index.js\":\"27e71065eaf45151\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/model.js\":\"c311568a7dfa3853\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/settings.js\":\"ce42ab7ddcc34ab4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-normal-mode/actions.js\":\"b93f491da1ddd5a9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-normal-mode/index.js\":\"7f812a0cc4dcccf8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-normal-mode/interactions.js\":\"86420cdd8ca59bd8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/workspace-header/index.js\":\"eef4923059bd90d1\",\"/knowledge-medium/pr-preview/pr-1911/src/registerServiceWorker.js\":\"ef04a5cbf7be8197\",\"/knowledge-medium/pr-preview/pr-1911/src/requestPersistentStorage.js\":\"3720f4b6ab1491fa\",\"/knowledge-medium/pr-preview/pr-1911/src/services/authRequestDeadline.js\":\"d848326016abe728\",\"/knowledge-medium/pr-preview/pr-1911/src/services/authStorage.js\":\"577209984fe54a4a\",\"/knowledge-medium/pr-preview/pr-1911/src/services/powersync.js\":\"5e4884d59709c329\",\"/knowledge-medium/pr-preview/pr-1911/src/services/supabase.js\":\"1519b05d4a9ded73\",\"/knowledge-medium/pr-preview/pr-1911/src/services/uploadErrorClassifier.js\":\"2ddfbd645f1a5453\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/ActiveContexts.js\":\"a7f47938034758a7\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/HotkeyReconciler.js\":\"887426bc505ad3d9\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/WipeLocalDataDialog.js\":\"9b29fc9c9a849d56\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/actionDispatch.js\":\"5567e422452dc935\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/actionRefItems.js\":\"052bfd1571185833\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/applyKeybindingOverrides.js\":\"9a93271cdb734cde\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/blockActions.js\":\"8e4ef589c997fe90\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/blockMergeGesture.js\":\"1b2e5c2d24114d17\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/canonicalizeChord.js\":\"2bdf682994c70ee4\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/defaultContexts.js\":\"ccae30a3d7697311\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/defaultShortcuts.js\":\"fae1f532f91bcc90\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/effectiveActions.js\":\"e7d865233012bef7\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/gestureAction.js\":\"bb77f3ba0578c46b\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/gestureBinding.js\":\"5131f02c77af0cd5\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/holdRegistry.js\":\"84f38caccb447483\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/keybindingConflicts.js\":\"c1713c69d15fc3f6\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/keybindingOverrides.js\":\"e8225f3fb17ee5df\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/pointerAction.js\":\"485c371937d6d181\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/resolve.js\":\"6ddaba1febbd7988\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/runAction.js\":\"63bb4dcd38f0512c\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/sequenceMatcher.js\":\"e93c4ccda2fcc6f1\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/types.js\":\"37d48687862ed527\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/useActionContext.js\":\"3c4b1d8176c3dc64\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/useActionDiscovery.js\":\"468f1caa761fc0bc\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/utils.js\":\"3276e8c1f483b8fd\",\"/knowledge-medium/pr-preview/pr-1911/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1911/src/sw/bootStore.js\":\"7dde63460a7ab8fe\",\"/knowledge-medium/pr-preview/pr-1911/src/sw/previewDatabases.js\":\"bca8b382912cd327\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/byteTransform.js\":\"671ddf5dbe312c25\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/attachmentCleaner.js\":\"0e972f1cacdd66bf\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/attachmentParts.js\":\"2790dcdcbe6a6b00\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/bundleParts.js\":\"e640e77223c346a9\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/bundleRecord.js\":\"42cddae8a9598a72\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/manifest.js\":\"bbee77182425c71f\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/takeBundle.js\":\"5084bd57a75cddb8\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/verifyBundle.js\":\"de58a9afc989c8da\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/cleaningStage.js\":\"551b5869371bbad1\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/conversionKey.js\":\"88ef13d4801d7f25\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/conversionServer.js\":\"efe35d10fbc30156\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/flip.js\":\"0f4e539055c5173a\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/flipAttempts.js\":\"3c1d96266f562a84\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/pages.js\":\"e9b818686c2ae02d\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/preflight.js\":\"dcb3d8f153d582c8\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/reseal.js\":\"b85c7dbfa4c8c3e6\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/runConversion.js\":\"3036434acbea3894\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/runLock.js\":\"2b871e2020b11c4c\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/sealing.js\":\"406d734281a32203\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/sealingStage.js\":\"fc20629123caf1f2\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/stage.js\":\"6975bf92b13f5007\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/verifyReseal.js\":\"bff356bd517b64f4\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/aad.js\":\"1ef04264e5d68b4f\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/aead.js\":\"aded44ce03ec6894\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/base32.js\":\"cf09992d9d99a9cd\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/base64url.js\":\"1107876efc8eb7a9\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/binaryEnvelope.js\":\"68469956423af23f\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/byteAead.js\":\"88e2b68ceee2075f\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/canary.js\":\"89df087a63028b6e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/contentHash.js\":\"44e2e72d2f1d6867\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/contentKey.js\":\"2a9a00ea3bb1b7e0\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/derivedIdNamespace.js\":\"149a7daa11042bc4\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/envelope.js\":\"e392f9a83537d93c\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/hex.js\":\"951cad8b17360d2a\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/sha256Hex.js\":\"d2fad3c22e49a918\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/workspaceKey.js\":\"d80d385e4552ead1\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/conversionState.js\":\"854a6d1b0ece19c2\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/createEncryptedWorkspace.js\":\"01b3e7b80c4cd068\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/pastedKey.js\":\"8c733b76c215d04e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b261f74806b21ae6\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2f8f03e6c5c49b6e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/keyStore.js\":\"987da495345d8c54\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/mintWorkspaceKey.js\":\"3e400f847929b231\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/modePin.js\":\"aa61633fa915ad6c\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/openWorkspaceKeys.js\":\"50fee21e415348d5\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/resolveWorkspaceEntry.js\":\"b3ba31a770409877\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/resolver.js\":\"44eab011bf127bbf\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/workspaceAccess.js\":\"9a3d6b43ba2e358a\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/transform.js\":\"50ef6e22bf1ff7fd\",\"/knowledge-medium/pr-preview/pr-1911/src/themeBootDefaults.js\":\"1cac37c0c2e16d33\",\"/knowledge-medium/pr-preview/pr-1911/src/types.js\":\"59911af1d303040e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/ClientLocalSettings.js\":\"1b843d0245f63b19\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/abortableSleep.js\":\"73d22f71b4aef7bb\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/array.js\":\"fd7848f2b47cd76b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/backlinkAutocomplete.js\":\"ae3f69757eb30325\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/blockCrumbs.js\":\"67403ad781df6294\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/blockrefAutocomplete.js\":\"a20d51242c7aec9e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/cadencedIdleJob.js\":\"6ca44adf36b9474e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/callbackSet.js\":\"721656ea97d481cc\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/clientId.js\":\"7caf47b90a20c034\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/codemirror.js\":\"53f431df5305de84\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/codemirrorCompletion.js\":\"fa74764e017050f8\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/copy.js\":\"51060a3fe27874a7\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dailyPage.js\":\"af5df07339b24658\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dbForensics.js\":\"30891cb6a4c5077a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dbForensicsHooks.js\":\"c633af2710bcad5f\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/deleteBlockThroughUi.js\":\"31cd803d9057f1c2\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dialogs.js\":\"cd330f12a4954731\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dom.js\":\"770265e91ba5ecbb\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/downloadBlob.js\":\"ecab8de13d91937a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/drawnWalk.js\":\"78d532579ae2aa79\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/exportSqliteDb.js\":\"c5e2dbcc837ff9e0\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/fileSystemAccess.js\":\"e3fe3452c14ed775\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/flipSlide.js\":\"5e7d282f1d288a24\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/fnv1a.js\":\"513f65c6ecc53bf3\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/formatBytes.js\":\"ca784294edcb78be\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/fuzzyRank.js\":\"ddc0ae4472e0c083\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/idbKeyedStore.js\":\"c96e6f0b6da63d54\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/idleCallbackPolyfill.js\":\"c5c7584c77778f25\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/keyboardAwareScroll.js\":\"b81bd63d7ec81bdf\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/keyboardViewport.js\":\"267ffdab67d9895b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/lastWorkspace.js\":\"8f6d2a9e9176c359\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/layoutColumns.js\":\"f13cd4f0cec489b2\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/layoutSessionDom.js\":\"d074dd67bf715bbb\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/layoutSessionId.js\":\"da3eaab0c892d676\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/linkClickGestures.js\":\"dddd3f499dfb65f8\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/linkTargetAutocomplete.js\":\"8601a79a0a4e1e83\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/localDbCorruption.js\":\"b94a497b3b0a7d2e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/localDbRecovery.js\":\"c0c7cdd5314a7788\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/markdownParser.js\":\"56205aba0723ca50\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/memoize.js\":\"455375b90ac640e7\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/nameFieldCommit.js\":\"95346d41e9e8f287\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/nameList.js\":\"a7601c4a075388f6\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/navigation.js\":\"c4dd874fa4ca9095\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/omnilinerNamespace.js\":\"705227cefdb71063\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/opfsPageScan.js\":\"f8326e5d17452258\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelClearance.js\":\"b129ab908b6768ee\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelHistory.js\":\"acfe06ba2802fd90\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelLanes.js\":\"596b64c6a5088d06\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelLayoutProjection.js\":\"2904a20a5de0b9f0\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelScrollAnchor.js\":\"abd04d9265074b9b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelUrlFlags.js\":\"e4449040d39e6d48\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/platform.js\":\"0021dc7206953859\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/pluralize.js\":\"d7f4298fcd1afec9\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/propertyCreation.js\":\"eb232420f553735e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/propertyNavigation.js\":\"ab84438fecf31bea\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/propertyValueContext.js\":\"8bdeee4d2e88d583\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/react.js\":\"0952d1bf883c6099\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/relativeDate.js\":\"7abb9c365a9fda8a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/relativeTime.js\":\"8c1766bf1ae8d2d5\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/renderScope.js\":\"a1f428bd001d10a6\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/resolvedThenable.js\":\"26158f0026d69ae5\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/routing.js\":\"83f490499cf03969\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/safeMode.js\":\"d26de89f8cff27cf\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/scheduleIdle.js\":\"bee405129e2fe32a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/screenWakeLock.js\":\"e5d06ed9b6b130da\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/selection.js\":\"69e59548ac156099\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/softKeyboardGrab.js\":\"6dfa2421ab8a45d4\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/startupTimeline.js\":\"3f8b5d301c557708\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/state.js\":\"be3601ad8e674815\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/string.js\":\"24890678aa8ef9d6\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/surfaceZoom.js\":\"ab79b7ea6ae836ef\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/time.js\":\"ddb13f653ae50e40\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/toast.js\":\"8a76c740571adfe6\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/toggleStore.js\":\"8340c886a43cc44d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/untilStopped.js\":\"0a04a79e76ff956d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/userActivity.js\":\"6fd1d20e11f10445\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/viewTransition.js\":\"918bfe3d9dacee0f\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/viewport.js\":\"7fa157a94ac8f0be\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/webLock.js\":\"3bd17336fa1e94c1\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/workspaceRecovery.js\":\"6fb2c410956e4d14\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/workspaceSnapshotStore.js\":\"7bf3db47ad355c99\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-compiler-runtime.js\":\"074e2db69ed14076\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-client.js\":\"0cad752f5f6eaf4c\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-server-edge.js\":\"c1ba001d2bd77470\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-server.js\":\"369162453a72979c\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-static-edge.js\":\"873fd19c7b4d26ec\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-static.js\":\"291f8d7c6a445d89\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-test-utils.js\":\"d931c62bfd3bcd8e\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom.js\":\"ad7588a8ec953cd5\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-jsx-runtime.js\":\"6fe8ac6d44c955bb\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react.js\":\"dd920c7c28576002\",\"/knowledge-medium/pr-preview/pr-1911/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1911/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1911/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
