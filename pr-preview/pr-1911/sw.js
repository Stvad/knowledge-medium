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
		buildId: "223b880b2ad9-e49443ed",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1911/\":\"52951c27b0056dc5\",\"/knowledge-medium/pr-preview/pr-1911/index.html\":\"52951c27b0056dc5\",\"/knowledge-medium/pr-preview/pr-1911/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1911/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1911/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1911/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1911/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1911/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1911/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1911/assets/FacadeVFS-DDPpiBH6.js\":\"66137dca2d28c6fc\",\"/knowledge-medium/pr-preview/pr-1911/assets/OPFSCoopSyncVFS-BRqjpT-8.js\":\"93125017fb0b44fe\",\"/knowledge-medium/pr-preview/pr-1911/assets/OPFSWriteAheadVFS-Vv1Buh2u.js\":\"074f504e0a7e4221\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-C1QtU6F6.js\":\"c117472a9a28a7dd\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1911/assets/wa-sqlite-async-DYIs45a_.js\":\"c3d3ec2341b9d81c\",\"/knowledge-medium/pr-preview/pr-1911/assets/worker-DthS8fUD.js\":\"b57b5cde39584cc0\",\"/knowledge-medium/pr-preview/pr-1911/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1911/chunks/app-R6UXjN1R.js\":\"796b692cc4b53b2d\",\"/knowledge-medium/pr-preview/pr-1911/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1911/index.js\":\"fd1def87b8f4b4bc\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1911/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1911/assets/AccessHandlePoolVFS-YxrvLNzn.js\":\"7e2b09a526ec8550\",\"/knowledge-medium/pr-preview/pr-1911/assets/IDBBatchAtomicVFS-DA3h_1jv.js\":\"73a724999ad03d9f\",\"/knowledge-medium/pr-preview/pr-1911/assets/MemoryVFS-Dmi06P4u.js\":\"ca7d8a756747edd8\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-BeRVHdbm.js\":\"67b3226de41b65f3\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-async-6OJ34hPF.js\":\"7565094b49d981ca\",\"/knowledge-medium/pr-preview/pr-1911/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1911/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1911/chunks/AccessHandlePoolVFS-B6DRNzJA.js\":\"ccd374cdcbb9112b\",\"/knowledge-medium/pr-preview/pr-1911/chunks/FacadeVFS-RkI6ZUwk.js\":\"faa0b0ea31e10c82\",\"/knowledge-medium/pr-preview/pr-1911/chunks/IDBBatchAtomicVFS-CMH2zPUt.js\":\"dda36b4ca0d7001d\",\"/knowledge-medium/pr-preview/pr-1911/chunks/MemoryVFS-5eDzjWMY.js\":\"980296edc6c5a36e\",\"/knowledge-medium/pr-preview/pr-1911/chunks/OPFSCoopSyncVFS-DEKu9Tg0.js\":\"57a07147ffcb3d06\",\"/knowledge-medium/pr-preview/pr-1911/chunks/OPFSWriteAheadVFS-Cq086DiC.js\":\"d174cc6ff06288d2\",\"/knowledge-medium/pr-preview/pr-1911/chunks/Preview-OlzuEO0m.js\":\"e45e205f73ff6f87\",\"/knowledge-medium/pr-preview/pr-1911/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1911/chunks/card-C-WckKw2.js\":\"145d9f871e6aa046\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1911/chunks/dist-WpHXdJh6.js\":\"cb40aba7a569c384\",\"/knowledge-medium/pr-preview/pr-1911/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1911/chunks/mc-wa-sqlite-aJ_EL5Na.js\":\"ddfc87b9c2549b59\",\"/knowledge-medium/pr-preview/pr-1911/chunks/mc-wa-sqlite-async-CkiEWOxA.js\":\"1e6da89155dc0b9a\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-8I3aSKmi.js\":\"eea7e423750f1d9d\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-BC5Vx9_i.js\":\"b3bce0cc1f6cba1a\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-BTeOEken.js\":\"b2da737f9b9805b2\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-CM1luycr.js\":\"9b480603af92ec68\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-DQF6R964.js\":\"7f68a30f64aaf38f\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-Dshlf9yJ.js\":\"5b83925a572471a6\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-HCfvePZX.js\":\"5463ff88fcb306d2\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-_ZOEL6Bx.js\":\"eb30414f83fc5320\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-dom-server-legacy.browser.production-je0CqHPD.js\":\"0ba0d0363fb93816\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-dom-server.browser.production-DeHDOHsA.js\":\"3b3c7a330834504c\",\"/knowledge-medium/pr-preview/pr-1911/chunks/react-dom-server.edge.production-D700ZvbK.js\":\"8ece50d6b7d64118\",\"/knowledge-medium/pr-preview/pr-1911/chunks/server.browser-DU5Krv34.js\":\"bdba3157447488f8\",\"/knowledge-medium/pr-preview/pr-1911/chunks/textarea-RsdrTYK6.js\":\"b831de421f7ef91d\",\"/knowledge-medium/pr-preview/pr-1911/chunks/ui-BCjrsxTK.js\":\"a44fe96248312e5f\",\"/knowledge-medium/pr-preview/pr-1911/chunks/wa-sqlite-DAihVJhn.js\":\"e20843c5a8e46d80\",\"/knowledge-medium/pr-preview/pr-1911/chunks/wa-sqlite-async-bH-bXAXZ.js\":\"323a2ef51c9d4e9e\",\"/knowledge-medium/pr-preview/pr-1911/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1911/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1911/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1911/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1911/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1911/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1911/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1911/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1911/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1911/src/App.js\":\"9a469f7ceedb8e04\",\"/knowledge-medium/pr-preview/pr-1911/src/appUpdate.js\":\"3bd8a2d265ec3cd8\",\"/knowledge-medium/pr-preview/pr-1911/src/appVersion.js\":\"9ab75650e7c90414\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/initialLayout.js\":\"ee7ac7ebf196e210\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/openWorkspaceData.js\":\"5398f8209e7d46b4\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/resolveWorkspace.js\":\"976076069929e0e1\",\"/knowledge-medium/pr-preview/pr-1911/src/bootstrap/workspaceBootstrap.js\":\"94ff30cb9868c108\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockComponent.js\":\"c28c2b1e958f6ec1\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockCrumbs.js\":\"66fde87b5ec95a04\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockEditor.js\":\"d1890b2eb26932ef\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockLoadingPlaceholder.js\":\"b296e75375af9f78\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockProperties.js\":\"5e2919416c908ae9\",\"/knowledge-medium/pr-preview/pr-1911/src/components/BlockSearchPicker.js\":\"84076a5db460b58f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ConfirmBulkDeleteDialog.js\":\"c7f56d32d30d4155\",\"/knowledge-medium/pr-preview/pr-1911/src/components/DividerHandle.js\":\"8266ed16007612f2\",\"/knowledge-medium/pr-preview/pr-1911/src/components/DraftEditor.js\":\"3cfd48ce6c8fbb82\",\"/knowledge-medium/pr-preview/pr-1911/src/components/GutterPill.js\":\"d0bb60360cc8b282\",\"/knowledge-medium/pr-preview/pr-1911/src/components/Header.js\":\"c7011cfead1c45ef\",\"/knowledge-medium/pr-preview/pr-1911/src/components/LazyBlockComponent.js\":\"b780e2b9c3dfc8f1\",\"/knowledge-medium/pr-preview/pr-1911/src/components/Login.js\":\"093831a83265cd58\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ZoomableSurface.js\":\"d7a85dc7538c679e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/editModeKeepalive.js\":\"fd9e2cfb9306931c\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyDisplay/PropertyDisplayScope.js\":\"ace4b4c4494b213d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"305710911d9b982e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/RefPropertyEditor.js\":\"0ad7f6b3c7f103e2\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/RefTargetTypePicker.js\":\"fcd6484973c18165\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/SelectPropertyEditor.js\":\"65db0d0e663894d0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/TypesPropertyEditor.js\":\"a8023a854321446e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/defaults.js\":\"88688573f0458a62\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/kernelValuePresets.js\":\"894eb0c2a2dafa45\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/selectablePresets.js\":\"66615f4f9c3ea3b7\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyEditors/typesPropertyUi.js\":\"2ae03a4014482b97\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/AddPropertyForm.js\":\"badee493cb71fd85\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/PropertyPicker.js\":\"3e5d1fb12d9e15eb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/PropertyRow.js\":\"9c787759021cbb66\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/Rows.js\":\"42c57976ba3b545a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/actions.js\":\"7deca894ada8fb31\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/declarationOnly.js\":\"14261119db60d0e2\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/layout.js\":\"05a3f3d95c961f56\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/model.js\":\"195a9283a33391b5\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/shapeUi.js\":\"278b41c29bdbdc9d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/shapes.js\":\"397e1c4dc5ff7b3f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/usePropertyEditingActivation.js\":\"b300af3d279d6de1\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanel/visibility.js\":\"163ecf72f322db25\",\"/knowledge-medium/pr-preview/pr-1911/src/components/propertyPanelSections.js\":\"817bf10903b88d77\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/BlockEmbed.js\":\"073d3b4f054c179f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/BlockLink.js\":\"db299370a156ef06\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/BlockRef.js\":\"c1d8878ac8aa78b0\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/CompactReferenceLink.js\":\"0fe48de4411ac305\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/ReferenceLink.js\":\"2ed2fc058358d9bb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/cycleGuard.js\":\"7649796ff448f6c9\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/cycleGuardContext.js\":\"27d63ec386c121d1\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/linkInteraction.js\":\"f600b284eaf29b92\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/referenceLayout.js\":\"d074cb0628ece532\",\"/knowledge-medium/pr-preview/pr-1911/src/components/references/useBlockRefAncestors.js\":\"93de41446eedab3b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockGutter.js\":\"a0efc2edd3b6bfd6\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockInfoDialog.js\":\"a4de8467422963a3\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockReadText.js\":\"0b737471777b1917\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BlockTypeBlockRenderer.js\":\"9581ad76c1929e8b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/BulletHoverCard.js\":\"a9f41f92c2e321f4\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/CodeMirrorContentRenderer.js\":\"ea4e8f5749e22eac\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"51ea597358c9f972\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/ColumnResizeHandles.js\":\"d95ae2c48fe79727\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5779530a3a0e0f33\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/DefaultBlockRenderer.js\":\"f12184c7d806ec57\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/LayoutRenderer.js\":\"5c08c8dc6d0a681d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/MarkdownContentRenderer.js\":\"34140dec094a3267\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/MissingDataRenderer.js\":\"beb1d828ec8cd251\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/PanelRenderer.js\":\"d8d6ee4d17d178fb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/PropertySchemaBlockRenderer.js\":\"4b8f40033a82c8a4\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/TopLevelRenderer.js\":\"e0abef547d1106df\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/blockGutterMode.js\":\"c9ee2852ffd2ad2e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/blockTitleText.js\":\"1cc3ec48aeb17f60\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/fieldCreationKeydown.js\":\"461104988e311e73\",\"/knowledge-medium/pr-preview/pr-1911/src/components/renderer/layoutRootContext.js\":\"1873526358cf0d7e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/typeChip/TypeChip.js\":\"2f3dc9a9c7f582ae\",\"/knowledge-medium/pr-preview/pr-1911/src/components/typeChip/chipStyle.js\":\"b0deebccff82a427\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/anchored-floating.js\":\"4a648ad0b9170c3b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/button.js\":\"a10445bdf936cdf3\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/card.js\":\"7695f813f350f490\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/checkbox.js\":\"1e73ab96062a461b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/collapsible.js\":\"256749ec19e0a828\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/command.js\":\"a43946020155a261\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/context-menu.js\":\"942f3c4c4ba19869\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/dialog.js\":\"10887acb847d5995\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/dropdown-menu.js\":\"16f303dad2b5f0a9\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/floating-listbox.js\":\"911dd8a1c8f42cbb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/index.js\":\"ce601988ea36c56b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/input.js\":\"243e2374c97ad96c\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/kbd.js\":\"3b16887e7054b43d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/label.js\":\"52e3a284a0801a2c\",\"/knowledge-medium/pr-preview/pr-1911/src/components/ui/textarea.js\":\"d282684eb6997d26\",\"/knowledge-medium/pr-preview/pr-1911/src/components/useEditModeYieldKeepalive.js\":\"2ba124ebba26ae40\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/BootFallback.js\":\"dc76259a61a0e51f\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/FocusedRowLazyMount.js\":\"480c936bdb2c9206\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/LazyViewportMount.js\":\"5224702fe4bc7e22\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/LocalDbCorruptionFallback.js\":\"838d79cb0e53a6e7\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/error.js\":\"66bf14fe97128ae6\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/lazyMountRegistry.js\":\"bc2f56f1f49fddc6\",\"/knowledge-medium/pr-preview/pr-1911/src/components/util/suspense.js\":\"3df71a989661deb7\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/CreateWorkspaceDialog.js\":\"a0755623182c500d\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/PendingInvitations.js\":\"d507923c66c6903e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/SyncProgress.js\":\"ca04a55b7e8051b8\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/UnlockProgress.js\":\"4b8e770111a7b96b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceKeyGate.js\":\"d4bdfccb7879aefb\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceSettingsDialog.js\":\"48a82d21fc257a24\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceSwitcher.js\":\"a3ef164a838f39e8\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/WorkspaceSyncGate.js\":\"8d2e1134544e5124\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/ConversionFlow.js\":\"e098079c69fc9c9b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/ConversionFlowHost.js\":\"651f4fc7cdc10254\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/EncryptionSection.js\":\"c3f90f3525e7931b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/attachmentPrompts.js\":\"5bbf9da939be5372\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0cd662fd66100e8e\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/conversionFlowDeps.js\":\"fac62b4a76f6b3c3\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/conversionFlowStore.js\":\"5fabc0fb82a2fd7c\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/flowUi.js\":\"bee73fc5b44ce55b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/conversion/useConversionRun.js\":\"a75ecad2551bbc92\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/keyUi.js\":\"0a35e0b373b2d56a\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/useCloseOnKeyLoss.js\":\"71fbd69887f8ebd4\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/useCloseOnServerE2ee.js\":\"a4987e8cfe0c726b\",\"/knowledge-medium/pr-preview/pr-1911/src/components/workspace/workspaceUnlocked.js\":\"6fc0b957d4e5c2d0\",\"/knowledge-medium/pr-preview/pr-1911/src/context/backgroundSubtree.js\":\"81c9dddac76430e2\",\"/knowledge-medium/pr-preview/pr-1911/src/context/block.js\":\"a2255970d51e7729\",\"/knowledge-medium/pr-preview/pr-1911/src/context/layoutWsContext.js\":\"8eee6f868596d369\",\"/knowledge-medium/pr-preview/pr-1911/src/context/propertyDisplay.js\":\"30dd0a654407420a\",\"/knowledge-medium/pr-preview/pr-1911/src/context/repo.js\":\"335a2d1a3a57f9ae\",\"/knowledge-medium/pr-preview/pr-1911/src/data/aliasClaim.js\":\"657bcf3c054123c7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/aliasSeatNamespace.js\":\"009773816e58d40d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/blockData.js\":\"f4be43112faf1b3e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/blockType.js\":\"d194ebc28c840b33\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/changeScope.js\":\"5c03cd655bf21d56\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/codecs.js\":\"67ac1f0c31aeab19\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/derivedData.js\":\"83ec405bee3a1f17\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/errors.js\":\"1350546cfcb5af2c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/events.js\":\"3aaaab792800f470\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/handle.js\":\"158e8621217c1d4c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/index.js\":\"965836ce466a46e0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/mutator.js\":\"2c5acf2756196be2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/processor.js\":\"cb557b72927f52ce\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/propertySchema.js\":\"b8f1f35909180c56\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/query.js\":\"2ad794548de2f97b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/sameTxProcessor.js\":\"dcfbb6b1112d3eb7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/schema.js\":\"158e8621217c1d4c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/tx.js\":\"158e8621217c1d4c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/typedBlockQuery.js\":\"dc2a3fa36addb4d7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/user.js\":\"e518ebe661a815df\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/valuePresetCore.js\":\"2f6596f2c4add389\",\"/knowledge-medium/pr-preview/pr-1911/src/data/api/valuePresets.js\":\"be162ebd3d743780\",\"/knowledge-medium/pr-preview/pr-1911/src/data/attachmentCleanerIOVerb.js\":\"57fd0bf0b0a5f234\",\"/knowledge-medium/pr-preview/pr-1911/src/data/block.js\":\"bdba654fe7c2c776\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockCache.js\":\"a14f77eee915cc43\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockId.js\":\"052da5fccb61cab0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockLiveness.js\":\"396214138b800e35\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockMerge.js\":\"0f25ee731f3c8755\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockSchema.js\":\"704cdc65242e0576\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockTypeLookup.js\":\"526d1b4d1de0d277\",\"/knowledge-medium/pr-preview/pr-1911/src/data/blockTypes.js\":\"6a3bea1ba2f1a03d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/childrenView.js\":\"96f006f9ee82d413\",\"/knowledge-medium/pr-preview/pr-1911/src/data/clientContext.js\":\"deefd88b892e3087\",\"/knowledge-medium/pr-preview/pr-1911/src/data/dbFileSiblings.js\":\"26dbec98da970cfe\",\"/knowledge-medium/pr-preview/pr-1911/src/data/definitionSeeds.js\":\"280a1ef46752026a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/derivedIds.js\":\"19dbacde8e26bf11\",\"/knowledge-medium/pr-preview/pr-1911/src/data/drawnSubtree.js\":\"c5ed3de8c3a66574\",\"/knowledge-medium/pr-preview/pr-1911/src/data/facetBridge.js\":\"6dfd9f5992180933\",\"/knowledge-medium/pr-preview/pr-1911/src/data/facets.js\":\"f399e71b83c0decf\",\"/knowledge-medium/pr-preview/pr-1911/src/data/globalState.js\":\"15acec24e47932d4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/aliasClaimRederiveProcessor.js\":\"2e3a19981cfc4efc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/ancestorBatch.js\":\"bbcab37a2164af02\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/blockTypeTypeifyProcessor.js\":\"07ac79575aea73ef\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/clientSchema.js\":\"5a1b768f7533ec03\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/commitPipeline.js\":\"565789f5191c843b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/devAssertions.js\":\"a021e85bf1ad0f25\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/firstSync.js\":\"166eb0738a0dfff2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/freshInitialLoad.js\":\"dfa45c0562be264c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/graphBackfillClaim.js\":\"3c705555871960f6\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/handleStore.js\":\"fdf492db21a17a5e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/idleMarkerJobs.js\":\"383334a5829acaa8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/initialDownload.js\":\"03123d775681f864\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/initializeClientDatabase.js\":\"b29492a312edd5bd\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/jsonCanonical.js\":\"1011a802f087bdd1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/kernelInvalidation.js\":\"fbfe32e384c4440f\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/kernelProcessors.js\":\"f82b94b9da549642\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/kernelQueries.js\":\"d1e6d408f48dd620\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/mergeTypeMembershipProcessor.js\":\"972b743a4ceda79c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/normalizeReferencesProcessor.js\":\"a1b3ef90534f5b30\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/poolInstrumentation.js\":\"a4271407f1799ca1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/processorRunner.js\":\"d1a967f8ade6e561\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyCellBackfill.js\":\"b9d7bb9bdf74f5f0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyChildMint.js\":\"f4c7917dd07a5781\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyChildrenProcessor.js\":\"f1e2d90d64bfecd2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyDefinitionChangeProcessor.js\":\"00e959ca25d2a479\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyDefinitionSynthesis.js\":\"990c58e568791eae\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyKeyScan.js\":\"5cb3193c593b6fc7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertySchemaResolution.js\":\"4dfb24e1bc9b10aa\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/propertyValueEdits.js\":\"17550990f4c0fe5d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/raiseProtocol.js\":\"5eff47659506c718\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/readBatch.js\":\"0ae220cb8c04e890\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/refProjection.js\":\"48d02370d163fab3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/referenceTargetLookups.js\":\"4a2916e5a9a16e24\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/referenceTargetProcessor.js\":\"82fc571e30a6fa3b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/replayMerge.js\":\"1d3d1c7786ca468a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/sqlBinds.js\":\"afdb90e49010fb8f\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"3d3e0faec90c8f7e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/arrivalProcessors.js\":\"fd0087306b7d24e2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/invalidate.js\":\"cb2ae2b0ab0cf68d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/materialize.js\":\"04f3ed8d8b762bbd\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/observer.js\":\"e8657d2ba154eb97\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/syncObserver/reconcile.js\":\"d9b61b1bf95d9bfc\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/timingMetrics.js\":\"30851aaefedf7727\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/treeQueries.js\":\"c3f6acd8bf684d16\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/txEngine.js\":\"ef462565481b543b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/txSnapshots.js\":\"abef3250b4c0f87b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/typedBlockQuery.js\":\"4fb29703103e14a4\",\"/knowledge-medium/pr-preview/pr-1911/src/data/internals/undoManager.js\":\"dc14da1997c5bce6\",\"/knowledge-medium/pr-preview/pr-1911/src/data/invalidation.js\":\"c3bf87fb9ea66e24\",\"/knowledge-medium/pr-preview/pr-1911/src/data/kernelDataExtension.js\":\"9e3672662e769d84\",\"/knowledge-medium/pr-preview/pr-1911/src/data/kernelPage.js\":\"722a76a376b3a98a\",\"/knowledge-medium/pr-preview/pr-1911/src/data/kernelValuePresetCores.js\":\"2b09cfb225522f0e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localDbCorruptionSignal.js\":\"8e1be9c7ba1853ba\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localDbStorage.js\":\"a7659318f3ef03e8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localDbVfs.js\":\"ae6c2fbdac56d2d9\",\"/knowledge-medium/pr-preview/pr-1911/src/data/localSchema.js\":\"c9c0d7470e587383\",\"/knowledge-medium/pr-preview/pr-1911/src/data/maintenance.js\":\"53b35fcb3db71da3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/mergeProperties.js\":\"bdab38429a903cc1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/metricsConsoleHook.js\":\"145b7da1842e0503\",\"/knowledge-medium/pr-preview/pr-1911/src/data/migrationsPage.js\":\"7aa36df96477ccf5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/mutators.js\":\"1059dd542d3bab54\",\"/knowledge-medium/pr-preview/pr-1911/src/data/orderKey.js\":\"2e31ce43fe463661\",\"/knowledge-medium/pr-preview/pr-1911/src/data/orderKeyPlacement.js\":\"b9a1feb1e83b85bd\",\"/knowledge-medium/pr-preview/pr-1911/src/data/outlineSurface.js\":\"bcff26f716009de1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/pendingEditorContent.js\":\"6ef066f68f05dd97\",\"/knowledge-medium/pr-preview/pr-1911/src/data/pendingUploadsSql.js\":\"b365d91578d2b68e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/pluginStateExtensions.js\":\"d3f32a84352b39b7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/powerSyncLogger.js\":\"92446a0a72ebb0c9\",\"/knowledge-medium/pr-preview/pr-1911/src/data/projectorRuntime.js\":\"93b21c7fb345efdd\",\"/knowledge-medium/pr-preview/pr-1911/src/data/properties.js\":\"fd929562fc636327\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertiesPage.js\":\"369862a6bd72dd24\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyChildren.js\":\"175a48596ea65f27\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDefinitionFanout.js\":\"c622ec3363e5936e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDefinitionMetadata.js\":\"f5491b5c7aa318d0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDefinitionRegistry.js\":\"f407a691d0e47d79\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyDisplayMode.js\":\"bcd0c79ce5b44698\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertyRowCreation.js\":\"547a2a843d868f29\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertySchemaCreation.js\":\"6da84e52e71b28c5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/propertySeeds.js\":\"96e089716eeac7f2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/recentsPage.js\":\"3df8039350b13037\",\"/knowledge-medium/pr-preview/pr-1911/src/data/refTargetComparableProperty.js\":\"da5285aaa51827e8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/referenceBlock.js\":\"075d30e3b50d908d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/rejectedUploads.js\":\"9b8b53fa4264ba41\",\"/knowledge-medium/pr-preview/pr-1911/src/data/releasePowerSyncConnection.js\":\"0af15ac80b335b5d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/repo.js\":\"55f00f89a71aedd8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/repoProvider.js\":\"07825233df3b5abb\",\"/knowledge-medium/pr-preview/pr-1911/src/data/rowProperty.js\":\"da0e0ea2955c0afb\",\"/knowledge-medium/pr-preview/pr-1911/src/data/searchFilter.js\":\"00a48bde28625422\",\"/knowledge-medium/pr-preview/pr-1911/src/data/seedIdentityLedger.js\":\"3cf29abd4decf72b\",\"/knowledge-medium/pr-preview/pr-1911/src/data/stateBlocks.js\":\"01eaf6707294a55d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/structuralEditPolicy.js\":\"c33ed848629d4cca\",\"/knowledge-medium/pr-preview/pr-1911/src/data/structuralInsert.js\":\"72e0672455be874d\",\"/knowledge-medium/pr-preview/pr-1911/src/data/subtreeDelete.js\":\"0c47f7e264942639\",\"/knowledge-medium/pr-preview/pr-1911/src/data/syncStreamLock.js\":\"f89174b7465b9515\",\"/knowledge-medium/pr-preview/pr-1911/src/data/syncedTableSqlRecognizer.js\":\"41db572d94e3d495\",\"/knowledge-medium/pr-preview/pr-1911/src/data/syncedTableWriteGuard.js\":\"ba694da8fee74cf7\",\"/knowledge-medium/pr-preview/pr-1911/src/data/targets.js\":\"40de7b2837fd64a0\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeColors.js\":\"3d9ea0908b38e3af\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeDefinitionMetadata.js\":\"fa38c6ad42b4c625\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeDefinitionRegistry.js\":\"6a42e2d894a5ce98\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeExtraction.js\":\"3562f18942b5a920\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeInitialValues.js\":\"cba4b3013c2008e3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typePropertyGroups.js\":\"815651a003685a2c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeSeeds.js\":\"761d35192f5baae5\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typeTagger.js\":\"51c13dbc3faaaa13\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typedRecords.js\":\"6ca5aa8adcf9187f\",\"/knowledge-medium/pr-preview/pr-1911/src/data/typesPage.js\":\"bc6375fb0f0b96d2\",\"/knowledge-medium/pr-preview/pr-1911/src/data/userPrefs.js\":\"942f22599a899968\",\"/knowledge-medium/pr-preview/pr-1911/src/data/userSchemasService.js\":\"c327bdc28eb33cc1\",\"/knowledge-medium/pr-preview/pr-1911/src/data/userTypesService.js\":\"764ce90b441db871\",\"/knowledge-medium/pr-preview/pr-1911/src/data/valuePresetRegistry.js\":\"00545596e3d3f6a8\",\"/knowledge-medium/pr-preview/pr-1911/src/data/visibleChildren.js\":\"25114d4d4ea4dac3\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceConversion.js\":\"5c4fbc5922461486\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceFirstSync.js\":\"f2de1fdd1932a0eb\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceIdNamespace.js\":\"c0a9a27af4c7a07c\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaceSchema.js\":\"b076d25be6eb0560\",\"/knowledge-medium/pr-preview/pr-1911/src/data/workspaces.js\":\"7a9b0e900a568935\",\"/knowledge-medium/pr-preview/pr-1911/src/data/writeAheadLog.js\":\"f3b3e8622043bd4e\",\"/knowledge-medium/pr-preview/pr-1911/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/BlockPasteShellDecorator.js\":\"15f34c9b0fcd25ae\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/atTrigger.js\":\"bb4843001915f4a8\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/autocomplete.js\":\"0dac97b236857f8d\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/codeMirrorExtensions.js\":\"90394e50a365e6f4\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/contentFlush.js\":\"eecce96d7403673c\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/defaultInteractions.js\":\"d736d78ae06224c2\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/editSettleSignal.js\":\"fc08551e451ee373\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/insertImage.js\":\"ca0f230170038bde\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/referenceCompletionRange.js\":\"8661706ad3ada3e5\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/referenceTargetTypes.js\":\"9b621bff6a078877\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/syntaxContext.js\":\"c2b1347e8ba3dfba\",\"/knowledge-medium/pr-preview/pr-1911/src/editor/triggerMatch.js\":\"f49b57412bc8269c\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/AppRuntimeProvider.js\":\"be92d53886356c0b\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/BlockFocusShellDecorator.js\":\"e82ee55f74f42dc7\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/ExtensionRenderBoundary.js\":\"7ce79aa2f2a6c1f1\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/PanelContentRecovery.js\":\"208b70e4062b291b\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/apiCatalog.js\":\"8d86a5744331741b\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/appRuntimeController.js\":\"29b94c99c392814c\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/approveExtensionHere.js\":\"5fa13e0cc4337cfc\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/armedCutAppMount.js\":\"eb3166c781e9593d\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/batchableKeyedStore.js\":\"3ef05b4d3211db85\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/blockInteraction.js\":\"06e03d03772c6fac\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/blockSelectionAction.js\":\"b8a49a8d9b9a17b1\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/compileExtensionModule.js\":\"2acf2fd3b7c2aed0\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/compiledModuleCache.js\":\"352d0700b3e83c12\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/continuousGestures.js\":\"7a58e48c14cb66b7\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/core.js\":\"0af90b904af31e2d\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/defaultRenderers.js\":\"53d6d81744615989\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/definitionFanoutAppMount.js\":\"10d0fce8c453523b\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/dialogAppMount.js\":\"cb967d61ebbad829\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/dynamicExtensionSeeds.js\":\"e480218c387c3aba\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/dynamicExtensions.js\":\"8ccb780f3fcf3165\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/exampleExtensions.js\":\"97671d8055346fa1\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionApprovalStatus.js\":\"580e561b134fb420\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionLoadErrorToast.js\":\"30a552ef449f58cd\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionLoadErrors.js\":\"2ddbd51e97bf7f91\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionLookup.js\":\"35d6d0a02468ef25\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionToggles.js\":\"60b6999225cf5349\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/extensionUtilitiesCss.js\":\"b1185aba7b769a57\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/kernelPageDeletionGuard.js\":\"fb3d7da9c1ce5f29\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/liveRuntime.js\":\"eec2580c7cd92793\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/openExtensionsSettings.js\":\"c000b2bc43c6a686\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/overridesCache.js\":\"edd1d114d3ba9935\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/pluginIds.js\":\"959f27c75d07f764\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/processorRejectionToast.js\":\"a4300dcc6351dac4\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/runtimeActions.js\":\"a644eb9acbeb931f\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/runtimeContext.js\":\"95b1c57496a62e87\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/staticAppExtensions.js\":\"bafe7a4ea5cf69fe\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/staticDataExtensions.js\":\"cfebed9d689e678a\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/toastAppMount.js\":\"142d9fb26ea06a02\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/useOverrides.js\":\"377a2e85e5d6ccd0\",\"/knowledge-medium/pr-preview/pr-1911/src/extensions/useShortcutSurfaceActivations.js\":\"0d95f922f1b516b8\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/discoverToggleTree.js\":\"baad9ed7f50d5e65\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/facet.js\":\"11acdd99d500afe3\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/resolveAppRuntime.js\":\"ca19b6d4741df275\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/runtimeEvents.js\":\"4086f7124ef3e9a0\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/togglable.js\":\"15fb72a947302026\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/variantFacet.js\":\"4e3266caf2775ea8\",\"/knowledge-medium/pr-preview/pr-1911/src/facets/verbFacet.js\":\"7099f0ca5924f1ce\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/block.js\":\"36d5f90a19c493cb\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/focusedChild.js\":\"9fda216ee6cea5ec\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/propertySchemas.js\":\"3db977b079dfdfa8\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/typeRegistry.js\":\"78cad3a4ca60742b\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useAncestorCrumbs.js\":\"6c4621c174a1be19\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useAutocompleteListbox.js\":\"bf60f27b196fafce\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useDebouncedSearch.js\":\"735330f80f68146a\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useDebouncedValue.js\":\"1f4885b15c0208d2\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useFacetValue.js\":\"4efa01f65d7a7c49\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useIsFocalRender.js\":\"4cc099311bc107f5\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useIsReadOnly.js\":\"c938d0400f1baed3\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useMaterializeBacklog.js\":\"6a177fbd3570153a\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useMinuteClock.js\":\"01cc8406ab6e9a75\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/usePanelLayoutProjection.js\":\"1791be29b6b2fba1\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/usePendingInvitations.js\":\"cc589c49cd2c22c5\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useRendererRegistry.js\":\"45a5dd77c1692d70\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useRetainedFieldRows.js\":\"939a6592d0f92dcf\",\"/knowledge-medium/pr-preview/pr-1911/src/hooks/useWorkspaces.js\":\"2f3a67f4b8b70d74\",\"/knowledge-medium/pr-preview/pr-1911/src/lib/utils.js\":\"aa5ea729e8b9e3f4\",\"/knowledge-medium/pr-preview/pr-1911/src/main.js\":\"6b094990bd2d33f7\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/MarkdownImage.js\":\"fbcce355f5617b91\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/blockSeparators.js\":\"bb9a4cdca17ab56c\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/context.js\":\"a6b47c538769465e\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/defaultMarkdownExtension.js\":\"76f8de09a7a81a18\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/extensions.js\":\"8d10ef824edb504c\",\"/knowledge-medium/pr-preview/pr-1911/src/markdown/renderMarkdownHtml.js\":\"5938cb9dd72b0fda\",\"/knowledge-medium/pr-preview/pr-1911/src/minimal-editor.js\":\"7f55252ced1b9b25\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/armedCut.js\":\"2c9d405205748001\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/captureMediaVerb.js\":\"b7006d5fa7082057\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/clipboard.js\":\"8027861710e6851b\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/decision.js\":\"3f7c29bb143c5db6\",\"/knowledge-medium/pr-preview/pr-1911/src/paste/operations.js\":\"8a017b078e734338\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/account-header/AccountHeaderItem.js\":\"dba19109e8895ec6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/account-header/index.js\":\"32c6c67996b48135\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"275a12b9ed96074b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/askAgent.js\":\"7d3a0d385aac3d24\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/askedStore.js\":\"50c9891f9f9b4d43\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"494b4eb1e65ffa1d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/chipState.js\":\"699887cfa965aa31\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/dataExtension.js\":\"1fd5c0354e92c3d4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/index.js\":\"47309c9aa310c809\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c440220a1d88cba9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-dispatch-companion/schema.js\":\"f3fb57bfd3a6c6d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/AgentTokensDialog.js\":\"4fb3efeffdff4695\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/BridgePairingDialog.js\":\"bd686d8e7ffd6b4e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/addMedia.js\":\"be9334da3508d7b3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e5ea1a92a52839b2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/block.js\":\"749c0db04612deff\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/context.js\":\"7a4e14185b4c385e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/displayIds.js\":\"45d9a45a82613673\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/index.js\":\"ddbe2f9d46b10dca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/outline.js\":\"0e8b01d16d5444d6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/properties.js\":\"48e71c492f730dee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/refs.js\":\"1c74a24f3c6bf7e5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"936bc54e5552eb50\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/search.js\":\"5512cd3ca7927d0a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/shared.js\":\"7527781f103199d1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"4953e9c73cd6e113\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentViews/text.js\":\"9043a0c11b54c2a7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/agentWrites.js\":\"ae9725e124fa1f74\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/authoringCatalog.js\":\"dda7fbf9df6f9ad3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/blockRefTargets.js\":\"4e09912f4d4134f5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/bridge.js\":\"f9b2ec4df394e1e8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/bridgeLoop.js\":\"aeeb9189719ca987\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/changeHistory.js\":\"9877306220954cfc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/commands.js\":\"d160c7d1627b35ae\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/commentsCommands.js\":\"d549f76f7419bc57\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/dataExtension.js\":\"aa198683a83de84a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/dataModelGuide.js\":\"73d4e6ae5b552f9e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/dayPropertyInputs.js\":\"b95fa99d8f4084ca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/describeRuntime.js\":\"9a789db9ea94cc6a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/extensionLint.js\":\"3aa1a8ccd01c17d7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/grainAudit.js\":\"20bdd0f10d829c6a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/healthCommand.js\":\"9ca051df3f95be0f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/index.js\":\"24f970a17b113e1e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/presetIdentity.js\":\"149c56245fe061e6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"9ef22f5259daaaa9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/readMedia.js\":\"c22b25d8d865c3a0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/schema.js\":\"b8bab5f4a26b5468\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/serialization.js\":\"a85bd7dd3039825b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/targets.js\":\"0bbae920e918fcce\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/tokens.js\":\"2ccf4c4ab81e803e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/watchEvents.js\":\"a811ac57925f4ba2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/workspaceGuard.js\":\"d333aa8119bbec64\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/agent-runtime/writeCommands.js\":\"321ef114818dee46\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/AliasCollisionToast.js\":\"18bb1814b62327cc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/DuplicateNameBanner.js\":\"b954b76df4f9dc12\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/collisionMerge.js\":\"b3c8acae96bffc4b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/dataExtension.js\":\"8d8c15cd5f71b82a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/index.js\":\"4836955fa3df935f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/mergeCollisionAction.js\":\"7ab708b4dd6d91d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/pageStyling.js\":\"86ece621ab4b7ab8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/rejectionToast.js\":\"96a16d7d1551de91\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/alias/syncProcessor.js\":\"4713fb23e559728d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/actions.js\":\"8359c8e818998c89\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/addComment.js\":\"dc1dc4db20d17329\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/anchor.js\":\"8ef3535c96df79cf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/anchorState.js\":\"c81f256cdfe1de73\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/commentLinks.js\":\"561e2570a8db5955\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/confirmThreadDeletion.js\":\"8988dcd8826236bd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/container.js\":\"410ade465d21343b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/dataExtension.js\":\"7ea63ab4f173e0dc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/deleteComment.js\":\"b29a6af7872ba29e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/highlights.js\":\"86ef68f507945555\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/index.js\":\"dc08ca239b99510d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/linkedCommentsPill.js\":\"48eb99dc03f786c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/margin.js\":\"9c3bbf25f4ed0a19\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/marginAnchorLinks.js\":\"d869e8de194417f0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/marginSchema.js\":\"71747efccd3a59ee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/newComment.js\":\"f9732230a39e7a17\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/ownThreadPicker.js\":\"4a24e0fc729cbe6e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/placement.js\":\"413b2d69f28d0489\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/queries.js\":\"4ef6c33f4ad2a1c5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/quotePosition.js\":\"cf06c8f6ffd844d0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/quotedIn.js\":\"7d290d8a746f46bf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/quotedRange.js\":\"551807534d2a4fa9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/rangeRefs.js\":\"d9e8b3f7d8c6a817\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/readHighlights.js\":\"95386c598710c337\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/readSelection.js\":\"fd4f659d17bf9a6f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/readSelectionUi.js\":\"82dc8c816856d301\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/reanchor.js\":\"338a1486a56d8ab3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/schema.js\":\"d053faabec3aa92c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/scope.js\":\"0e2a044cc2ef9d3a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/scopeThreads.js\":\"45f84c3ddf9bd8a7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/splitRetarget.js\":\"321db8a452b13d6e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/suggestionCard.js\":\"f7eb6938141e1b9e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/suggestions.js\":\"2045591314b01edf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/summaries.js\":\"88520a3adb5450b0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/summaryBatch.js\":\"0b6564cc8b92c7a0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/surface.js\":\"0d62a6b470e7a605\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/threadNavigation.js\":\"1656fba853b8d9b9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/threads.js\":\"8d306f1594440bbc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/ui.js\":\"93368f0e9442dbdf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/annotations/uiStore.js\":\"ef033efe136718ec\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-intents/appIntents.js\":\"c94ccff9bc235503\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-intents/index.js\":\"53fad9ab427246ae\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-update-prompt/index.js\":\"d7a100016da0da8c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/app-update-prompt/status.js\":\"728ec1e1152e5bcd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d9619cf5b78f1339\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/MediaBlockRenderer.js\":\"aa65887c07a93ee9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d3be7ffff3479955\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/MediaUploadReconciler.js\":\"90a5ce44cf7b6d8e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/assetDownLane.js\":\"2611d0024f9ccfb8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/assetResolver.js\":\"3896039fc55574f1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/assetUpload.js\":\"6058ddb519b7aad9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/attachmentCleanerIO.js\":\"f11ce9242e50ad4d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4769dd3f3f479e66\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/blobStore.js\":\"ea3d20f6383fbda6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/browserMedia.js\":\"48145e79878fa9b7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/byteStore.js\":\"49496412552c4ed3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/cleanerIO.js\":\"03d69455711c4bd4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/cleanupAttachments.js\":\"1b292e609884ee67\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/dataExtension.js\":\"bcfb2534d31275e5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/downLane.js\":\"eaa7440bc81957ee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/index.js\":\"253845dbfec43d7e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/insertImageContribution.js\":\"af85e1d911378dbe\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/laneArming.js\":\"c6dbe5c7b92cf994\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/laneLock.js\":\"77501392d4f25444\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaBlock.js\":\"a42d08d18d02e2df\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaCapture.js\":\"c764626bcbbd2939\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaLanes.js\":\"32520510010fe24b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaViewers.js\":\"d20c20a74089af96\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/mediaViewersFacet.js\":\"669117fee02d5ce8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/pasteCapture.js\":\"69aecd81e0bbdb03\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/resolver.js\":\"5e2ac38d9b2e1d26\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/retryUploadsAction.js\":\"86d227181884922c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/storagePaths.js\":\"0030e5fbc685c754\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadDrain.js\":\"bc41af4d79091149\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadLaneStatus.js\":\"b262bce031ce1261\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadReconcile.js\":\"de285bc12276c771\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadRecovery.js\":\"4782eeebd686c794\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/uploadStore.js\":\"f0fd3c7d210685b5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/attachments/useAssetObjectUrl.js\":\"affc8339d010d87c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9f36fd76ed8acd8d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d8588794d9a77122\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/facet.js\":\"7f6831b9e13ecded\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/index.js\":\"c48e73c1eff8d976\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks-view/prop.js\":\"4aa48b4c5995f2d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/BacklinkFilters.js\":\"8ac9fa32742b2b6a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"94f0ebf9033a9644\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/BlockEntry.js\":\"100aff4afd4a8e75\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/LinkedReferences.js\":\"f5427f2442f7ed36\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fdf975dbb1b756af\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/dailyNoteDefaults.js\":\"1a064abcbaf9406e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/dataExtension.js\":\"e8db7dee5604523a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/edgeExclusions.js\":\"8f9920f0ac27e8fc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/filterProperty.js\":\"4ed0d495d0f5ebd5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/index.js\":\"07e1c0247dd998f0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a6e1cb541a05afef\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/applies.js\":\"77818de3e6779896\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/countQuery.js\":\"0179de92d6de3279\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8ae66da7723cbb76\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/index.js\":\"dd3528745e775c59\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"db64f2d2179abc70\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/presentationInvalidation.js\":\"2e7dc43127b4f31a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/propertyEditorOverride.js\":\"d57a0b64d616381d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/propertyFilter.js\":\"c114998f9d8dd151\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/query.js\":\"db63b3ef61165fcd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/resolveFilter.js\":\"62c1f27a0a521a45\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/sourceBatch.js\":\"434728c521ce3db9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/sources.js\":\"fe78587ed3ccb61d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/useBacklinks.js\":\"14fe943b9bd56386\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"c0bfc43d10512bf4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/BirthdayCelebration.js\":\"b856118bd5734e8b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/BirthdayOverlay.js\":\"062169f35c9a320b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/gate.js\":\"e107b346ff0d5e62\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/index.js\":\"de2ee11423073d0c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/birthday/wolfTheme.js\":\"186732f189c3e8df\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/BlockDragLayer.js\":\"90462e90766ffdb5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/dragController.js\":\"31bc8001f3e0dc66\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/dropTarget.js\":\"0ca7595b6a6566d5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/index.js\":\"252e11e9c3e7b8bd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-drag/projection.js\":\"6065df09cbc3adb1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-info/BlockMetaCard.js\":\"043d6391f3e07a76\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-info/index.js\":\"7dd2211c4dd74ba0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/AddTagDialog.js\":\"6b9ca60855f1039a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"81d3dbc88cb91a8d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/TagNameIssueHint.js\":\"ba40d22905fd559d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/addTagAction.js\":\"5fe78fb4d3404d9e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/appendTag.js\":\"f000df775f7227e8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/config.js\":\"526766fab3f70de0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/dataExtension.js\":\"e62f96eac79bd13c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/index.js\":\"cc4e3171499d2895\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/block-tagging/propertyEditorOverride.js\":\"18a9a8c38515b5ac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8099c21a9e447ede\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9b634eb8e6d60fe6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/Breadcrumbs.js\":\"030d836c7815fccd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0e5b66ddcdfa1dba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"25f17e947c5cb35f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/index.js\":\"dce8759739e49542\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"23252b8f466852d6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/CharacterCountItem.js\":\"844034c2cc34f331\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b1734e6b8da61d15\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/actions.js\":\"d9a54d4c857aabc1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/blockType.js\":\"f0b202b2d674946e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/charCount.js\":\"f87a9494718302be\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/dataExtension.js\":\"445af6f45fb2f5d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/index.js\":\"0f342835d7f6adb8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/profiles.js\":\"d2c83084de3496d0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/properties.js\":\"fbc78bcb4d752f96\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/subtree.js\":\"ea6aa74ac31399c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/character-counter/textCounts.js\":\"e761f4b15a963ca3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/colemak-keybindings/index.js\":\"d9debbfc4c38b5d1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/CommandPalette.js\":\"ee3a9a672473cfa7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/HeaderItem.js\":\"2bcae7437a4b4cb2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/context.js\":\"9b4e8d87ab705b33\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/index.js\":\"6c4711e7aeac5b25\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/selection.js\":\"35f7c702f59fe452\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/toggleStore.js\":\"6921ccc9d8cd34cb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/command-palette/useCommandPaletteActions.js\":\"782411ab4e620da9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/ContributorBadges.js\":\"df124d15b2fae5d5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/ProfilePicture.js\":\"e15e096c59e6bc39\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/author.js\":\"7abdaf51c7d2793e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/codeMirrorExtensions.js\":\"74adb5c5cbe4d4b4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/dataExtension.js\":\"3d6c6eb11f2ca7f9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/index.js\":\"b6a703d975253309\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/mentionAutocomplete.js\":\"ccb9d7cc69afaaad\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/processor.js\":\"e3a967d860506f8e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/profiles.js\":\"2c2b06abae3e215f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/queries.js\":\"939444b42414e3c9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/schema.js\":\"0500dec6551e8488\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/contributors/useCommentAuthor.js\":\"6b374bdafa63f53d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4cdf487fefbe0b57\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/followOrigin.js\":\"4f02318c05d6cf2e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/index.js\":\"0db4664307aa92a6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"8c0263e0529b575b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c585f11617395b06\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/CalendarGrid.js\":\"874bbbcba774a409\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DailyNotePicker.js\":\"e60c7fc1e4464426\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d35d79667726d556\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DateNavDecorator.js\":\"28f8ba4adc5fb7c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DateScrubOverlay.js\":\"f4f976f13f7eeb9a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DayPropertyControl.js\":\"624c4df7f29719d2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/DayValueReferenceControl.js\":\"6a0f59996d3e45ae\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/HeaderItem.js\":\"0fe0bf0717be898d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/ReschedulePicker.js\":\"e27f0814fbd56ac6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/SpreadDatesDialog.js\":\"198be82fce6384e6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/actions.js\":\"7859d7b9be6c957d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/blockDateAdapter.js\":\"2cfb32a9a5f26eec\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/calendar.js\":\"24d73f86d3c21bc7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dailyNotes.js\":\"dc7fa4578f35fb2c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dataExtension.js\":\"cf3a7f8453c8f488\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubActions.js\":\"7f2f38a7c0f7a191\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubGesture.js\":\"6f3a828cf556f514\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e23752d7cefa1676\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9a5a5766904c2ae2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dayProperty.js\":\"4a6bd36db5ab0d94\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"182dd39f38e11455\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/deletionGuard.js\":\"579fdca807b4debb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/dueQuery.js\":\"ae05b004d64cc789\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/index.js\":\"717784fa8617b486\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/landing.js\":\"f5a3f372f5169d51\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/localSchema.js\":\"e6365ba2dc2b1f4a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/referenceDateAdapter.js\":\"c5d20450a6d973eb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/rescheduleAction.js\":\"04affa37cbd05908\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/schema.js\":\"910ce165a9cafc90\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/spreadBlockDates.js\":\"0c02871a82913170\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/spreadDatesAction.js\":\"ea921e3e9c706c5b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/today.js\":\"8b690100147a3248\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c3ba014f967c2ca7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"94061864bd0b934c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/audit.js\":\"21b9ff3c48477f5f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/auditAction.js\":\"08e7ff7a50a6fe24\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/auditRanges.js\":\"c4ed767b0a2da18e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/diagnosticsSource.js\":\"2d664a4d532784f4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/divergenceScan.js\":\"bbb253bb47fb3801\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/index.js\":\"06a413fc73301112\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d74d68d4ab968b2b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/referencesMirror.js\":\"555ba689e36c38f4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/rowJson.js\":\"e6bc951e018f56ca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/schedule.js\":\"833b61b26f9fc707\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/data-integrity/store.js\":\"139fd1d67ef7fdea\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-maintenance/action.js\":\"d6d1129eb2654b93\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-maintenance/index.js\":\"8cdf6f66f5021833\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-maintenance/plugin.js\":\"b38a5affea56c2a3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"be34ba936a36efd2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/actions.js\":\"9401e3ca6f9d065e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/changeMarker.js\":\"1af9ea7945d944e1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/diagnostics.js\":\"62bab06196f8be9d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/fileSystemAccess.js\":\"680f30b13c6335fa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/filenames.js\":\"1f75bf93708de0d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/index.js\":\"a5f673a5393b4c36\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/mirror.js\":\"43708b43bbd4a7c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/runLock.js\":\"58696676f6a77d16\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/runtimeHealth.js\":\"554feb223b7bfd77\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/schedule.js\":\"11a11c23131f5571\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/db-mirror/store.js\":\"88603dcc67511a03\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/default-themes/index.js\":\"797b23e0e5d0b484\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/default-themes/themes.js\":\"d582b09709698267\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/diagnostics/facet.js\":\"547de65dfdb81d00\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/diagnostics/useDiagnostics.js\":\"51220313601ce74c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/dismissals.js\":\"786775c098d9a0c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/index.js\":\"1e2c6025d76d7a74\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/status.js\":\"0db21dd2d74221cd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extension-prompts/store.js\":\"ef8621802a8a91b8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1315e1e7b329d4ff\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8877fe158788e099\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/actions.js\":\"86a618d2ca54caca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/config.js\":\"baa4f8a991bfeaaf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/dataExtension.js\":\"fcb64324fba7ad14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/effect.js\":\"5f5a16bc56d77922\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/index.js\":\"ba391bf74981ac76\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/propertyEditorOverride.js\":\"49701569f5b2cdc3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extensions-settings/useToggleTree.js\":\"f35ee446660058c6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/ExtractTypeDialog.js\":\"2a0757e1598cfd12\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"1aa493624d0bd2b5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/PropertyShapePicker.js\":\"fad4ab44dbd2d93f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/action.js\":\"3cc7810fdc9b0ea9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/extract-type/index.js\":\"813482b058849a51\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/FindReplaceDialog.js\":\"371a90b3e4f9b128\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/HeaderItem.js\":\"f60bbd5866109aa7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/dataExtension.js\":\"4118d9b7fb566263\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/index.js\":\"5e551bf2438de604\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/search.js\":\"713c571ca88494b5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/toggleStore.js\":\"2446cc3337f88535\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/LocationPropertyEditor.js\":\"b4203a141ca9f08f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/MapView.js\":\"930bbd8dcc618e47\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/blockTypes.js\":\"fa674bfe230dd1b8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/codeMirrorExtensions.js\":\"0edb602a38bba28d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/createOrFindPlace.js\":\"e480048bc8f3a2d0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/currentLocation.js\":\"a73a1f37abf95d5e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/dataExtension.js\":\"1788f92cb2408a5a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/geoContentDecorator.js\":\"3768c041003fbd7c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/googlePlacesClient.js\":\"c68e14d42a1b88da\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/index.js\":\"896531f5c1c169d7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/locationsPage.js\":\"4376fac5d24500a8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/mapViewport.js\":\"71da007ae6a79205\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/pickCurrentLocation.js\":\"271f49bc36941040\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/placeAutocomplete.js\":\"18056978ae72b9eb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/placeNameCollision.js\":\"53754d6512b70c9e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/properties.js\":\"7986952e80f9561e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/propertyEditorOverrides.js\":\"007a241633e23bcd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/query.js\":\"f1205a137a66b1e6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/geo/usePlaceSearch.js\":\"8f31204020f132f6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"391df79822c516f9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7f6ea5e6603fdb53\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"2fc464c77036b98f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/config.js\":\"880c4f3d6d901e7d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/dataExtension.js\":\"d12544abe581f91b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/facet.js\":\"3ffd41b70617c4ab\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/grouping.js\":\"498a1c54af2e434b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/index.js\":\"4a94a0260e310339\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"0e07cfcdd7161295\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/query.js\":\"2a2de167451103d1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/resolveConfig.js\":\"9a803cf2cfa22be8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d128b671d3881d05\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"5a891194db7ec2ca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/HtmlDocumentContent.js\":\"051729d3d9a9992f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/HtmlFrame.js\":\"b92c2651979fa208\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/actions.js\":\"53b5284d5abc733c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/blockType.js\":\"88d1cc2ff5bc522e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/confirmRunScripts.js\":\"b32c9a78346549f4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/dataExtension.js\":\"dd8604b599015f22\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/frameAnnotations.js\":\"04680d05a336b166\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/frameDocument.js\":\"12a4a4ab914a67f1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/frameTheme.js\":\"543d988d56e83a64\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/index.js\":\"2fb18773c68a586c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/scriptConsent.js\":\"5e9179570e65fb16\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/sourceMap.js\":\"1f17f7daa0d59562\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/html-document/useDocumentScripts.js\":\"102b766806ddde49\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/index.js\":\"38e8b004286e0ca8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/record.js\":\"3b022f433cc06efd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/recordStore.js\":\"d8371a4ef67c9ccd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/responsiveness.js\":\"5821df49731e815d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/schedule.js\":\"45aa1997097fc1ef\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/interaction-metrics/sessionContext.js\":\"a010bb7430fe6a9b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9a75e75c8631f928\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"562ef391e3664efd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/actions.js\":\"cf49f5c139241c94\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/config.js\":\"e2a907aa386cd9aa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/dataExtension.js\":\"56d32f0926ba5db4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/effect.js\":\"39406edaaa6bf6f1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/index.js\":\"b7519ebe8b5d1269\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/keyCapture.js\":\"19ff69ae521af252\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/overrideStore.js\":\"1a7222ec210fe555\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f0241e625b4f5d92\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/HeaderItem.js\":\"7b2c21445b2f2ec9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/LeftSidebar.js\":\"6322329881e945d0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/actions.js\":\"1f12e1b1acafa561\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/facet.js\":\"38c8a7bd5ee130c6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/index.js\":\"66dc14d92aa40a38\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/shortcuts.js\":\"dae90c7993f90adc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/left-sidebar/toggleStore.js\":\"ff756b911565dfad\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/MergePicker.js\":\"073c0e57450a7652\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/index.js\":\"c99d53cb5bd8edb8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/mergeAction.js\":\"ab65e862d4702bcf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/merge-blocks/strategy.js\":\"0d38381babf64d5b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/Button.js\":\"3f0583b1c12a8d53\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f1861619709a16ac\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/defaultItems.js\":\"5e6cfe192519ee7a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/facet.js\":\"d0a404271e8f6b6c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-bottom-nav/index.js\":\"d2947ad41eb56144\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a22aa2d76484e20c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/actions.js\":\"9e2e5688110dcaf7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"3cd3b6b67a69300c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6fe335c846a1a6fa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/mobile-keyboard-toolbar/index.js\":\"e472e53e82732f96\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3aa2c8d40260ac58\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/blockSubtreeMembership.js\":\"90101da0771cdf86\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/contextMenuItem.js\":\"90dc57d4b0e6e8e9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/index.js\":\"65929787423487a2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/moveAction.js\":\"de996c3bb15b6a20\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/moveBlocks.js\":\"f11e2e423498c3ce\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/move-blocks/selectionAfterMove.js\":\"005060e3434ed1dd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/TutorialBanner.js\":\"2b78ceca38fbaaf8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/action.js\":\"e13d3d739a26180f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/bannerDismissal.js\":\"3f3267889da28c38\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/documents/cheatSheet.js\":\"420a318f5caa0a23\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/index.js\":\"622a345ffa456e57\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/keys.js\":\"b22348f14b63ce79\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/landing.js\":\"d2a08b36dc3b3b9b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/outline.js\":\"4bfcfda710570a6a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/onboarding/seed.js\":\"c7afdb4e7bdc1287\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1c091ff2b560624b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/analyze.js\":\"9fe18c51d10e3b96\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/diagnosticsSource.js\":\"55f891561963e205\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/index.js\":\"2cd4ee22bedb83d3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/load.js\":\"97f11bcb7e04d3b1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/monitorRun.js\":\"0701d5d0136bed2a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/schedule.js\":\"a57b2c56473091d9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/series.js\":\"9b3f9f5517ad149e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/store.js\":\"9829203564199396\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/trendAction.js\":\"f3504094c35c4d83\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/perf-monitor/verdict.js\":\"930cb459e2e3d9c4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/plain-outliner/clickToEditAction.js\":\"ed8d81f1699f200d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/plain-outliner/index.js\":\"508e41df28278f00\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/plain-outliner/interactions.js\":\"bfd060f351d54633\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1dd2a31a6d613abc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/MigrationGate.js\":\"6d50d6a7e38e36d3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/MigrationGateDialog.js\":\"7cd39177c4da64c7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/action.js\":\"ff3baae2cd8f4b63\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/index.js\":\"61256946763cedaa\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/localRunMessage.js\":\"34bc912c60c9eeaf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/plugin.js\":\"df95883d66270629\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/progressReport.js\":\"7165e2e3fdc5fdff\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/properties-migration/sweepProgress.js\":\"d374a1b3ab1a853b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/FieldRowRenderer.js\":\"05487a1d7c0a03ef\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/ValueRowRenderer.js\":\"b17d56927b8edaf7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/actions.js\":\"f140904e0b1d2935\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/autocomplete.js\":\"0ec2dca60d11aa7a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/fieldRow.js\":\"5cda78c083fdf3ad\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/index.js\":\"b7c2e342cf28d79e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/referenceWarning.js\":\"0bc75de72ac25bd7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/valueAutocomplete.js\":\"f0ca66e11bddfcca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/property-rows/valueSchema.js\":\"b97c171ca0520bd4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/HeaderItem.js\":\"b582a154e7c646c5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/QuickFind.js\":\"a3e812ebe67b0b2b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/index.js\":\"16ffc7d27b47193a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/recents.js\":\"21a0b11d8b3d72f5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/resultItems.js\":\"fecb52de783fc0ed\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/selection.js\":\"897e131d3e4974dd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/quick-find/toggleStore.js\":\"4b31a7de01c3b6a8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/HeaderItem.js\":\"8142e5c06262cabf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/RecentsPageBlockRenderer.js\":\"3e499137a1e46f00\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/grouping.js\":\"11c11bb4f4e637e2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/index.js\":\"624aa6c0a7146af4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/recents/target.js\":\"d5a34cf7567de80b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/codeMirrorExtensions.js\":\"ace203a9fb270d15\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/contentPrefill.js\":\"078428e923b98546\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/dataExtension.js\":\"53fca4abcf386622\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/index.js\":\"692900d022a0d244\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"02be9b9dcc55bdae\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/invalidation.js\":\"249d0231cc61db05\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/localSchema.js\":\"6bce9bfcaa7ed545\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/blockrefs/index.js\":\"4f8be4a284502a5e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"94ad6c9425a3c94d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/index.js\":\"515441eb8611d599\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/referenceNode.js\":\"32b55e01d8588329\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d4b6fab3d9f60737\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5c256ffab13cf63d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/index.js\":\"0fdcc79b540a9123\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b7173b622913bb0d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c87aafffd142239e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/mergeRetargetProcessor.js\":\"dda368aa3d4d1cc3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/parseFence.js\":\"92277b0a5698ba64\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/referenceParser.js\":\"2330cd3429525a55\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/referenceProjection.js\":\"0a1cc0fa5ee6deb2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/referencesProcessor.js\":\"15865397083683c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/renameProcessor.js\":\"db869a0ea711ae8a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/references/spanReplacement.js\":\"162c017cea284322\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/htmlToOutline.js\":\"f268af099dd273d5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/index.js\":\"be45baa12841c10c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/normalizeClipboardDom.js\":\"946ae436956b8c3c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/rich-paste/pasteDecision.js\":\"62f3ca0099874144\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/action.js\":\"a3c6374b229e9899\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/blockIds.js\":\"68267a16b7547dca\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/content.js\":\"2990daf3d1057680\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/effect.js\":\"f3e9e14bd1dc565e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/ids.js\":\"7667ec01d3a39772\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/import.js\":\"5be19d4f6f7322de\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/index.js\":\"4251e02b1ceed15a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/plan.js\":\"7f5dd94c8554027b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/plugin.js\":\"75429a2d982f9402\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/promotion.js\":\"cc01c77374acff6c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/properties.js\":\"370e6fe5a21912f1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/references.js\":\"751a1d0704726852\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/report.js\":\"dfc87a0a88819830\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/roamMemo.js\":\"91f26a2376b839b5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/runtime.js\":\"b897651dcbce83b3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/schemaReconciliation.js\":\"f5205f32ec7066a1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/srsMarkers.js\":\"5362267283b209a3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/todo.js\":\"9423c0ccbf672fb2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/typeCandidates.js\":\"13e2a3703fd8effc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/roam-import/types.js\":\"d54c9c17132c70ab\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/search-health/index.js\":\"025ed7f82e8ba474\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/search-health/store.js\":\"d7a0148a4c31b687\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/HeaderItem.js\":\"d92098b5a97ae4a6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"e9fe20d263502417\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/index.js\":\"8000aa0252431346\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/model.js\":\"8277eb0fb303412e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/toggleStore.js\":\"5b3c3690475acfa1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/shortcut-help/useKeyInspector.js\":\"c17a9bf99c12d8eb\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"d7cd4d56712b658c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/ShellDecorator.js\":\"9c89db5b7346a21d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/actions.js\":\"c057aa9ea96c9728\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/exclusionsFacet.js\":\"f58bbf91268ef604\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/index.js\":\"cf4db15df165c90d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/shell.js\":\"a2895828d6b8fd73\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/surface.js\":\"ca27d04f5818c2d1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/spatial-navigation/walker.js\":\"d091ed49b7c79cfc\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1e1f619a50aa74f9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/dataExtension.js\":\"97e9b25024c9af44\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/index.js\":\"c8bc40dadd3b7ef0\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/indicator.js\":\"b518e73ce4e7c46f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/moveSrsState.js\":\"abc8df97a266f0ec\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a34aece2df2b8f41\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/scheduler.js\":\"b8aa2ad0114035f5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/schema.js\":\"80d7ca9a6075c7c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ecc0c3fbcdcaeda9\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/srsClipboard.js\":\"aa949d664f53e6ba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c3e4037c51d09331\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e5d74430e8505a5b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/DeckPicker.js\":\"1707c38c6e5f474c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/ReviewControls.js\":\"febb05be6c449436\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0f68209db6794c8d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/ReviewSession.js\":\"2479602d0550ce4f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/actions.js\":\"7ed6b396a36ca61e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/archive.js\":\"a328f267cb5af91c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/dataExtension.js\":\"1d099c99bf19a540\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/deck.js\":\"b757f92d5fb9b956\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/dueQuery.js\":\"ebc1ec6023d72b0f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/gradeDecision.js\":\"391ffdd959a404d6\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/index.js\":\"532d31ac706edf04\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/keyHints.js\":\"08ebc7dd0d4b559e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/reviewCardLayout.js\":\"e06da8d717013d29\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/reviewProgress.js\":\"81d279ee3fa3302f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/schema.js\":\"a3e28169dd2a3cf7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/srs-review/useDueCards.js\":\"555af50b64c96554\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/startup-metrics/index.js\":\"a3bd7cf41ff3d545\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/startup-metrics/record.js\":\"edfa648535040984\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/storage-persistence/index.js\":\"37b3c5815f1ab43c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/storage-persistence/persistenceStatus.js\":\"a3e99c9cc6287c10\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/storage-persistence/requestAction.js\":\"736ccf2555e6d471\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/TypeChipsDecorator.js\":\"b235bf8e1c98a7a2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/codeMirrorExtensions.js\":\"7573389f369e5119\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/index.js\":\"9911fc73be745416\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/supertags/typeAutocomplete.js\":\"23d6856b0accffee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e791d041df5dd317\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/actions.js\":\"fde7673a0e2807ba\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/anchor.js\":\"8fae019c9756999e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/events.js\":\"8939ffd6b14868fd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/gestureActions.js\":\"b1d2c63b999ad75c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/index.js\":\"0b799e925b28952e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"95447df74e339394\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/sync-metrics/collect.js\":\"b6e4a79cda622d2a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/sync-metrics/index.js\":\"77783cb03994bb72\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/sync-metrics/record.js\":\"0a95df5da2a662c1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/RejectionDialog.js\":\"f456bd899425f0b8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f45b0368b662524e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/index.js\":\"944e53ee08426372\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/model.js\":\"67672dfd5a7a23a3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/queueCounts.js\":\"c7084674eb6b9a26\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/rejectedHelpers.js\":\"d10155ef1ee0fb64\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/rematerializeAction.js\":\"1d0bd266ed07f2c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/system-status/useHysteresis.js\":\"f3afa546ca937544\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/ColumnHeaders.js\":\"8605a03a0ebd00f3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/QueryUi.js\":\"34900a2bf8525902\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/TableLayout.js\":\"9483d032e17320b7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/actions.js\":\"a8cea4adc207116b\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/cellEdits.js\":\"6e58dd68e4102462\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/childrenViews.js\":\"08c9b8a9ec48da0e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/columns.js\":\"5badb70ec9d7753e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/controller.js\":\"09eb7baab552f403\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/convert.js\":\"ebbfbe9a9342cfe4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/dataExtension.js\":\"3dc7997c37ae4683\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/index.js\":\"130e0d589058e8ee\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/keys.js\":\"f94ebf3318349fd8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/model.js\":\"8098a89b484dcb2f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/QueryText.js\":\"157ff8db2df20a21\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/backfill.js\":\"67c7641b52379266\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/completion.js\":\"cc745d8c9c1ad7c4\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/format.js\":\"88ba68d1d53ef797\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/parse.js\":\"71aefda9e0a8ff8e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/queryValue.js\":\"bfe72c05e4a6b374\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/registrations.js\":\"574b40c9a9b8085a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/query/source.js\":\"179afa1fbcea7307\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/registry.js\":\"c91f6b735807d439\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/rowGutter.js\":\"ef4eefd028c0564f\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/rowVerbs.js\":\"14177a3bbf7b09b1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/schema.js\":\"4e8cfb31f8212374\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/tables/sort.js\":\"a7f2af40deeabd60\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/theme-toggle/effect.js\":\"5f3868497682d789\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/theme-toggle/index.js\":\"77a19417b77135e1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/theme-toggle/theme.js\":\"f5e6defe5ca61260\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/actions.js\":\"872547f36c42ab00\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/dataExtension.js\":\"5f472c90f5e58615\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/index.js\":\"c066ed8ea389546d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/todo/schema.js\":\"39d1808fca82070d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/TouchSelectionLayer.js\":\"6e20f7c3b750fc48\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/actions.js\":\"671f839009611a43\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/defaultItems.js\":\"7d965e04a059e0e1\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/facet.js\":\"baea1f42b53116a5\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/holdRecognizer.js\":\"55d94d73b27e195e\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/touch-selection/index.js\":\"f10d771e5cbf710a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/update-indicator/UpdateIndicator.js\":\"c65763ca0e04889c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/update-indicator/index.js\":\"c1e9f70aa7422199\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/update-indicator/loadTimes.js\":\"5e567712015f635d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/VideoNotesRenderer.js\":\"974667d16b44dab2\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/VideoPlayerRenderer.js\":\"b1ca7c6a392ea834\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/VideoTimeStamp.js\":\"05d2eed3c8852d21\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/actions.js\":\"7030277d673095d8\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/index.js\":\"e681d5c96071c02c\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/markdown.js\":\"ebf682ec42156068\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/notes.js\":\"84207248702a756a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/registry.js\":\"e3c07a92d656d4d7\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/remark-timestamps.js\":\"e748ececc56d0c34\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/video-player/view.js\":\"6c4e6449c4e147fd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/LinkHints.js\":\"f29d29b3c2ac152d\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/index.js\":\"f839231a802c01cd\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/model.js\":\"b815c36db15fc7cf\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-link-hints/settings.js\":\"2cea6dba7f1294c3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-normal-mode/actions.js\":\"13bfb58bfb267d2a\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-normal-mode/index.js\":\"2566e34f3ee580b3\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/vim-normal-mode/interactions.js\":\"f1991c7e9e24cc53\",\"/knowledge-medium/pr-preview/pr-1911/src/plugins/workspace-header/index.js\":\"5e073134b1b76aea\",\"/knowledge-medium/pr-preview/pr-1911/src/registerServiceWorker.js\":\"082b8a02c4a6f3dd\",\"/knowledge-medium/pr-preview/pr-1911/src/requestPersistentStorage.js\":\"f7acdc983b07ab95\",\"/knowledge-medium/pr-preview/pr-1911/src/services/authRequestDeadline.js\":\"7e8ade5b440fa9ec\",\"/knowledge-medium/pr-preview/pr-1911/src/services/authStorage.js\":\"68d96f18da4a2817\",\"/knowledge-medium/pr-preview/pr-1911/src/services/powersync.js\":\"f5ee61b920714523\",\"/knowledge-medium/pr-preview/pr-1911/src/services/supabase.js\":\"98808c597e2dc295\",\"/knowledge-medium/pr-preview/pr-1911/src/services/uploadErrorClassifier.js\":\"56f43cbffe138049\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/ActiveContexts.js\":\"b3665535c33bd13d\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/HotkeyReconciler.js\":\"105576b043a5d94b\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/WipeLocalDataDialog.js\":\"536cb34cbc0bc03f\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/actionDispatch.js\":\"20f1e8b0e8977fc7\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/actionRefItems.js\":\"9cb73fb3824909eb\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/applyKeybindingOverrides.js\":\"59fc99c286e4ee78\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/blockActions.js\":\"f46bf016bde10c06\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/blockMergeGesture.js\":\"bff74331f77fd46d\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/canonicalizeChord.js\":\"f4fee6f2f93751c0\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/defaultContexts.js\":\"0fe96be97a534f52\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/defaultShortcuts.js\":\"8e6da476ff2acddb\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/effectiveActions.js\":\"b2a8ce42610c1a44\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/gestureAction.js\":\"4c5134ef0ac5d969\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/gestureBinding.js\":\"1440f7eaaa16770e\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/holdRegistry.js\":\"2791111c71cc759f\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/keybindingConflicts.js\":\"7d0d3c73981408aa\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/keybindingOverrides.js\":\"c9c1bd1d5b33659e\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/pointerAction.js\":\"2f9987a26bf20436\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/resolve.js\":\"38b8930863c2d000\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/runAction.js\":\"bf2ab822e3ea982c\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/sequenceMatcher.js\":\"6619d83f3dc5f428\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/types.js\":\"0a1c26e05ea36b6f\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/useActionContext.js\":\"fc41133904f0c164\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/useActionDiscovery.js\":\"d37c1e3f904bb876\",\"/knowledge-medium/pr-preview/pr-1911/src/shortcuts/utils.js\":\"647ef603b6d956c1\",\"/knowledge-medium/pr-preview/pr-1911/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1911/src/sw/bootStore.js\":\"9ee26c6ccefda8b0\",\"/knowledge-medium/pr-preview/pr-1911/src/sw/previewDatabases.js\":\"f1385e48201ce8c0\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/byteTransform.js\":\"efa53fefa2c47c48\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/attachmentCleaner.js\":\"8e3853ca03fad9cd\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/attachmentParts.js\":\"1d1cb6cc62f902a5\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/bundleParts.js\":\"c6dd9e3693ff1363\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/bundleRecord.js\":\"27ca7faf1b7f7ec4\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/manifest.js\":\"8cc5833104eb6c0d\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/takeBundle.js\":\"45cf0322c1383570\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/bundle/verifyBundle.js\":\"3e7627230fd3f10c\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/cleaningStage.js\":\"40ed19f041df7be0\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/conversionKey.js\":\"0b756f4d782bf8ec\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/conversionServer.js\":\"0bf3948b1f688a6b\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/flip.js\":\"accbcd629748fcef\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/flipAttempts.js\":\"f2367aa3bd05d6e7\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/pages.js\":\"3af48a2122e191ca\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/preflight.js\":\"ed573ccf99a8074d\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/reseal.js\":\"8e59109e7ab177d6\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/runConversion.js\":\"2f2ad52c00414e75\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/runLock.js\":\"929720a9b6596df1\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/sealing.js\":\"0d004ee9dafdb90e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/sealingStage.js\":\"e8121f71b7fde5a4\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/stage.js\":\"47a73c59df6d2e09\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/conversion/verifyReseal.js\":\"34ed7ab060fe02e1\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/aad.js\":\"a04725289a3bc463\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/aead.js\":\"114caadaa9ac9eb9\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/base32.js\":\"33cf1ed07612999a\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/base64url.js\":\"f3d5644e7a8be43e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/binaryEnvelope.js\":\"f73d381767ba0522\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/byteAead.js\":\"c303688fa0c35e36\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/canary.js\":\"8c1e15e988fa9a15\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/contentHash.js\":\"e8f07d00113e4d1e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/contentKey.js\":\"ac8ca604cb771060\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/derivedIdNamespace.js\":\"90d0a1e730e70a5d\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/envelope.js\":\"91afef8b56399378\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/hex.js\":\"ea1c18ecde0fe963\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/sha256Hex.js\":\"68644cd3286f3c93\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/crypto/workspaceKey.js\":\"ef4614440fc4e4a2\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/conversionState.js\":\"586878e0c4d633cf\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2bbc2b21a812f7b6\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/pastedKey.js\":\"0636e40b8803c585\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"6d68bee3670e33ee\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e57c55c6682e607b\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/keyStore.js\":\"9f0d4404159976c8\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/mintWorkspaceKey.js\":\"1e8148f464f3a56e\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/modePin.js\":\"2ff89c7a9f2501a2\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/openWorkspaceKeys.js\":\"c7f7e58c174e48b5\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/resolveWorkspaceEntry.js\":\"a3c8e721dac6775b\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/resolver.js\":\"dfe50c636168886b\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/keys/workspaceAccess.js\":\"c32da4aaf9248ff7\",\"/knowledge-medium/pr-preview/pr-1911/src/sync/transform.js\":\"93bfe646f382f0e3\",\"/knowledge-medium/pr-preview/pr-1911/src/themeBootDefaults.js\":\"71b85b15d9662174\",\"/knowledge-medium/pr-preview/pr-1911/src/types.js\":\"655462808a534c85\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/ClientLocalSettings.js\":\"a1052a41571b4da8\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/abortableSleep.js\":\"fe42a40c5bffcb20\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/array.js\":\"2bd99d11ff092717\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/backlinkAutocomplete.js\":\"948aad62ea30b04e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/blockCrumbs.js\":\"52ff67488e7e2bad\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/blockrefAutocomplete.js\":\"52cbc63bbc1b45dc\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/cadencedIdleJob.js\":\"dfd99ea0dd058ff0\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/callbackSet.js\":\"333ea8ff2bcf01d1\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/clientId.js\":\"3f14071eea07ac8b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/codemirror.js\":\"608398b740e6f1a5\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/codemirrorCompletion.js\":\"0d4ddbf8545a654b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/copy.js\":\"42ed00da90a03fb0\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dailyPage.js\":\"ff11eb595f7b6a0a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dbForensics.js\":\"6044852c28e8c3f0\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dbForensicsHooks.js\":\"0e1f953dee60f1ea\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/deleteBlockThroughUi.js\":\"ad71c14af3b91fe0\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dialogs.js\":\"1e4dc49d6bcb7394\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/dom.js\":\"ec440e83ef74453d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/downloadBlob.js\":\"dce4dfcd9a2f433d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/drawnWalk.js\":\"1afd331a5b0d6a05\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/exportSqliteDb.js\":\"2f7237b8fe3999c7\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/fileSystemAccess.js\":\"c0c8dc32c0d8597f\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/flipSlide.js\":\"ec7781e6fd6081e4\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/fnv1a.js\":\"6be67f53838a124c\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/formatBytes.js\":\"6cfff31f9512a550\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/fuzzyRank.js\":\"bf57fbe26cb77784\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/idbKeyedStore.js\":\"b95546fa97bebefe\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/idleCallbackPolyfill.js\":\"4058bcb9574be243\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/keyboardAwareScroll.js\":\"89ac698eb22abf2a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/keyboardViewport.js\":\"df7974d4263df706\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/lastWorkspace.js\":\"1d2e922eacf129ea\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/layoutColumns.js\":\"87b14d248ccd72ea\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/layoutSessionDom.js\":\"5ec1c2e70b84da94\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/layoutSessionId.js\":\"6fcafb3bf5b27e3d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/linkClickGestures.js\":\"625273fe7f04139d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/linkTargetAutocomplete.js\":\"1e2d951e4ae5cac6\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/localDbCorruption.js\":\"29fb6400b36e8a51\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/localDbRecovery.js\":\"331f73c20abc6f7d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/markdownParser.js\":\"292759b1d6963c04\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/memoize.js\":\"f5b0bc80e18aa066\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/nameFieldCommit.js\":\"91af76b79e3e786e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/nameList.js\":\"ecddccfb3f153392\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/navigation.js\":\"e13ec32eabb8bb05\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/omnilinerNamespace.js\":\"110f78fd7f555fc9\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/opfsPageScan.js\":\"f40a5b99c62f6022\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelClearance.js\":\"6b883a98153819d5\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelHistory.js\":\"1301a74224d4a0aa\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelLanes.js\":\"e07156bcb0303ef7\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelLayoutProjection.js\":\"e9273eb710f6c6cf\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelScrollAnchor.js\":\"323c447398ddea60\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/panelUrlFlags.js\":\"1da150cd490486ee\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/platform.js\":\"ba0832b789b87425\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/pluralize.js\":\"6d273ca864c2c07c\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/propertyCreation.js\":\"155ab86e6814c34d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/propertyNavigation.js\":\"af02f4d4f89d3b7a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/propertyValueContext.js\":\"e70faa6b5a5ca2bb\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/react.js\":\"0955937ec98b20ff\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/relativeDate.js\":\"51e5a57598aa9e99\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/relativeTime.js\":\"2192241245f700ed\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/renderScope.js\":\"5b19e152a8ac4c6e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/resolvedThenable.js\":\"9be183bcac2c5186\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/routing.js\":\"15ff3831cecfd10d\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/safeMode.js\":\"e6befb08172dd6d1\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/scheduleIdle.js\":\"f51c5e8f788d845e\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/screenWakeLock.js\":\"d40acb127f30a814\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/selection.js\":\"dad2e6a1bccf6dbc\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/softKeyboardGrab.js\":\"f46fb2c017b53415\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/startupTimeline.js\":\"670bcf192e7160bd\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/state.js\":\"898ad836286f0b58\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/string.js\":\"e940faea6e3db74a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/surfaceZoom.js\":\"cbd2b7960a84ebe5\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/time.js\":\"4638dce96fa51ab8\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/toast.js\":\"c84fdc461fde34c3\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/toggleStore.js\":\"efaefde1a96fb0ca\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/untilStopped.js\":\"54a0c920767d3e9a\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/userActivity.js\":\"cdcde2108dfce7b7\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/viewTransition.js\":\"5726a414de3996b6\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/viewport.js\":\"5051290804ffe54b\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/webLock.js\":\"5a6e9a42a1820a9c\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/workspaceRecovery.js\":\"474858ad5b5c0aee\",\"/knowledge-medium/pr-preview/pr-1911/src/utils/workspaceSnapshotStore.js\":\"e8cab16d14630830\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-compiler-runtime.js\":\"122300347cde65a7\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-client.js\":\"499d1fa7ded64dc3\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-server-edge.js\":\"86eaa1d1fc946229\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-server.js\":\"9bc98b3b92cbf288\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-static-edge.js\":\"8407865e9ef0ce83\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-static.js\":\"04fe471473d82049\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom-test-utils.js\":\"3e00f9e4c69306d6\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-dom.js\":\"fff01301af8e18e0\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react-jsx-runtime.js\":\"20c37beedbf691f8\",\"/knowledge-medium/pr-preview/pr-1911/src/vendor/react.js\":\"44a4cc16039187de\",\"/knowledge-medium/pr-preview/pr-1911/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1911/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1911/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
