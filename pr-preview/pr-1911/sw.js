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
		buildId: "bb0717b788dc-3e5c2be5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1911/\":\"056b9cf1856f351b\",\"/knowledge-medium/pr-preview/pr-1911/index.html\":\"056b9cf1856f351b\",\"/knowledge-medium/pr-preview/pr-1911/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1911/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1911/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1911/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1911/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1911/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1911/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1911/assets/FacadeVFS-DDPpiBH6.js\":\"66137dca2d28c6fc\",\"/knowledge-medium/pr-preview/pr-1911/assets/OPFSCoopSyncVFS-BRqjpT-8.js\":\"93125017fb0b44fe\",\"/knowledge-medium/pr-preview/pr-1911/assets/OPFSWriteAheadVFS-Vv1Buh2u.js\":\"074f504e0a7e4221\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-C1QtU6F6.js\":\"c117472a9a28a7dd\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-async-DYIs45a_.js\":\"c3d3ec2341b9d81c\",\"/knowledge-medium/pr-preview/pr-1911/assets/worker-DthS8fUD.js\":\"b57b5cde39584cc0\",\"/knowledge-medium/pr-preview/pr-1911/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1911/chunks/app-D2jLEf8b.js\":\"6a4efc54f54aae96\",\"/knowledge-medium/pr-preview/pr-1911/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1911/index.js\":\"5965282b52c6e68b\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1911/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1911/assets/AccessHandlePoolVFS-YxrvLNzn.js\":\"7e2b09a526ec8550\",\"/knowledge-medium/pr-preview/pr-1911/assets/IDBBatchAtomicVFS-DA3h_1jv.js\":\"73a724999ad03d9f\",\"/knowledge-medium/pr-preview/pr-1911/assets/MemoryVFS-Dmi06P4u.js\":\"ca7d8a756747edd8\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-BeRVHdbm.js\":\"67b3226de41b65f3\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-async-6OJ34hPF.js\":\"7565094b49d981ca\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1911/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1911/chunks/AccessHandlePoolVFS-CSt0cxbR.js\":\"e6338f9bc85b8d00\",\"/knowledge-medium/pr-preview/pr-1911/chunks/FacadeVFS-DQXepiKY.js\":\"a7ae5b3ded2c6cac\",\"/knowledge-medium/pr-preview/pr-1911/chunks/IDBBatchAtomicVFS-PU15jUvA.js\":\"a213081dd6de0bac\",\"/knowledge-medium/pr-preview/pr-1911/chunks/MemoryVFS-Ok9MAl21.js\":\"e5f2df685cd84417\",\"/knowledge-medium/pr-preview/pr-1911/chunks/OPFSCoopSyncVFS-CZ65vV_S.js\":\"8180dc16f478f189\",\"/knowledge-medium/pr-preview/pr-1911/chunks/OPFSWriteAheadVFS-D9FQgyGU.js\":\"3e2b4a52087e8b1c\",\"/knowledge-medium/pr-preview/pr-1911/chunks/Preview-D-fhPsiB.js\":\"7bec85168721392e\",\"/knowledge-medium/pr-preview/pr-1911/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1911/chunks/card-BXMXV5zp.js\":\"0abb9edcbc8f6374\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dist-DcTH5kbS.js\":\"6e0b1109f1da547e\",\"/knowledge-medium/pr-preview/pr-1911/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1911/chunks/mc-wa-sqlite-aJ_EL5Na.js\":\"ddfc87b9c2549b59\",\"/knowledge-medium/pr-preview/pr-1911/chunks/mc-wa-sqlite-async-CkiEWOxA.js\":\"1e6da89155dc0b9a\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-B16xdob5.js\":\"63425ac6e26c92e0\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-BPosNw_j.js\":\"3b4f151791072e7c\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-BZ2ED86g.js\":\"1bee5c4919e16280\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-BekQL-Qv.js\":\"dcd0be343577c045\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-Cl8Y5NsJ.js\":\"39ee99950dfb676c\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-DixD8BnX.js\":\"b7bb491825b7db37\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-DsPckOzS.js\":\"a536358ebd426cee\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-L3PQI87H.js\":\"4e07664a36e12268\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-dom-server-legacy.browser.production-Dzw4f8Y8.js\":\"8bff203d71ce16b8\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-dom-server.browser.production-Cv10s4fo.js\":\"f2d78a0bdfb9c0ba\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-dom-server.edge.production-B_UIKOC1.js\":\"66351bc464070312\",\"/knowledge-medium/pr-preview/pr-1911/chunks/server.browser-Cp9pqrDp.js\":\"13af82d8c8a6e6ac\",\"/knowledge-medium/pr-preview/pr-1911/chunks/textarea-BNORuiUG.js\":\"3e2ab61260e52b01\",\"/knowledge-medium/pr-preview/pr-1911/chunks/ui-CG1HjMqe.js\":\"46eb8483d30e5e72\",\"/knowledge-medium/pr-preview/pr-1911/chunks/wa-sqlite-DAihVJhn.js\":\"e20843c5a8e46d80\",\"/knowledge-medium/pr-preview/pr-1911/chunks/wa-sqlite-async-bH-bXAXZ.js\":\"323a2ef51c9d4e9e\",\"/knowledge-medium/pr-preview/pr-1911/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1911/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1911/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1911/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1911/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1911/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1911/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1911/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1911/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1911/src/App.js\":\"a6ade2faa9b072f2\",\"/knowledge-medium/pr-preview/pr-1911/src/appUpdate.js\":\"7392756802eb34ad\",\"/knowledge-medium/pr-preview/pr-1911/src/appVersion.js\":\"c9950f5cc6bac549\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/initialLayout.js\":\"8e6ee3afbc87cb6d\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/openWorkspaceData.js\":\"29255e39d4360b44\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/resolveWorkspace.js\":\"29db1d109f66bc1c\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/workspaceBootstrap.js\":\"0418d0376d3c8d1f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockComponent.js\":\"2c5d0d004815d17a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockCrumbs.js\":\"36e06ac7be07da35\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockEditor.js\":\"5511e6388c14ecff\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockLoadingPlaceholder.js\":\"0136f0b182b323aa\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockProperties.js\":\"4f0439e0c15e9590\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockSearchPicker.js\":\"d5b3d1cb19b62e98\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ConfirmBulkDeleteDialog.js\":\"ef023a796e88b76a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/DividerHandle.js\":\"5f64da536ccfbb8b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/DraftEditor.js\":\"b431f36b13889324\",\"/knowledge-medium/pr-preview/pr-1911/src/components/GutterPill.js\":\"5b21075fa8d2d0ed\",\"/knowledge-medium/pr-preview/pr-1911/src/components/Header.js\":\"d5ca460595541d84\",\"/knowledge-medium/pr-preview/pr-1911/src/components/LazyBlockComponent.js\":\"d18cda362733a6f0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/Login.js\":\"a94a323e1726aed0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ZoomableSurface.js\":\"88c6b3d2073645da\",\"/knowledge-medium/pr-preview/pr-1911/src/components/editModeKeepalive.js\":\"72be16eedabf1b33\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyDisplay/PropertyDisplayScope.js\":\"42c21af0fb0db658\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ca25d48560349961\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/RefPropertyEditor.js\":\"3a4acf72e3e4a4e1\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/RefTargetTypePicker.js\":\"fda21bc36e264dc1\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/SelectPropertyEditor.js\":\"7fb261878a3c3e7a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/TypesPropertyEditor.js\":\"ef9adc9333fe230f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/defaults.js\":\"94c1972397391c01\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/kernelValuePresets.js\":\"fafd7a8b09bb5000\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/selectablePresets.js\":\"ce818e160f1fb69b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/typesPropertyUi.js\":\"452be0379deeae12\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/AddPropertyForm.js\":\"561b5f0ce2685604\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/PropertyPicker.js\":\"3e914df3ec668302\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/PropertyRow.js\":\"875f54bac39c2fcd\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/Rows.js\":\"add816c8d1ead2ed\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/actions.js\":\"02144c02896c3042\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/declarationOnly.js\":\"ebed0dfbe6b7ff8e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/layout.js\":\"2fa24370dae3f031\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/model.js\":\"3349e22be8cb390d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/shapeUi.js\":\"dcc3e92c1425c4ae\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/shapes.js\":\"021e246a26a52747\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c7548949859bb7fc\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/visibility.js\":\"905f66a4e72fcafa\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanelSections.js\":\"15a27e046d88440b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/BlockEmbed.js\":\"4d3ddf7f607f1823\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/BlockLink.js\":\"e13976d4f52eccfa\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/BlockRef.js\":\"86434833dbaf6009\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/CompactReferenceLink.js\":\"0a97342f03bdbeef\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/ReferenceLink.js\":\"06d958756763bc30\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/cycleGuard.js\":\"6a91ef83050e6478\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/cycleGuardContext.js\":\"0fddb8ed27ede7b1\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/linkInteraction.js\":\"2df0aada05c8e4b0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/referenceLayout.js\":\"55d8a7789e052e40\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/useBlockRefAncestors.js\":\"9b22041e58523028\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockGutter.js\":\"c27a73eca02e0adc\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockInfoDialog.js\":\"a3c71bb4c5e79054\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockReadText.js\":\"4ee122e250860b7d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockTypeBlockRenderer.js\":\"a059dba11c955343\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BulletHoverCard.js\":\"007c2ea35bc0bc20\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/CodeMirrorContentRenderer.js\":\"75b79f3c73e36835\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"71477919c0508897\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/ColumnResizeHandles.js\":\"b2c22cf5c46baefe\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"811b01e2f5f48dbf\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/DefaultBlockRenderer.js\":\"90f6eb056c7d4696\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/LayoutRenderer.js\":\"6154b52562a4fe56\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/MarkdownContentRenderer.js\":\"2906cc08a26db3d0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/MissingDataRenderer.js\":\"be2e40a539e67046\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/PanelRenderer.js\":\"620a7037e8f3977e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/PropertySchemaBlockRenderer.js\":\"5a17a327553c58b8\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/TopLevelRenderer.js\":\"ffdc1a5b9ffdfe14\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/blockGutterMode.js\":\"49e7f6f81a784f66\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/blockTitleText.js\":\"6bad025805f6d990\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/fieldCreationKeydown.js\":\"4bd89102f49fb272\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/layoutRootContext.js\":\"bc0bdea5e9b6cb1b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/typeChip/TypeChip.js\":\"539eedb1f01a1c58\",\"/knowledge-medium/pr-preview/pr-1911/src/components/typeChip/chipStyle.js\":\"6d8a60375266c1c3\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/anchored-floating.js\":\"7322dbfe0ca15d9f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/button.js\":\"6432d2daee93dd18\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/card.js\":\"89f99ccca12b306e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/checkbox.js\":\"362934570f1f9057\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/collapsible.js\":\"03a19695dc4859b5\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/command.js\":\"a2c42c6d23269f2e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/context-menu.js\":\"fbd4bcdf0385898d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/dialog.js\":\"868dc831f6f5ff2a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/dropdown-menu.js\":\"fd4c60d2763027fe\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/floating-listbox.js\":\"207e2f1f72ecf591\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/index.js\":\"7842d20610e84bb9\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/input.js\":\"6d8e52afbf66e3d0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/kbd.js\":\"a0cbf23abe8e7430\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/label.js\":\"db36fb6f7c1c4527\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/textarea.js\":\"42fab32b1471a8fc\",\"/knowledge-medium/pr-preview/pr-1911/src/components/useEditModeYieldKeepalive.js\":\"76e10e4a9fb68aab\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/BootFallback.js\":\"788e05bf23e8d71f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/FocusedRowLazyMount.js\":\"07c830635e9ee73b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/LazyViewportMount.js\":\"006f9fb3989c8884\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/LocalDbCorruptionFallback.js\":\"285f38591ac78a27\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/error.js\":\"a68ea6b68f2480cf\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/lazyMountRegistry.js\":\"0e7f8dd7fa3ba8b4\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/suspense.js\":\"b1965804056a323e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/CreateWorkspaceDialog.js\":\"a268127a4063d320\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/PendingInvitations.js\":\"577a68d660f8efff\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/SyncProgress.js\":\"42aca9d1ce0ef024\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/UnlockProgress.js\":\"7e7451a42cd916f7\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceKeyGate.js\":\"23b808225aa5c919\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceSettingsDialog.js\":\"a92dc1e3e9c0e72e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceSwitcher.js\":\"641f70b104162879\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceSyncGate.js\":\"3523ca3b2382b861\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/ConversionFlow.js\":\"503c23f0b835de1d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/ConversionFlowHost.js\":\"4059f090cbc5ef64\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/EncryptionSection.js\":\"e6585d87bcd414a2\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/attachmentPrompts.js\":\"33ed3efcea17209f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/bundleFolderPrompts.js\":\"21f31001cc0bfc2f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/conversionFlowDeps.js\":\"7cb6edec2264c0c0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/conversionFlowStore.js\":\"4a61991ef0bfc524\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/flowUi.js\":\"a5e548ceada178c5\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/useConversionRun.js\":\"cb27bccc0ea74bcd\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/keyUi.js\":\"9847a36edf739c3f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/useCloseOnKeyLoss.js\":\"d18a64fe09725385\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/useCloseOnServerE2ee.js\":\"5f4ba51a5b81d8af\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/workspaceUnlocked.js\":\"33a9ffa5ebf63864\",\"/knowledge-medium/pr-preview/pr-1911/src/context/backgroundSubtree.js\":\"cbddfe087371a0bf\",\"/knowledge-medium/pr-preview/pr-1911/src/context/block.js\":\"aae8a87b0c860183\",\"/knowledge-medium/pr-preview/pr-1911/src/context/layoutWsContext.js\":\"8597d6d472a24d39\",\"/knowledge-medium/pr-preview/pr-1911/src/context/propertyDisplay.js\":\"059c0a725406f33b\",\"/knowledge-medium/pr-preview/pr-1911/src/context/repo.js\":\"eb42b107f25db546\",\"/knowledge-medium/pr-preview/pr-1911/src/data/aliasClaim.js\":\"ecc815c5bafecdd1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/aliasSeatNamespace.js\":\"2b0cef454fb39cb7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/blockData.js\":\"ad18525a47b3f81d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/blockType.js\":\"4c32342c3c26d917\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/changeScope.js\":\"c3b21a5621f0b25d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/codecs.js\":\"369cebbfb4b63684\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/derivedData.js\":\"f333c1e41a0300b1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/errors.js\":\"69f76b9aff1ab8a0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/events.js\":\"2905a7d0be5d8124\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/handle.js\":\"acba03b16da90420\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/index.js\":\"57d8a8317243c781\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/mutator.js\":\"3edb5d4c57c04cd4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/processor.js\":\"3893b361a9b15711\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/propertySchema.js\":\"3b7ab07900903632\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/query.js\":\"724833f2c27dbeb2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/sameTxProcessor.js\":\"700cbefcfc4adb05\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/schema.js\":\"acba03b16da90420\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/tx.js\":\"acba03b16da90420\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/typedBlockQuery.js\":\"0a330ca2ff794238\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/user.js\":\"669a8db5de18cf5d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/valuePresetCore.js\":\"1f5f08f3a85f4e40\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/valuePresets.js\":\"fb6e24929a5f8f65\",\"/knowledge-medium/pr-preview/pr-1911/src/data/attachmentCleanerIOVerb.js\":\"5a7042d77edfd2ca\",\"/knowledge-medium/pr-preview/pr-1911/src/data/block.js\":\"29ec48e99a7b20b7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockCache.js\":\"bc99c0a916223fc9\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockId.js\":\"d5f749af46454401\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockLiveness.js\":\"5cdc42dd105652ee\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockMerge.js\":\"531c60d7da9aad2c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockSchema.js\":\"957f75bf68d8998b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockTypeLookup.js\":\"b40cf39797689e8f\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockTypes.js\":\"a6ef5f52c896b921\",\"/knowledge-medium/pr-preview/pr-1911/src/data/childrenView.js\":\"ad397c7e51abe0ca\",\"/knowledge-medium/pr-preview/pr-1911/src/data/clientContext.js\":\"8ee988c2b794647a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/dbFileSiblings.js\":\"05d85c5771e708e3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/definitionSeeds.js\":\"687e9d2c664bab1d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/derivedIds.js\":\"ca7334e144ef7752\",\"/knowledge-medium/pr-preview/pr-1911/src/data/drawnSubtree.js\":\"90fe15d078aa8f90\",\"/knowledge-medium/pr-preview/pr-1911/src/data/facetBridge.js\":\"8bc62c517273f500\",\"/knowledge-medium/pr-preview/pr-1911/src/data/facets.js\":\"883423d4ddedda1b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/globalState.js\":\"6f170b88a03b3917\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/aliasClaimRederiveProcessor.js\":\"0ba9de681a1f2626\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/ancestorBatch.js\":\"ba11fef703bcfc06\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/blockTypeTypeifyProcessor.js\":\"0c7f6c49fd152324\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/clientSchema.js\":\"7a41e2c7f986d410\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/commitPipeline.js\":\"07d6f77d9851940a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/devAssertions.js\":\"7503674310ec9951\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/firstSync.js\":\"134710a219713686\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/freshInitialLoad.js\":\"771d14a00f361aed\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/graphBackfillClaim.js\":\"6c292a95108556c3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/handleStore.js\":\"d0fc802489425499\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/idleMarkerJobs.js\":\"3bb8dc8fb9c21fe1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/initialDownload.js\":\"9fdff023b7206bd0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/initializeClientDatabase.js\":\"b7f40ea5a807e0aa\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/jsonCanonical.js\":\"3e229c60589fb298\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/kernelInvalidation.js\":\"787c4c82bec88bd1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/kernelProcessors.js\":\"d526d9bdf41e98b3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/kernelQueries.js\":\"31b2b3f46cc43d70\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/mergeTypeMembershipProcessor.js\":\"6db23bc8c0032672\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/normalizeReferencesProcessor.js\":\"d8ea8c9eb3e54b42\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/poolInstrumentation.js\":\"d7293d7a515b23b5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/processorRunner.js\":\"6576ebc7d437c1a3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyCellBackfill.js\":\"8b7ea6db3a79fb4a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyChildMint.js\":\"ad9ae1e48e4fa3bd\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyChildrenProcessor.js\":\"2f2ff1b50ac80cd4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9a280a206df6e545\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyDefinitionSynthesis.js\":\"ed2aaa2aed66f056\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyKeyScan.js\":\"b065b7837c92b03d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertySchemaResolution.js\":\"ea5ef3f30346ae8d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyValueEdits.js\":\"7cafdbe275b1f38a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/raiseProtocol.js\":\"699df5b9dda018c3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/readBatch.js\":\"4083268eb3814616\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/refProjection.js\":\"f4bf3a440322b924\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/referenceTargetLookups.js\":\"885e9e318f8b5aa8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/referenceTargetProcessor.js\":\"bb1787f22e81800b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/replayMerge.js\":\"0e3b165ac72ab7e7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/sqlBinds.js\":\"47cd992f70b0b622\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"fe32578b0056e4d7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/arrivalProcessors.js\":\"b3eeb9e985fb4fcc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/invalidate.js\":\"58d79771e3bba41a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/materialize.js\":\"646c0a210a46acba\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/observer.js\":\"615050252796b743\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/reconcile.js\":\"ab9e1b3d05293f44\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/timingMetrics.js\":\"10725bad6d045737\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/treeQueries.js\":\"9965b94b3ce5053d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/txEngine.js\":\"5f5ef1093769e141\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/txSnapshots.js\":\"9f65efdf40b391de\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/typedBlockQuery.js\":\"8fc6d41c00769555\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/undoManager.js\":\"6ca616d569863df1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/invalidation.js\":\"5d1915c9f453f144\",\"/knowledge-medium/pr-preview/pr-1911/src/data/kernelDataExtension.js\":\"81ded33a8090714e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/kernelPage.js\":\"626f90bf1af255eb\",\"/knowledge-medium/pr-preview/pr-1911/src/data/kernelValuePresetCores.js\":\"4bfb2d72ae3c09ad\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localDbCorruptionSignal.js\":\"a35262ad435c0693\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localDbStorage.js\":\"d5e295083dd3565e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localDbVfs.js\":\"075d9a4aed6eb5b4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localSchema.js\":\"2589b2c6ac65e8a4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/maintenance.js\":\"4865e506192ce317\",\"/knowledge-medium/pr-preview/pr-1911/src/data/mergeProperties.js\":\"e526d55388a318e9\",\"/knowledge-medium/pr-preview/pr-1911/src/data/metricsConsoleHook.js\":\"b7ff675edcaa88af\",\"/knowledge-medium/pr-preview/pr-1911/src/data/migrationsPage.js\":\"c13d49bec1155443\",\"/knowledge-medium/pr-preview/pr-1911/src/data/mutators.js\":\"0cf18bfaa51158a5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/orderKey.js\":\"a97d67652a7e7dfb\",\"/knowledge-medium/pr-preview/pr-1911/src/data/orderKeyPlacement.js\":\"4ae0ef09d9d96b1c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/outlineSurface.js\":\"e4d5b076e4f171de\",\"/knowledge-medium/pr-preview/pr-1911/src/data/pendingEditorContent.js\":\"7ee86b5b321c0fcf\",\"/knowledge-medium/pr-preview/pr-1911/src/data/pendingUploadsSql.js\":\"ad2fd14a768be17a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/pluginStateExtensions.js\":\"dd03a329e036d3a4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/powerSyncLogger.js\":\"43f0c887eb34be3c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/projectorRuntime.js\":\"3fc8b01e22f1917f\",\"/knowledge-medium/pr-preview/pr-1911/src/data/properties.js\":\"ba12035c29d42119\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertiesPage.js\":\"fd31c697124c539f\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyChildren.js\":\"7d7fbe15d65f1eb5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDefinitionFanout.js\":\"85ca42f6877689be\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDefinitionMetadata.js\":\"684578171fc4e1c0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDefinitionRegistry.js\":\"e51368c631d412b1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDisplayMode.js\":\"bf6a9ce857c4ff81\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyRowCreation.js\":\"0ea1fb62e3e903e2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertySchemaCreation.js\":\"530871fdd2eb2d98\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertySeeds.js\":\"7fd998e7925dbb0e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/recentsPage.js\":\"55a77715f49f9f80\",\"/knowledge-medium/pr-preview/pr-1911/src/data/refTargetComparableProperty.js\":\"1c031a80a30904e8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/referenceBlock.js\":\"1686ad642d7bf750\",\"/knowledge-medium/pr-preview/pr-1911/src/data/rejectedUploads.js\":\"8e4703f6ef6e44af\",\"/knowledge-medium/pr-preview/pr-1911/src/data/releasePowerSyncConnection.js\":\"1c296a2d4b400622\",\"/knowledge-medium/pr-preview/pr-1911/src/data/repo.js\":\"f81bc0e896167d69\",\"/knowledge-medium/pr-preview/pr-1911/src/data/repoProvider.js\":\"5d46815e18045fc8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/rowProperty.js\":\"2891549079411876\",\"/knowledge-medium/pr-preview/pr-1911/src/data/searchFilter.js\":\"b2ff94075e720fd8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/seedIdentityLedger.js\":\"edbe8b44b2efc84d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/stateBlocks.js\":\"90c127b6ff7ac506\",\"/knowledge-medium/pr-preview/pr-1911/src/data/structuralEditPolicy.js\":\"f5ef3f98a04bb797\",\"/knowledge-medium/pr-preview/pr-1911/src/data/structuralInsert.js\":\"0e5b2fe55a238e19\",\"/knowledge-medium/pr-preview/pr-1911/src/data/subtreeDelete.js\":\"d9d86d50cd277826\",\"/knowledge-medium/pr-preview/pr-1911/src/data/syncStreamLock.js\":\"ea15bb6764a87171\",\"/knowledge-medium/pr-preview/pr-1911/src/data/syncedTableSqlRecognizer.js\":\"1377c990a16325aa\",\"/knowledge-medium/pr-preview/pr-1911/src/data/syncedTableWriteGuard.js\":\"5a0e05b924e2b155\",\"/knowledge-medium/pr-preview/pr-1911/src/data/targets.js\":\"f59002edad11abab\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeColors.js\":\"72135794d350ad1a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeDefinitionMetadata.js\":\"9615c898008c4d6e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeDefinitionRegistry.js\":\"cafe2cf7d8c7ec4b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeExtraction.js\":\"7639c2b182442795\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeInitialValues.js\":\"e20874bb59afdf6d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typePropertyGroups.js\":\"ead6cd61485203eb\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeSeeds.js\":\"03e9510354211d33\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeTagger.js\":\"75513b56333427a4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typedRecords.js\":\"9459bef3c53380a3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typesPage.js\":\"67f823f3cd20a760\",\"/knowledge-medium/pr-preview/pr-1911/src/data/userPrefs.js\":\"a430f223c12b79f1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/userSchemasService.js\":\"00fa4092887a735a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/userTypesService.js\":\"695e6b0421846074\",\"/knowledge-medium/pr-preview/pr-1911/src/data/valuePresetRegistry.js\":\"a365ebfe75a4fe0b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/visibleChildren.js\":\"c949ebb17a04f275\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceConversion.js\":\"2bf7d71709c22dcc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceFirstSync.js\":\"e5fd9190d2247b24\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceIdNamespace.js\":\"46a1ba53e91f1607\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceSchema.js\":\"6f0dc41707d44398\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaces.js\":\"4e284e15d32a2030\",\"/knowledge-medium/pr-preview/pr-1911/src/data/writeAheadLog.js\":\"2bced692db9ab0c4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/BlockPasteShellDecorator.js\":\"9c4044fcf4dd023f\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/atTrigger.js\":\"e4191614a6c6ea13\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/autocomplete.js\":\"3fe71154b8bda9af\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/codeMirrorExtensions.js\":\"9804cda542aaf7fe\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/contentFlush.js\":\"285febde145f7429\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/defaultInteractions.js\":\"2c6d149eb6b61e8e\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/editSettleSignal.js\":\"b956ae79f6775ca6\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/insertImage.js\":\"c58b3e743095f8ec\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/referenceCompletionRange.js\":\"039444c17b039b9f\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/referenceTargetTypes.js\":\"1fd986f64c48e5e9\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/syntaxContext.js\":\"ecb8aef8dcf80d33\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/triggerMatch.js\":\"1aa20c8f10335a1d\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/AppRuntimeProvider.js\":\"f707f8c55dd1faed\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/BlockFocusShellDecorator.js\":\"6db0316d5278b752\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/ExtensionRenderBoundary.js\":\"a89e31b911931b5d\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/PanelContentRecovery.js\":\"c56bb0fa85cb6317\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/apiCatalog.js\":\"04c85be417ab45fe\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/appRuntimeController.js\":\"241790196c3acc9f\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/approveExtensionHere.js\":\"1d38e50d40f91263\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/armedCutAppMount.js\":\"3fa6a5df036b12f6\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/batchableKeyedStore.js\":\"0e79cd219339c035\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/blockInteraction.js\":\"71751acf4279d004\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/blockSelectionAction.js\":\"64efc3006f2b6f75\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/compileExtensionModule.js\":\"7a112571224eff58\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/compiledModuleCache.js\":\"f5cce150dda8c092\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/continuousGestures.js\":\"80c0fa219b1e0fce\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/core.js\":\"efc03853825377e6\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/defaultRenderers.js\":\"19391517bafd1907\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/definitionFanoutAppMount.js\":\"d68649c410036b5d\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/dialogAppMount.js\":\"0712832b0df3ae03\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/dynamicExtensionSeeds.js\":\"4d78cf0a878f7028\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/dynamicExtensions.js\":\"bf87fe1cdc4446bc\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/exampleExtensions.js\":\"f0731a5251380724\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionApprovalStatus.js\":\"d468e7ae26bee88b\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionLoadErrorToast.js\":\"327841c3364dd3c2\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionLoadErrors.js\":\"ee1665fb1cd67007\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionLookup.js\":\"7fee6bd743357efa\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionToggles.js\":\"b9ac9c0ae48fe502\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionUtilitiesCss.js\":\"8efeb18f54a7df89\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/kernelPageDeletionGuard.js\":\"d692b4cab439e8f1\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/liveRuntime.js\":\"df9947a3e09a8800\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/openExtensionsSettings.js\":\"240961f85943ff66\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/overridesCache.js\":\"c2087c4125bdc9b5\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/pluginIds.js\":\"c4187badd214d75c\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/processorRejectionToast.js\":\"9dd59b07abdff4bf\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/runtimeActions.js\":\"7dd3b0df18b2a741\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/runtimeContext.js\":\"edece18caf72274d\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/staticAppExtensions.js\":\"af4dd2cb9378e3ee\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/staticDataExtensions.js\":\"0112bd3bf264f138\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/toastAppMount.js\":\"42d7485cd2065e0a\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/useOverrides.js\":\"022731dff683f4dd\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/useShortcutSurfaceActivations.js\":\"3623c898f325ab52\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/discoverToggleTree.js\":\"479b598699bff719\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/facet.js\":\"6d8e7ced157a9917\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/resolveAppRuntime.js\":\"fc782da80a98dcaa\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/runtimeEvents.js\":\"21462f931a0213ba\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/togglable.js\":\"90a99fa21ae1810d\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/variantFacet.js\":\"7566298aec93586a\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/verbFacet.js\":\"54dbe3b14b440226\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/block.js\":\"efafa0db78a8321f\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/focusedChild.js\":\"ca024ce3cf6161fa\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/propertySchemas.js\":\"9e9171ed995c837d\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/typeRegistry.js\":\"d0f792dbd50957a5\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useAncestorCrumbs.js\":\"9acb6041700f0b85\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useAutocompleteListbox.js\":\"9f2bdd8b198b179d\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useDebouncedSearch.js\":\"8ee315c920793f70\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useDebouncedValue.js\":\"893411e57f85b4d0\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useFacetValue.js\":\"65c1d9918db5dc0d\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useIsFocalRender.js\":\"e05cd186d2f27542\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useIsReadOnly.js\":\"537fd85e1cea95bc\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useMaterializeBacklog.js\":\"bcfd63628edfbf7b\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useMinuteClock.js\":\"178cc694d6f2c184\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/usePanelLayoutProjection.js\":\"ff55739ce05e657d\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/usePendingInvitations.js\":\"b444346e0681e377\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useRendererRegistry.js\":\"51d6a6f25d9a1b61\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useRetainedFieldRows.js\":\"a57769eba3730ce6\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useWorkspaces.js\":\"58e3184a655c80e0\",\"/knowledge-medium/pr-preview/pr-1911/src/lib/utils.js\":\"0f29c68ff769b209\",\"/knowledge-medium/pr-preview/pr-1911/src/main.js\":\"77989a0fb6f374cc\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/MarkdownImage.js\":\"5e1018ad338c1784\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/blockSeparators.js\":\"2485f41a97f422c6\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/context.js\":\"f87483ab34cd7352\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/defaultMarkdownExtension.js\":\"db19c8f9de0f740b\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/extensions.js\":\"10c8569b370153ea\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/renderMarkdownHtml.js\":\"1b14b227ce64c104\",\"/knowledge-medium/pr-preview/pr-1911/src/minimal-editor.js\":\"739a9fa8bced91db\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/armedCut.js\":\"b4d4faaafdca243e\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/captureMediaVerb.js\":\"bbf19a7df53fa13d\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/clipboard.js\":\"b1519d4525ac1656\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/decision.js\":\"28f3149901ecaf91\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/operations.js\":\"507bcfa2c82edd57\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/account-header/AccountHeaderItem.js\":\"eb594ab826b0c629\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/account-header/index.js\":\"95eaf86f56278e62\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"28b1245ea064bdb1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/askAgent.js\":\"0da11726e80b7673\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/askedStore.js\":\"15295d1e1d11dac1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cce5610a21be7645\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/chipState.js\":\"5079252d9727415d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0f00d223b8b11ceb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/index.js\":\"2ff6639fde62a542\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1e41728a02705935\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/schema.js\":\"bbc9eabb5bea7d02\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8bc09fd7a77b333b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/BridgePairingDialog.js\":\"27daacae2682662c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/addMedia.js\":\"974aa63dc82765ff\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7ecfe552c41526e1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/block.js\":\"e70b30b1da3f39cb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/context.js\":\"7e56f9f6ba5865e1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b84e285ec25d8398\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/index.js\":\"ce830e24c0cbb45d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/outline.js\":\"0684e252b20da9ea\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/properties.js\":\"0a98a2198bf6b9ee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/refs.js\":\"fe4d54bc98ea6e48\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ba95d5d498bba614\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/search.js\":\"1c313f0009ee6f8f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/shared.js\":\"ac9ad404ceffd718\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"2ee61ae0af0de9ec\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/text.js\":\"4d8badc421be47c5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentWrites.js\":\"ad63bae31212aafc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/authoringCatalog.js\":\"fce2e651c454bfdb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/blockRefTargets.js\":\"de2ff37bbfb65866\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/bridge.js\":\"60b6ef6721f34ff2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/bridgeLoop.js\":\"4e9bee48515355d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/changeHistory.js\":\"91f919bdb046047e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/commands.js\":\"dd42af88c732a834\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/commentsCommands.js\":\"59b79de7c911db8d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/dataExtension.js\":\"12b9763b2539bd5c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/dataModelGuide.js\":\"4f4527bc3b45231b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/dayPropertyInputs.js\":\"91ee27004aa80458\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/describeRuntime.js\":\"ca7caa1fe38c7331\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/extensionLint.js\":\"cbcd096c0eb45e49\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/grainAudit.js\":\"528a804f21eef7f2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/healthCommand.js\":\"37173cae92e97f76\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/index.js\":\"64e79bafe347896e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/presetIdentity.js\":\"5f2ab72f6cada0c6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1034c9449628ab77\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/readMedia.js\":\"24bfe14ee39bf229\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/schema.js\":\"8f01614ccd0b5499\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/serialization.js\":\"1e14b060137260d4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/targets.js\":\"46fa6616ff0dcac4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/tokens.js\":\"6df0f58fc5fe4f2c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/watchEvents.js\":\"72f1dc2345ecd2d7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/workspaceGuard.js\":\"9fd2218696f88108\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/writeCommands.js\":\"08d3ec760985cdea\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/AliasCollisionToast.js\":\"adfd7499f4130b20\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/DuplicateNameBanner.js\":\"6a92ca2482b6ab5c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/collisionMerge.js\":\"8c9c0588e9ccb0bb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/dataExtension.js\":\"fd89fb2d6bdb47ba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/index.js\":\"3cd5c9690598ad81\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/mergeCollisionAction.js\":\"29e13c315c310819\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/pageStyling.js\":\"d9f168ffe9eccc78\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/rejectionToast.js\":\"bccebea9577a4959\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/syncProcessor.js\":\"6e7c2b51221e2bca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/actions.js\":\"43e8b8eb24495760\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/addComment.js\":\"080c56e73810b64c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/anchor.js\":\"df9253f5eb7f9e05\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/anchorState.js\":\"f5b41d782f67531a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/commentLinks.js\":\"4dbaba6f73f026ab\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/confirmThreadDeletion.js\":\"d4712294f461f3ab\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/container.js\":\"71b23d943aca1bfb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/dataExtension.js\":\"afdc152c85adc177\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/deleteComment.js\":\"692afb2734153594\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/highlights.js\":\"be063184681e1912\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/index.js\":\"5943f1c6190bf8f7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/linkedCommentsPill.js\":\"eeb20be12ef9057b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/margin.js\":\"1c48e8a131c7bbff\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/marginAnchorLinks.js\":\"00051a2a1d6d7dd8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/marginSchema.js\":\"bc096e80b7982263\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/newComment.js\":\"ac8db0c42c4cb9c6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/ownThreadPicker.js\":\"cd3bee2165463d26\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/placement.js\":\"5a25d28ad28bce91\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/queries.js\":\"2080b700cfe2d7fe\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/quotePosition.js\":\"54085765d1edba03\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/quotedIn.js\":\"ca1e7caf3044b51c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/quotedRange.js\":\"41a2113a22470ac6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/rangeRefs.js\":\"9d56ac12dc0d3a3e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/readHighlights.js\":\"8c7fe11f68290b40\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/readSelection.js\":\"eedef6b3d3b94790\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/readSelectionUi.js\":\"d57920e78404bcdc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/reanchor.js\":\"a09b18a94902cdfc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/schema.js\":\"db182295620cf6d2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/scope.js\":\"e1150eb72aea2b6b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/scopeThreads.js\":\"09af0799d000b3b6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/splitRetarget.js\":\"02bf0e41a97a5e4f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/suggestionCard.js\":\"ae1efed5f7d04bbd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/suggestions.js\":\"9e653e5296dbcef1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/summaries.js\":\"557b714af44c36c0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/summaryBatch.js\":\"6b5c0e36f31bffe6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/surface.js\":\"1209202cf9a78996\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/threadNavigation.js\":\"269ac47227b3426b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/threads.js\":\"1f7ffd6fa2bdc877\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/ui.js\":\"2218b86a2b0ce7b7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/uiStore.js\":\"10333ce6d05f0653\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-intents/appIntents.js\":\"c7ab4c6fc4f538f8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-intents/index.js\":\"7bb021957b3aaefd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-update-prompt/index.js\":\"1ec41b551a9d11c8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-update-prompt/status.js\":\"b5f25ea592773ac7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c183e856d044edf8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/MediaBlockRenderer.js\":\"f5a832e3ab77b26c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7322e3190c67d2c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/MediaUploadReconciler.js\":\"e9179b0215005909\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/assetDownLane.js\":\"12c378f779b6858a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/assetResolver.js\":\"c807c30769d298f9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/assetUpload.js\":\"be3aa5f43f0dae77\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/attachmentCleanerIO.js\":\"59d7b924f6480f32\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/supabaseAuditIO.js\":\"fb28ddd7dca472f2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/blobStore.js\":\"fb32604cb59d0b01\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/browserMedia.js\":\"9f14f27c6bd8efb9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/byteStore.js\":\"c4e09366d97b9353\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/cleanerIO.js\":\"e8cb12b06d924cbf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/cleanupAttachments.js\":\"764c2582368318f7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/dataExtension.js\":\"1e7aaa19c5a2c44d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/downLane.js\":\"81f22eaf14f17404\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/index.js\":\"e19439fc533e0eb4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/insertImageContribution.js\":\"b27c6aa8b7abc43d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/laneArming.js\":\"27aea8c43034b11f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/laneLock.js\":\"43c8f94572e64c32\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaBlock.js\":\"1896f76bd6fdb623\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaCapture.js\":\"0f6affdc7bc1a102\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaLanes.js\":\"68ec6869144f3cae\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaViewers.js\":\"c7f3695b81254cdf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaViewersFacet.js\":\"ab6c61080d9318db\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/pasteCapture.js\":\"94ee061f10e40930\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/resolver.js\":\"7fdb5d2beb81dce6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/retryUploadsAction.js\":\"f420ef1d4c54da2c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/storagePaths.js\":\"4c0e2ef2d2f8efd1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadDrain.js\":\"523ef53beb2cce9f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadLaneStatus.js\":\"68f98ab8de56265b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadReconcile.js\":\"6d27ffb0cfac17da\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadRecovery.js\":\"d54a486a39d93f7d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadStore.js\":\"a56646982c0da752\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/useAssetObjectUrl.js\":\"ed05ab5781d8202b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"c190fd40312aad98\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5d68754f356c625f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/facet.js\":\"44be73131ab07621\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/index.js\":\"484bbd815fd572a3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/prop.js\":\"54927bbe5c0451fd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/BacklinkFilters.js\":\"0bcf5b8062f31dac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"fd47027fe50d7527\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/BlockEntry.js\":\"3eec52b1cb51970f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/LinkedReferences.js\":\"6dbafc4d37147ed5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"f25f883aad649ebb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/dailyNoteDefaults.js\":\"ede4269178ce1b82\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/dataExtension.js\":\"c08f1be886cbef94\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/edgeExclusions.js\":\"5a4ecc7ef53599a7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/filterProperty.js\":\"e9769ad457116406\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/index.js\":\"decc337993ab5a60\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"81a2ea73a12a5818\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/applies.js\":\"40e54574db3f9626\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/countQuery.js\":\"88de42892fa33d4e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/expansionStore.js\":\"294617b2e7dea9b8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/index.js\":\"fb0c44487ae06e48\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"da363c5a5b4ec591\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/presentationInvalidation.js\":\"0b2127bcc12e29d5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/propertyEditorOverride.js\":\"adb8c47e9f1fd462\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/propertyFilter.js\":\"f41f259ad0da602e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/query.js\":\"361b06229ef985ef\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/resolveFilter.js\":\"d5e237668fb42ab7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/sourceBatch.js\":\"3529c997c8bb8b01\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/sources.js\":\"97a261ddcf006f81\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/useBacklinks.js\":\"3f94a18077678cea\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"0da537e1d7adacdf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/BirthdayCelebration.js\":\"01ab3231edff4c03\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/BirthdayOverlay.js\":\"e9e6cba8d431492d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/gate.js\":\"d8258c5931d10f74\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/index.js\":\"d7e668dd9e1a044c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/wolfTheme.js\":\"616da003dc649cfc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/BlockDragLayer.js\":\"627535b179d78119\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/dragController.js\":\"6bf7f429f7f1f244\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/dropTarget.js\":\"05eb06eba5c3ea78\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/index.js\":\"50e97cba91325474\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/projection.js\":\"307a3f344439ba8a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-info/BlockMetaCard.js\":\"d0ec17df2fa842a6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-info/index.js\":\"f507a65633107a6e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/AddTagDialog.js\":\"7e204fb851d27365\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f2ae39c66afa2642\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/TagNameIssueHint.js\":\"a00051a9415ded8d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/addTagAction.js\":\"a7b5b29288766c23\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/appendTag.js\":\"5f0873297a6460c2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/config.js\":\"c5a1bd9fd3ad44ef\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/dataExtension.js\":\"602f3a4a6989ba7f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/index.js\":\"298129b1c9e77419\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/propertyEditorOverride.js\":\"d5004587ca0e6d2b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5df05f0208e574f2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"b5e01861aa5fa55b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1602ec82269e7a81\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9ae81171000b5174\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"91715a76b510e30f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/index.js\":\"aff1caab804bed37\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"8ffb62b7388cf1f4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/CharacterCountItem.js\":\"72356c1cb53999f0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7212c675cb33ee73\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/actions.js\":\"d016ef9cd3a8f6cb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/blockType.js\":\"435711faa6108202\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/charCount.js\":\"8908800d46505b7e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/dataExtension.js\":\"5148e5363b8e81be\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/index.js\":\"f4fa9a919cc22bc5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/profiles.js\":\"0d4579448cbaa8cb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/properties.js\":\"77b1b530af111601\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/subtree.js\":\"62d8c23b47531a29\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/textCounts.js\":\"a9a0916f931c1a40\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/colemak-keybindings/index.js\":\"a043b301ddf62713\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/CommandPalette.js\":\"fd8af6afb771046a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/HeaderItem.js\":\"3286c4423e02d123\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/context.js\":\"d036e73d65a1718e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/index.js\":\"a5ca30b06e850f86\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/selection.js\":\"05bcb860a4b328bd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/toggleStore.js\":\"df05a7f0a7cd714f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/useCommandPaletteActions.js\":\"230830f4ee1d1dcb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/ContributorBadges.js\":\"25abbbe665a07a46\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/ProfilePicture.js\":\"1d74ac750e4ef29c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/author.js\":\"ce1ac3118d922ed8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/codeMirrorExtensions.js\":\"a040371f810149ba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/dataExtension.js\":\"0a427efc96d13161\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/index.js\":\"d16fa6819ef11e9d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/mentionAutocomplete.js\":\"94ff637df3be35f6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/processor.js\":\"5c72649b4c8e3380\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/profiles.js\":\"76348ba31d539d9d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/queries.js\":\"46b0ab1fbe5a86b5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/schema.js\":\"7137df590721057a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/useCommentAuthor.js\":\"cb0291756c564fda\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"502e5ec3ac37c27e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/followOrigin.js\":\"127998256c671f85\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/index.js\":\"8ec649fe16818850\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"157fd115bff5ea75\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5918271540ffdde0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/CalendarGrid.js\":\"6c7ba0ae9c70dee5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DailyNotePicker.js\":\"2e555c5d8bf80d30\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"bccc598b8399a8e2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DateNavDecorator.js\":\"7e235d5155f9d587\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DateScrubOverlay.js\":\"16fa9ff2bc548b84\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DayPropertyControl.js\":\"84f75b625dc45ef1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DayValueReferenceControl.js\":\"5d340692ceef0355\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/HeaderItem.js\":\"c84f49d4fa9708e4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/ReschedulePicker.js\":\"9786c80e57535609\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1deeb79b042e913c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/actions.js\":\"9deae020cfe8bfea\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/blockDateAdapter.js\":\"967ce712a469ed5f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/calendar.js\":\"d77eddcea9dd7e56\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dailyNotes.js\":\"6040697f4690e941\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dataExtension.js\":\"da31b461a46eab37\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubActions.js\":\"20cb65572b6a349d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubGesture.js\":\"45d78853cabe4720\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubGestureActions.js\":\"cb4ee77d142bdd57\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4080999a047e915a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dayProperty.js\":\"ba2c2f7f467f585d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"b376cc72653c5424\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/deletionGuard.js\":\"76d8bf3c1984677c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dueQuery.js\":\"cafc472d577364ae\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/index.js\":\"3899f26e99e49045\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/landing.js\":\"00d1857e6023d0fd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/localSchema.js\":\"e5e1218f616bde52\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/referenceDateAdapter.js\":\"cca8ceef5399d065\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/rescheduleAction.js\":\"89aed8b86231a3a7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/schema.js\":\"f52b40e87515c0e9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/spreadBlockDates.js\":\"ce61a362c99a988d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/spreadDatesAction.js\":\"f4c1d0a84ae51188\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/today.js\":\"87bcac6d3fec4bff\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"90e04459d2e4b93f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"8bfb3515e200dca9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/audit.js\":\"62bd440f44a34a8a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/auditAction.js\":\"73cfbe77255e625e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/auditRanges.js\":\"e4383ec600d4ce42\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/diagnosticsSource.js\":\"674f9675a59c76e7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/divergenceScan.js\":\"112ab696dc84d9a2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/index.js\":\"672b76132297041c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/propertyChildrenChecks.js\":\"faf156af9dd025db\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/referencesMirror.js\":\"bb78baba2180971b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/rowJson.js\":\"12bb57239ac49f7a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/schedule.js\":\"f8f24c18fb68ed3d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/store.js\":\"e9cf206be2c03db2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-maintenance/action.js\":\"e559003c542959b4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-maintenance/index.js\":\"9591b55290935308\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-maintenance/plugin.js\":\"ffc037f44a34348a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d5fbcaf8cc69ee88\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/actions.js\":\"5c12280fe1121d13\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/changeMarker.js\":\"72706b02313fa62c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/diagnostics.js\":\"3a6cd388dd7a7838\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/fileSystemAccess.js\":\"90f437a30bd7f0eb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/filenames.js\":\"6d57300ba4da38bc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/index.js\":\"e3f35022f875eda6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/mirror.js\":\"2df67cae162951e6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/runLock.js\":\"e3324ba9d66c4721\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/runtimeHealth.js\":\"7ded8d6302e9591e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/schedule.js\":\"ce051cdd77ce4e3a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/store.js\":\"30a7bc136e162383\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/default-themes/index.js\":\"3335e46eca543d05\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/default-themes/themes.js\":\"67f2692d7b1d7a70\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/diagnostics/facet.js\":\"31888dc669bbb12e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/diagnostics/useDiagnostics.js\":\"822ded49ebe19a6a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/dismissals.js\":\"2908be25a61d38ec\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/index.js\":\"8cf6564997cdbdec\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/status.js\":\"d1b3faea401d7908\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/store.js\":\"3af5d328f940612a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"26be6cf36dd50b1b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9c198d834657b723\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/actions.js\":\"c310bb73fc733190\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/config.js\":\"bf5a34fae53b3dfd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/dataExtension.js\":\"03ddc0721e34a8fc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/effect.js\":\"0021efd075bea58f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/index.js\":\"450b0932c1badb29\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/propertyEditorOverride.js\":\"e7fa9a1b5d2d338d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/useToggleTree.js\":\"1fdaec897181e7e5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/ExtractTypeDialog.js\":\"6e3fbf6223824857\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"d9cba22de4fc7bcb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/PropertyShapePicker.js\":\"0363f307bcc2ff0b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/action.js\":\"c17ef041b7c5fc52\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/index.js\":\"34c34af3b9c136f2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/FindReplaceDialog.js\":\"03f48d6a1fb192ca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/HeaderItem.js\":\"9b78981286191ca8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/dataExtension.js\":\"a580d5fc7c214c43\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/index.js\":\"6dad058f373fc1a4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/search.js\":\"fe61d226e3174785\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/toggleStore.js\":\"26ad4c941c87bd00\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/LocationPropertyEditor.js\":\"254d81e90caa458b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/MapView.js\":\"9bee7316b99a72e6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/blockTypes.js\":\"94b431efa7fb90c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/codeMirrorExtensions.js\":\"d48d025558c5b1cd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/createOrFindPlace.js\":\"6b8135f866a76eb8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/currentLocation.js\":\"4fac66bce4791772\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/dataExtension.js\":\"6ead9c4dc0ede961\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/geoContentDecorator.js\":\"56e9c829ac8fbc47\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/googlePlacesClient.js\":\"21c62f8f312c540f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/index.js\":\"a25a697d6c06ebcf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/locationsPage.js\":\"abf7fc05398ef589\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/mapViewport.js\":\"35b964eff3d75ff1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/pickCurrentLocation.js\":\"f96e61d6a22dece9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/placeAutocomplete.js\":\"af0fd6193cc98edf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/placeNameCollision.js\":\"189a1b68fef59d78\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/properties.js\":\"9bfc19aa16991a71\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/propertyEditorOverrides.js\":\"85ad743ee7c5f993\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/query.js\":\"a048442793f55d7a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/usePlaceSearch.js\":\"d5a8e4a660feafbd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"cad3a4c5fff7aebb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"9964156308af942e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"670f106202ed60ca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/config.js\":\"925bff58dfff2c79\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/dataExtension.js\":\"0a1b7af20d912a17\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/facet.js\":\"c1bc9b21630cd091\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/grouping.js\":\"73ec306d208a6ac4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/index.js\":\"b8bb7ab73a848302\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"6e10bcf6886b8fe0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/query.js\":\"413f9dc4935ea2d9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/resolveConfig.js\":\"303e832294daf0dc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bb94249702a4553f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7092536c9540602e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/HtmlDocumentContent.js\":\"8ed9852e82142ab7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/HtmlFrame.js\":\"5ab1a9f889081fa6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/actions.js\":\"77048aee46c98a95\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/blockType.js\":\"5b848fbccc63fd58\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/confirmRunScripts.js\":\"2ebc821bbb1df90f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/dataExtension.js\":\"b7e44f618e956110\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/frameAnnotations.js\":\"9241cb328e40b054\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/frameDocument.js\":\"e4ceb14946981b43\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/frameTheme.js\":\"f2dca72b678f6537\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/index.js\":\"0f5b01992174b141\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/scriptConsent.js\":\"0d697045ad9441c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/sourceMap.js\":\"fd48bca4b5799f84\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/useDocumentScripts.js\":\"ae13b0e41ee655c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/index.js\":\"c9993918f3aa5ee1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/record.js\":\"20393fe9e7961afa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/recordStore.js\":\"aea83a902763cf14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/responsiveness.js\":\"2067d33da6e62cd8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/schedule.js\":\"7ff41df0e6d2b250\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/sessionContext.js\":\"36bd901a9baa5dfc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d84aa30309c062ac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"40dae5240ef8a876\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/actions.js\":\"c37918508f831386\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/config.js\":\"7d53dfe866b58767\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/dataExtension.js\":\"1c4bd94dd334e2cc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/effect.js\":\"f2a1413d01a7d14b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/index.js\":\"ce3bd3f649503cde\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/keyCapture.js\":\"7084f4ba718dbd2a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/overrideStore.js\":\"412e1ad8afc2170e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"7d484520de9f8e04\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/HeaderItem.js\":\"7ea038f8ccc71a39\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/LeftSidebar.js\":\"61ae45b4ae150bdf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/actions.js\":\"58cf957e524af7b3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/facet.js\":\"67e9c7fcec440d13\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/index.js\":\"de5bd5d7622ec5d3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/shortcuts.js\":\"6315726ac7d470ba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/toggleStore.js\":\"47a35f09e88d513f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/MergePicker.js\":\"6fa7c5e6a3c3f696\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/index.js\":\"d9b267498b687ef0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/mergeAction.js\":\"bf14f6264f3679ab\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/strategy.js\":\"0fcb9bce7f843888\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/Button.js\":\"5682ed1385477237\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"09a3e908c2860e61\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/defaultItems.js\":\"3b3ea927a553753d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/facet.js\":\"49dd27522b0324c4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/index.js\":\"9b221937d84e981c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"74faeca8f7596e09\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ff3533e2da89f9bb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"a5800801fda4da7c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/facet.js\":\"55741c6e32279df2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/index.js\":\"dfb17ff2ded5621b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/MoveDestinationPicker.js\":\"48c23f809dfa3f97\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/blockSubtreeMembership.js\":\"06a069785b64ddb5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/contextMenuItem.js\":\"807d9dc0eec5ce68\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/index.js\":\"996af19f0613b93a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/moveAction.js\":\"bbd77069a9e333ad\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/moveBlocks.js\":\"8f3c5368471e7083\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/selectionAfterMove.js\":\"a56f206b5bcb846b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/TutorialBanner.js\":\"20e09ee0e51dd65a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/action.js\":\"f4837fbdfdaa8d0d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/bannerDismissal.js\":\"d485bc5ec654c28a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/documents/cheatSheet.js\":\"a2d95648cb682c00\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/index.js\":\"83f5a5b5eb178a2f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/keys.js\":\"1fbfab1b84688d62\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/landing.js\":\"4719e3587670c301\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/outline.js\":\"2c595ebbbe1c32f9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/seed.js\":\"afb8a2b1705b8362\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/PerfTrendDialog.js\":\"fdb406c591e98f7e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/analyze.js\":\"209c236fcab9636a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/diagnosticsSource.js\":\"5e1edbe84244098d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/index.js\":\"b958b41486b0e1eb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/load.js\":\"d2d78c66f1633802\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/monitorRun.js\":\"2b4e308e77f1d583\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/schedule.js\":\"7c0c471c23d1fb87\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/series.js\":\"9a0bef580f30ea3d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/store.js\":\"715e31f7e9c3a569\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/trendAction.js\":\"629b3d0445b7eb69\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/verdict.js\":\"0e1637e7c0d45f36\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/plain-outliner/clickToEditAction.js\":\"b8710cfd53d39204\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/plain-outliner/index.js\":\"38d31d18bb1ca5ac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/plain-outliner/interactions.js\":\"ee935515aa8b15c8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9cc3ff38b4ec1b64\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/MigrationGate.js\":\"5ec66629c57d9d19\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/MigrationGateDialog.js\":\"479d0e298c146b2f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/action.js\":\"b971a05000160e34\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/index.js\":\"b35238cb054a745f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/localRunMessage.js\":\"a73a8e5167d8c81b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/plugin.js\":\"e929d0acbcaffe46\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/progressReport.js\":\"3b9819850f0d284b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/sweepProgress.js\":\"6ba13989faf3c7cb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/FieldRowRenderer.js\":\"e1279e896ab26ec3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/ValueRowRenderer.js\":\"308126d164b07a43\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/actions.js\":\"98d476d8ff16f08d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/autocomplete.js\":\"6989cfec67431aa5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/fieldRow.js\":\"b03a640001ec4b3b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/index.js\":\"7b4356b41c1f8a03\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/referenceWarning.js\":\"6157e7255ef0c758\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/valueAutocomplete.js\":\"5d7cc700e7b901b9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/valueSchema.js\":\"42dc49de1909b5a6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/HeaderItem.js\":\"f30650e21a1f31a1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/QuickFind.js\":\"689e60197344e0a0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/index.js\":\"7596f64b02045c60\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/recents.js\":\"f787b0fdcde22941\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/resultItems.js\":\"a87b933c1c9cd200\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/selection.js\":\"c5f30d5387d1fc5c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/toggleStore.js\":\"f205d7ca8484904e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/HeaderItem.js\":\"81c06453902b755b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c32d1b937960f6d5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/grouping.js\":\"2427d6257deda89c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/index.js\":\"a4f74a0c03baec0f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/target.js\":\"f152880fd7fac2ca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/codeMirrorExtensions.js\":\"a8c737b8597574f2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/contentPrefill.js\":\"7ba5282dd1918fa2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/dataExtension.js\":\"b22d404322be97aa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/index.js\":\"4eb0cf1a424d1744\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"9a278e07ada4c630\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/invalidation.js\":\"920544de38aec067\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/localSchema.js\":\"40081ed3bea84e5e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/blockrefs/index.js\":\"b597567d21b16d36\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3f46a739ef5727cd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/index.js\":\"ae9788fd5ac7a2d5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/referenceNode.js\":\"ad4267f4cc249e8b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/remark-reference-occurrences.js\":\"92c7a7e900b73b7e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"fa98eb660d1c257c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/index.js\":\"b75bba315b0a3ba0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fad423bfc21d5986\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"277c6bf0f47119eb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/mergeRetargetProcessor.js\":\"a1b43b80e7c9e9bc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/parseFence.js\":\"816aab27f038100c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/referenceParser.js\":\"c8565c50fbc62f50\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/referenceProjection.js\":\"b85795372f5fa5c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/referencesProcessor.js\":\"4840caadc89fcb7d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/renameProcessor.js\":\"76a302be7b2bafcb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/spanReplacement.js\":\"7c5174b3e24842b5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/htmlToOutline.js\":\"3c1f4a46486baead\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/index.js\":\"95be9344e419aacc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/normalizeClipboardDom.js\":\"00de49bd98b66ae3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/pasteDecision.js\":\"681349cdf71cd5ff\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/action.js\":\"8422f5b6b971260d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/blockIds.js\":\"7cebe97271f2da8f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/content.js\":\"f70570eb1d31a38f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/effect.js\":\"68dfcb3acae469a7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/ids.js\":\"1ccf3042a4b925b0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/import.js\":\"fbe3a87173e14ade\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/index.js\":\"8209ca86dcd8f43c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/plan.js\":\"0afe1fb1bfec58ff\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/plugin.js\":\"fce0f9339c6fb2d9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/promotion.js\":\"c0412f1d4d671d1a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/properties.js\":\"70d609191703e498\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/references.js\":\"e0766f0e799b3766\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/report.js\":\"9825ad01aeba1a91\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/roamMemo.js\":\"3e790eb36f50ac7e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/runtime.js\":\"2a35475bd6f102f1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/schemaReconciliation.js\":\"7954262e338ec17c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/srsMarkers.js\":\"a5cbc47376259377\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/todo.js\":\"59cbd1551f13fcf6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/typeCandidates.js\":\"7dfe8e146c0a3684\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/types.js\":\"e686240222394f53\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/search-health/index.js\":\"44778825f6440e86\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/search-health/store.js\":\"733164aa1e514150\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/HeaderItem.js\":\"349c7951d91cd539\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"5dfef0f656135834\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/index.js\":\"909580c3588750d5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/model.js\":\"571eff100bd95fcb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/toggleStore.js\":\"7420305d696dbdfb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/useKeyInspector.js\":\"d9c0f050ea5d158e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"7179b812f47804f3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/ShellDecorator.js\":\"dd59b8de3105f81b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/actions.js\":\"a0186930e32117a7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/exclusionsFacet.js\":\"79f8407d618f64c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/index.js\":\"4fb9bca3f2805efd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/shell.js\":\"58d2faf6a1d8668a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/surface.js\":\"82105d4cfa5406b5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/walker.js\":\"ba6efb423516c7f5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/RescheduleToast.js\":\"13cc4cf266cbd3a0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/dataExtension.js\":\"37ab6888a7afdb4d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/index.js\":\"8dd0874db82a0f16\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/indicator.js\":\"9e0e473cb7e2ecdc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/moveSrsState.js\":\"77e17611c94dc7da\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8831ae0e758df4e9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/scheduler.js\":\"03f848e6cd617ad6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/schema.js\":\"35660d0f49e64b3d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"c7d1b25b3417c45a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/srsClipboard.js\":\"fe745b7b289d7fe6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"74b1b48090de492a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7ed2a2c45280d126\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/DeckPicker.js\":\"a529a97751d4c556\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/ReviewControls.js\":\"9d1d1c85cd4bef76\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/ReviewDeckRenderer.js\":\"9dda61824beb37df\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/ReviewSession.js\":\"f33e87821a765dd8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/actions.js\":\"62a068ccf0e906d7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/archive.js\":\"ddce495f3da70c42\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/dataExtension.js\":\"eae33f0d67f3a3c6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/deck.js\":\"d50de4167f2e6c1e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/dueQuery.js\":\"f4d52f23274fe58b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/gradeDecision.js\":\"467f6d2fe5993e57\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/index.js\":\"82b6ed0833907299\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/keyHints.js\":\"e02d7fd7221a744b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/reviewCardLayout.js\":\"2bcf9fe40f8803f1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/reviewProgress.js\":\"de84e4518a1cf6bf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/schema.js\":\"6d69d7d534e88fda\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/useDueCards.js\":\"1450acdcd96bf17e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/startup-metrics/index.js\":\"68c0d61076174896\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/startup-metrics/record.js\":\"3730ef3e967b4c98\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/storage-persistence/index.js\":\"55303518c44f8c5c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/storage-persistence/persistenceStatus.js\":\"1f1783424a5c4ba6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/storage-persistence/requestAction.js\":\"716f31c1ad5c0aae\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/TypeChipsDecorator.js\":\"f6826fe4f3625296\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/codeMirrorExtensions.js\":\"a7086620514dc1ac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/index.js\":\"7bd987eff00fd5bc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/typeAutocomplete.js\":\"810aba5b32ae259c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c8fbb6dfb3befa93\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/actions.js\":\"da694b5ce39b6cf0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/anchor.js\":\"7b12eaaa706eb4b1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/events.js\":\"8adccb5ee3073f8b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/gestureActions.js\":\"bcbc6ec88bf4f926\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/index.js\":\"d6410c0f4a2d9ad4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8ae6b4cc0b32ea52\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/sync-metrics/collect.js\":\"473be1972fe89f49\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/sync-metrics/index.js\":\"a91e71b8b649f1f5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/sync-metrics/record.js\":\"cf5749ad78b93278\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/RejectionDialog.js\":\"a71133e985d2336b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ebe1a575c10640c5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/index.js\":\"add48229a3ab7899\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/model.js\":\"d3f1c68e29bebc46\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/queueCounts.js\":\"0f684bd4ff9aa2be\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/rejectedHelpers.js\":\"27e843171ffcdec8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/rematerializeAction.js\":\"774136d832fbe9f3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/useHysteresis.js\":\"aeb033dfbbb5069b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/ColumnHeaders.js\":\"1411b0af4dc99623\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/QueryUi.js\":\"060b2dc7d7d07e41\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/TableLayout.js\":\"7a2acba95c63c1ec\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/actions.js\":\"2b3e8d3c2c604c78\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/cellEdits.js\":\"cd4240f367cfe6ba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/childrenViews.js\":\"e85a527e7af19e4a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/columns.js\":\"b52afd4a8b73705b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/controller.js\":\"ef33c5018968a17f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/convert.js\":\"8053d8fa9360ed01\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/dataExtension.js\":\"b9d1f6fd084c343f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/index.js\":\"e40e7dbd685233df\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/keys.js\":\"b599ab25a1f6c3ee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/model.js\":\"54b6c586560fb4a6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/QueryText.js\":\"bed635686d2d3bf4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/backfill.js\":\"63aa74a93a5f0f98\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/completion.js\":\"9e3cddbb017586c7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/format.js\":\"726ff0acb61e8cf7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/parse.js\":\"1b00a9ea2e3b93d7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/queryValue.js\":\"008ef3aceb221dd5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/registrations.js\":\"6732c6dfae432a99\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/source.js\":\"b19b5c2d6f7d0cf0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/registry.js\":\"f3d5d104bcd8338b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/rowGutter.js\":\"76ed45276c00a5f3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/rowVerbs.js\":\"36dff6da2502a803\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/schema.js\":\"17c4f1ff09a3e901\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/sort.js\":\"c65ba8f24381f188\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/theme-toggle/effect.js\":\"35174e39a08782f2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/theme-toggle/index.js\":\"1abbc1fc7a15b3c2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/theme-toggle/theme.js\":\"2aca0a166d42ea58\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/actions.js\":\"104c37972056b707\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/dataExtension.js\":\"4d88a92cc2d07ce6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/index.js\":\"42f6bc2ffc4a99b0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/schema.js\":\"a7d7051bae8248b1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/TouchSelectionLayer.js\":\"47324aba908e393d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/actions.js\":\"1a403575ae6c016c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/defaultItems.js\":\"63c3e2102b18eac0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/facet.js\":\"9d9cb98c6f8c9761\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/holdRecognizer.js\":\"ce59914009dad1d3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/index.js\":\"04833867ec2866a4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/update-indicator/UpdateIndicator.js\":\"bb39f43f25efda16\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/update-indicator/index.js\":\"8735be2fe3ff74b7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/update-indicator/loadTimes.js\":\"5a1e684512a529df\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/VideoNotesRenderer.js\":\"44b796dfed28f9e7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/VideoPlayerRenderer.js\":\"95765f906f04bb76\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/VideoTimeStamp.js\":\"e9277055fab4cf03\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/actions.js\":\"e1d7a43d26ee2ce6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/index.js\":\"7b94d5f60d7fd7cc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/markdown.js\":\"7e4736e63a08d90b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/notes.js\":\"9cfba3f964408251\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/registry.js\":\"818608e5db4dcb91\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/remark-timestamps.js\":\"3a15a7194dce7aba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/view.js\":\"0b66658f04316bcd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/LinkHints.js\":\"1e1b2d3ac0f27daf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/index.js\":\"f8fd8a80420c4b37\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/model.js\":\"177435db0e85b8d2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/settings.js\":\"a0ddd2a5945c0154\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-normal-mode/actions.js\":\"69aaf3cd482dde62\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-normal-mode/index.js\":\"af7f8bfdd10c4ef8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-normal-mode/interactions.js\":\"dd3ab6f742b596a5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/workspace-header/index.js\":\"9b9ed95b8a2fdd66\",\"/knowledge-medium/pr-preview/pr-1911/src/registerServiceWorker.js\":\"f855482f01be6b2c\",\"/knowledge-medium/pr-preview/pr-1911/src/requestPersistentStorage.js\":\"40e4660f689b7231\",\"/knowledge-medium/pr-preview/pr-1911/src/services/authRequestDeadline.js\":\"7c2a90172d92bdc3\",\"/knowledge-medium/pr-preview/pr-1911/src/services/authStorage.js\":\"ca6a709b6f8812ba\",\"/knowledge-medium/pr-preview/pr-1911/src/services/powersync.js\":\"487fe08326934480\",\"/knowledge-medium/pr-preview/pr-1911/src/services/supabase.js\":\"4b16518c75c422b4\",\"/knowledge-medium/pr-preview/pr-1911/src/services/uploadErrorClassifier.js\":\"9dd2c1c8925c0a3c\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/ActiveContexts.js\":\"0afb0db05e752cfc\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/HotkeyReconciler.js\":\"1e5562baaadc9ee1\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/WipeLocalDataDialog.js\":\"1a64a97196bd33ea\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/actionDispatch.js\":\"22c91b315da5cc00\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/actionRefItems.js\":\"c83832998064772e\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/applyKeybindingOverrides.js\":\"b95ef7b3db0e4047\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/blockActions.js\":\"497b97a822ca7b6a\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/blockMergeGesture.js\":\"24114efa206c300c\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/canonicalizeChord.js\":\"2746a1be08976e92\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/defaultContexts.js\":\"b54bb5e64a2d1acf\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/defaultShortcuts.js\":\"57e85dbf825e7364\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/effectiveActions.js\":\"5a45d6450c663024\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/gestureAction.js\":\"a1c9d0f76a6ff27b\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/gestureBinding.js\":\"3d1d12cf13d16457\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/holdRegistry.js\":\"1357fafb8f5a7c74\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/keybindingConflicts.js\":\"cb6976ff9bcee9fe\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/keybindingOverrides.js\":\"e561e5dc7dacd631\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/pointerAction.js\":\"0de139e84427b454\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/resolve.js\":\"3629a19e37d1bd0e\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/runAction.js\":\"aee1d4b57745f1d4\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/sequenceMatcher.js\":\"0fd782c729a74798\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/types.js\":\"4b2c75654b0d961f\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/useActionContext.js\":\"342deecf14289da0\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/useActionDiscovery.js\":\"3e51de5f2034c8d5\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/utils.js\":\"ff0cee564080398f\",\"/knowledge-medium/pr-preview/pr-1911/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1911/src/sw/bootStore.js\":\"6e00369fe58a1231\",\"/knowledge-medium/pr-preview/pr-1911/src/sw/previewDatabases.js\":\"01c6259141a579e1\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/byteTransform.js\":\"0aae68128ce5d22b\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/attachmentCleaner.js\":\"8e8bc59961703d65\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/attachmentParts.js\":\"3235bfed8178c357\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/bundleParts.js\":\"e2a8dc032e308261\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/bundleRecord.js\":\"61c9b39456aaa64c\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/manifest.js\":\"4fe55f95733c63b8\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/takeBundle.js\":\"30143dcc906f6974\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/verifyBundle.js\":\"fa528051859a3ceb\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/cleaningStage.js\":\"7641f59b7f2e67c0\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/conversionKey.js\":\"9fb6adef01b55ecd\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/conversionServer.js\":\"6d37ebd9a896707c\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/flip.js\":\"866ebd7e5cc144f5\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/flipAttempts.js\":\"01a93186f45de8a6\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/pages.js\":\"ac4fc0b48839d76b\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/preflight.js\":\"5a6409431158a9c0\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/reseal.js\":\"8b0ce1d1056bac6e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/runConversion.js\":\"fdd90eb490d3799d\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/runLock.js\":\"b02713e46e53b76e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/sealing.js\":\"e1403e5b4b6c63cf\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/sealingStage.js\":\"7380cbfbe4b4972a\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/stage.js\":\"4a505cf1564bbade\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/verifyReseal.js\":\"6e7220bdbc4d0515\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/aad.js\":\"11debb57453e19bf\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/aead.js\":\"4f5b4741760d0d95\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/base32.js\":\"8765d78a3bfc6677\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/base64url.js\":\"cc069075d787a279\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/binaryEnvelope.js\":\"a1f6a025b7179e8d\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/byteAead.js\":\"3eb8c7912c4d2a14\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/canary.js\":\"c20a93f59e43ebe5\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/contentHash.js\":\"f8cb7d2094b7c0cb\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/contentKey.js\":\"74043376493fb332\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/derivedIdNamespace.js\":\"ffec099dc77f4144\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/envelope.js\":\"175ae3b76cdac6ed\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/hex.js\":\"eb65489cfde8179d\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/sha256Hex.js\":\"a6441dd702bf701e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/workspaceKey.js\":\"aa09e5c15ff2c920\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/conversionState.js\":\"175a44322f4d6e1e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/createEncryptedWorkspace.js\":\"92429273046be01e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/pastedKey.js\":\"200a85c9a12b95c3\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"639695371e8686ac\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ef0d85bc1e61b32d\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/keyStore.js\":\"8c26737f12b34663\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/mintWorkspaceKey.js\":\"d83c42abb57ec455\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/modePin.js\":\"6102f85bc27cc3a7\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/openWorkspaceKeys.js\":\"9e171f130a5052d6\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/resolveWorkspaceEntry.js\":\"1e70b40dcc1e60e7\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/resolver.js\":\"8718c1f6b33302ba\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/workspaceAccess.js\":\"6c3100e684a4a33c\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/transform.js\":\"80ec7df350841943\",\"/knowledge-medium/pr-preview/pr-1911/src/themeBootDefaults.js\":\"b9e1c2b524236fae\",\"/knowledge-medium/pr-preview/pr-1911/src/types.js\":\"8f0f2da165c791a8\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/ClientLocalSettings.js\":\"2e2425d602e8e3f8\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/abortableSleep.js\":\"1628a9e95c3739f9\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/array.js\":\"026c47230cf7bc4a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/backlinkAutocomplete.js\":\"0c6c5fcf5aede520\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/blockCrumbs.js\":\"f87ea7aa18bb3348\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/blockrefAutocomplete.js\":\"3f84aea731664154\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/cadencedIdleJob.js\":\"6193ad180105eacf\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/callbackSet.js\":\"66e42bbcfd06248a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/clientId.js\":\"27d6d5dc51a003b1\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/codemirror.js\":\"2f9a796acd5fde2f\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/codemirrorCompletion.js\":\"c36b5334411c001b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/copy.js\":\"ec2b7f2921de01eb\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dailyPage.js\":\"1460816bac899165\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dbForensics.js\":\"ab8843db4d8700cd\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dbForensicsHooks.js\":\"2e85939d7fbfd126\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/deleteBlockThroughUi.js\":\"c38289a52a53047a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dialogs.js\":\"d4aac2458e2bee8f\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dom.js\":\"5eb7f74e874e781a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/downloadBlob.js\":\"65e5859f93828de5\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/drawnWalk.js\":\"6bf3fa23bf2eb499\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/exportSqliteDb.js\":\"a053fefb6734355b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/fileSystemAccess.js\":\"4f85c29292338e29\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/flipSlide.js\":\"17bafa23ad999caf\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/fnv1a.js\":\"924eb7109c81e204\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/formatBytes.js\":\"6ed5cb2f1c84437c\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/fuzzyRank.js\":\"716fddc0e3db1f51\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/idbKeyedStore.js\":\"7d3a6c4c0a481c0e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/idleCallbackPolyfill.js\":\"252aa132b98a9a52\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/keyboardAwareScroll.js\":\"851b868875cc833e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/keyboardViewport.js\":\"69d46beb3b5bd8b1\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/lastWorkspace.js\":\"066d180973fc4aec\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/layoutColumns.js\":\"9733a97ac3444afc\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/layoutSessionDom.js\":\"61ea41812f2f9b47\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/layoutSessionId.js\":\"5f3a78f307d6eede\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/linkClickGestures.js\":\"1e82a3acee45436f\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/linkTargetAutocomplete.js\":\"60f3393b3b1189c8\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/localDbCorruption.js\":\"e771bcb011e860c4\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/localDbRecovery.js\":\"1d4b5b18452e5db8\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/markdownParser.js\":\"1afa5505ac683924\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/memoize.js\":\"5c172653b56547ad\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/nameFieldCommit.js\":\"5b7ca7af2f49d88e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/nameList.js\":\"819364c0f539f529\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/navigation.js\":\"c2382775b3912c5d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/omnilinerNamespace.js\":\"20a710b306d27b76\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/opfsPageScan.js\":\"d9b6aceb80f27e20\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelClearance.js\":\"a0cfdc30a2a32fff\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelHistory.js\":\"b01d493bb323cbb1\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelLanes.js\":\"dc1243a2f82bc322\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelLayoutProjection.js\":\"e5dd85cef593f1c1\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelScrollAnchor.js\":\"2fbc7a267336d1c9\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelUrlFlags.js\":\"139432445758fd85\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/platform.js\":\"fc8bf7ada1eae35d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/pluralize.js\":\"8490c628ef81bff8\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/propertyCreation.js\":\"5e8928dc871802b3\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/propertyNavigation.js\":\"916de3976c8143ad\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/propertyValueContext.js\":\"7d501c2531f5dfee\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/react.js\":\"2fb9bf033489508b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/relativeDate.js\":\"057c054b2d8591eb\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/relativeTime.js\":\"2fae3f4a37312ba2\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/renderScope.js\":\"b62b33593ebc3e96\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/resolvedThenable.js\":\"1f413f73e6c7899e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/routing.js\":\"14d712f3de89b609\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/safeMode.js\":\"9551fb3e7e382dff\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/scheduleIdle.js\":\"9e33a9b7f33d4b92\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/screenWakeLock.js\":\"2b9855a98fecb809\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/selection.js\":\"207ae3148b18f82e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/softKeyboardGrab.js\":\"5728aa677db5dc21\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/startupTimeline.js\":\"b4c3b564b67d3828\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/state.js\":\"f9d6402c7ce08a1b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/string.js\":\"eb132e2b38a5b0e2\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/surfaceZoom.js\":\"0dc3bf7a67ad664e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/time.js\":\"d3b14f4b1bf8e98a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/toast.js\":\"06ed14ba1e930fa0\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/toggleStore.js\":\"ee7da4b47fd37955\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/untilStopped.js\":\"8c9c69c48da81097\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/userActivity.js\":\"da6729065e1b2fbf\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/viewTransition.js\":\"e9e61dfa6c7351da\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/viewport.js\":\"93cd53b21e3b8fe1\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/webLock.js\":\"85be86b2a41067ce\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/workspaceRecovery.js\":\"f0c2ebc53d4eb1c7\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/workspaceSnapshotStore.js\":\"2440832def2c1c41\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-compiler-runtime.js\":\"7ead72fcf3c32617\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-client.js\":\"b04e41d5c94ae22c\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-server-edge.js\":\"b89f0d0f5b076411\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-server.js\":\"e4998a8d03a3f852\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-static-edge.js\":\"054c1ceb0a96e6f4\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-static.js\":\"c6a30542efe31cd3\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-test-utils.js\":\"4ddb4775125f736a\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom.js\":\"fc0a10c66c651978\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-jsx-runtime.js\":\"dff82089faaddead\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react.js\":\"77f4bbb148f5b3c3\",\"/knowledge-medium/pr-preview/pr-1911/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1911/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1911/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
