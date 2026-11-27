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
		buildId: "203428e1ef8c-06cb9a47",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/\":\"b32d15aadc89a310\",\"/knowledge-medium/pr-preview/pr-1912/index.html\":\"b32d15aadc89a310\",\"/knowledge-medium/pr-preview/pr-1912/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1912/assets/FacadeVFS-z0B0ZQDn.js\":\"d99dade86fe43df1\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSCoopSyncVFS-DoojieyI.js\":\"34f7f1cb4a56f51b\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSWriteAheadVFS-NsruLbjv.js\":\"87f5aa8e6785473d\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-4GSll1Mp.js\":\"6140e36f7dea7f67\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-BCRBXAqc.js\":\"018f6c8b2a143b45\",\"/knowledge-medium/pr-preview/pr-1912/assets/worker-BYg_2rPe.js\":\"fe9bc682b865cb6d\",\"/knowledge-medium/pr-preview/pr-1912/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1912/chunks/app-CMoUDNkU.js\":\"6e99371192ed7daa\",\"/knowledge-medium/pr-preview/pr-1912/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1912/index.js\":\"24398303b9f6e2e1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1912/assets/AccessHandlePoolVFS-cQAAQGdG.js\":\"c4ec8efc6f0ab44e\",\"/knowledge-medium/pr-preview/pr-1912/assets/IDBBatchAtomicVFS-DdNRDtnV.js\":\"a07ba84f95d309a9\",\"/knowledge-medium/pr-preview/pr-1912/assets/MemoryVFS-Cezz5vZE.js\":\"edf30314a3479c94\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-B0dUFdPu.js\":\"eff18346372b58c8\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-CctxJKTs.js\":\"af5f140e179ca6c6\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1912/chunks/AccessHandlePoolVFS-C-VSnTD8.js\":\"05eba8818608dbf0\",\"/knowledge-medium/pr-preview/pr-1912/chunks/FacadeVFS-BJz-D-QZ.js\":\"fabb6669188abca0\",\"/knowledge-medium/pr-preview/pr-1912/chunks/IDBBatchAtomicVFS-BjIB4eKF.js\":\"2ff86da372d8bc64\",\"/knowledge-medium/pr-preview/pr-1912/chunks/MemoryVFS-Br6Fe7fS.js\":\"89627247731b26e3\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSCoopSyncVFS-DdwfbB8U.js\":\"c103ef55a2bd9f96\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSWriteAheadVFS-C467Rh0A.js\":\"898ece829ba56f6b\",\"/knowledge-medium/pr-preview/pr-1912/chunks/Preview-CYGmoCPh.js\":\"5e29cd77881b152d\",\"/knowledge-medium/pr-preview/pr-1912/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1912/chunks/card-C7wiwqoR.js\":\"967b7b68222fc1df\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-DIYUxSUa.js\":\"f05cc91751adcf14\",\"/knowledge-medium/pr-preview/pr-1912/chunks/freezeExtensionImports-B6b8lnYf.js\":\"8ec27d2da05ea9b3\",\"/knowledge-medium/pr-preview/pr-1912/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1912/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-DtQKssN8.js\":\"0da7da74c69c5d72\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-async-DVbvn30X.js\":\"ba92c11e09beea44\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-9Dc0DmkQ.js\":\"a6c84c4b2a32ec45\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-BgBjrAGK.js\":\"ad9d47f876418b4e\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-BowiYG7W.js\":\"27f82745acd6bbb3\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-C6R2hTvm.js\":\"bd190902dc1b36b2\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-CCW6Kuvz.js\":\"ee901367563c3b96\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-CI62KwAZ.js\":\"2f8d4e373a4b8845\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-D-jkTeCV.js\":\"1446f0574751e437\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server-legacy.browser.production-vF511VAp.js\":\"fcda24e6004bff81\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.browser.production-BNw7Gqta.js\":\"4f5ac29f52354393\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.edge.production-ibMrAnfQ.js\":\"86fc46e06c5444ea\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-goiThaSp.js\":\"0a8f6c8a1d36174c\",\"/knowledge-medium/pr-preview/pr-1912/chunks/server.browser-CGZnQ1Xg.js\":\"56204ef4e03f00f5\",\"/knowledge-medium/pr-preview/pr-1912/chunks/textarea-D74zGqau.js\":\"19444f3e6af24075\",\"/knowledge-medium/pr-preview/pr-1912/chunks/ui-DzBmGA9u.js\":\"ab8a8cd04de092de\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-DIvmIEH6.js\":\"726811a0d8d04043\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-async-DCuUfx99.js\":\"8b4ab71b9536f2e4\",\"/knowledge-medium/pr-preview/pr-1912/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1912/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/src/App.js\":\"e0b16aa4a6bb4ff8\",\"/knowledge-medium/pr-preview/pr-1912/src/appUpdate.js\":\"b76c19e32a3844f5\",\"/knowledge-medium/pr-preview/pr-1912/src/appVersion.js\":\"eedecc04e8e5bc07\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/initialLayout.js\":\"dac718bcb822d66e\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/openWorkspaceData.js\":\"1c22c9b95dc82c59\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/resolveWorkspace.js\":\"5d1f5992a046fec3\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/workspaceBootstrap.js\":\"4ee28122052b375a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockComponent.js\":\"e132821d85737262\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockCrumbs.js\":\"ce48d118957dd7d5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockEditor.js\":\"d062276fddc37661\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockLoadingPlaceholder.js\":\"1a4da32f168aa7ee\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockProperties.js\":\"850d3b2b800891b5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockSearchPicker.js\":\"8e680aff6ce6d5cb\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ConfirmBulkDeleteDialog.js\":\"9fe2c1244cc09405\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DividerHandle.js\":\"4dfa4556f483ad10\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DraftEditor.js\":\"c09ed9044d3f1ff9\",\"/knowledge-medium/pr-preview/pr-1912/src/components/GutterPill.js\":\"c06c17a0df67787e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Header.js\":\"4a968e9f507a04dc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/LazyBlockComponent.js\":\"b3885b808e2cfa47\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Login.js\":\"a3e376f1936e2df9\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ZoomableSurface.js\":\"84277680968f2291\",\"/knowledge-medium/pr-preview/pr-1912/src/components/editModeKeepalive.js\":\"2cd99ff637e9bfeb\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyDisplay/PropertyDisplayScope.js\":\"bf539123dd75b618\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"e18f8444990bfd40\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefPropertyEditor.js\":\"a2aebc4b4d5d609d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefTargetTypePicker.js\":\"c3b9dfce583415d0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/SelectPropertyEditor.js\":\"bed7c524c92932c7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/TypesPropertyEditor.js\":\"6f39cf425adbcb7b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/defaults.js\":\"a6eb21044f8a3bf5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/kernelValuePresets.js\":\"7009b0dbe9e4dfde\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/selectablePresets.js\":\"842d30ef667072cb\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/typesPropertyUi.js\":\"7aa3dbc997ff8c38\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/AddPropertyForm.js\":\"152b90c2a4e33d21\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyPicker.js\":\"43e50e7e06707b17\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyRow.js\":\"ff016276341e03de\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/Rows.js\":\"368b8c2016725f11\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/actions.js\":\"aee3b778b0e6761e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/declarationOnly.js\":\"cdaa4369639174ca\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/layout.js\":\"35f53f9b31a0c5f0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/model.js\":\"bd716eca8c552d83\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapeUi.js\":\"a993877c25081be2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapes.js\":\"06e48796e7cb4f00\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e426161cc1b20543\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/visibility.js\":\"71bdae1670da2daa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanelSections.js\":\"4d3835cea7021e23\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockEmbed.js\":\"2eff0f8c05475552\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockLink.js\":\"4ddc361d32e59bed\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockRef.js\":\"ba420afa38e8a4ef\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/CompactReferenceLink.js\":\"83c4e10b7369f35e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/ReferenceLink.js\":\"6f072f16033146a3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuard.js\":\"406f062956ab5540\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuardContext.js\":\"78b4dcd90c9cf25d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/linkInteraction.js\":\"4cd0b87afeb8a41e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/referenceLayout.js\":\"65b7c521ff2474a0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/useBlockRefAncestors.js\":\"10a787ad554c2367\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockGutter.js\":\"df3355e6964e8fe9\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockInfoDialog.js\":\"53a195f8e4dbd70d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockReadText.js\":\"f6bbb3f7080523ec\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockTypeBlockRenderer.js\":\"5662cc5a2bb93c9d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BulletHoverCard.js\":\"ecd558a57bb2f2c0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorContentRenderer.js\":\"b66529b32f796de2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d834d47ddad0deaf\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ColumnResizeHandles.js\":\"7edadae3e2015cf5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b4c6b80d9a7ba3b5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/DefaultBlockRenderer.js\":\"d2d1aeb338e6facd\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/LayoutRenderer.js\":\"2f235a42c57ca003\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MarkdownContentRenderer.js\":\"78ea6e93dde9ca84\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MissingDataRenderer.js\":\"fca2242bf6c5d1fc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PanelRenderer.js\":\"4fe4d4c2aa156b6a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d4a30c8faebb079f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/TopLevelRenderer.js\":\"0123dd8d5f3f729c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockGutterMode.js\":\"a3a9b667ea10a506\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockTitleText.js\":\"db2d081080a8eb5c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/fieldCreationKeydown.js\":\"c2ef0b53c4bb09b7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/layoutRootContext.js\":\"1eace92b871ced70\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/TypeChip.js\":\"3dce25bccd7b0853\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/chipStyle.js\":\"3671c79e0cf009e7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/anchored-floating.js\":\"5d50ab62f97510fa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/button.js\":\"88aac95a97e827ed\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/card.js\":\"8f81c701ecc73e90\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/checkbox.js\":\"9f8eedd7571ed3f8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/collapsible.js\":\"4bd2bfb7ca726aa8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/command.js\":\"6280c93c455821dc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/context-menu.js\":\"1e632d837262eb4a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dialog.js\":\"618d1567a141edfa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dropdown-menu.js\":\"7b210994e31aab9a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/floating-listbox.js\":\"3424819c204c3703\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/index.js\":\"76152fd8c604944f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/input.js\":\"294eb872276d9c25\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/kbd.js\":\"536fb7f6870cc5b6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/label.js\":\"ae03c07281f1b291\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/textarea.js\":\"0185ea2e3260b0e7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/useEditModeYieldKeepalive.js\":\"f06b6fef42379c94\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/BootFallback.js\":\"bd0bd1998c9728c8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/FocusedRowLazyMount.js\":\"6c94123f2a92994c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LazyViewportMount.js\":\"a0b1efa387683ef8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LocalDbCorruptionFallback.js\":\"e4c8faadc7b8c7fa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/error.js\":\"27fe288c3eaf6ef7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/lazyMountRegistry.js\":\"e7d6a7a5961cc87a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/suspense.js\":\"a659a72b362f15ae\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/CreateWorkspaceDialog.js\":\"d8f1d4d7784a9733\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/PendingInvitations.js\":\"9103e1686beee241\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/SyncProgress.js\":\"d75bceed03ea1008\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/UnlockProgress.js\":\"ca8b5844d5ab1c5d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceKeyGate.js\":\"4f1c18bd7b70e7d5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSettingsDialog.js\":\"e4e19d9fd053fbbe\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSwitcher.js\":\"4e9363767719d17c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSyncGate.js\":\"3aab500790dec241\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlow.js\":\"d64860a62718656d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlowHost.js\":\"83dfeb0f50e8642a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/EncryptionSection.js\":\"4b53234d41692048\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/attachmentPrompts.js\":\"5dbb73e2717a263a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b17c2f930ceaca24\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowDeps.js\":\"c9b576fd2d0f45b6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowStore.js\":\"6f1477713744aee7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/flowUi.js\":\"f848ff865cb38884\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/useConversionRun.js\":\"5699d3a3932e0b9d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/keyUi.js\":\"0641dd4c2cdbd43c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnKeyLoss.js\":\"8b715082f639a149\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnServerE2ee.js\":\"96ba5e4ba787cc39\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/workspaceUnlocked.js\":\"545218c99c0b640b\",\"/knowledge-medium/pr-preview/pr-1912/src/context/backgroundSubtree.js\":\"cafa41c2bbc2f3e5\",\"/knowledge-medium/pr-preview/pr-1912/src/context/block.js\":\"156b9283bd0d6b6d\",\"/knowledge-medium/pr-preview/pr-1912/src/context/layoutWsContext.js\":\"4607b7aea4ba8295\",\"/knowledge-medium/pr-preview/pr-1912/src/context/propertyDisplay.js\":\"928b43ed199f361d\",\"/knowledge-medium/pr-preview/pr-1912/src/context/repo.js\":\"18f33c00edfebf98\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasClaim.js\":\"03ec13b6ff425e33\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasSeatNamespace.js\":\"e024d369b097dbe3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockData.js\":\"f30b6c49c66461f8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockType.js\":\"fea3cb788af979cc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/changeScope.js\":\"11c8d88c14f12044\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/codecs.js\":\"4cd7cd8361f405d7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/derivedData.js\":\"8b3f635e26d48813\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/errors.js\":\"10349c35cf810ea6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/events.js\":\"93704361416b1e11\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/handle.js\":\"c266fdc0851709ce\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/index.js\":\"476b1e4aa7ed0aba\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/mutator.js\":\"56eae7a3bc9692e4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/processor.js\":\"8108312d13a94c92\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/propertySchema.js\":\"c37d62fafc986251\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/query.js\":\"742fc7cbad638e7e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/sameTxProcessor.js\":\"3e90a8f23b9f7349\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/schema.js\":\"c266fdc0851709ce\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/tx.js\":\"c266fdc0851709ce\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/typedBlockQuery.js\":\"5aae47423d1bdb6c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/user.js\":\"c50d98376bc2a4fc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresetCore.js\":\"0466f59f1310294c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresets.js\":\"16f11ca648819356\",\"/knowledge-medium/pr-preview/pr-1912/src/data/attachmentCleanerIOVerb.js\":\"db0d2f16b283f308\",\"/knowledge-medium/pr-preview/pr-1912/src/data/block.js\":\"d20217e42bdebab1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockCache.js\":\"6a90f3561a19bec1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockId.js\":\"2532c79b0758437b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockLiveness.js\":\"965cb8e3292923c3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockMerge.js\":\"972f9bdb6dd61713\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockSchema.js\":\"62fd485b3c298b78\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypeLookup.js\":\"3b5ea30e87902cb7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypes.js\":\"971fac6554e92e6a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/childrenView.js\":\"1f6121c6373d4a36\",\"/knowledge-medium/pr-preview/pr-1912/src/data/clientContext.js\":\"342022b2af43947b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/dbFileSiblings.js\":\"9bd006eaa6c5c55e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/definitionSeeds.js\":\"93e4f731d12ba1f3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/derivedIds.js\":\"67186d3978b6a941\",\"/knowledge-medium/pr-preview/pr-1912/src/data/drawnSubtree.js\":\"b0ab2b0b6df45c95\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facetBridge.js\":\"9ec5c224eacc4f0f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facets.js\":\"6d878390612b3b37\",\"/knowledge-medium/pr-preview/pr-1912/src/data/globalState.js\":\"c67ce814e94d6b6b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/aliasClaimRederiveProcessor.js\":\"50fd8b032e9afe4d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/ancestorBatch.js\":\"d84d8150c9199eab\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/blockTypeTypeifyProcessor.js\":\"b4793e1873a3baa0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/clientSchema.js\":\"72b273ffabb4ea99\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/commitPipeline.js\":\"d631a5dd5b1ad57f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/devAssertions.js\":\"ee3619e687509318\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/firstSync.js\":\"c9011957a25ea469\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/freshInitialLoad.js\":\"7dc38b0c111698f2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/graphBackfillClaim.js\":\"010e9e47f2c53806\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/handleStore.js\":\"3cf97908833cd1ab\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/idleMarkerJobs.js\":\"20fdc1c04489017f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initialDownload.js\":\"86b15973150aa792\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initializeClientDatabase.js\":\"093e97b6fc013f08\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/jsonCanonical.js\":\"3aae3f9ec2112a32\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelInvalidation.js\":\"9223ad4da1e629da\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelProcessors.js\":\"92b60b8ffba601d4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelQueries.js\":\"4720c27ded7f1894\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/mergeTypeMembershipProcessor.js\":\"dfa9b8de14505a65\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/normalizeReferencesProcessor.js\":\"89ada659afd69aa9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/poolInstrumentation.js\":\"ded34e8277e5945c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/processorRunner.js\":\"7154e9ef974de0eb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyCellBackfill.js\":\"d459606602338d08\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildMint.js\":\"727f3343b8416fd5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildrenProcessor.js\":\"4439c9c86d704cfc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4d995f2158d18248\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionSynthesis.js\":\"146822fe0aefcb6c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyKeyScan.js\":\"9e5d6a8caaab1a90\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertySchemaResolution.js\":\"cf3a683df69808ea\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyValueEdits.js\":\"7ed35d38296401f1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/raiseProtocol.js\":\"908391d2d30d56ea\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/readBatch.js\":\"bf23f77b9338fc4d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/refProjection.js\":\"dc51684e807f64e1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetLookups.js\":\"0844bbf299e71c7a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetProcessor.js\":\"d07878e8a4283f13\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/replayMerge.js\":\"7586ac10579dc70b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/sqlBinds.js\":\"e44da8efc0d861c3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e9f8c7c05dae5ef6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/arrivalProcessors.js\":\"5916d9084d337258\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/invalidate.js\":\"19ddc37505d85cae\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/materialize.js\":\"bff1318561b1ec2f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/observer.js\":\"98ee10ac340c0714\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/reconcile.js\":\"48ba19869142562f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/timingMetrics.js\":\"4d18f138bdb1517e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/treeQueries.js\":\"fb58dead3bef6fe9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txEngine.js\":\"9a73e86cfdb5603f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txSnapshots.js\":\"b1ab5617edd6e43e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/typedBlockQuery.js\":\"927e660bedfb1817\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/undoManager.js\":\"d539e0a2857fbf51\",\"/knowledge-medium/pr-preview/pr-1912/src/data/invalidation.js\":\"dd60400b7b37cb93\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelDataExtension.js\":\"da4585e8b2738bea\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelPage.js\":\"33e0a8ef6fed411f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelValuePresetCores.js\":\"376431440f157de0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbCorruptionSignal.js\":\"c04db42ff4452492\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbStorage.js\":\"7e74147f34f4d0c9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbVfs.js\":\"51a44958420e2b9d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localSchema.js\":\"3bbe6623ffe3ac19\",\"/knowledge-medium/pr-preview/pr-1912/src/data/maintenance.js\":\"803a6dcf431a8c57\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mergeProperties.js\":\"f6510057e9d03b67\",\"/knowledge-medium/pr-preview/pr-1912/src/data/metricsConsoleHook.js\":\"978bfd63a1b0e4f5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/migrationsPage.js\":\"b8cb85f8d3994729\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mutators.js\":\"df6e9265bf6c57a2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKey.js\":\"1852ef888e06e7a4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKeyPlacement.js\":\"7841fd0f3dc67eba\",\"/knowledge-medium/pr-preview/pr-1912/src/data/outlineSurface.js\":\"22cc938c68b38d65\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingEditorContent.js\":\"61bb78d6ab720f7a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingUploadsSql.js\":\"15673def36810aa0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pluginStateExtensions.js\":\"412f902270d5f4db\",\"/knowledge-medium/pr-preview/pr-1912/src/data/powerSyncLogger.js\":\"71a2f384af6ffc16\",\"/knowledge-medium/pr-preview/pr-1912/src/data/projectorRuntime.js\":\"ebcedf0f04132ff4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/properties.js\":\"63662612117d1103\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertiesPage.js\":\"408c24a977990b24\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyChildren.js\":\"aa27da849227aefb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionFanout.js\":\"c0021533901d09e9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionMetadata.js\":\"60524e15768933d4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionRegistry.js\":\"2d22734acc8694d5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDisplayMode.js\":\"d5c04adaad365707\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyRowCreation.js\":\"502ee235e7b52eec\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySchemaCreation.js\":\"bbd11a3c7b66513f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySeeds.js\":\"8991ab0a4d1dbc76\",\"/knowledge-medium/pr-preview/pr-1912/src/data/recentsPage.js\":\"04f9fe2adae44cd8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/refTargetComparableProperty.js\":\"7920787529c56e66\",\"/knowledge-medium/pr-preview/pr-1912/src/data/referenceBlock.js\":\"1370603ab7f5f1d1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rejectedUploads.js\":\"f340f0f5e71b8e55\",\"/knowledge-medium/pr-preview/pr-1912/src/data/releasePowerSyncConnection.js\":\"11e39824a8831938\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repo.js\":\"b869bea21e2b858f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repoProvider.js\":\"1f3f318178f90abb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rowProperty.js\":\"f9a26f83dfda675c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/searchFilter.js\":\"9425c9b00a4e7d48\",\"/knowledge-medium/pr-preview/pr-1912/src/data/seedIdentityLedger.js\":\"1808aa086d46defb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/stateBlocks.js\":\"0843b25053f162d6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralEditPolicy.js\":\"fbf7ae1a4583f9ed\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralInsert.js\":\"9fe83c7edc25ec1a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/subtreeDelete.js\":\"7d9226ac447eedf1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncStreamLock.js\":\"144c2fa84798499a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableSqlRecognizer.js\":\"10f379adbc105b32\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableWriteGuard.js\":\"cf11ab036f215462\",\"/knowledge-medium/pr-preview/pr-1912/src/data/targets.js\":\"45e05ce06ec389c2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeColors.js\":\"bc04f3ab3a4a5d55\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionMetadata.js\":\"d2b29c76e0688d6d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionRegistry.js\":\"b67b553da9a9594e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeExtraction.js\":\"d66025e3932e7f45\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeInitialValues.js\":\"11a33841bb9e7619\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typePropertyGroups.js\":\"9a787b77cfb51846\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeSeeds.js\":\"28f8618c7269401a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeTagger.js\":\"a578415e818dd6b6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typedRecords.js\":\"0e640476606a4100\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typesPage.js\":\"b4f1b094d3a3821b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userPrefs.js\":\"eeac95f3923164f9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userSchemasService.js\":\"6e82265f1a9254d2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userTypesService.js\":\"3ac5bb14be91df11\",\"/knowledge-medium/pr-preview/pr-1912/src/data/valuePresetRegistry.js\":\"5da1d9fcabadf24f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/visibleChildren.js\":\"296e78a9d6d537d1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceConversion.js\":\"bbe9ff91c68bfac2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceFirstSync.js\":\"c01ae6b3960c6f9c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceIdNamespace.js\":\"c61ac72ee2864d51\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceSchema.js\":\"50a096353f6eaeb6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaces.js\":\"d040eef2cf11b942\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadLog.js\":\"57ffd9098ac71596\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/BlockPasteShellDecorator.js\":\"aad9ce44d7a5d222\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/atTrigger.js\":\"fc9ca6cc1789ac80\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/autocomplete.js\":\"436160e0b0f509b2\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/codeMirrorExtensions.js\":\"3e021bba8cfeef71\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/contentFlush.js\":\"6f75ce23ba1eb931\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/defaultInteractions.js\":\"b4e121f68687e50b\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/editSettleSignal.js\":\"4e52c32ea4a54512\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/insertImage.js\":\"5544c832aa987f57\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceCompletionRange.js\":\"a74bd0e8ed164bac\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceTargetTypes.js\":\"b1c0fbd99d0bc813\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/syntaxContext.js\":\"a6f63260002bdfa9\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/triggerMatch.js\":\"2ba7045b02e18e50\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/AppRuntimeProvider.js\":\"e74f87544404d1f7\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/BlockFocusShellDecorator.js\":\"1e0a61c48feaf424\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/ExtensionRenderBoundary.js\":\"3c72feb396784e43\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/PanelContentRecovery.js\":\"93731a7d97d553b0\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/apiCatalog.js\":\"84121799ecd3629f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/approveExtensionHere.js\":\"64ae95f356f9b011\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/armedCutAppMount.js\":\"70dbeebe6b588c59\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/batchableKeyedStore.js\":\"5c483761c6829699\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockInteraction.js\":\"fd1b3a89bf59c8d5\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockSelectionAction.js\":\"d0babc0d76906e91\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compileExtensionModule.js\":\"75f6f6f60c523fcc\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compiledModuleCache.js\":\"67392d77ca05f5c1\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/continuousGestures.js\":\"e038a58b1992122d\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/core.js\":\"b9fe0a4b3c415cfe\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/defaultRenderers.js\":\"1d8c0b374d4d0eb2\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/definitionFanoutAppMount.js\":\"626e52bb28f49890\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dialogAppMount.js\":\"d447eacf41003978\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensionSeeds.js\":\"26bce656ac5d7b17\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensions.js\":\"b6401719e24fe231\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/exampleExtensions.js\":\"01c74e90934f159f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionApprovalStatus.js\":\"5ad57b357c134125\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionImportPolicy.js\":\"9e6b08dfb7542c70\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrorToast.js\":\"4cd4469d430c201f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrors.js\":\"daf69a60cb7f80ad\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLookup.js\":\"1152382857411274\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionToggles.js\":\"bd7780c2c2a98193\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionUtilitiesCss.js\":\"ed0b36f7b43b1288\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/kernelPageDeletionGuard.js\":\"9c75cfac17b6acc0\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/liveRuntime.js\":\"351173afb870ba7c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/normalizeExtensionSource.js\":\"a7a2c63bd0f6205d\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/openExtensionsSettings.js\":\"d03d6de10ce95ab7\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/overridesCache.js\":\"cdeb3c02038a63af\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/pluginIds.js\":\"ff0ae64a5ff390d9\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/processorRejectionToast.js\":\"653417e75f224f0a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeActions.js\":\"7c74dd807439c837\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeContext.js\":\"59f968553b88ea90\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticAppExtensions.js\":\"4d72874b5982ca32\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticDataExtensions.js\":\"381631832ade6c7e\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/toastAppMount.js\":\"e8040cdea7497e76\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/transpileExtension.js\":\"0e1603a4cfda68ef\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useOverrides.js\":\"710f266a17fcb607\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useShortcutSurfaceActivations.js\":\"3aeddf2ede2809c7\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/discoverToggleTree.js\":\"5e6d62975a50a6ee\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/facet.js\":\"e3de43cdf8dd8807\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/resolveAppRuntime.js\":\"a0116f0b236689e6\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/runtimeEvents.js\":\"dd45f29d470e7e25\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/togglable.js\":\"d46f5b22ee7c861d\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/variantFacet.js\":\"4551aba479580224\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/verbFacet.js\":\"8318bc4ece2627d9\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/block.js\":\"fa979ccdc0e85ba7\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/focusedChild.js\":\"a740f9e904e7b074\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/propertySchemas.js\":\"f2ae50402cd9d6ec\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/typeRegistry.js\":\"e31df0099c431c27\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAncestorCrumbs.js\":\"1743f23261b6e8d6\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAutocompleteListbox.js\":\"4941744a08760d00\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedSearch.js\":\"cd193acd6fb6b11b\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedValue.js\":\"3da39dc10e1fc44d\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useFacetValue.js\":\"03f799ff213f1c90\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsFocalRender.js\":\"0f84457117b83deb\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsReadOnly.js\":\"e819ebf54e9ef079\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMaterializeBacklog.js\":\"edc5a7749c98b981\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMinuteClock.js\":\"13492f19e7dee321\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePanelLayoutProjection.js\":\"8f827c10c6c33c18\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePendingInvitations.js\":\"db74de347452a19c\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRendererRegistry.js\":\"673a4309970b814d\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRetainedFieldRows.js\":\"6b5b395d47164389\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useWorkspaces.js\":\"7ef3a377bb7d9348\",\"/knowledge-medium/pr-preview/pr-1912/src/lib/utils.js\":\"7651d4d634125832\",\"/knowledge-medium/pr-preview/pr-1912/src/main.js\":\"3d460702533fa280\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/MarkdownImage.js\":\"081c568ad8df820e\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/blockSeparators.js\":\"02a19475347791f6\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/context.js\":\"567756201891aa4c\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/defaultMarkdownExtension.js\":\"28e4b54e6cf6f2ed\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/extensions.js\":\"d4a58315d5d6d192\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/renderMarkdownHtml.js\":\"289122e6264cc33a\",\"/knowledge-medium/pr-preview/pr-1912/src/minimal-editor.js\":\"e2c6c67f73933371\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/armedCut.js\":\"59a65c3884a619bb\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/captureMediaVerb.js\":\"725b389bcbe5c409\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/clipboard.js\":\"0782774f01f81aa3\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/decision.js\":\"01474504773e4bcd\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/operations.js\":\"53280fe579b7e35d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/AccountHeaderItem.js\":\"3ba0eca82ca7b179\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/index.js\":\"fba873773e77c9df\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ad42677862e36f8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askAgent.js\":\"03eac86020d385f1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askedStore.js\":\"5905f5ae2aca12be\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"e88e07b859bf778e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/chipState.js\":\"0d8a2548f7675531\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6405ee1c64e122f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/index.js\":\"91a166e6b8c32ceb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"87083054daa9bffd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/schema.js\":\"ed89b279f5e6f658\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b9621fa631461ef6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4b3b50ffadc23847\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/addMedia.js\":\"850ac9e62e3840d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f8dd45075cf494bc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/block.js\":\"58d40a3980f1191e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/context.js\":\"16c8cc84c70fb36c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7361a2e432e4ae17\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/index.js\":\"9de9dfe86f404ba7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/outline.js\":\"c9e1bdce5903da61\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/properties.js\":\"7e50da4d237b31d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/refs.js\":\"1673ba015dd5cc5e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b517fd1bf239b50b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/search.js\":\"ec5fdbf9830cd6ce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/shared.js\":\"c0fe600252fcb83d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"cedbbe65f74d0ee8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/text.js\":\"d853ce29b51ef4db\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentWrites.js\":\"15f93e477bdd8da6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/authoringCatalog.js\":\"ba17e7048414c5c2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/blockRefTargets.js\":\"d063b81983855a94\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridge.js\":\"a304d3a218e8740d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridgeLoop.js\":\"69739fbbd8732546\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/changeHistory.js\":\"7710ae2d6cab7f0f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commands.js\":\"dff88f591137bc50\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commentsCommands.js\":\"3e733be2459bc3ba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataExtension.js\":\"928e60df11153d9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataModelGuide.js\":\"08ef22fe969dda20\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dayPropertyInputs.js\":\"433f29afddfead40\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/describeRuntime.js\":\"d3ba9abe81287235\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/extensionLint.js\":\"c897723549b69249\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/grainAudit.js\":\"1190e3459f82e1a4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/healthCommand.js\":\"4a6a3f88e62c5c4d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/index.js\":\"81bef59f3b9295b4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/presetIdentity.js\":\"f77832561ca5a2f7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"fdb6b6b54d4d0166\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/readMedia.js\":\"d81e7bb04c8a936c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/schema.js\":\"fffd4d0a42113732\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/serialization.js\":\"05c80312c4e6fec8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/targets.js\":\"f36644fc36d0a38f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/tokens.js\":\"2ceb85b85152fa24\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/watchEvents.js\":\"53ecec8953693183\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/workspaceGuard.js\":\"10ddef929d6bf396\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/writeCommands.js\":\"2663e3acbedfe3e6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/AliasCollisionToast.js\":\"e0d5e5a1b431640c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/DuplicateNameBanner.js\":\"915cb2f4e93d63ec\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/collisionMerge.js\":\"93ae2b0546a49516\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/dataExtension.js\":\"e12c450f5869cc23\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/index.js\":\"52d792907bdaf04f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/mergeCollisionAction.js\":\"058f5cfa839a08c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/pageStyling.js\":\"6c235f676c97d994\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/rejectionToast.js\":\"3953c96df6f486a6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/syncProcessor.js\":\"711acf7178bcdf74\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/actions.js\":\"5ee867d30da7537e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/addComment.js\":\"98ddf72a17f71d00\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchor.js\":\"d5dafd1ac55fa1aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchorState.js\":\"340fe99d8a9aac55\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/commentLinks.js\":\"0cfbe27dd554e637\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/confirmThreadDeletion.js\":\"ca5820a1c3dd55f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/container.js\":\"f41efa0110c1450b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/dataExtension.js\":\"3e2fc2614a8628eb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/deleteComment.js\":\"d3dba1a21f745d22\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/highlights.js\":\"0d0d668f8882d546\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/index.js\":\"056d43d0535461cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/linkedCommentsPill.js\":\"9498ee94f5e80d10\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/margin.js\":\"5703930610636809\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginAnchorLinks.js\":\"ec8cb3fa9f758fa9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginSchema.js\":\"3d800fcb80932ccc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/newComment.js\":\"52c1f3396b2b5ff2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ownThreadPicker.js\":\"c1ab271ddafdb3f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/placement.js\":\"ead35a690459405d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/queries.js\":\"a3532bc7edd8bac1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotePosition.js\":\"c3e7d93a4c32cb49\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedIn.js\":\"22a3e5404f2a78af\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedRange.js\":\"180e007f3c36bf8c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/rangeRefs.js\":\"32630c638bc74d46\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readHighlights.js\":\"4bee8db550d4f4e5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelection.js\":\"251c8206d4a610e5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelectionUi.js\":\"e0e879f84e1b76db\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/reanchor.js\":\"132c50f1d6708254\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/schema.js\":\"3514cc749b061f44\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scope.js\":\"9bab087bce719f58\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scopeThreads.js\":\"c9ac825567fba60c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/splitRetarget.js\":\"d18684526af54f14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestionCard.js\":\"fddbb3bcde90f640\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestions.js\":\"c7fa5514115eb0b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaries.js\":\"b262c88b85b446e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaryBatch.js\":\"c59efabb071807da\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/surface.js\":\"955ebc460d074723\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threadNavigation.js\":\"199c073e5be746a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threads.js\":\"29d26858b67be7c2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ui.js\":\"97d9983e6bacd742\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/uiStore.js\":\"680670ad7b1b31d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/appIntents.js\":\"8a1cfd44db6f0538\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/index.js\":\"e5084ce3dc793ee0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/index.js\":\"dbf09d25fe1671e5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/status.js\":\"fab10d233dd3e21f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ec8d0d9c8dd17013\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaBlockRenderer.js\":\"bac9d2895da8eba5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaDownLaneReplicator.js\":\"dad34f922ec512e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaUploadReconciler.js\":\"27c8ce8a08e0d368\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetDownLane.js\":\"b6b0f78ee8531545\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetResolver.js\":\"616408588ebc7c3e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetUpload.js\":\"d0a4d2e4775eda95\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/attachmentCleanerIO.js\":\"2dc88c00d69479bc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5a1a9539ba5ebb5d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/blobStore.js\":\"8cd5851a0bebf09b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/browserMedia.js\":\"f61e75ce8fdcde2d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/byteStore.js\":\"87a181921e4da44e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanerIO.js\":\"b392bedc7ec9db5c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanupAttachments.js\":\"4f449e7f79f6f933\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/dataExtension.js\":\"762f72f623170990\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/downLane.js\":\"09166e71b2dfaf3c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/index.js\":\"6768b7cfb7132f91\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/insertImageContribution.js\":\"f95c8dfb678ba1cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneArming.js\":\"29df7f3f740da70b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneLock.js\":\"7419314ff4df961d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaBlock.js\":\"aad9b0c8c7841ad4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaCapture.js\":\"149d08ba29dc798f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaLanes.js\":\"e6911942552514b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewers.js\":\"0a0dbe5b5cf488e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewersFacet.js\":\"9dae7709a5fe7eaf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/pasteCapture.js\":\"00ffdf4d3ee08bd2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/resolver.js\":\"2e02ef04cfab4b46\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/retryUploadsAction.js\":\"3cffe3fa3929b82d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/storagePaths.js\":\"c57416d315f65783\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadDrain.js\":\"365b91749f0d846e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadLaneStatus.js\":\"524e8711b9700656\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadReconcile.js\":\"dad99a4f84e1b5cb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadRecovery.js\":\"6a2b48f63ceec156\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadStore.js\":\"e2e35084be84de16\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/useAssetObjectUrl.js\":\"9d990a867169b666\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"220a606424318de7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c68d2cc36cebf718\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/facet.js\":\"fab8640189f619e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/index.js\":\"58dd85a5be9825aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/prop.js\":\"6b20a9a156546f4c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinkFilters.js\":\"54c462077cb593c4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1c2a4891fad6c134\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BlockEntry.js\":\"f08581be0fe0d024\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/LinkedReferences.js\":\"6bae226d4c821d45\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e74afd7fda2ee62b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dailyNoteDefaults.js\":\"91406988c4e864f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dataExtension.js\":\"33f03f0bbc39055a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/edgeExclusions.js\":\"807d51221e27b47d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/filterProperty.js\":\"4f965ad41650f97b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/index.js\":\"1b20b47607499416\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c4f3eb0f44183d14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/applies.js\":\"03ef5a8e6fd26f42\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/countQuery.js\":\"7341a443fea76e35\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/expansionStore.js\":\"fceffca544aa3af5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/index.js\":\"30f7f5810df6f2c1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b0780cbfd69b53a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/presentationInvalidation.js\":\"42cbc97f3e33dce9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyEditorOverride.js\":\"cf50250cfc1e47f6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyFilter.js\":\"8abfca6e44cddf97\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/query.js\":\"67833e59d3da2394\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/resolveFilter.js\":\"ecfb3ec582af3420\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sourceBatch.js\":\"ddbc6f8f443577f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sources.js\":\"47c31a84f8b4abf4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useBacklinks.js\":\"2cf0465fd96466e4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"dfba4987037d2ea4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayCelebration.js\":\"4305f5ee4c0cac1f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayOverlay.js\":\"eedf4c44566faf8e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/gate.js\":\"a6f3b9adc4b64009\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/index.js\":\"2b709b53f7c4f06b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/wolfTheme.js\":\"55261b436f2cde55\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/BlockDragLayer.js\":\"e894a36ca72d32a5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dragController.js\":\"b06c590dcc78daa1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dropTarget.js\":\"1960e3afba30d0df\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/index.js\":\"ce6c79eee1b82b3d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/projection.js\":\"fc36e42ab554d2cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/BlockMetaCard.js\":\"7355f8f90b24cfb9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/index.js\":\"da218d71c3c70a74\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/AddTagDialog.js\":\"fef135bba556297f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"7a77a7c437490b83\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/TagNameIssueHint.js\":\"b4ee91aa0b01a1d9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/addTagAction.js\":\"a881eec2c738886e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/appendTag.js\":\"b060299d63e69666\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/config.js\":\"a28a66986030a9b4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/dataExtension.js\":\"d6bc1d25565df23a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/index.js\":\"b4f87ab53e85b35a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/propertyEditorOverride.js\":\"e2cd10e1f3aebd6f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbList.js\":\"4a947754b609ad3d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1d7c6fea3327c244\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/Breadcrumbs.js\":\"63b8ca37b0f5bbd3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4a9ab376d0bab577\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8d807c71d6186872\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/index.js\":\"ac846e9c964aa269\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"981c8987eb7c036b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/CharacterCountItem.js\":\"c55f34ab6426a9a2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e1cee390dc91eb8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/actions.js\":\"23abbbd42e306421\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/blockType.js\":\"dacac349c9878f94\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/charCount.js\":\"7bda0cae5a0d4aac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/dataExtension.js\":\"8d2e72a71fec8c86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/index.js\":\"ff4dc9d8d57a2108\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/profiles.js\":\"315db62ef0bac6cb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/properties.js\":\"04d107e63f6a32ba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/subtree.js\":\"ce63bcf2d18d8228\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/textCounts.js\":\"595d65ec7c798741\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/colemak-keybindings/index.js\":\"4b2c1b4d108f1e0f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/CommandPalette.js\":\"36b3b8be5aca566d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/HeaderItem.js\":\"eaa21f09a940b2ea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/context.js\":\"43e28cf5ebff7454\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/index.js\":\"d2f313fc71c38fb8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/selection.js\":\"b4d27c831b154e73\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/toggleStore.js\":\"5feb1e32f0808d66\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/useCommandPaletteActions.js\":\"c419a6d5a6493007\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ContributorBadges.js\":\"294ae6cd7c7024f6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ProfilePicture.js\":\"e2cc625956496cfb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/author.js\":\"948c876f683bc220\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/codeMirrorExtensions.js\":\"d5892175c54f86d3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/dataExtension.js\":\"7d01a76d9ab112b3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/index.js\":\"d8dae8d6ddf233c6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/mentionAutocomplete.js\":\"beb975fb51570800\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/processor.js\":\"6b98b3ac78df967d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/profiles.js\":\"7b79bc88b64de929\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/queries.js\":\"6e2ec9c1047a17b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/schema.js\":\"8f8335ba27ac2da5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/useCommentAuthor.js\":\"3047867dacae3191\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"9b5ddf77a61b8cc5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/followOrigin.js\":\"89ea46b33e23451e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/index.js\":\"cffac3f0e868bfa1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5bb81750e0cb0a23\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"32c0ca647d83f781\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/CalendarGrid.js\":\"4f2d0c032d1b9e99\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DailyNotePicker.js\":\"983935d98a1d7a29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b340aff17d0e872d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateNavDecorator.js\":\"2b6b60b91777d440\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateScrubOverlay.js\":\"5b956282355f27dd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayPropertyControl.js\":\"8a2e6343fd3b6970\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayValueReferenceControl.js\":\"3b9e9e063b5ee61d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/HeaderItem.js\":\"7ed88a3a1edf4ff9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/ReschedulePicker.js\":\"9c9d1e16645edbc7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/SpreadDatesDialog.js\":\"bce29a177c6379b3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/actions.js\":\"ff2198959bc81e0d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/blockDateAdapter.js\":\"739dc0bf9e3f9d98\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/calendar.js\":\"63d9267dbfe91dc7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dailyNotes.js\":\"f7e8a61ef87c7ca3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dataExtension.js\":\"358f3e68916b5278\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubActions.js\":\"149b5abc641b8b35\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGesture.js\":\"6de193327c743d23\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c5585a1a98bd5af7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubRecognizer.js\":\"dcebf980c5727145\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayProperty.js\":\"3308c6d9e95c4d1f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"65c13a2db7b04598\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/deletionGuard.js\":\"bc7560c291ad01de\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dueQuery.js\":\"a758031c478c83f8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/index.js\":\"ecf3586f346ed19c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/landing.js\":\"cbbb9c38c9de70bb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/localSchema.js\":\"f9d9ed80718d6808\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/referenceDateAdapter.js\":\"5f59620850a14409\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/rescheduleAction.js\":\"5fbbc76e71e0fbd2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/schema.js\":\"ecf65163e07e185d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadBlockDates.js\":\"09825403e7f76ccf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadDatesAction.js\":\"c4e0d2f0726ed2b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/today.js\":\"990b33c9ff0fa495\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"0fdfd047b0fc815f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d6f5f066c11d1b20\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/audit.js\":\"fa178d192081070f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditAction.js\":\"71f02971ea776260\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditRanges.js\":\"8c4857d166f628f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/diagnosticsSource.js\":\"8cc08dc8c078b415\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/divergenceScan.js\":\"c0ed13a8473e6bfa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/index.js\":\"10ca3b26c7863f70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8ddbbd3380d6de1f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/referencesMirror.js\":\"450d7ceaae4d2e70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/rowJson.js\":\"1e55470de7ab84a2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/schedule.js\":\"2f92f59058ea9dfa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/store.js\":\"34b83fc963271cb9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/action.js\":\"4d0c6f3d645a55e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/index.js\":\"b3610a44af7ee9b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/plugin.js\":\"43ed4b87d4ca9a2c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"df51c94d456a4c21\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/actions.js\":\"410330393b63751c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/changeMarker.js\":\"9af65ba501aa55d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/diagnostics.js\":\"29079a65626d1760\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/fileSystemAccess.js\":\"6a3c923e3fe5e7b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/filenames.js\":\"1de419819275b92c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/index.js\":\"4d1796ebe8aa02e7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/mirror.js\":\"42bd9fb71e96cd86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runLock.js\":\"c11882019733a9fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runtimeHealth.js\":\"f98fc2137b96e596\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/schedule.js\":\"632b8cdfb5d82c3b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/store.js\":\"3014637d56613579\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/index.js\":\"19a7cf550e659e34\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/themes.js\":\"42567f8b4cd615e0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/facet.js\":\"d26496a176a937b3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/useDiagnostics.js\":\"2de00f146a58160c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/dismissals.js\":\"94e5c7e3ceb86b45\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/index.js\":\"58fd5de44132ec29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/status.js\":\"4d2a48bf27d55866\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/store.js\":\"d2ae7f874077ea6c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"3a861b31e9a02cf1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2c0126ff5eb56315\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/actions.js\":\"bf32fdc1441bfcb5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/config.js\":\"5d9583bdc82732ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/dataExtension.js\":\"c69a8598284e2a32\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/effect.js\":\"6df30a85ea13986d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/index.js\":\"65f1e2076d34ba4f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/propertyEditorOverride.js\":\"1de686fed113c5f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/useToggleTree.js\":\"3f5a56ddfd4ff32a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/ExtractTypeDialog.js\":\"57edd3dd7fd4fc80\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f4aaef483730fcf6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/PropertyShapePicker.js\":\"9b0c95b7fd7ab85b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/action.js\":\"9f578271fb5f4d20\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/index.js\":\"3551d57c0c85b194\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/FindReplaceDialog.js\":\"502545b950b62ce7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/HeaderItem.js\":\"74b3234411e825d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/dataExtension.js\":\"c557065086972d16\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/index.js\":\"8541b7ce1063e344\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/search.js\":\"68dcaef4e20e5ed3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/toggleStore.js\":\"b81a65e9c1611d58\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/LocationPropertyEditor.js\":\"3f4ad07d3f6243bc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/MapView.js\":\"004d298fae2dd275\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/blockTypes.js\":\"0be72f53c9b82114\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/codeMirrorExtensions.js\":\"56a9df00560d7f43\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/createOrFindPlace.js\":\"9ca10180e1a7b579\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/currentLocation.js\":\"70f7c26d1076809f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/dataExtension.js\":\"95d62688eec7deb4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/geoContentDecorator.js\":\"a58bb5ea498a4ecc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/googlePlacesClient.js\":\"779ae1fda89cdaec\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/index.js\":\"541804b8d3259eb0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/locationsPage.js\":\"ce9b764c211946f1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/mapViewport.js\":\"72751f8fbc86d9aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/pickCurrentLocation.js\":\"2b9f6a9db3bbea44\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeAutocomplete.js\":\"5186cb7509ace0bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeNameCollision.js\":\"7d1a2cbaea10e7d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/properties.js\":\"b9f1c2d5ff1be561\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/propertyEditorOverrides.js\":\"6a19b6fb53045ad5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/query.js\":\"54f4143a3dfc3279\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/usePlaceSearch.js\":\"ba55c7a3e4ef799f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d77af32ea9b8f7fa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"32fdf2fac8108bfb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6dc356e64ecd6809\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/config.js\":\"389e92cd40b1438e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/dataExtension.js\":\"460ef2efb111717f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/facet.js\":\"bc5528eab1aa3ab3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/grouping.js\":\"e20eaaee77cc8acf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/index.js\":\"07d44bd885040f1f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4eb09bb2ca17ff9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/query.js\":\"ec3fefc569a1c27e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/resolveConfig.js\":\"0ac718d465b68f80\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"18a3e0dcdde9fce0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"11ff577f231731ba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlDocumentContent.js\":\"0a5224f99d6d27fc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlFrame.js\":\"1091b859eabd7ce1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/actions.js\":\"e5f6f5be9d90281c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/blockType.js\":\"7b124b5ddf442e74\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/confirmRunScripts.js\":\"e9a01d311da6f618\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/dataExtension.js\":\"ef991c07d36f5b5a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameAnnotations.js\":\"02f9f84724eae530\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameDocument.js\":\"45b46fdb8eba66e0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameTheme.js\":\"d2c3826bdbc7e115\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/index.js\":\"fbd057e6b0772a29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/scriptConsent.js\":\"ed29d59cae57e5c8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/sourceMap.js\":\"212b489711ef32e5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/useDocumentScripts.js\":\"44005ca565c5d873\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/index.js\":\"bdfc4c63986fce81\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/record.js\":\"d2d61d281a877391\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/recordStore.js\":\"b10c7b5f15fc223b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/responsiveness.js\":\"51310f5bdf8e66f1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/schedule.js\":\"8389a34a6847ca02\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/sessionContext.js\":\"5de372bdbe6bd993\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"409e2bce3b0b5609\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"8e0e7f5901081a8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/actions.js\":\"6444d431b5abf8cb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/config.js\":\"c50e1e53410cab5a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/dataExtension.js\":\"16f30bd2b02d159c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/effect.js\":\"269a4dffc3aabcc6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/index.js\":\"b9bf09b1d95fd8ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/keyCapture.js\":\"e8bc0aeffe8e1144\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/overrideStore.js\":\"58f1b7b00382440e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"0e0072e7f0641ad5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/HeaderItem.js\":\"e6fa7f9cb5f4cf62\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/LeftSidebar.js\":\"fca6638bbd6c6bf7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/actions.js\":\"b42edb471fcd1849\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/facet.js\":\"80bc12e0033fb9f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/index.js\":\"0cc28844df38325a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/shortcuts.js\":\"1f45e06609770da5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/toggleStore.js\":\"e1a3161831228c6b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/MergePicker.js\":\"cd285992ccc30d52\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/index.js\":\"ee8f630e1e2a0c16\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/mergeAction.js\":\"cbd4bf7e2b614f17\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/strategy.js\":\"5d5c7070fd21721f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/Button.js\":\"db7df2b86bb750cc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a7d1babf55997ead\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e495e9e657235837\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/facet.js\":\"b4fc9a036ec1aa8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/index.js\":\"8412c3b139ac141d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d1045bf0792ed22c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/actions.js\":\"1dcfda1da2730a1c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"775639e9ddee6442\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9407b5ba9722576b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/index.js\":\"9c784f52004cbd59\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6cd19c09a8716d3c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/blockSubtreeMembership.js\":\"d52194d597e1e84d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/contextMenuItem.js\":\"f197ed4344d282e3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/index.js\":\"62159ca11bb54536\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveAction.js\":\"3de92476f09472f4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveBlocks.js\":\"dee0a0c70cfc0dfb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/selectionAfterMove.js\":\"ee1febd87a5fa8b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/TutorialBanner.js\":\"684f26bd072fb437\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/action.js\":\"298010fe72a61be6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/bannerDismissal.js\":\"9739ed346b9d2070\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/documents/cheatSheet.js\":\"8a09463c0c7bb09d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/index.js\":\"374a8e75ae797358\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/keys.js\":\"0ac2b8317cd86cf7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/landing.js\":\"58fc83378cd48243\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/outline.js\":\"44a5d213c7dbc542\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/seed.js\":\"b2fe0bc8dee43dea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/PerfTrendDialog.js\":\"acbcd5a20f3f5a18\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/analyze.js\":\"d8c8017fdda06f43\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/diagnosticsSource.js\":\"30cc48080b914810\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/index.js\":\"98969d2beb492681\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/load.js\":\"e40a359ca904fdf6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/monitorRun.js\":\"8e3f506300dbd9f8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/schedule.js\":\"9653efbd7489e75a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/series.js\":\"959fbcb2e3a29b0c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/store.js\":\"4b4dec8aa6a5756d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/trendAction.js\":\"78b0329d2d919ae3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/verdict.js\":\"e6780100b221f79b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/clickToEditAction.js\":\"aa0d48b58b193e7c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/index.js\":\"daaab96cfbafd9c3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/interactions.js\":\"73af000af6a025ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"bfee566ff8099e48\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGate.js\":\"94d9e9ba0ca74a41\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGateDialog.js\":\"39b3a4f886c3b9d3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/action.js\":\"6247c6d725a35853\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/index.js\":\"a0cfff21e6ece31b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/localRunMessage.js\":\"298df47fbaf7bb69\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/plugin.js\":\"c14568fd17be1efc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/progressReport.js\":\"5255f1aa6ebefb46\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/sweepProgress.js\":\"8cbbd44e09d70e69\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/FieldRowRenderer.js\":\"6ba73853dede6e8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/ValueRowRenderer.js\":\"ae8f858fd8a9c8a4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/actions.js\":\"976a11a0b712b2c6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/autocomplete.js\":\"674b7822671daf6a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/fieldRow.js\":\"e7415e03992715b8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/index.js\":\"c001633a664bd2cb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/referenceWarning.js\":\"a2ee49ef83975c39\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueAutocomplete.js\":\"7951522f54ef88b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueSchema.js\":\"8690b0a25a03f164\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/HeaderItem.js\":\"14889ea03e306f4c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/QuickFind.js\":\"8d56380fe8d7de9f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/index.js\":\"0d8a581ab8bf7f4e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/recents.js\":\"f7ecf4eb1c395d6d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/resultItems.js\":\"a9d9b06d117e12ca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/selection.js\":\"e9b743339ecccaf0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/toggleStore.js\":\"846c7969ce7fb70f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/HeaderItem.js\":\"f9d7f6d65259e694\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/RecentsPageBlockRenderer.js\":\"37675856489a9d3d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/grouping.js\":\"c7ff6024a71defbc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/index.js\":\"f626b36a8d2c8b1b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/target.js\":\"301b020286ebf7ba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/codeMirrorExtensions.js\":\"9d74b90d4341f454\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/contentPrefill.js\":\"7b4c7c90d0154153\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/dataExtension.js\":\"c7a9a181a5b7aeb9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/index.js\":\"a4a472c27baa036e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cc2f5a349b420501\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/invalidation.js\":\"9529e524bb2bb55c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/localSchema.js\":\"bfc8b6a1bb575c07\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/index.js\":\"b694d6902d42f40d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0d8e3e303f611deb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/index.js\":\"2113ae8e6b4d2a72\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/referenceNode.js\":\"e1d0263a520bc36d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b978ad6fbe023f91\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ca366d14e4be1bef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/index.js\":\"d5e15b152d0e853d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8023597970ca7e1b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"8d665d93a9521da0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/mergeRetargetProcessor.js\":\"2f5d29d1c4b82bce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/parseFence.js\":\"769f1f59f77dab33\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceParser.js\":\"2841a8ee8057c295\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceProjection.js\":\"eab3218a138e1a5c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referencesProcessor.js\":\"a327bdbb909c62f8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/renameProcessor.js\":\"bae6cc2673e63e7c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/spanReplacement.js\":\"c0526382af45cfe7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/htmlToOutline.js\":\"cdfc6de93e58828f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/index.js\":\"8bc0f60b5bb184e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f6795eea41b7ab4c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/pasteDecision.js\":\"9e7556079c4e155d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/action.js\":\"c15369af2e1c93a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/blockIds.js\":\"8269a3244ea95228\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/content.js\":\"535e831141b926e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/effect.js\":\"9111ad4e69e08a56\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/ids.js\":\"984c14a9b1fabc31\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/import.js\":\"fdbb58e588d77e86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/index.js\":\"49e9372b989bcd21\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plan.js\":\"4f99e531a2d56465\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plugin.js\":\"c84628aee9b4e2e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/promotion.js\":\"03e0cd607ed098db\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/properties.js\":\"14e47c1eb9305e0f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/references.js\":\"e5af033a8ceb48bb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/report.js\":\"b8eef3e098ae9f5e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/roamMemo.js\":\"1675199f6d55108e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/runtime.js\":\"01de12ee22870dc1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/schemaReconciliation.js\":\"7a424eafd6ae19d1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/srsMarkers.js\":\"3ca0f19c490e1765\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/todo.js\":\"6f27bbe3773467b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/typeCandidates.js\":\"9184f8ba44a0c58a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/types.js\":\"902437e2e2b893ee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/index.js\":\"edcc8de9d253f8aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/store.js\":\"956406fa9dee8bab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/HeaderItem.js\":\"e0e882fc08eea1a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3f03eedc03d54849\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/index.js\":\"e5026ccd9f1f8d21\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/model.js\":\"c366b4339a0ca7bf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/toggleStore.js\":\"741b035d446238ce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/useKeyInspector.js\":\"05dca77a517e3d5d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e7e5cd21ef26f074\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/ShellDecorator.js\":\"8a0b142af55b5be5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/actions.js\":\"b8622148976e04d4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4036a3739961d7a5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/index.js\":\"49c9ddcdfa7cd0ac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/shell.js\":\"283f93ce1d0a960f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/surface.js\":\"521fa7dac35a03d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/walker.js\":\"e150173c529789f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/RescheduleToast.js\":\"19064da56e51a97b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/dataExtension.js\":\"572ad9a9e656d4b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/index.js\":\"3a78488935e23990\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/indicator.js\":\"dd5bab5d5fdbc2ab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/moveSrsState.js\":\"0447678d1c8a0943\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"74a8540deab6b0ae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/scheduler.js\":\"599ea10546e01168\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/schema.js\":\"033b4f6165a5c169\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"126864438c68e586\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsClipboard.js\":\"8ef3493a003bcafd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"fc24f7833e88b340\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DailyNoteReviewHint.js\":\"f0609526c05c94f1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DeckPicker.js\":\"29ded5a11ed72791\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewControls.js\":\"4df10a48ff976246\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0364c04e990d24f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewSession.js\":\"38cad56e4bfd74a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/actions.js\":\"a9168a9bebe9ee5b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/archive.js\":\"d05c861ca3d7bb06\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dataExtension.js\":\"12229d48b8b08c54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/deck.js\":\"b3842e2fc0ae95de\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dueQuery.js\":\"03d7f283ef2d3903\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/gradeDecision.js\":\"476b85ad1dc2b81e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/index.js\":\"ed3c33a200e2d268\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/keyHints.js\":\"afb9591e3a4759ba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewCardLayout.js\":\"14ef4d7c840465ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewProgress.js\":\"0b83e30450a41139\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/schema.js\":\"a07350ed2ef266cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/useDueCards.js\":\"dc5314b02c912601\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/index.js\":\"6775cbca8599e725\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/record.js\":\"5a09523dc95bf1cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/index.js\":\"05d2ec746b4dd022\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/persistenceStatus.js\":\"2ad55df55349b37f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/requestAction.js\":\"ca30319b154cf56e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/TypeChipsDecorator.js\":\"463a99164a470891\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/codeMirrorExtensions.js\":\"c8ce9e036528c481\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/index.js\":\"6cea0454fbfe7c98\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/typeAutocomplete.js\":\"d285735197ca5ecf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ebd36c0f9bcf1ea0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/actions.js\":\"1b84f17f9e5bdbbb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/anchor.js\":\"01edb06c33f674ea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/events.js\":\"8dcdfdd74e3e1e7e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/gestureActions.js\":\"6d5c5815b691a944\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/index.js\":\"70ee749b2b47cda6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"21bd6baee8a15f5e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/collect.js\":\"cb0b54df1fec7d83\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/index.js\":\"d0685fe7c8efe60f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/record.js\":\"7315457b1bc21950\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/RejectionDialog.js\":\"4d20c3524568e1f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/SystemStatusHeaderItem.js\":\"6cdc720b593c57d3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/index.js\":\"93f88f7a4a18face\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/model.js\":\"875712009538ccff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/queueCounts.js\":\"2d076e5c8d8ac4f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rejectedHelpers.js\":\"3d9efea15be15157\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rematerializeAction.js\":\"9731169d26816a37\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/useHysteresis.js\":\"6875849be7b034d9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/ColumnHeaders.js\":\"6cd6bdd34f45eddc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/QueryUi.js\":\"3143a65d482448bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/TableLayout.js\":\"70accbe1eb86b8bb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/actions.js\":\"0b3341eb9b84cfde\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/cellEdits.js\":\"5af8f1b79fc53d9a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/childrenViews.js\":\"8bafbc8ce577ad11\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/columns.js\":\"c7b2f6e3fa1c4cc1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/controller.js\":\"cad984393844a021\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/convert.js\":\"80854d59c3acc2d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/dataExtension.js\":\"0df52f3e2904fab3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/index.js\":\"4c84ecd2b06ce051\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/keys.js\":\"7c068120c374c056\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/model.js\":\"ac19477e2346ce77\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/QueryText.js\":\"9ccc8ba5e9e3fa64\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/backfill.js\":\"d54d799cd48c3d14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/completion.js\":\"7da98a57209b54fc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/format.js\":\"d17447ac2c589842\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/parse.js\":\"4fce1e18068c4dff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/queryValue.js\":\"6eb56d32f701fce4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/registrations.js\":\"8cd33ae8fd23da65\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/source.js\":\"e85fbd14bcd451cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/registry.js\":\"d14a7231426f8210\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowGutter.js\":\"9d00a41b683b2390\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowVerbs.js\":\"3a6f5649aba91fc5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/schema.js\":\"0b62698230010092\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/sort.js\":\"bf6fb794750ed3c2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/effect.js\":\"e82752845ab35610\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/index.js\":\"d23c935ba9f4d04b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/theme.js\":\"849ba71bfac3ccbf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/actions.js\":\"4c52bcffd4357638\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/dataExtension.js\":\"c3f2791bc7d5a0ec\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/index.js\":\"0c7c4080825831d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/schema.js\":\"dbe9392f463529c6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/TouchSelectionLayer.js\":\"2039a29079dcde99\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/actions.js\":\"5ac4a661e13f5d29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/defaultItems.js\":\"c1fff6c5a236a762\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/facet.js\":\"71d1e0445f9208ba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/holdRecognizer.js\":\"718f2938c4285b0e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/index.js\":\"2cbea50268e4aaff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/UpdateIndicator.js\":\"48b8dd8f72d4aec5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/index.js\":\"afbaf596d0f87ae3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/loadTimes.js\":\"83c0d58579bece79\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoNotesRenderer.js\":\"077cd02fe95d706a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoPlayerRenderer.js\":\"c8ea2fc1385bcd06\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoTimeStamp.js\":\"0eb1d4e11721e397\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/actions.js\":\"8acd3408b5db954d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/index.js\":\"7c504e8a2b5593f7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/markdown.js\":\"7c5bc6549df5a5a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/notes.js\":\"4c255a0a59422bae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/registry.js\":\"f4e83acd24e2a1e2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/remark-timestamps.js\":\"4f6365aaef541a2f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/view.js\":\"449cad58f5da15aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/LinkHints.js\":\"07c37b5d7efb2561\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/index.js\":\"c070c8f6cbf81e59\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/model.js\":\"e829fec2b5bb2d6f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/settings.js\":\"ee80e4d2844ed064\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/actions.js\":\"768c3defe81a6c9d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/index.js\":\"56eae0360849ed7b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/interactions.js\":\"ebadeb5fd8d7e1fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/workspace-header/index.js\":\"82e8641a3e4f2bdf\",\"/knowledge-medium/pr-preview/pr-1912/src/registerServiceWorker.js\":\"20412ef9333ead18\",\"/knowledge-medium/pr-preview/pr-1912/src/requestPersistentStorage.js\":\"b3eefed2bb8e5642\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authRequestDeadline.js\":\"805728cdc59a4081\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authStorage.js\":\"de326b990bed6fba\",\"/knowledge-medium/pr-preview/pr-1912/src/services/powersync.js\":\"3aaa83ce306154b3\",\"/knowledge-medium/pr-preview/pr-1912/src/services/supabase.js\":\"76c3078751fa147e\",\"/knowledge-medium/pr-preview/pr-1912/src/services/uploadErrorClassifier.js\":\"07511379dfc10f04\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/ActiveContexts.js\":\"08c910183b57a3f4\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/HotkeyReconciler.js\":\"9ed7529edf31dd84\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/WipeLocalDataDialog.js\":\"b5ff72f48e47bef6\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionDispatch.js\":\"cbbf81a87a5ac81f\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionRefItems.js\":\"2bfbf76f1af277d4\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/applyKeybindingOverrides.js\":\"9a64208ef06b7a4e\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockActions.js\":\"23bcd6ff49bac638\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockMergeGesture.js\":\"9fa614bd7724bfba\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/canonicalizeChord.js\":\"b1348df3e74ae921\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultContexts.js\":\"b11deefe181d16e2\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultShortcuts.js\":\"d9b96cafdb7a43ea\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/effectiveActions.js\":\"cacd8806aa200fce\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureAction.js\":\"608b0e8e99822b5d\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureBinding.js\":\"9cf1a355c789dc21\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/holdRegistry.js\":\"e76ebf2d37aa9e05\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingConflicts.js\":\"eb37cee2c4455397\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingOverrides.js\":\"fe95c4f67c4c4be5\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/pointerAction.js\":\"3d3058f85e6749f5\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/resolve.js\":\"e2eaf4dca2f5606a\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/runAction.js\":\"de643959ed5a76ed\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/sequenceMatcher.js\":\"66e9e3fbf283d5ae\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/types.js\":\"e37a9adf6939b4f6\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionContext.js\":\"0060bebf80d551c3\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionDiscovery.js\":\"f5419e50ee757f8a\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/utils.js\":\"eb8e22fd7855ac48\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/bootStore.js\":\"a777a90b6ef1f09b\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/previewDatabases.js\":\"095dbe2318175d35\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/byteTransform.js\":\"b2b55337d987b825\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/attachmentCleaner.js\":\"6f1b0625c1f3b2b6\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/attachmentParts.js\":\"2d5c0fa32483420c\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleParts.js\":\"300cd4c287ad5a4b\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleRecord.js\":\"740e11139f559960\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/manifest.js\":\"12362d16c77ecf4f\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/takeBundle.js\":\"e8087456355b3b44\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/verifyBundle.js\":\"e3bb174847eddb45\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/cleaningStage.js\":\"b064a6eb5dc20de3\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionKey.js\":\"c35d5bb9146b8930\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionServer.js\":\"8d8f53830584937f\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flip.js\":\"198b6bc0e6e126ae\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flipAttempts.js\":\"d026b16ed3972d40\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/pages.js\":\"b38edc9623bd57b9\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/preflight.js\":\"ffff983dceac5c6e\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/reseal.js\":\"6b807514ca703c34\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runConversion.js\":\"01a4ba15e53d1db2\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runLock.js\":\"51b8b8d3071d488d\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealing.js\":\"e5a22ab80c618beb\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealingStage.js\":\"01d9232a2eb979fd\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/stage.js\":\"c82f86fffb0631e2\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/verifyReseal.js\":\"83e1dc6fe9accf54\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aad.js\":\"1e32ba39de437469\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aead.js\":\"9374e1e3dda390e9\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base32.js\":\"9ddc0d7da2d6891d\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base64url.js\":\"869edfd85bea96f5\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/binaryEnvelope.js\":\"5fbd8f3b1b75f3f8\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/byteAead.js\":\"3bbcf536c7943aec\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/canary.js\":\"047870d47c4aa1b1\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentHash.js\":\"1099bb30db23d492\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentKey.js\":\"4b6adb680311aa9d\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/derivedIdNamespace.js\":\"239a728acb5b5ce0\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/envelope.js\":\"4ab6c755f015ae47\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/hex.js\":\"578bd658b40e3771\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/sha256Hex.js\":\"3caa3bb4e98effd3\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/workspaceKey.js\":\"baa4fb5ce17baf49\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/conversionState.js\":\"9b5d2d3c81a0d693\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6d59e53c3894aa50\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/pastedKey.js\":\"c208bc2ca9975243\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4fc963a8028d12f9\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/upgradeWorkspacePin.js\":\"788fedcc97c4fa4e\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/keyStore.js\":\"2baf07e035ed72f3\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/mintWorkspaceKey.js\":\"d6f70e3082505a3e\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/modePin.js\":\"afa9dee503c5a0bf\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/openWorkspaceKeys.js\":\"9cce40b059cb79c0\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolveWorkspaceEntry.js\":\"9e7bf7d994e062e6\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolver.js\":\"79b19074fd6c8fe3\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/workspaceAccess.js\":\"dc681b91bf48b01f\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/transform.js\":\"ef5e2d763a5af874\",\"/knowledge-medium/pr-preview/pr-1912/src/themeBootDefaults.js\":\"3acfd76384149ff3\",\"/knowledge-medium/pr-preview/pr-1912/src/types.js\":\"09ea6880d76e9366\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/ClientLocalSettings.js\":\"d46a13c018cee9c4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/abortableSleep.js\":\"5573729577798662\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/array.js\":\"b64b7e9be8d9ad4f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/backlinkAutocomplete.js\":\"b3f021170b5bd187\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockCrumbs.js\":\"b7e114f4365e42d8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockrefAutocomplete.js\":\"62e0620336ea6fdb\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/cadencedIdleJob.js\":\"325b4faf29742cf9\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/callbackSet.js\":\"3e04b2b896dce1b9\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/clientId.js\":\"57085b6fa52648e8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirror.js\":\"26de69dcd14e8a78\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirrorCompletion.js\":\"97d0ae4e39f2c57b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/copy.js\":\"3e2ecbf3ad33299b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dailyPage.js\":\"6aafcb812c9b7c29\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensics.js\":\"4b0beb5c068b81c6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensicsHooks.js\":\"632e69d2daa58c3d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/deleteBlockThroughUi.js\":\"9fffc63f9cddb351\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dialogs.js\":\"1d5171e33ddf5574\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dom.js\":\"bf3f37e09d1eaefa\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/downloadBlob.js\":\"8941b28b0cc35692\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/drawnWalk.js\":\"467c164d500a265a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/exportSqliteDb.js\":\"8e08577c3a604386\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fileSystemAccess.js\":\"5008748f5bc5675b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/flipSlide.js\":\"8693fb6e8b43ef18\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fnv1a.js\":\"864e0cdc9ae3dae5\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/formatBytes.js\":\"f4585c0df7568023\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fuzzyRank.js\":\"60e4b1dae42b954d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idbKeyedStore.js\":\"5cbc4f83abbe6351\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idleCallbackPolyfill.js\":\"6794c51470fc93ea\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardAwareScroll.js\":\"f760a2c8c29010b0\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardViewport.js\":\"01d7a00cbe980998\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/lastWorkspace.js\":\"1ba79d51d3e5330c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutColumns.js\":\"10d0437529cbbf20\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionDom.js\":\"ae8bbf0ed8c334ce\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionId.js\":\"205890af187ce210\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkClickGestures.js\":\"d904a53ec2321b1c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkTargetAutocomplete.js\":\"d2b340929b5cdf94\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbCorruption.js\":\"4f8ab5ad5301d5de\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbRecovery.js\":\"5d72507cb3bea7e5\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/markdownParser.js\":\"a5e8abebc1f56ee3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/memoize.js\":\"da533710dbf39263\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameFieldCommit.js\":\"0398a549ecb3ba7f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameList.js\":\"6fb5c36a6f5021cc\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/navigation.js\":\"f7f28d3275856d07\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/omnilinerNamespace.js\":\"89944f917e817f42\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/opfsPageScan.js\":\"997b4a0493bf0de8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelClearance.js\":\"eac3d44f4fa9e005\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelHistory.js\":\"25bfd6cebead5cfe\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLanes.js\":\"ddc0f3ba12ac7ed0\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLayoutProjection.js\":\"c9059043825fe176\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelScrollAnchor.js\":\"b25097627cc80940\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelUrlFlags.js\":\"826bcdad200a5c18\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/platform.js\":\"89a796209e1915b4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/pluralize.js\":\"34b07113a967e122\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyCreation.js\":\"3928f7bde61ac42f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyNavigation.js\":\"56de91cd18cc0394\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyValueContext.js\":\"331bb57c54e49420\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/react.js\":\"07bb17cd5a6590ec\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeDate.js\":\"c73eec66548d1a07\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeTime.js\":\"958d32014b4fb959\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/renderScope.js\":\"9aeb8777466dd72a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/resolvedThenable.js\":\"95249519eaf9b83d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/routing.js\":\"d37b0bf5d3240eb4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/safeMode.js\":\"1fb6ebd1f09d5e01\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/scheduleIdle.js\":\"9a2190e884df11ec\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/screenWakeLock.js\":\"96ab80fede33d88b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/selection.js\":\"d74b27135b90ea52\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/softKeyboardGrab.js\":\"9f02b804e23136d9\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/startupTimeline.js\":\"5737aa68f4c1c344\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/state.js\":\"2434bfecfd65aa8c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/string.js\":\"e1b04f637c68cf9d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/surfaceZoom.js\":\"e7dec2ebaa7f2825\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/time.js\":\"325a0658df0e4d17\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toast.js\":\"59bf3d46453627ec\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toggleStore.js\":\"813684ca647519b6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/untilStopped.js\":\"864da8cd9ea3c057\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/userActivity.js\":\"a2c8f11ca855a4b4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewTransition.js\":\"a269e54f40687f7c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewport.js\":\"f3749780e099d16b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/webLock.js\":\"e3abec3b0ac79a77\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceRecovery.js\":\"0c92fafcf2f5b170\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceSnapshotStore.js\":\"8ff4898130f477df\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-compiler-runtime.js\":\"61dc918fbafb2008\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-client.js\":\"0f2a34982a1f5c6f\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server-edge.js\":\"e76ae9a64408a3bf\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server.js\":\"714c8aecd42464fb\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static-edge.js\":\"c9785f1469cdbc2f\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static.js\":\"3e4b135f205c5d53\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-test-utils.js\":\"84563b7ea14a1624\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom.js\":\"4f535d9e334f4949\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-runtime.js\":\"2c0225b3e306245e\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react.js\":\"b5b6d7b08ad6d6b0\",\"/knowledge-medium/pr-preview/pr-1912/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
