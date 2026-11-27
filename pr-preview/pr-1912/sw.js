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
		buildId: "8ff36c2bf7df-58154547",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/\":\"4c73cc15f93ff097\",\"/knowledge-medium/pr-preview/pr-1912/index.html\":\"4c73cc15f93ff097\",\"/knowledge-medium/pr-preview/pr-1912/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1912/assets/FacadeVFS-z0B0ZQDn.js\":\"d99dade86fe43df1\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSCoopSyncVFS-DoojieyI.js\":\"34f7f1cb4a56f51b\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSWriteAheadVFS-NsruLbjv.js\":\"87f5aa8e6785473d\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-4GSll1Mp.js\":\"6140e36f7dea7f67\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-BCRBXAqc.js\":\"018f6c8b2a143b45\",\"/knowledge-medium/pr-preview/pr-1912/assets/worker-BYg_2rPe.js\":\"fe9bc682b865cb6d\",\"/knowledge-medium/pr-preview/pr-1912/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1912/chunks/app-De-lIFbD.js\":\"5069a01ee70cf30f\",\"/knowledge-medium/pr-preview/pr-1912/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1912/index.js\":\"752218bc2b7372e1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1912/assets/AccessHandlePoolVFS-cQAAQGdG.js\":\"c4ec8efc6f0ab44e\",\"/knowledge-medium/pr-preview/pr-1912/assets/IDBBatchAtomicVFS-DdNRDtnV.js\":\"a07ba84f95d309a9\",\"/knowledge-medium/pr-preview/pr-1912/assets/MemoryVFS-Cezz5vZE.js\":\"edf30314a3479c94\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-B0dUFdPu.js\":\"eff18346372b58c8\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-CctxJKTs.js\":\"af5f140e179ca6c6\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1912/chunks/AccessHandlePoolVFS-DlzoaXgI.js\":\"a570571307f62739\",\"/knowledge-medium/pr-preview/pr-1912/chunks/FacadeVFS-DdlEoK_w.js\":\"273675a2817c8d2f\",\"/knowledge-medium/pr-preview/pr-1912/chunks/IDBBatchAtomicVFS-C_XKoL4S.js\":\"e218b01668084365\",\"/knowledge-medium/pr-preview/pr-1912/chunks/MemoryVFS-BhlQl5ws.js\":\"59c56eb58dad225d\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSCoopSyncVFS-BG4QPR37.js\":\"a0985e1fd313d3fb\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSWriteAheadVFS-pkYxXtBD.js\":\"d119ed59c93283eb\",\"/knowledge-medium/pr-preview/pr-1912/chunks/Preview-BTnHvjZs.js\":\"3221f815646379cb\",\"/knowledge-medium/pr-preview/pr-1912/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1912/chunks/card-DiBO_74V.js\":\"d0a2e0b13b056a46\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-C3-hmyQq.js\":\"d7a50c16021e7296\",\"/knowledge-medium/pr-preview/pr-1912/chunks/freezeExtensionImports-B3Oz7WDu.js\":\"d830d3a0ad78c1e3\",\"/knowledge-medium/pr-preview/pr-1912/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1912/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-DtQKssN8.js\":\"0da7da74c69c5d72\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-async-DVbvn30X.js\":\"ba92c11e09beea44\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-BDeKwp1Q.js\":\"8ba2f127661b4139\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-Bndv4EbH.js\":\"35a8927cabe4fa35\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-Bv1-gbPm.js\":\"bf46c4e8ca2bf2a0\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-C0B6_J6S.js\":\"9689854e06150230\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-C6rCdVdc.js\":\"5f2685d917b1fd33\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-CYfHKcZx.js\":\"e2d3763bdfc910a0\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-Csf5aPV0.js\":\"095f1b7713d7a8a3\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-D4L45TNp.js\":\"29c95bce161cf495\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server-legacy.browser.production-BkMh4HO1.js\":\"de20a636fae64457\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.browser.production-D1so5t_K.js\":\"a71ddcef8899d27b\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.edge.production-CyzbbP6D.js\":\"01c274e9e4d364fa\",\"/knowledge-medium/pr-preview/pr-1912/chunks/server.browser-DsThPB4C.js\":\"52dbd187989cd347\",\"/knowledge-medium/pr-preview/pr-1912/chunks/textarea-DEn3Kxi-.js\":\"c96b83e4ebdaac5f\",\"/knowledge-medium/pr-preview/pr-1912/chunks/ui-P9o_i7GI.js\":\"99cc427097e2b383\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-DIvmIEH6.js\":\"726811a0d8d04043\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-async-DCuUfx99.js\":\"8b4ab71b9536f2e4\",\"/knowledge-medium/pr-preview/pr-1912/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1912/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/src/App.js\":\"53147f9dd94253d2\",\"/knowledge-medium/pr-preview/pr-1912/src/appUpdate.js\":\"29b206b62f25de20\",\"/knowledge-medium/pr-preview/pr-1912/src/appVersion.js\":\"b4764086b56d9c0a\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/initialLayout.js\":\"7a2eab28567a3b0a\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/openWorkspaceData.js\":\"09a32a3f4216460d\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/resolveWorkspace.js\":\"d0847acad3b3f54c\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/workspaceBootstrap.js\":\"cbb0fafc06ab504b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockComponent.js\":\"29fa1e8eeccf43d5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockCrumbs.js\":\"71025ea35344b514\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockEditor.js\":\"c3df9615d511437c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockLoadingPlaceholder.js\":\"235baec01273304a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockProperties.js\":\"d1d4fbdc33883eb7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockSearchPicker.js\":\"79dd0b334e0bf479\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ConfirmBulkDeleteDialog.js\":\"e1b120084649e312\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DividerHandle.js\":\"1f282ee0e9303a60\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DraftEditor.js\":\"179ad4c332288330\",\"/knowledge-medium/pr-preview/pr-1912/src/components/GutterPill.js\":\"95345666982c62c8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Header.js\":\"aabb59c2cba04233\",\"/knowledge-medium/pr-preview/pr-1912/src/components/LazyBlockComponent.js\":\"d90d4e0eceffba9f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Login.js\":\"70ba97f5f57a7ad7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ZoomableSurface.js\":\"9eea77d35dc9f386\",\"/knowledge-medium/pr-preview/pr-1912/src/components/editModeKeepalive.js\":\"ecce877f1b34b984\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e559761a213215b0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"79e020ab04af5954\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefPropertyEditor.js\":\"9e3f4ba8be8f2ce1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefTargetTypePicker.js\":\"4dba00421e178c65\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/SelectPropertyEditor.js\":\"adc9096bd0b093be\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/TypesPropertyEditor.js\":\"8b5d2a70cd84300a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/defaults.js\":\"69564b6852846dbe\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/kernelValuePresets.js\":\"60e64bbb880bdf1f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/selectablePresets.js\":\"f4bc14209cfc1a51\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/typesPropertyUi.js\":\"e5f40a5b9d13876b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/AddPropertyForm.js\":\"94b82d8c39b52962\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyPicker.js\":\"67206e36e7dcc5aa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyRow.js\":\"541c74f11f4b68dc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/Rows.js\":\"1efe48442f155ca1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/actions.js\":\"71ca6ef296dc00bd\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/declarationOnly.js\":\"96b9304c908d40f4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/layout.js\":\"5b565b091811e3a6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/model.js\":\"cfc5a0d4b623c2a1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapeUi.js\":\"8736d17a33689436\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapes.js\":\"dacbc3487f4690a5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e882a7879bae17c3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/visibility.js\":\"5ad2c6022d191e54\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanelSections.js\":\"910c6e5de5d6778e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockEmbed.js\":\"b221b183975665d3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockLink.js\":\"5f79f7f295025f8e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockRef.js\":\"b1e687dee7cf1e47\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/CompactReferenceLink.js\":\"910576df103a195f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/ReferenceLink.js\":\"a22af507f52e5934\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuard.js\":\"836c349b1bc32c6e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuardContext.js\":\"5ff23ceebcf74641\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/linkInteraction.js\":\"1abbddc50ba02902\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/referenceLayout.js\":\"1a37e310867cc954\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/useBlockRefAncestors.js\":\"61578c5082cbe623\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockGutter.js\":\"226a3ae01cfc2896\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockInfoDialog.js\":\"59b1fd0a14cbb9e1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockReadText.js\":\"61c3a28882a860bf\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockTypeBlockRenderer.js\":\"02d2d8b6df0f6d30\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BulletHoverCard.js\":\"c1543443f5056560\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorContentRenderer.js\":\"1ba3141c55f7ec3e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8a45ea5c99ba1e0e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ColumnResizeHandles.js\":\"bb75ef2a98aad9e4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"41db23d970590aa3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/DefaultBlockRenderer.js\":\"9fc2a013f56ecdd3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/LayoutRenderer.js\":\"a0d38d7290c14810\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MarkdownContentRenderer.js\":\"cbc1051e9e042db6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MissingDataRenderer.js\":\"4fc1d9f63348a83d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PanelRenderer.js\":\"c33894b7128bd5d1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PropertySchemaBlockRenderer.js\":\"f23a3077c511bc04\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/TopLevelRenderer.js\":\"3fd25230a9767bfa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockGutterMode.js\":\"962862d07ce2ff56\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockTitleText.js\":\"75580ad4851f9a17\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/fieldCreationKeydown.js\":\"477481fa74e8e08d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/layoutRootContext.js\":\"278938918890acc9\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/TypeChip.js\":\"81b5a87722ab3ac2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/chipStyle.js\":\"da4d215d4ea57522\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/anchored-floating.js\":\"df704ad8a2b1d434\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/button.js\":\"400b3024b5eea044\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/card.js\":\"9d5fca693d562ffd\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/checkbox.js\":\"7fd4a3a9552e51f4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/collapsible.js\":\"5ecc4bbcac0709ff\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/command.js\":\"79b9a9861e03ffee\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/context-menu.js\":\"b6402da5625c1085\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dialog.js\":\"6fec683ca5261c72\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dropdown-menu.js\":\"8f51291f7a273840\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/floating-listbox.js\":\"a764927238a57b49\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/index.js\":\"1867a8d99df5f848\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/input.js\":\"790f601c3cb94a18\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/kbd.js\":\"66457811e9f86039\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/label.js\":\"a56403faeafbcd08\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/textarea.js\":\"a28a280a6d6222b9\",\"/knowledge-medium/pr-preview/pr-1912/src/components/useEditModeYieldKeepalive.js\":\"ec0d881f64fd2440\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/BootFallback.js\":\"45a2ecf619f3d917\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/FocusedRowLazyMount.js\":\"fc7382e04b2fbaf2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LazyViewportMount.js\":\"a722ca515d727a4d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LocalDbCorruptionFallback.js\":\"6c8219c0fd3e2446\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/error.js\":\"b328edfb2388227c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/lazyMountRegistry.js\":\"e2efaf2efecbadfb\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/suspense.js\":\"8d447f17d8bb2db5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/CreateWorkspaceDialog.js\":\"74dd1fb481eb0598\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/PendingInvitations.js\":\"e2bd69b6de84bc9d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/SyncProgress.js\":\"2aa96602c8f28066\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/UnlockProgress.js\":\"c552e5a7892bfdf0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceKeyGate.js\":\"0d715d2679143dcc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSettingsDialog.js\":\"88818118f067789e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSwitcher.js\":\"4d77a2b3f2f2e0b3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSyncGate.js\":\"2d11b38f9e4e6b77\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlow.js\":\"f9638c0d242b1bec\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlowHost.js\":\"8c56bf6220b336a1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/EncryptionSection.js\":\"5b89d5a54b6633b4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/attachmentPrompts.js\":\"ea7ab8e6054d7345\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/bundleFolderPrompts.js\":\"19d013d37193e091\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowDeps.js\":\"641813a17080e63f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowStore.js\":\"08353a445761af81\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/flowUi.js\":\"f5d4075c40e86b7f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/useConversionRun.js\":\"d9965342f7d14d9c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/keyUi.js\":\"64d29afff38449bb\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnKeyLoss.js\":\"32a48a4255f1c706\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnServerE2ee.js\":\"02be6d691c8a171b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/workspaceUnlocked.js\":\"f1a224d0e7726179\",\"/knowledge-medium/pr-preview/pr-1912/src/context/backgroundSubtree.js\":\"1bc98e47b211838a\",\"/knowledge-medium/pr-preview/pr-1912/src/context/block.js\":\"b9d452a14bfd4562\",\"/knowledge-medium/pr-preview/pr-1912/src/context/layoutWsContext.js\":\"24b217bb9d2be577\",\"/knowledge-medium/pr-preview/pr-1912/src/context/propertyDisplay.js\":\"a39d8d5c5ae60a2f\",\"/knowledge-medium/pr-preview/pr-1912/src/context/repo.js\":\"cd3cae405f68ecf2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasClaim.js\":\"5660ec0ddf11bae1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasSeatNamespace.js\":\"1c1c3051b6e26b48\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockData.js\":\"1109436a71bd3274\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockType.js\":\"ff6026ec0bb402fe\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/changeScope.js\":\"dca6e884fa3640d8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/codecs.js\":\"50ba4b1a3a32788c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/derivedData.js\":\"3bdea201a092e509\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/errors.js\":\"523a3f35ea86ba34\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/events.js\":\"621ff30487fa90a6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/handle.js\":\"e5f8e429810e788a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/index.js\":\"9ee99a1257996307\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/mutator.js\":\"48ec714b693fc64e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/processor.js\":\"e8d47919279d1a10\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/propertySchema.js\":\"925385a1b5c3310b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/query.js\":\"77985a52d79e8d6c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/sameTxProcessor.js\":\"b70691bf63d3ab87\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/schema.js\":\"e5f8e429810e788a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/tx.js\":\"e5f8e429810e788a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/typedBlockQuery.js\":\"b28a8c9a2443750c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/user.js\":\"961d94e1987e9b1f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresetCore.js\":\"b2abfe592902a313\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresets.js\":\"f5e2a56c411a01c9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/attachmentCleanerIOVerb.js\":\"81c6be29c91438f7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/block.js\":\"fc9e089a2fa7bada\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockCache.js\":\"c3ba5e271dbdc1c8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockId.js\":\"5d18c97512228161\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockLiveness.js\":\"ff4bc8ad35894db9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockMerge.js\":\"d4d7e56f1071c032\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockSchema.js\":\"5e2539437bc57521\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypeLookup.js\":\"e3ee637703e5aa2a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypes.js\":\"3cdf1a39ca0b1c0c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/childrenView.js\":\"7e228921ec3bcb2e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/clientContext.js\":\"0c2a3283e0379963\",\"/knowledge-medium/pr-preview/pr-1912/src/data/dbFileSiblings.js\":\"d70d3ff2ce81fc36\",\"/knowledge-medium/pr-preview/pr-1912/src/data/definitionSeeds.js\":\"4c6210b12f45b58e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/derivedIds.js\":\"5fe31f6f41832acc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/drawnSubtree.js\":\"f9ca1636b5c2fdfc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facetBridge.js\":\"38fba26aebcb8037\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facets.js\":\"ace3bf42d80503aa\",\"/knowledge-medium/pr-preview/pr-1912/src/data/globalState.js\":\"1d34399ce0f78084\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/aliasClaimRederiveProcessor.js\":\"7982c73b74aa7737\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/ancestorBatch.js\":\"3df67c0cb92443aa\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/blockTypeTypeifyProcessor.js\":\"abbbeca270029098\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/clientSchema.js\":\"47c787ed7a517f6c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/commitPipeline.js\":\"83276fae66cde8ae\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/devAssertions.js\":\"fb641cf22bb36a36\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/firstSync.js\":\"524223bb44a0b362\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/freshInitialLoad.js\":\"9d44caaa947cd91b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/graphBackfillClaim.js\":\"2b2fcfc0ceab37e1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/handleStore.js\":\"8038350546b46234\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/idleMarkerJobs.js\":\"e84a46471a2d6c12\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initialDownload.js\":\"f8acc8a4806959b9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initializeClientDatabase.js\":\"583c14814c64d612\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/jsonCanonical.js\":\"8eb3b1431a6413eb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelInvalidation.js\":\"6db3f4482c68dfd4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelProcessors.js\":\"a763121c121932f8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelQueries.js\":\"b3af530cd1338bcb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/mergeTypeMembershipProcessor.js\":\"931033cdfb93742e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/normalizeReferencesProcessor.js\":\"166ca7315d896118\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/poolInstrumentation.js\":\"b54aacea244b1eb9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/processorRunner.js\":\"26c186ca831f3cb5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyCellBackfill.js\":\"023b4a4561c18996\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildMint.js\":\"4c39e55e730f0966\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildrenProcessor.js\":\"a48f23583b9b15c9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8265c94a21d07e8b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionSynthesis.js\":\"640fc17dd47852bf\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyKeyScan.js\":\"c554a98b8fa5238f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertySchemaResolution.js\":\"1da1434b8bf7af2c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyValueEdits.js\":\"e33e447c7a5cb945\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/raiseProtocol.js\":\"aeb0d409eb304e9a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/readBatch.js\":\"e93b87e9167f2492\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/refProjection.js\":\"95791b5986acac10\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetLookups.js\":\"61ad517d40fbb916\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetProcessor.js\":\"61afb1b83aeaa81e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/replayMerge.js\":\"dc20f43b0240c390\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/sqlBinds.js\":\"073708c5ff9277e8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"479cadf6cf9ec51c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/arrivalProcessors.js\":\"781fff844a818112\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/invalidate.js\":\"e6a4de696d01f7ac\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/materialize.js\":\"e206257b6849cb2d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/observer.js\":\"8849a92cb3a0b11e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/reconcile.js\":\"b7ea89c82f64bd35\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/timingMetrics.js\":\"856a657502c98b12\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/treeQueries.js\":\"407fc45813b6772c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txEngine.js\":\"81087e6e96ba96ea\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txSnapshots.js\":\"604ac994abd91b83\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/typedBlockQuery.js\":\"9def9157dd9c83c0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/undoManager.js\":\"65de49eb8b453ec6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/invalidation.js\":\"4d3ecf5a7a45b3ea\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelDataExtension.js\":\"141b678bd5641a0e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelPage.js\":\"ee3039defc83cc1a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelValuePresetCores.js\":\"0370c74d633c09d7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbCorruptionSignal.js\":\"1d5694eecbfa928f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbStorage.js\":\"00a474bab63c0944\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbVfs.js\":\"cd6a83e34c89dab9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localSchema.js\":\"7595e9e6ec6c140c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/maintenance.js\":\"4454b069381e6d70\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mergeProperties.js\":\"10c15f6b705e35bd\",\"/knowledge-medium/pr-preview/pr-1912/src/data/metricsConsoleHook.js\":\"f5fb03bf90136059\",\"/knowledge-medium/pr-preview/pr-1912/src/data/migrationsPage.js\":\"eca3a0aa073d92e5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mutators.js\":\"fc33c01b45997ddc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKey.js\":\"68367847b81d0f2d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKeyPlacement.js\":\"20bad5affb7d6eb8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/outlineSurface.js\":\"f6574ed2dd51f62c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingEditorContent.js\":\"bd465f3f69e7aab7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingUploadsSql.js\":\"2c1bc72606053e7d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pluginStateExtensions.js\":\"2ce64e057c005825\",\"/knowledge-medium/pr-preview/pr-1912/src/data/powerSyncLogger.js\":\"23ff0f2b18ad15fd\",\"/knowledge-medium/pr-preview/pr-1912/src/data/projectorRuntime.js\":\"690443ea54832b9e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/properties.js\":\"8aba468919149024\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertiesPage.js\":\"b737f6a5ace2d163\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyChildren.js\":\"6757f464040a9e3e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionFanout.js\":\"6f04952fb30867fd\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionMetadata.js\":\"804b36892aeaf82c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionRegistry.js\":\"2f3aeaad853a8073\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDisplayMode.js\":\"b7007faa74f30e41\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyRowCreation.js\":\"f3e60e02117a5582\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySchemaCreation.js\":\"7f63f5a869c56ae7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySeeds.js\":\"0d48cc9d7381285f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/recentsPage.js\":\"cfa7c46aa73ac8f7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/refTargetComparableProperty.js\":\"df9fa90dc91028c0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/referenceBlock.js\":\"71bb64bbb02df1ae\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rejectedUploads.js\":\"f07c13779349526a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/releasePowerSyncConnection.js\":\"f321a79267b4db81\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repo.js\":\"b50c9e5f481cdda9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repoProvider.js\":\"d14016a573081a7f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rowProperty.js\":\"cb911c8e8f8812fd\",\"/knowledge-medium/pr-preview/pr-1912/src/data/searchFilter.js\":\"fa03d3af656715be\",\"/knowledge-medium/pr-preview/pr-1912/src/data/seedIdentityLedger.js\":\"595554c4368dfe93\",\"/knowledge-medium/pr-preview/pr-1912/src/data/stateBlocks.js\":\"6474d41539d8383c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralEditPolicy.js\":\"d5bc1cb007a98c90\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralInsert.js\":\"817c4e170741ec9c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/subtreeDelete.js\":\"157c6bb4e1e641d1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncStreamLock.js\":\"34c64036520d918f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableSqlRecognizer.js\":\"7c539e69d45b473c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableWriteGuard.js\":\"bf9d050a4a8b7d4e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/targets.js\":\"57758093e59cf8ac\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeColors.js\":\"3efabedff79fae7b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionMetadata.js\":\"838e1ec2682ac3fd\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionRegistry.js\":\"022f514f9f3c27dc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeExtraction.js\":\"01ce34f13015278b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeInitialValues.js\":\"b1dc2b244d1839a3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typePropertyGroups.js\":\"7539031e762874f2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeSeeds.js\":\"2f29517e2664406c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeTagger.js\":\"d59446e82313c7b4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typedRecords.js\":\"b43f89698886265f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typesPage.js\":\"61fd74bcc3e82ee0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userPrefs.js\":\"5842fefbb854a17e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userSchemasService.js\":\"b29c62bbe0506686\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userTypesService.js\":\"7f88fb9f6eaa1f4a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/valuePresetRegistry.js\":\"5e00dd5991a0f7a9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/visibleChildren.js\":\"814049234d76f56f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceConversion.js\":\"abaeba012e031399\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceFirstSync.js\":\"4c955e94c3ae4e68\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceIdNamespace.js\":\"32a82ec8a7ed17d0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceSchema.js\":\"1751a0d5d918b738\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaces.js\":\"efad3469cfbe0ea3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadLog.js\":\"d894a37a4e2f3ffa\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/BlockPasteShellDecorator.js\":\"b5b51d5aa631b9d2\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/atTrigger.js\":\"90f09e10bad84d53\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/autocomplete.js\":\"36b44c5e2f57cf38\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/codeMirrorExtensions.js\":\"64bc79c7f402e2e4\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/contentFlush.js\":\"6e77a82e701ddd1e\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/defaultInteractions.js\":\"d4cf11a6fa5d3dd9\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/editSettleSignal.js\":\"0425b4c3a15a7a90\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/insertImage.js\":\"7fd5f01ceebb6570\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceCompletionRange.js\":\"4a43b0f68694374e\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceTargetTypes.js\":\"844a7260a4556884\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/syntaxContext.js\":\"bf43f7197be85151\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/triggerMatch.js\":\"063ec0a6ca9f354d\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/AppRuntimeProvider.js\":\"48beefcbcc261895\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/BlockFocusShellDecorator.js\":\"6f4ae1fccf41884b\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/ExtensionRenderBoundary.js\":\"9897b6b559549313\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/PanelContentRecovery.js\":\"7a0ede18bc78bf54\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/apiCatalog.js\":\"e05d4bf39e64e87e\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/approveExtensionHere.js\":\"d86dea68179d7b2a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/armedCutAppMount.js\":\"26ed4f57c2552473\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/batchableKeyedStore.js\":\"91212ba5bed2d4a9\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockInteraction.js\":\"58a67c6823ce6bf6\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockSelectionAction.js\":\"42e400559ef95ac0\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compileExtensionModule.js\":\"8d4fe53f77bb646a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compiledModuleCache.js\":\"985bc80a71ea88d5\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/continuousGestures.js\":\"fbd7fc01b1191e2c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/core.js\":\"8740b08423874e67\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/defaultRenderers.js\":\"7bd32cec8d3d8a53\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/definitionFanoutAppMount.js\":\"b2d183636bb225d0\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dialogAppMount.js\":\"2a7bf897ea16f923\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensionSeeds.js\":\"9dbcae127c89cddd\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensions.js\":\"909adf00ef6cf58d\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/exampleExtensions.js\":\"b43336906988c036\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionApprovalStatus.js\":\"c9e20c1944b9c101\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionImportPolicy.js\":\"ab848fa4a442905a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrorToast.js\":\"16f54fc528c4d476\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrors.js\":\"fb675d68067eadc3\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLookup.js\":\"facefa65c4515eaa\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionToggles.js\":\"8e535d458fbcd144\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionUtilitiesCss.js\":\"9f08040fcd30bcae\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/kernelPageDeletionGuard.js\":\"f76037e1e70d4353\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/liveRuntime.js\":\"99e3b480693be089\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/normalizeExtensionSource.js\":\"ec71dad09c9a7b9c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/openExtensionsSettings.js\":\"e0413fa518e42cf7\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/overridesCache.js\":\"6ef8482365aa701a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/pluginIds.js\":\"a691114c393f8c91\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/processorRejectionToast.js\":\"f359789bc1695eb8\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeActions.js\":\"7a29f44036844ab0\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeContext.js\":\"bf49c8412c14c09c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticAppExtensions.js\":\"5bb1f03c846fc003\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticDataExtensions.js\":\"75b18c172c25a928\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/toastAppMount.js\":\"1d876205be7ae82b\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/transpileExtension.js\":\"eece8668f11543b7\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useOverrides.js\":\"d5d1fbdd297cda03\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useShortcutSurfaceActivations.js\":\"33625553a07b0a46\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/discoverToggleTree.js\":\"157e48866aed67df\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/facet.js\":\"d8512604ba7713bd\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/resolveAppRuntime.js\":\"93122c70ef336a60\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/runtimeEvents.js\":\"958773066bcb89f9\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/togglable.js\":\"75b744a916a21ff4\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/variantFacet.js\":\"b40af1077c4dbc40\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/verbFacet.js\":\"cd7167962f4e1a97\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/block.js\":\"841cb7ee6b46e822\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/focusedChild.js\":\"d67fb871d8550a8b\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/propertySchemas.js\":\"2d1aad1bd7c43d48\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/typeRegistry.js\":\"fdc6670fb0375c6b\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAncestorCrumbs.js\":\"8c56bf2be15697a7\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAutocompleteListbox.js\":\"9e7b8b5ae14fa470\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedSearch.js\":\"ecf8cab5c7e8785d\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedValue.js\":\"9c39624d540f6d7e\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useFacetValue.js\":\"e5cc427110802d19\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsFocalRender.js\":\"b94bfa1b9b0bb9db\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsReadOnly.js\":\"9866707fcd93e138\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMaterializeBacklog.js\":\"523ed53f0553fdb5\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMinuteClock.js\":\"741a559834caccac\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePanelLayoutProjection.js\":\"c0a7402d51f341cd\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePendingInvitations.js\":\"2343aebe7a687fed\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRendererRegistry.js\":\"79dd7336a7971675\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRetainedFieldRows.js\":\"6ebfc89377c69cbc\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useWorkspaces.js\":\"348f88ddead5403c\",\"/knowledge-medium/pr-preview/pr-1912/src/lib/utils.js\":\"b37ad09146dd2802\",\"/knowledge-medium/pr-preview/pr-1912/src/main.js\":\"82840397d4cfbd06\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/MarkdownImage.js\":\"0230ba05b6df636e\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/blockSeparators.js\":\"b2fd02de0c9b4c1b\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/context.js\":\"a8cb1d07ede83575\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/defaultMarkdownExtension.js\":\"2629ddd801291bc7\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/extensions.js\":\"65ac9745481df38b\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/renderMarkdownHtml.js\":\"7854523bce1309a1\",\"/knowledge-medium/pr-preview/pr-1912/src/minimal-editor.js\":\"e1c9839cca4969bf\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/armedCut.js\":\"a234f75c2ffe788a\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/captureMediaVerb.js\":\"3388aa6e8caae5ef\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/clipboard.js\":\"5f9a2a333d5b5102\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/decision.js\":\"05bf7462d928f8b4\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/operations.js\":\"16d6c10bfc2f1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/AccountHeaderItem.js\":\"e9c7d12cd3cde90b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/index.js\":\"e8d6d0003b224a25\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8487d120d0b971f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askAgent.js\":\"6725f15a97aaa190\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askedStore.js\":\"c1004cd578c3bbca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"cfc2ace5094cc9a6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/chipState.js\":\"d8d946d2c1aa2c43\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7af590af0851db2e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/index.js\":\"51a4518a37e3cd12\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"483d6c3331976a26\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/schema.js\":\"ab52608cdc262188\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c00e7780bef2b3f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/BridgePairingDialog.js\":\"40c7bcbb27900e86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/addMedia.js\":\"efd25c4c357d4df3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1d527188cd2f73bb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/block.js\":\"cfabca1e60c63c3a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/context.js\":\"838f9b4b2d960e80\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/displayIds.js\":\"99ac2246e7777795\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/index.js\":\"a117094c033f46cb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/outline.js\":\"ff0c35eaaeaea46e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/properties.js\":\"fd0aa67b6faba769\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/refs.js\":\"e044ab872f31eeed\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"746fdda16c0dc080\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/search.js\":\"9740101a16a1e282\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/shared.js\":\"66e8452ef4c2dd47\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c8055a5f8da6425a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/text.js\":\"7675561cbca0e594\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentWrites.js\":\"3a7acfa09a30e369\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/authoringCatalog.js\":\"1ce763870f86b74d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/blockRefTargets.js\":\"e27e1f13b9bcd5bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridge.js\":\"8f2c6e7e6b74bbac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridgeLoop.js\":\"28fa1bfe9a431705\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/changeHistory.js\":\"e540b863f20faec5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commands.js\":\"03cba80f9c8809ec\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commentsCommands.js\":\"120018805f04c226\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataExtension.js\":\"4d8a5b4a948bce7b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataModelGuide.js\":\"1f1d0145d0efef96\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dayPropertyInputs.js\":\"7bb208f36bf77d4b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/describeRuntime.js\":\"c88777fceb3513b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/extensionLint.js\":\"436ef5d59d77d186\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/grainAudit.js\":\"fb4a5c5fb9ac32ac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/healthCommand.js\":\"fa06a80661196b7f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/index.js\":\"514e2224744640d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/presetIdentity.js\":\"ae1d3615d63c9869\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"548e50c126931cc8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/readMedia.js\":\"1e5c122a759a413a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/schema.js\":\"beb9103aa94fefb7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/serialization.js\":\"f0219c6d5336c145\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/targets.js\":\"c4190139787b8441\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/tokens.js\":\"e946cc88140e4c61\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/watchEvents.js\":\"2713e9ecd8fd68e8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/workspaceGuard.js\":\"addf25b1c246a24e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/writeCommands.js\":\"9bef27a6568d8f1d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/AliasCollisionToast.js\":\"2b8b8986272b44f6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/DuplicateNameBanner.js\":\"cc4cc4b238333973\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/collisionMerge.js\":\"44b7458e7cb413d6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/dataExtension.js\":\"54704a3180145249\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/index.js\":\"44459e03fc47e201\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/mergeCollisionAction.js\":\"a16e0106f7d28351\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/pageStyling.js\":\"22928d080b9a405e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/rejectionToast.js\":\"9c790097ddedf54f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/syncProcessor.js\":\"75d72d7f85323231\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/actions.js\":\"8e5a13ca6059e22d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/addComment.js\":\"f032f7aeb6298ee0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchor.js\":\"8dfed6bf7615b729\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchorState.js\":\"f6747cebd2ed2236\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/commentLinks.js\":\"f75d8ec86cee8450\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/confirmThreadDeletion.js\":\"991e207d22fe9b0a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/container.js\":\"462708fbb2e058cc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/dataExtension.js\":\"b74fe3442adbdf3f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/deleteComment.js\":\"30e8efb27762fa42\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/highlights.js\":\"139630743518f5e8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/index.js\":\"a4eb8638452d09cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/linkedCommentsPill.js\":\"6b8046da55fe81f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/margin.js\":\"82212cf750a60277\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginAnchorLinks.js\":\"b65024b9e5065a27\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginSchema.js\":\"73c3793e6108b69b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/newComment.js\":\"ada60edf9220d73a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ownThreadPicker.js\":\"2f1ea71bc9b11e04\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/placement.js\":\"3cd02f6330ecb980\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/queries.js\":\"01d443705a80687a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotePosition.js\":\"f57351d3cc8917b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedIn.js\":\"d68a3f5f258b2bf0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedRange.js\":\"b1208346b9296052\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/rangeRefs.js\":\"6bd61abfd93f9e8b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readHighlights.js\":\"03de1eb6c46785a9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelection.js\":\"13e9117aeb2a5d0c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelectionUi.js\":\"009be7dbd9cec873\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/reanchor.js\":\"310c8df2509f8353\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/schema.js\":\"fce382a37de7f25b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scope.js\":\"bc818c0e6a196ee2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scopeThreads.js\":\"7fa8bda9c13203b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/splitRetarget.js\":\"57ed2025007fec75\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestionCard.js\":\"61793b268e17e811\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestions.js\":\"3b77e29f929b3de5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaries.js\":\"290f7718ad54b14e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaryBatch.js\":\"3d45527d9c5021ca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/surface.js\":\"c6c4bab7bff9a381\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threadNavigation.js\":\"ae44ef9f33d7a8ca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threads.js\":\"c3feb192062cd954\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ui.js\":\"5211ccf2673f7a9a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/uiStore.js\":\"09e30e565a4ab04b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/appIntents.js\":\"401f88b6b2006796\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/index.js\":\"f22ab5069eddf835\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/index.js\":\"2ce90879b6296630\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/status.js\":\"e3c857b0a347c430\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7aeb7a48967f70aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaBlockRenderer.js\":\"d463ed51d3988398\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaDownLaneReplicator.js\":\"663f72b8ac16e4d9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaUploadReconciler.js\":\"85d7bffe6cbac99f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetDownLane.js\":\"d8f2ff849167cd22\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetResolver.js\":\"b845da1328f9ac1e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetUpload.js\":\"ace977d78e47d7ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/attachmentCleanerIO.js\":\"5f0f2c16466faadc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4ba758465f884600\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/blobStore.js\":\"56e4e0c4bf1d9562\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/browserMedia.js\":\"758140bce8d265f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/byteStore.js\":\"f7ab04259c13351f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanerIO.js\":\"f7eef3dabe426939\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanupAttachments.js\":\"71e4b7b4f8ee5cb2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/dataExtension.js\":\"81167cb371fccd1d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/downLane.js\":\"311ec708471642a2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/index.js\":\"7e8c34693af292b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/insertImageContribution.js\":\"a0da935f8a81126a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneArming.js\":\"0fb06e99b2439ecf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneLock.js\":\"ac6dada5b07a5cce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaBlock.js\":\"6e842de00c0e8b0c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaCapture.js\":\"bbc5549c7fd37ca0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaLanes.js\":\"3308f2dcd7896e14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewers.js\":\"1dee32f76dc97c7c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewersFacet.js\":\"74fb164491d47131\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/pasteCapture.js\":\"d7bf390d897103ba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/resolver.js\":\"dbaadb2db6133216\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/retryUploadsAction.js\":\"9f66babf053358a6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/storagePaths.js\":\"f13ff227e20803af\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadDrain.js\":\"6b870f956dc2b6de\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadLaneStatus.js\":\"d015c79c59e20d99\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadReconcile.js\":\"9c27771e491fd08b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadRecovery.js\":\"9297e48fb8f78e3b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadStore.js\":\"717c485c12a7c4c1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/useAssetObjectUrl.js\":\"a830524c101f5be8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"6d855f36cac38794\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0d0880b18398885d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/facet.js\":\"e8265eeb4cc6a45f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/index.js\":\"4c2c9e5cf17fca00\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/prop.js\":\"25af6fa65db57520\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinkFilters.js\":\"0725563eec738f5a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"539d966ada64564a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BlockEntry.js\":\"4462fc15ca97153a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/LinkedReferences.js\":\"9f826b71159cc656\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9bfe345510a1698a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dailyNoteDefaults.js\":\"6a3b545a81340d73\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dataExtension.js\":\"d52aad0c8f73c188\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/edgeExclusions.js\":\"2e60ea3a0bc6a710\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/filterProperty.js\":\"8d8bda0fb9ee37bb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/index.js\":\"23675b56d991cf94\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"a30b1ba2ec396055\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/applies.js\":\"2309e8567318bf01\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/countQuery.js\":\"9562800111eaf955\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/expansionStore.js\":\"2eb93d130777c42f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/index.js\":\"0f78350bb67cf673\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8b7034322dd64670\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/presentationInvalidation.js\":\"85bcd559d84c99e6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyEditorOverride.js\":\"ac80aaa3ab191826\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyFilter.js\":\"0db670935fddcb90\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/query.js\":\"a090ed03dac6af44\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/resolveFilter.js\":\"e9cca1af22bd679a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sourceBatch.js\":\"51a6b1c450933829\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sources.js\":\"258d3043dd100c65\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useBacklinks.js\":\"755073179f569ce4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"078b591decbf49c8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayCelebration.js\":\"53ebb61c37e910bf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayOverlay.js\":\"206a85d4e639ce8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/gate.js\":\"d55c3c4792c5f966\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/index.js\":\"51a774b825573444\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/wolfTheme.js\":\"2e7a09c31364741e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/BlockDragLayer.js\":\"979ef99abe229e1b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dragController.js\":\"7abc8ebdd8b298c9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dropTarget.js\":\"f002048e1bdfff43\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/index.js\":\"f9d7fe9af0d93361\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/projection.js\":\"91fc0e3a05e2c41c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/BlockMetaCard.js\":\"7810bb495530e69c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/index.js\":\"6021627956555eaf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/AddTagDialog.js\":\"f014966ecd0fb112\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"93cd3d6bd0b69be9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/TagNameIssueHint.js\":\"663cfd9a5a6da7db\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/addTagAction.js\":\"ee95b3c93a2672fa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/appendTag.js\":\"a2c09c7ab96c4cff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/config.js\":\"f79ccdf0e78c8129\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/dataExtension.js\":\"e34f4953e073855d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/index.js\":\"7110395d84cd09ea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/propertyEditorOverride.js\":\"f260090ec95dc3a1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbList.js\":\"91bd88b2bda82430\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fc293096f301dde0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/Breadcrumbs.js\":\"af2a03e1f45b6106\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"cc486b248c576108\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"595c13a6787cec9a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/index.js\":\"50adf39e23eba4dc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"52d97d48b1100770\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/CharacterCountItem.js\":\"3c7866522504132f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7d4912c2d0eaaaef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/actions.js\":\"5495df01fe653e88\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/blockType.js\":\"9bacf9b6d129e7ce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/charCount.js\":\"4a4b195fc0a94064\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/dataExtension.js\":\"9d74bc5c4955b88f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/index.js\":\"ce4e68ae12450e58\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/profiles.js\":\"e688f27978c3a045\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/properties.js\":\"0e34568f369cde9c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/subtree.js\":\"e879afacfccb04b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/textCounts.js\":\"3a7a15bd21c12eeb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/colemak-keybindings/index.js\":\"acc33399765fee27\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/CommandPalette.js\":\"cbd6bf5d3a62e40c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/HeaderItem.js\":\"d60939ff2e88cc8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/context.js\":\"6ef76701c9dca848\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/index.js\":\"39160d835f5484b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/selection.js\":\"d11c81c31b3e8a45\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/toggleStore.js\":\"dc840961d885be19\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/useCommandPaletteActions.js\":\"01cecce55ee8e099\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ContributorBadges.js\":\"e44f65bfa698146a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ProfilePicture.js\":\"a48f2113b80da2de\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/author.js\":\"faa8b24f3aa7b99d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/codeMirrorExtensions.js\":\"c6097d6f4f444ff6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/dataExtension.js\":\"d261aaf8703f4bee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/index.js\":\"0ef3f4a148873a89\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/mentionAutocomplete.js\":\"ce067eece9db1086\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/processor.js\":\"7ce07803dace0c31\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/profiles.js\":\"a481b46995729a1a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/queries.js\":\"5c6b1d9307b5b47d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/schema.js\":\"b5c8aad7dab5b531\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/useCommentAuthor.js\":\"b171f713c54f9d5d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3a2ba3e87f69d886\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f71e6d0065f2605b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/index.js\":\"d1018756ddc6840c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"c4482b30ac427bb4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"865573d4d0b364f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/CalendarGrid.js\":\"f2e246cebc1f0aa7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DailyNotePicker.js\":\"2b04f7025a87142b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"906fd2322f6f29b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateNavDecorator.js\":\"fb92839e43e3ecf8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateScrubOverlay.js\":\"56d12758ada05515\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayPropertyControl.js\":\"d1606be9215e8181\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayValueReferenceControl.js\":\"bd976cc282d238bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/HeaderItem.js\":\"37d0f2d379d8309c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/ReschedulePicker.js\":\"3fce759383281ba6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/SpreadDatesDialog.js\":\"604b9e326fb02842\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/actions.js\":\"91a6064aa6649de0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/blockDateAdapter.js\":\"5acff96ec91fb006\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/calendar.js\":\"52964976663d7d1c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dailyNotes.js\":\"e120782d5897930b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dataExtension.js\":\"37daee31755f0c7e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubActions.js\":\"42f12d7d88ccf70e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGesture.js\":\"b299b2d55b67250b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGestureActions.js\":\"4e002227e94de4b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8d4094ade595948a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayProperty.js\":\"02e64ce75927d1a5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"20067f23e3c1325d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/deletionGuard.js\":\"16b0a795453dd336\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dueQuery.js\":\"fbd7690227c33079\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/index.js\":\"8dc9808156548bc0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/landing.js\":\"3c6bfb067e48fb3c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/localSchema.js\":\"69315f46aa0a1b55\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/referenceDateAdapter.js\":\"780bffc0bc7f5554\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/rescheduleAction.js\":\"5ee1193ea9b5e113\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/schema.js\":\"74b45272c78efab7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadBlockDates.js\":\"91a3042e9fcf855b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadDatesAction.js\":\"47937246320310a0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/today.js\":\"6e7723017801b077\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f19355779527b977\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"19855e0c922da6c6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/audit.js\":\"0605f0bb3b771608\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditAction.js\":\"2e9f0e7af81d0e4c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditRanges.js\":\"f44e37a03fe68c45\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/diagnosticsSource.js\":\"0bcc5919391e2a6e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/divergenceScan.js\":\"102733e073896735\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/index.js\":\"d8734e42c3208a4b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/propertyChildrenChecks.js\":\"dbcd1240b579f621\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/referencesMirror.js\":\"c55d60c42e1965c6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/rowJson.js\":\"818ac2b569aba73f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/schedule.js\":\"e385a8285daa3ba2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/store.js\":\"2e32ef687d23ff99\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/action.js\":\"b45ee3f4b902731b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/index.js\":\"003925c89ddee733\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/plugin.js\":\"5874daf2b8613f16\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4e9bce7c875c7a67\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/actions.js\":\"f8356f9aa552b16d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/changeMarker.js\":\"5ee3706b94bf316a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/diagnostics.js\":\"1691426c80aab12e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/fileSystemAccess.js\":\"5701ead669316437\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/filenames.js\":\"996cdbe13d354ac4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/index.js\":\"b5933344bba9a30d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/mirror.js\":\"a7befe5e57d9aed9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runLock.js\":\"8faa4a298d89f543\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runtimeHealth.js\":\"80d5698c7ba861f1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/schedule.js\":\"aeb0edf066ed0595\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/store.js\":\"e6d7f7fffcfb63ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/index.js\":\"c56c73fac3409ade\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/themes.js\":\"047ab3793818db9c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/facet.js\":\"709fec69e4afd519\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/useDiagnostics.js\":\"9601dd7e175c4bb9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/dismissals.js\":\"3ee59ff5b06f8fcb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/index.js\":\"495ddfa00dece28c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/status.js\":\"edc342364a37f558\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/store.js\":\"74c5e9e47b012927\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"928b46ec10424948\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsSettings.js\":\"3a26ce4dcae5b48e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/actions.js\":\"38c7cf2a5a0f7416\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/config.js\":\"0e349043d4537b88\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/dataExtension.js\":\"65f2d2fe290ec6c2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/effect.js\":\"6fd08aa1802c7c5c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/index.js\":\"12591117848462c4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/propertyEditorOverride.js\":\"214628114b41d6e4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/useToggleTree.js\":\"e10c99d497b00789\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/ExtractTypeDialog.js\":\"98c93d3d3d2d4270\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"932209091991cee2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/PropertyShapePicker.js\":\"02cec4f411868a67\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/action.js\":\"e7df5f86b43f6734\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/index.js\":\"5ea7e2084eef8e65\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/FindReplaceDialog.js\":\"6887c33e565e1114\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/HeaderItem.js\":\"2face9dcacb86afa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/dataExtension.js\":\"dee84361bde20e9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/index.js\":\"c26ccb2837ef9bca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/search.js\":\"9069af95e1d62771\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/toggleStore.js\":\"7914aa0cf22a5258\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/LocationPropertyEditor.js\":\"3dd03b3144d3cff7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/MapView.js\":\"718c2a4b92badb54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/blockTypes.js\":\"a7e23a6b5eaf02d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/codeMirrorExtensions.js\":\"d843b71ef1641605\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/createOrFindPlace.js\":\"b66d3be0edc44c9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/currentLocation.js\":\"25da2fb2fcd34140\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/dataExtension.js\":\"050390163c9e33fb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/geoContentDecorator.js\":\"8e22fccccfcf00f1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/googlePlacesClient.js\":\"c87373c6fab8154d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/index.js\":\"96bcd1c09e483f6a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/locationsPage.js\":\"3aa4ea89a61432a2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/mapViewport.js\":\"9d6c55154b2d2b54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/pickCurrentLocation.js\":\"e93013cb12c8ecba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeAutocomplete.js\":\"ce6940c7792fbfb6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeNameCollision.js\":\"2f0f266f1f2bfe7c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/properties.js\":\"947da5a8288c52e0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/propertyEditorOverrides.js\":\"d26fce02edc23173\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/query.js\":\"f919b44f039d887f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/usePlaceSearch.js\":\"38437f73b2891ef3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"af89a15e3fad83cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"2711b0d08bfd29f4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e0cbbd554d3c5afa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/config.js\":\"c83ad66eb830f35b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/dataExtension.js\":\"6c92f8ce54b1f755\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/facet.js\":\"ca62c3a9dba2c624\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/grouping.js\":\"74f027baf6c4b79b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/index.js\":\"c93ad27cba11547b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"60d620e900f13dc6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/query.js\":\"f469e930942714c7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/resolveConfig.js\":\"d07cfad4bab99641\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"65a9e65bbac6778f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"43d65acf55608489\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlDocumentContent.js\":\"b6cf437252a7a326\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlFrame.js\":\"ea8c674d4e988e7f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/actions.js\":\"98a09ccc1a05e23e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/blockType.js\":\"0fcfaa3bac86843f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/confirmRunScripts.js\":\"bf96035d0cde0434\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/dataExtension.js\":\"0cc16dfe43d3d2d8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameAnnotations.js\":\"d7771259bdbb301f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameDocument.js\":\"5da0e87e4b134e61\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameTheme.js\":\"a8e10222ce864f53\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/index.js\":\"dc2f42c951063630\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/scriptConsent.js\":\"7912c68c74460860\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/sourceMap.js\":\"17d176f409959730\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/useDocumentScripts.js\":\"555e9c4324650b49\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/index.js\":\"aa673879a4387ce8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/record.js\":\"0797701cf3e8c606\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/recordStore.js\":\"21638c16c5c7285f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/responsiveness.js\":\"a327ab78aaf060d3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/schedule.js\":\"1057fcedc50396a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/sessionContext.js\":\"408d80cad640c4ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"c5ea99fa23186364\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1b6f3f8277a4e22c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/actions.js\":\"498a005b6afb0470\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/config.js\":\"39de0d2a78844abd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/dataExtension.js\":\"53ad56a2a2344f31\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/effect.js\":\"0f47508398ebf40f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/index.js\":\"7442a87078e784f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/keyCapture.js\":\"9252193ed5889a24\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/overrideStore.js\":\"6748a2432bed232c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"7e891ae708ba301c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/HeaderItem.js\":\"44221f5a204980f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/LeftSidebar.js\":\"88c8f2a327a64d75\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/actions.js\":\"c46fa74a4a6fc451\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/facet.js\":\"1e8b15a7c74d2b9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/index.js\":\"8b9848a94da76002\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/shortcuts.js\":\"be837e1d3d50e3ab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/toggleStore.js\":\"bada1d9c0f213c3f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/MergePicker.js\":\"9c879918dce8e038\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/index.js\":\"9f340ad3cdc562c4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/mergeAction.js\":\"bfd5db92c79bc315\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/strategy.js\":\"fd9976bfad006e9b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/Button.js\":\"86209f8b2a8f80c4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"75a646d5ea61552e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e0abb228ea2ee69f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/facet.js\":\"510c981fc746ab4f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/index.js\":\"eb1797f77cc4e658\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"843ce79c65190f09\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/actions.js\":\"d17e5f4db06d749b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"79090738cc38504b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/facet.js\":\"090cb4deed733a17\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/index.js\":\"a0583957b780952f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2819c9da9cc61a3e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c74777be04740035\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/contextMenuItem.js\":\"bf20569e75682da7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/index.js\":\"bb80b450f1ab9aae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveAction.js\":\"11aa519441c17875\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveBlocks.js\":\"9519de1b6fa3a6a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/selectionAfterMove.js\":\"ed203b28e32c34de\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/TutorialBanner.js\":\"fbe814d4d7d729de\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/action.js\":\"cacf650aeaf86b10\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/bannerDismissal.js\":\"d7caa01ae8772b9b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/documents/cheatSheet.js\":\"e1e380576b7a5ffa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/index.js\":\"1d8f6ccb866da8d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/keys.js\":\"fc4cf0e3c7685dd1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/landing.js\":\"0484d7064c30094b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/outline.js\":\"bee822159161d174\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/seed.js\":\"9f9aa30b22bf14d4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/PerfTrendDialog.js\":\"46c3f87618d22331\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/analyze.js\":\"83799bb9e7d528c7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/diagnosticsSource.js\":\"fce1a9c1bf966fc0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/index.js\":\"32499ebd559cdecd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/load.js\":\"7ed8888b62902f35\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/monitorRun.js\":\"9a918ffb54d4da78\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/schedule.js\":\"c25fa9b5822580c4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/series.js\":\"32570a75008a748e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/store.js\":\"454a0bc451b77fdf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/trendAction.js\":\"ab3f8c57a733ddcc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/verdict.js\":\"7fbabb983a55a60c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/clickToEditAction.js\":\"4bab63e1a48e1523\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/index.js\":\"0ded4b740637f42c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/interactions.js\":\"a232e1f26b24638a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"6daaa925dd6392fc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGate.js\":\"e3a50a26079eec33\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGateDialog.js\":\"818cf3e14adb832c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/action.js\":\"d6945f71264aea2c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/index.js\":\"d6ea1f196565f1f1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/localRunMessage.js\":\"540e71e8686c1823\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/plugin.js\":\"9c6415fbf1252220\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/progressReport.js\":\"f88e8033ff6418d3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/sweepProgress.js\":\"a1c243235943f54a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/FieldRowRenderer.js\":\"1a282a026c7d8fe5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/ValueRowRenderer.js\":\"0c7ebdcc8410891b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/actions.js\":\"238dc29d3cfb8f6c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/autocomplete.js\":\"f41282df909281e3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/fieldRow.js\":\"5d61dfb697b5ca8f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/index.js\":\"a65e24bf904fcf8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/referenceWarning.js\":\"65b77ea0134a525e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueAutocomplete.js\":\"303f7be46d73ca7b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueSchema.js\":\"5a99f2e9cf8e8f24\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/HeaderItem.js\":\"4e7b4111b98b120d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/QuickFind.js\":\"8afcc2799a4586c0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/index.js\":\"9bbe04eeb821b233\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/recents.js\":\"797f4056deec7e64\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/resultItems.js\":\"56a0a0a2bdf54384\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/selection.js\":\"21ccd8a12ab0435a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/toggleStore.js\":\"25df74fce848491b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/HeaderItem.js\":\"485d91c2606e9fc3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1f266736807f65cc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/grouping.js\":\"59206e7e673a3c77\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/index.js\":\"e99a0bec95ded5e2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/target.js\":\"aba7aa4c080e2f02\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/codeMirrorExtensions.js\":\"fca98538298a1b77\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/contentPrefill.js\":\"c7bc6552b7cd0a0e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/dataExtension.js\":\"f56d94a3dee4802a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/index.js\":\"1238d69bca56e38c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c57763aa460f69c7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/invalidation.js\":\"a5270feead8d7ad7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/localSchema.js\":\"c796c8ec808b00fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/index.js\":\"5920c076ac0e64b3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"86869deef3dd68a4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/index.js\":\"bf037bcc6f27f5c8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/referenceNode.js\":\"916756d2c12623bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/remark-reference-occurrences.js\":\"c863baad2d2a55b4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"fbf14b9b713161e8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/index.js\":\"054e6e2d1614e0ae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"646d4ab8a5251b35\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5c72f92026444d4a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/mergeRetargetProcessor.js\":\"4b06610c4c046ffd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/parseFence.js\":\"4a8b375343760ce5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceParser.js\":\"af277d63b0e11411\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceProjection.js\":\"5bd02e7b0beb492b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referencesProcessor.js\":\"47a99d15f0a45f49\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/renameProcessor.js\":\"70615219f50d43f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/spanReplacement.js\":\"b857a6821ddf60f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/htmlToOutline.js\":\"78ae78abb2f130a5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/index.js\":\"8cc7714b53ed4a10\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8312f7c81a874627\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/pasteDecision.js\":\"89936801c90468da\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/action.js\":\"05412643d8ee76a4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/blockIds.js\":\"c2c8bb9276184bef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/content.js\":\"c347b408c960ed4f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/effect.js\":\"804df0ab0f096858\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/ids.js\":\"69fb27eb1f44f428\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/import.js\":\"a8fbbd7eed0d2344\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/index.js\":\"40ecb36bbe8a84f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plan.js\":\"f1af7a95b1c72121\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plugin.js\":\"320e520e01936d3b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/promotion.js\":\"bd14183dd0795504\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/properties.js\":\"c1e918f706954d2f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/references.js\":\"49d7e6c37ef3175d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/report.js\":\"623b51716530fb20\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/roamMemo.js\":\"46e95718a7f9e1b7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/runtime.js\":\"a8a2d4bff84e5c28\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/schemaReconciliation.js\":\"c8d2fea01df1cb46\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/srsMarkers.js\":\"09aa4f48303b18a9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/todo.js\":\"667ac0b6808018bf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/typeCandidates.js\":\"03f110555738d5eb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/types.js\":\"c7f06f799e372f70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/index.js\":\"4510838da46320ed\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/store.js\":\"11a198975e485e30\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/HeaderItem.js\":\"a9b3efdbb71eb2b6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"04e660f9832fc271\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/index.js\":\"cecc7910e017002a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/model.js\":\"1a256b57e96f8657\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/toggleStore.js\":\"5214cf5a9471e4bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/useKeyInspector.js\":\"32d0a25c7980cc19\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"c152022788485ad6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/ShellDecorator.js\":\"c096e34fbaaccb9f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/actions.js\":\"7ba2c37a178fb9dc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c276cdb11b9c1dea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/index.js\":\"04200ab7c3a07f01\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/shell.js\":\"5fad60b4bd590425\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/surface.js\":\"9f464c5c4ba4b40d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/walker.js\":\"24da8f869f5fd127\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/RescheduleToast.js\":\"3cc3262e341aecba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/dataExtension.js\":\"21feca619adc5d63\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/index.js\":\"5abaa0cb4e852a3e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/indicator.js\":\"52645dc2fe7f1788\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/moveSrsState.js\":\"3cfbb8f3b1484e87\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"51927479b8fe8f2f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/scheduler.js\":\"be00bedcaf8c2675\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/schema.js\":\"c52ce47245140bfa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d3a3a95513e36a50\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsClipboard.js\":\"425c23140c24e14b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"af82e1103092d5dd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DailyNoteReviewHint.js\":\"37db103101319b69\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DeckPicker.js\":\"3ff20b38ed630fad\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewControls.js\":\"c828da3f5dab2cf2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewDeckRenderer.js\":\"46b78d3869bd8682\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewSession.js\":\"307a3fa1b17ad0e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/actions.js\":\"c37341fac3fdb8c2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/archive.js\":\"716b3b6326f06cd1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dataExtension.js\":\"27875ab307c2986e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/deck.js\":\"7309197e15ecd51e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dueQuery.js\":\"1e3461d15e818cfc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/gradeDecision.js\":\"eb4d42b7122f2ad7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/index.js\":\"01801d569f28ef0e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/keyHints.js\":\"6e36e12594694d6c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewCardLayout.js\":\"c4bc7ae5f99bc4bb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewProgress.js\":\"84673782f3071f90\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/schema.js\":\"9b3753cc579fb62a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/useDueCards.js\":\"8cda24061bd3e430\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/index.js\":\"0394c94c63e245be\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/record.js\":\"11dab8d1dc67ed86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/index.js\":\"9cdc63c417ede5ee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/persistenceStatus.js\":\"8016a63bbd5b4f47\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/requestAction.js\":\"706e88291810615c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/TypeChipsDecorator.js\":\"400bbf944c49c000\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/codeMirrorExtensions.js\":\"e2d954f90c929d83\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/index.js\":\"e0b90dff047c9a11\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/typeAutocomplete.js\":\"ea2b1ae95b5f0518\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e862e60b90a0b93c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/actions.js\":\"1c90a7df01fdd21e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/anchor.js\":\"d6aa2f44ed0bbb57\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/events.js\":\"bb6d3b8668acf93e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/gestureActions.js\":\"957b5c4ea4605de0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/index.js\":\"f07392fc1c35a480\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9b2a15da1605af8c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/collect.js\":\"9bf059e796c69483\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/index.js\":\"935ae587a94ddda5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/record.js\":\"7ad924d99b51dd47\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/RejectionDialog.js\":\"7b1c03ad00135400\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a0baddfd9016e962\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/index.js\":\"7ada50df7926a093\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/model.js\":\"f943120bd26761fc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/queueCounts.js\":\"21c4c6e8b99ebab8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rejectedHelpers.js\":\"dc55b3e75c54e1b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rematerializeAction.js\":\"97e41273976caf7d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/useHysteresis.js\":\"e1d7eb7e4a6c2dc7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/ColumnHeaders.js\":\"f2d6147ec3108db9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/QueryUi.js\":\"29f5b8445031cbb2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/TableLayout.js\":\"cf7d617bc22f6753\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/actions.js\":\"94daff140ea79529\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/cellEdits.js\":\"cf0231d2673c376a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/childrenViews.js\":\"07f4b86bd8a225a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/columns.js\":\"f64df052c182fced\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/controller.js\":\"f7867a913fbcf540\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/convert.js\":\"9fc9d12ce1b80bb0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/dataExtension.js\":\"c5232011294dd2a6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/index.js\":\"596d5d8039164ea6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/keys.js\":\"9ef595e467a733b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/model.js\":\"ac1be7c4697235fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/QueryText.js\":\"4417d202fee76274\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/backfill.js\":\"a592ff334b88095f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/completion.js\":\"1011f46f6ff2f891\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/format.js\":\"12094e07bf008bc4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/parse.js\":\"ba117c5e67b3614e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/queryValue.js\":\"374ee7f3bc23f612\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/registrations.js\":\"578c1822e54f00d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/source.js\":\"8794bcfca006babe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/registry.js\":\"1fc3910aab0be1f8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowGutter.js\":\"e559693cc0400580\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowVerbs.js\":\"39be8927ce16090a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/schema.js\":\"2ff819e8f2c5d939\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/sort.js\":\"147267022a51738e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/effect.js\":\"0cc9626b906bf7e2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/index.js\":\"0448fa128b4090e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/theme.js\":\"93cabc22dffc9c06\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/actions.js\":\"54012b813f9553dd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/dataExtension.js\":\"b4422444db17a1a1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/index.js\":\"addb3abec83418d8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/schema.js\":\"c51324718b6d4f30\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5511962785653b94\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/actions.js\":\"c744ec1b7107b061\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/defaultItems.js\":\"11207b02d8aaec9b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/facet.js\":\"6a8b74495449bcd1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/holdRecognizer.js\":\"cceb16c40cbe2090\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/index.js\":\"cbbdc6a0956de0f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/UpdateIndicator.js\":\"e47787f7c1bc9abb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/index.js\":\"0aa0eb2faf75ceaa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/loadTimes.js\":\"5304f59f4f186182\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoNotesRenderer.js\":\"b839041c1bc2a995\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoPlayerRenderer.js\":\"5ad28e938c621503\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoTimeStamp.js\":\"f2c97275ae3c2360\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/actions.js\":\"ab495ab496b9a746\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/index.js\":\"75638ace8b59f7ed\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/markdown.js\":\"8c904d8306626bbf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/notes.js\":\"96a3cbf4368b0ed7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/registry.js\":\"f88581d86f3105db\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/remark-timestamps.js\":\"23cd45d2954c9b8e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/view.js\":\"2a73c5a3408af6a8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/LinkHints.js\":\"22b12850778f1299\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/index.js\":\"b359a7ad59d86ab1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/model.js\":\"3e748ba2295dd0c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/settings.js\":\"3075758ef2673eaf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/actions.js\":\"06a1670ecb0e18d4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/index.js\":\"00a7625d766e986f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/interactions.js\":\"f60e289502e93549\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/workspace-header/index.js\":\"b43e5d8423cee44e\",\"/knowledge-medium/pr-preview/pr-1912/src/registerServiceWorker.js\":\"382f8727a9511ffb\",\"/knowledge-medium/pr-preview/pr-1912/src/requestPersistentStorage.js\":\"26ce28bfad738a2c\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authRequestDeadline.js\":\"99c1ba3d967cfabd\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authStorage.js\":\"9ede10fb9aae4c3e\",\"/knowledge-medium/pr-preview/pr-1912/src/services/powersync.js\":\"f48cd0024bc71399\",\"/knowledge-medium/pr-preview/pr-1912/src/services/supabase.js\":\"ab8601ac72e81dd9\",\"/knowledge-medium/pr-preview/pr-1912/src/services/uploadErrorClassifier.js\":\"4c589b79ea0a9e80\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/ActiveContexts.js\":\"6ce70e01327f728f\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/HotkeyReconciler.js\":\"bf0a3c6975873e65\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/WipeLocalDataDialog.js\":\"1cf771fd34060078\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionDispatch.js\":\"12c904447491a90e\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionRefItems.js\":\"9f21746dc344e8b7\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/applyKeybindingOverrides.js\":\"44a6373da17d41e6\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockActions.js\":\"5e4d2a6f2d3aba5c\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockMergeGesture.js\":\"502f8cf902552402\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/canonicalizeChord.js\":\"42969d9340163620\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultContexts.js\":\"0472ffe2b15fe0a6\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultShortcuts.js\":\"be4e61ed1cbc9bf4\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/effectiveActions.js\":\"d64fcd053af2521f\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureAction.js\":\"d5bb0fbabde34a73\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureBinding.js\":\"13c63d8b7c3b16b9\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/holdRegistry.js\":\"1a079878a39448b4\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingConflicts.js\":\"cd227be2170491c4\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingOverrides.js\":\"2bb269e3574bc485\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/pointerAction.js\":\"0c7fdc7ba2f193d6\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/resolve.js\":\"1a0ab288357a4443\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/runAction.js\":\"5a5e74d15b787ace\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/sequenceMatcher.js\":\"52a84bb00125f01b\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/types.js\":\"1c388641dd503d95\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionContext.js\":\"e59eb09a55eb2c22\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionDiscovery.js\":\"0c49f1206aabe8b5\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/utils.js\":\"906805a73b2584e9\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/bootStore.js\":\"7250bc5402f3c3fc\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/previewDatabases.js\":\"ac204888932ee4d0\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/byteTransform.js\":\"aa01426b529851a8\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/attachmentCleaner.js\":\"6dca9c84d6f2cf91\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/attachmentParts.js\":\"0c0ab0ce921e25d3\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleParts.js\":\"c662007b4d7b424d\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleRecord.js\":\"5a51b8d502c168e6\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/manifest.js\":\"75fc747dc1058be8\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/takeBundle.js\":\"1375ed15a24441e9\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/verifyBundle.js\":\"00c9f0f55e50d1ed\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/cleaningStage.js\":\"414f1a9555f86740\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionKey.js\":\"6582410e3898d63c\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionServer.js\":\"8ce125d01a526eae\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flip.js\":\"10f29fc77b0e42ac\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flipAttempts.js\":\"6e0a4634b9c2ccc1\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/pages.js\":\"c7924728d2c7dac5\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/preflight.js\":\"915dd8949b429092\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/reseal.js\":\"0dd68d597dde7168\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runConversion.js\":\"56855552357c520f\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runLock.js\":\"6ca8c1984d3faacc\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealing.js\":\"57c63e841da3a095\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealingStage.js\":\"fb27e265bde360d5\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/stage.js\":\"5c85d1f76f2c18fa\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/verifyReseal.js\":\"1bdfdfac2d729e52\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aad.js\":\"6625e7b7c98bedbe\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aead.js\":\"6ed84fa3d69d0aae\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base32.js\":\"499611b64337e1a9\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base64url.js\":\"2e0a5778a4601b62\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/binaryEnvelope.js\":\"932aa6c10d7a56e5\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/byteAead.js\":\"0062c193bd042afe\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/canary.js\":\"fa67e42d683ec62c\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentHash.js\":\"e621b014d87eebbe\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentKey.js\":\"93c62b572c538e3e\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/derivedIdNamespace.js\":\"20b32de41365b0e3\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/envelope.js\":\"794bb751615946a7\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/hex.js\":\"2936687cc753fedd\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/sha256Hex.js\":\"4591b18f9de447da\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/workspaceKey.js\":\"6c9c31901c236f81\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/conversionState.js\":\"6ab0618d927314c1\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9b9922b7e844f9f7\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/pastedKey.js\":\"ece280771ba3f636\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"06b3c45026da6c77\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c6b051e8448cd752\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/keyStore.js\":\"ba5b3beaf11e1c60\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/mintWorkspaceKey.js\":\"62c208fe82ae297d\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/modePin.js\":\"4530b920a37fc624\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/openWorkspaceKeys.js\":\"4f777aff1d9b200a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolveWorkspaceEntry.js\":\"ff310293daccfadd\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolver.js\":\"aebe9279ba57f1f0\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/workspaceAccess.js\":\"e96d7b37ea45efc6\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/transform.js\":\"68a2c349df242038\",\"/knowledge-medium/pr-preview/pr-1912/src/themeBootDefaults.js\":\"e9659269e3e8e3df\",\"/knowledge-medium/pr-preview/pr-1912/src/types.js\":\"b450e604a27942ae\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/ClientLocalSettings.js\":\"0b1cb4356d952565\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/abortableSleep.js\":\"a2ef31bf62d8e0e6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/array.js\":\"e34cea10ff6097d4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/backlinkAutocomplete.js\":\"9456e1a0ce3c864e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockCrumbs.js\":\"64d9fa7240efa917\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockrefAutocomplete.js\":\"dec4235aef043c42\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/cadencedIdleJob.js\":\"e2e6a143ec79bcf7\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/callbackSet.js\":\"ba0e650922605094\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/clientId.js\":\"6d5a1853aa20eedb\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirror.js\":\"ea3c29eea0126ad0\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirrorCompletion.js\":\"186e5cd641e860a6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/copy.js\":\"c5b90aaf04a2102b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dailyPage.js\":\"204a4f37ba75fc37\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensics.js\":\"0e6ffa3dca8e38f3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensicsHooks.js\":\"0dcf88a7d29ade7b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/deleteBlockThroughUi.js\":\"b72bbd2a8cde2e03\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dialogs.js\":\"32674a65be9fa918\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dom.js\":\"77254cd0c3fb758e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/downloadBlob.js\":\"5674193a1f47c140\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/drawnWalk.js\":\"2a917e03559643fe\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/exportSqliteDb.js\":\"c45de86f4c85e266\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fileSystemAccess.js\":\"aaf698c652f51ce2\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/flipSlide.js\":\"5f1dccc3f10a1789\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fnv1a.js\":\"d3189dc2148ab3df\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/formatBytes.js\":\"cdab68335193f5bf\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fuzzyRank.js\":\"6fc7762aabef616e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idbKeyedStore.js\":\"e6e009e322502a72\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idleCallbackPolyfill.js\":\"ded823e39898a7fe\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardAwareScroll.js\":\"ea73e5cc06c58432\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardViewport.js\":\"d1b9c2ae07b39162\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/lastWorkspace.js\":\"f1cc89d1e930fa76\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutColumns.js\":\"bb3a4e23d2e1c4e6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionDom.js\":\"bbff200aac69adc2\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionId.js\":\"b5da9092aa259283\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkClickGestures.js\":\"bfd8bca36efbfee8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkTargetAutocomplete.js\":\"466a4adf8a7a4319\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbCorruption.js\":\"1b48f09ea44f71e5\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbRecovery.js\":\"1d9022184a359371\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/markdownParser.js\":\"6c3cda75acaa5492\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/memoize.js\":\"6c0eead0f1a7e04a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameFieldCommit.js\":\"f5ff98243572ed64\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameList.js\":\"fb5b18b137b9626b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/navigation.js\":\"a30f394c560486c9\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/omnilinerNamespace.js\":\"a8f663279f4566f3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/opfsPageScan.js\":\"5e5fe4951e77e320\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelClearance.js\":\"d93e5c0bc49b53a1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelHistory.js\":\"e3d287738fbd0460\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLanes.js\":\"941ab9113b3bf0e4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLayoutProjection.js\":\"4c47ef034dcf1e6e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelScrollAnchor.js\":\"95cbaa6ccf660250\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelUrlFlags.js\":\"e1408db9c54c4edb\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/platform.js\":\"9101e811fca6be00\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/pluralize.js\":\"852fd35bb9625aba\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyCreation.js\":\"b1fdf0ff0e3cc4c5\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyNavigation.js\":\"a7879232a82a529d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyValueContext.js\":\"d6b2e0f39b3ff181\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/react.js\":\"57a9929ecc2d9862\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeDate.js\":\"15dc11367f3a2844\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeTime.js\":\"50f8303c1822c0c0\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/renderScope.js\":\"8d811a45cf3ba026\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/resolvedThenable.js\":\"2e17ae2e12e55bbf\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/routing.js\":\"7fc9617cad772651\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/safeMode.js\":\"b8ea80a04abc279e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/scheduleIdle.js\":\"64a06ef95e86cc22\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/screenWakeLock.js\":\"2fff154fce3989e7\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/selection.js\":\"96bb2009b9083799\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/softKeyboardGrab.js\":\"289b3fe2741c6af6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/startupTimeline.js\":\"4c4be02cd06741ff\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/state.js\":\"7e1b141b0eef7fb6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/string.js\":\"47678b53066f2ede\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/surfaceZoom.js\":\"48ed853465d18483\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/time.js\":\"2346be074c95ea5e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toast.js\":\"9678ae4a60b9a6d1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toggleStore.js\":\"e1620245d80235ac\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/untilStopped.js\":\"1b29e06a45436e1b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/userActivity.js\":\"bf2d1f2b5c2ed023\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewTransition.js\":\"1726edfb3f14b38f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewport.js\":\"35ebfca2f2d63fd4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/webLock.js\":\"a18b024e83dfc387\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceRecovery.js\":\"a7e9b92645268d61\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceSnapshotStore.js\":\"2fc44deb41f76f0d\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-compiler-runtime.js\":\"3e306e109e0b9828\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-client.js\":\"873c969d17ff6c4e\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server-edge.js\":\"524c2e007cc41d34\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server.js\":\"0b19557961eef318\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static-edge.js\":\"7c7b677e0fe9117e\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static.js\":\"e2b70298d134391c\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-test-utils.js\":\"64537247dc3e098f\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom.js\":\"3c32e93a6074bd1a\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-runtime.js\":\"56dfd2c476ceb5f3\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react.js\":\"b2cc078372aa059c\",\"/knowledge-medium/pr-preview/pr-1912/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
