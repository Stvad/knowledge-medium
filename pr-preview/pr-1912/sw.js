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
		buildId: "39766dd69d5b-589dd933",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/\":\"a4279f9294091e78\",\"/knowledge-medium/pr-preview/pr-1912/index.html\":\"a4279f9294091e78\",\"/knowledge-medium/pr-preview/pr-1912/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1912/assets/FacadeVFS-z0B0ZQDn.js\":\"d99dade86fe43df1\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSCoopSyncVFS-DoojieyI.js\":\"34f7f1cb4a56f51b\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSWriteAheadVFS-NsruLbjv.js\":\"87f5aa8e6785473d\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-4GSll1Mp.js\":\"6140e36f7dea7f67\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-BCRBXAqc.js\":\"018f6c8b2a143b45\",\"/knowledge-medium/pr-preview/pr-1912/assets/worker-BYg_2rPe.js\":\"fe9bc682b865cb6d\",\"/knowledge-medium/pr-preview/pr-1912/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1912/chunks/app-CjT-1RjE.js\":\"ee443a1393d1f751\",\"/knowledge-medium/pr-preview/pr-1912/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1912/index.js\":\"414f3b1405aca5c3\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1912/assets/AccessHandlePoolVFS-cQAAQGdG.js\":\"c4ec8efc6f0ab44e\",\"/knowledge-medium/pr-preview/pr-1912/assets/IDBBatchAtomicVFS-DdNRDtnV.js\":\"a07ba84f95d309a9\",\"/knowledge-medium/pr-preview/pr-1912/assets/MemoryVFS-Cezz5vZE.js\":\"edf30314a3479c94\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-B0dUFdPu.js\":\"eff18346372b58c8\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-CctxJKTs.js\":\"af5f140e179ca6c6\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1912/chunks/AccessHandlePoolVFS-DYkxMUry.js\":\"e8f270b6dd873e6e\",\"/knowledge-medium/pr-preview/pr-1912/chunks/FacadeVFS-Ch6pSbQd.js\":\"092f80edde618a20\",\"/knowledge-medium/pr-preview/pr-1912/chunks/IDBBatchAtomicVFS-BKf9mJTF.js\":\"6cc3a5641ab96edc\",\"/knowledge-medium/pr-preview/pr-1912/chunks/MemoryVFS-CjZ-AuFA.js\":\"88b3aa7657bfde33\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSCoopSyncVFS-4zLFD-kX.js\":\"00ed82a98fb5ee8a\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSWriteAheadVFS-B8OtuXfL.js\":\"53cb1bb19e5ba22a\",\"/knowledge-medium/pr-preview/pr-1912/chunks/Preview-CRIneqou.js\":\"da656d91702a5d3f\",\"/knowledge-medium/pr-preview/pr-1912/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1912/chunks/card-BqW_cQZB.js\":\"4c272eb390a02417\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-QIgPQroH.js\":\"0ae2a51733311acd\",\"/knowledge-medium/pr-preview/pr-1912/chunks/freezeExtensionImports-C9FQxqyP.js\":\"c28502e8894e0445\",\"/knowledge-medium/pr-preview/pr-1912/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1912/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-DtQKssN8.js\":\"0da7da74c69c5d72\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-async-DVbvn30X.js\":\"ba92c11e09beea44\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-CNp8hRsy.js\":\"40236826077285f4\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-Cx8bia0H.js\":\"dc10c296f8de9142\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-DShPi9JA.js\":\"e237085a1356ea2a\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-DWNzjOZT.js\":\"4104a7f00775c1da\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-Df4ODt87.js\":\"c1f1935726fde5ef\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server-legacy.browser.production-DgbMoVeW.js\":\"50c8595426157589\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.browser.production-BpJE1B2y.js\":\"7aaad53ba3e2aff2\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.edge.production-CEzcjUTg.js\":\"2208fec5beccfd57\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-jF0t_9Uz.js\":\"7e6b7d4bb1c350be\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-sO4uXhyN.js\":\"53ee66fc5f3edc65\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-scPbts-1.js\":\"596be955d3c07e14\",\"/knowledge-medium/pr-preview/pr-1912/chunks/server.browser-CYn-Nbv4.js\":\"cb5b9ef0d0bf9732\",\"/knowledge-medium/pr-preview/pr-1912/chunks/textarea-Dd37VWqI.js\":\"9240f500cba12030\",\"/knowledge-medium/pr-preview/pr-1912/chunks/ui-Y2g3kO68.js\":\"edc4cec31b34a7d7\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-DIvmIEH6.js\":\"726811a0d8d04043\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-async-DCuUfx99.js\":\"8b4ab71b9536f2e4\",\"/knowledge-medium/pr-preview/pr-1912/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1912/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/src/App.js\":\"780db0f1b89b98d5\",\"/knowledge-medium/pr-preview/pr-1912/src/appUpdate.js\":\"8219f1f1763e88c4\",\"/knowledge-medium/pr-preview/pr-1912/src/appVersion.js\":\"6f5ec3ecc188dca7\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/initialLayout.js\":\"715365c5d93f5809\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/openWorkspaceData.js\":\"b1aea4863992b377\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/resolveWorkspace.js\":\"c010327b095d499e\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/workspaceBootstrap.js\":\"0644e41d73edf618\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockComponent.js\":\"318e3f4061d2600e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockCrumbs.js\":\"6b25c45cbd175e76\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockEditor.js\":\"3330226a5e005389\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockLoadingPlaceholder.js\":\"5b14e9ac94dc8a36\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockProperties.js\":\"102dddd928da5723\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockSearchPicker.js\":\"1c113b0797049c7b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ConfirmBulkDeleteDialog.js\":\"95ddf77da9d8dd23\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DividerHandle.js\":\"15e09dd6add93f89\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DraftEditor.js\":\"56bab363881acf79\",\"/knowledge-medium/pr-preview/pr-1912/src/components/GutterPill.js\":\"7e0642b65d2c0418\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Header.js\":\"69d97ee21746bf9c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/LazyBlockComponent.js\":\"54dbf05e4cb1ae8c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Login.js\":\"3afa541f581e5080\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ZoomableSurface.js\":\"4e49838ac256128b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/editModeKeepalive.js\":\"bab8396dc845a43f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyDisplay/PropertyDisplayScope.js\":\"12218252a8b103d8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"79b1fcc16a12868d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefPropertyEditor.js\":\"d8e40d75355224bc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefTargetTypePicker.js\":\"11a1eff2fcda32cf\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/SelectPropertyEditor.js\":\"122acd66d2140a09\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/TypesPropertyEditor.js\":\"5c627bd394f924f2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/defaults.js\":\"3fadd43d64dcafc7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/kernelValuePresets.js\":\"77f8f98874559420\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/selectablePresets.js\":\"8f7d0145769c18d4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/typesPropertyUi.js\":\"dd9a011ef35c01f0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/AddPropertyForm.js\":\"bde638d9a41280f6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyPicker.js\":\"d83dac867cfe51e7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyRow.js\":\"38a9c9e144adce37\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/Rows.js\":\"7d54039c1fcc77ac\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/actions.js\":\"a4f4a2310571f96f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/declarationOnly.js\":\"1e103c999dfe0c9a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/layout.js\":\"e0e4d61b78790337\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/model.js\":\"08fa2c7a0254c6ee\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapeUi.js\":\"6a1d18a1d1648d7e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapes.js\":\"cb8c7d1520652b29\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9ac39254a06237b7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/visibility.js\":\"44e1483299b6a461\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanelSections.js\":\"6aaa648cdf199342\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockEmbed.js\":\"189ffaad4190db6c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockLink.js\":\"08334bf0982f8768\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockRef.js\":\"7b1032509993ee16\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/CompactReferenceLink.js\":\"715a6c32d48c6f31\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/ReferenceLink.js\":\"9f72ba09beb33bc8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuard.js\":\"bdd4983314612c01\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuardContext.js\":\"6c3644e8c03b86c4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/linkInteraction.js\":\"4f33423fad537db4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/referenceLayout.js\":\"229bcafe5862acba\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/useBlockRefAncestors.js\":\"c9cfbda8722cf24d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockGutter.js\":\"7e0f30142e58788b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockInfoDialog.js\":\"4ead060bf8e959f7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockReadText.js\":\"885964a3338465a5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockTypeBlockRenderer.js\":\"374a20cd12536f02\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BulletHoverCard.js\":\"2738deb34ade64e2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorContentRenderer.js\":\"c2c99c35731896d4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"321fda7c1a1f7b7a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ColumnResizeHandles.js\":\"bab1264303f8f0f0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"13e3a51067dea444\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/DefaultBlockRenderer.js\":\"3ad5036bde86119c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/LayoutRenderer.js\":\"818f416675475216\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MarkdownContentRenderer.js\":\"e42959bb6cb77311\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MissingDataRenderer.js\":\"b9e3acfd3d2b102a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PanelRenderer.js\":\"3bbc17b6d1f03bf8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PropertySchemaBlockRenderer.js\":\"09c7b0db4b08bd5d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/TopLevelRenderer.js\":\"2a01c5a0d24c7c2d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockGutterMode.js\":\"bfff9dff0ff26a7b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockTitleText.js\":\"e7d28d0d66f8e1b5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/fieldCreationKeydown.js\":\"9d62e29d0afd7504\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/layoutRootContext.js\":\"e49bc77bcded8102\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/TypeChip.js\":\"5b562d9e4f666bfe\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/chipStyle.js\":\"3934a2da20a8d087\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/anchored-floating.js\":\"20cb737c865b761d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/button.js\":\"3769bb5332bf1a43\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/card.js\":\"ea3800325937ae77\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/checkbox.js\":\"8d5fcf3b243c1a91\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/collapsible.js\":\"1821db6e00ae9c19\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/command.js\":\"5fc8965e8d990f50\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/context-menu.js\":\"6dbe92ea35155c22\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dialog.js\":\"c7d4eb1fd0d18ac2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dropdown-menu.js\":\"6667cff02735024e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/floating-listbox.js\":\"f46ef85323d6f4d6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/index.js\":\"938bc60df9855228\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/input.js\":\"ea94eda4d404a335\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/kbd.js\":\"0be900d4798882f2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/label.js\":\"da50dc9b73c225a7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/textarea.js\":\"2170c3da74c25570\",\"/knowledge-medium/pr-preview/pr-1912/src/components/useEditModeYieldKeepalive.js\":\"0c09a1c3474bef07\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/BootFallback.js\":\"d2d0b45b6738118c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/FocusedRowLazyMount.js\":\"931b32b209c75129\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LazyViewportMount.js\":\"64bbc55cfe9adc14\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LocalDbCorruptionFallback.js\":\"bb73489f466e4e3f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/error.js\":\"1bb827cf7c3edf43\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/lazyMountRegistry.js\":\"cf847bd77e647198\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/suspense.js\":\"7bd84d8136a27d3d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/CreateWorkspaceDialog.js\":\"7ccf8942a8c94267\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/PendingInvitations.js\":\"4e2fb33bfa18217a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/SyncProgress.js\":\"950bf6c83b02970d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/UnlockProgress.js\":\"b5e1a8d9bbe17114\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceKeyGate.js\":\"b213acc13f8505f7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSettingsDialog.js\":\"f8bd15382ea60c9c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSwitcher.js\":\"87af1288c1a6f525\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSyncGate.js\":\"618f64c9bed3fead\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlow.js\":\"b518a29bc73aa327\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlowHost.js\":\"dc251b28c70a8127\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/EncryptionSection.js\":\"a2e93e32e0bc9818\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/attachmentPrompts.js\":\"5185fc5c0487dbee\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/bundleFolderPrompts.js\":\"34f0539019c4bb7a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowDeps.js\":\"d9c50ee7e61530b0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowStore.js\":\"597a5277b9fcf2b8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/flowUi.js\":\"f58457bcded44fc2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/useConversionRun.js\":\"c63abfd05a3d76c6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/keyUi.js\":\"798989c74ab67bac\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnKeyLoss.js\":\"24be666953fae541\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnServerE2ee.js\":\"757c27aa9bd6d621\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/workspaceUnlocked.js\":\"c69a9981af529384\",\"/knowledge-medium/pr-preview/pr-1912/src/context/backgroundSubtree.js\":\"b14a1b0d6b03a097\",\"/knowledge-medium/pr-preview/pr-1912/src/context/block.js\":\"7d2234c5034609e6\",\"/knowledge-medium/pr-preview/pr-1912/src/context/layoutWsContext.js\":\"6f63fee744401b6d\",\"/knowledge-medium/pr-preview/pr-1912/src/context/propertyDisplay.js\":\"c6e600c735520550\",\"/knowledge-medium/pr-preview/pr-1912/src/context/repo.js\":\"d080fe09beff21d2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasClaim.js\":\"9f3c6d3b152836d0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasSeatNamespace.js\":\"cbbbd8f5b83bc485\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockData.js\":\"23445e6e00ad26d8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockType.js\":\"d3dbf6fd379e1a32\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/changeScope.js\":\"24786a1a0199c477\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/codecs.js\":\"7935bfc8acbe48e3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/derivedData.js\":\"be3f66c48a83ddc4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/errors.js\":\"a9c4cdae5572790e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/events.js\":\"8149ee62ca68663e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/handle.js\":\"45809d8da33a304a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/index.js\":\"29d8e0c84de460da\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/mutator.js\":\"e5094ad183242af4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/processor.js\":\"bb9835e5afd9873d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/propertySchema.js\":\"f6efb7fbe153040f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/query.js\":\"bee97c6d63169a52\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/sameTxProcessor.js\":\"a3ec350921f679ce\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/schema.js\":\"45809d8da33a304a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/tx.js\":\"45809d8da33a304a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/typedBlockQuery.js\":\"d9109fb66d0c565c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/user.js\":\"dff3e06b3219cd1c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresetCore.js\":\"ffe27a386e486988\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresets.js\":\"6999a229858a491c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/attachmentCleanerIOVerb.js\":\"4940c27c2e8be0bb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/block.js\":\"6f6e50fa95dad29c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockCache.js\":\"4921d9d94536a286\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockId.js\":\"afd9132e2d9562ab\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockLiveness.js\":\"5ca42d9348ec8409\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockMerge.js\":\"1eb7a6910403a272\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockSchema.js\":\"b88cc798c87c4b92\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypeLookup.js\":\"3b60a37e06ab8bb2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypes.js\":\"34a28b0c43cbcdbc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/childrenView.js\":\"28d0b23f9d7969fb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/clientContext.js\":\"c2b279a4f0e5861f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/dbFileSiblings.js\":\"aad0969f2e8d39c6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/definitionSeeds.js\":\"25fb87ab9fd7e5a0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/derivedIds.js\":\"52cfb8e182f80d3a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/drawnSubtree.js\":\"ddc8b522bd23c571\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facetBridge.js\":\"b9abfaa10f6e85e6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facets.js\":\"90f82f4bdc6286db\",\"/knowledge-medium/pr-preview/pr-1912/src/data/globalState.js\":\"0d9fa567cba5f114\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/aliasClaimRederiveProcessor.js\":\"83b74afe616cd545\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/ancestorBatch.js\":\"1a4e4e84ea6766f0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/blockTypeTypeifyProcessor.js\":\"e1d83fcaec54f81a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/clientSchema.js\":\"e3ec597228391fb5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/commitPipeline.js\":\"a731fbea7b0ec7c7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/devAssertions.js\":\"6c7300cef6afc8b0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/firstSync.js\":\"9a2c5414626a6786\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/freshInitialLoad.js\":\"b62633e05bf0f114\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/graphBackfillClaim.js\":\"e7f9439121e43baa\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/handleStore.js\":\"9a85e22d54fcb4de\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/idleMarkerJobs.js\":\"f211efda863621f3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initialDownload.js\":\"f8e44415f517a358\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initializeClientDatabase.js\":\"880072b862f98321\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/jsonCanonical.js\":\"d44e719232442d7e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelInvalidation.js\":\"2fe2416c2dfe6cfa\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelProcessors.js\":\"a88338d21d0236f6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelQueries.js\":\"c3101cea270fbc73\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/mergeTypeMembershipProcessor.js\":\"1c652fbc16c9c73d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/normalizeReferencesProcessor.js\":\"01bf244217f4f31e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/poolInstrumentation.js\":\"9108d960aec9be94\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/processorRunner.js\":\"7a23532102574b2c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyCellBackfill.js\":\"5ee16991db5ed88a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildMint.js\":\"560f151d93f45406\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildrenProcessor.js\":\"2b28b5c9fce2e715\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a2946bd04a41b11e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionSynthesis.js\":\"1491855793bbbe7d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyKeyScan.js\":\"e65508db56b2dc93\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertySchemaResolution.js\":\"f7f4082952c2595a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyValueEdits.js\":\"b8d6fdf93ee795fa\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/raiseProtocol.js\":\"93e6a444097e296a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/readBatch.js\":\"313488ab6fa4fac8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/refProjection.js\":\"8c3cece8b0e5bc0e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetLookups.js\":\"477d5e7e8ce6900d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetProcessor.js\":\"2828b89a209f0824\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/replayMerge.js\":\"6b2e390bf9e434a9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/sqlBinds.js\":\"049d7762e4dd02e2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c8dca9dff7f54789\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/arrivalProcessors.js\":\"dd19773a8929ad43\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/invalidate.js\":\"e8718a048e8371f3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/materialize.js\":\"6b12e1c8581d779d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/observer.js\":\"989fbd500b7d7765\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/reconcile.js\":\"52cb836c9ed9412a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/timingMetrics.js\":\"10839945e88d8da3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/treeQueries.js\":\"dd0d1396dece5e6d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txEngine.js\":\"7a92781a735f8779\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txSnapshots.js\":\"8fab3021cd27a37b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/typedBlockQuery.js\":\"af5e94086626280a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/undoManager.js\":\"fb3cdff0d95acfba\",\"/knowledge-medium/pr-preview/pr-1912/src/data/invalidation.js\":\"92b491330ef274c3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelDataExtension.js\":\"1cccec059db1379c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelPage.js\":\"02735ab72b8a9ea7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelValuePresetCores.js\":\"196a2540d9ce06ec\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbCorruptionSignal.js\":\"65d351e9363292ce\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbStorage.js\":\"7a87c3e79a4f5341\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbVfs.js\":\"3e924fc2fabca0ac\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localSchema.js\":\"50711c859032d87b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/maintenance.js\":\"1bafb5762966b5a9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mergeProperties.js\":\"484441973f5ce3a2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/metricsConsoleHook.js\":\"ead61b59440d567e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/migrationsPage.js\":\"50caf1bd5619939b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mutators.js\":\"e0082a524edae579\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKey.js\":\"11c6709c6be203af\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKeyPlacement.js\":\"748c59347c6e6af8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/outlineSurface.js\":\"91a37ae53a7004a2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingEditorContent.js\":\"372c8a1918022a6c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingUploadsSql.js\":\"92ed024c74723a98\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pluginStateExtensions.js\":\"9b1facf0625debec\",\"/knowledge-medium/pr-preview/pr-1912/src/data/powerSyncLogger.js\":\"2e161fc4ca073c6e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/projectorRuntime.js\":\"88533f98e89569cb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/properties.js\":\"40f4ba4348f6729d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertiesPage.js\":\"573fd8dfd9fcc555\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyChildren.js\":\"a125c57b5c650a73\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionFanout.js\":\"19cb5e0af285cc38\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionMetadata.js\":\"858e2a9501599e86\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionRegistry.js\":\"7d007ecf93599577\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDisplayMode.js\":\"b6024bf1b9365cc6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyRowCreation.js\":\"9fcec450a788670c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySchemaCreation.js\":\"e606979b4624b2c1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySeeds.js\":\"5fa2ef739a640c57\",\"/knowledge-medium/pr-preview/pr-1912/src/data/recentsPage.js\":\"a50db15ea4ee376f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/refTargetComparableProperty.js\":\"29b1f676dac9fc54\",\"/knowledge-medium/pr-preview/pr-1912/src/data/referenceBlock.js\":\"acf15f8f2782a07f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rejectedUploads.js\":\"1bccec7677ffa949\",\"/knowledge-medium/pr-preview/pr-1912/src/data/releasePowerSyncConnection.js\":\"2bbff1d168c111a9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repo.js\":\"c9f7b61925e991b5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repoProvider.js\":\"aff208e04549096e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rowProperty.js\":\"2be367b30dd26f4c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/searchFilter.js\":\"9ae8752031abb5ae\",\"/knowledge-medium/pr-preview/pr-1912/src/data/seedIdentityLedger.js\":\"101e5e6b3f405fc1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/stateBlocks.js\":\"913a7198c28f7e23\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralEditPolicy.js\":\"b15e7cfb3e6f6b43\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralInsert.js\":\"7e311295f5c0a76c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/subtreeDelete.js\":\"0a6fea4aa5163fc7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncStreamLock.js\":\"dec5acb889009682\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableSqlRecognizer.js\":\"65952ee773f4ac8c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableWriteGuard.js\":\"7038d190bcda968a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/targets.js\":\"9ff91ac1dceb3f86\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeColors.js\":\"beddbbf5225f7d16\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionMetadata.js\":\"2e4f1c08b50d3b7d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionRegistry.js\":\"ae42c5410f11b9ac\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeExtraction.js\":\"ab885224f0c76c16\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeInitialValues.js\":\"4daaef951ae46899\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typePropertyGroups.js\":\"9777c4c3468db10a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeSeeds.js\":\"e09231ed08e8ce3e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeTagger.js\":\"035d3e82ee7bcfa3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typedRecords.js\":\"126141d161a3b59d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typesPage.js\":\"7dc53580137c1acc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userPrefs.js\":\"c6c365e306da17f3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userSchemasService.js\":\"74849e88aca2b8eb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userTypesService.js\":\"fb10251928df043e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/valuePresetRegistry.js\":\"cce7dbe4d6f33a54\",\"/knowledge-medium/pr-preview/pr-1912/src/data/visibleChildren.js\":\"03d4351a9a70d5eb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceConversion.js\":\"57b6ad23b8cc7b6a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceFirstSync.js\":\"e48cda724f9539cf\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceIdNamespace.js\":\"91ada9e2ae39a119\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceSchema.js\":\"a6c04c01efe998ff\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaces.js\":\"5994c81765ead852\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadLog.js\":\"e4406706efc62eb9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/BlockPasteShellDecorator.js\":\"c7ff517140c36d8f\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/atTrigger.js\":\"3866722a3717547c\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/autocomplete.js\":\"4c79c9b59338b3d0\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/codeMirrorExtensions.js\":\"6ff612ccae8c6857\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/contentFlush.js\":\"55f2d6b286a5dd7b\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/defaultInteractions.js\":\"f060224cc77450f7\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/editSettleSignal.js\":\"013d4567ebd568ef\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/insertImage.js\":\"347b392611a97293\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceCompletionRange.js\":\"273967d2e46ec57b\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceTargetTypes.js\":\"67d3ff71fc7ad96d\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/syntaxContext.js\":\"152bdb374848c5b0\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/triggerMatch.js\":\"968d97f0338ba557\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/AppRuntimeProvider.js\":\"830efc9a3780bc17\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/BlockFocusShellDecorator.js\":\"8cf369fba21b9d18\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/ExtensionRenderBoundary.js\":\"0ebfb8ed11029660\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/PanelContentRecovery.js\":\"405579f7abfe1ed2\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/apiCatalog.js\":\"35426c9f87870e0c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/appRuntimeController.js\":\"b90368cb9f10863e\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/approveExtensionHere.js\":\"0efb3949b1e1e5e1\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/armedCutAppMount.js\":\"6c4ac84bcc732b11\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/batchableKeyedStore.js\":\"dbfa7436da9d8010\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockInteraction.js\":\"82e9628ba35dc36d\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockSelectionAction.js\":\"3e10e0eb659b7dc8\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compileExtensionModule.js\":\"9fa0b62e0a6a1cb5\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compiledModuleCache.js\":\"f2fb0fc9d147835b\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/continuousGestures.js\":\"2c532f47a71d2b4a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/core.js\":\"b725d0c9d0dd20bf\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/defaultRenderers.js\":\"58482ef1e60acb3c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/definitionFanoutAppMount.js\":\"114dce896c80d7a3\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dialogAppMount.js\":\"3b31a9c7a7fb000a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensionSeeds.js\":\"4d4f2899a3ece445\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensions.js\":\"4b58a64652a354ca\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/exampleExtensions.js\":\"fbe164de13c2b278\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionApprovalStatus.js\":\"02caa6ce1772406a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionImportPolicy.js\":\"85f94b14e5619ab8\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrorToast.js\":\"c076d7538de014c5\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrors.js\":\"87a148224a66b12b\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLookup.js\":\"ce5030a0a2b362c5\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionToggles.js\":\"f893630c6660abff\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionUtilitiesCss.js\":\"aca7ca2eb305f8b8\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/kernelPageDeletionGuard.js\":\"451e097eb6187d18\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/liveRuntime.js\":\"09124854421eaf9f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/normalizeExtensionSource.js\":\"9a653237e9e8610b\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/openExtensionsSettings.js\":\"477072f911730059\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/overridesCache.js\":\"2024accd210860c9\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/pluginIds.js\":\"b862cba350a77d59\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/processorRejectionToast.js\":\"89c41409394716ff\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeActions.js\":\"b42cfab5107edd70\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeContext.js\":\"a470ce9fbc699e8c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticAppExtensions.js\":\"3bb3f4566927dffc\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticDataExtensions.js\":\"9125c8e29463c778\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/toastAppMount.js\":\"1f5b1e4b48bf8d8d\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/transpileExtension.js\":\"337be9ab84eeb426\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useOverrides.js\":\"52bc436473acb179\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useShortcutSurfaceActivations.js\":\"d290812dc76b116c\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/discoverToggleTree.js\":\"22bcde9458db1016\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/facet.js\":\"13ef2470c107be47\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/resolveAppRuntime.js\":\"d12c720445bccedf\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/runtimeEvents.js\":\"c13429f20cbf413a\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/togglable.js\":\"81f4ce25ee1d98d3\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/variantFacet.js\":\"74c763ac549ebf79\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/verbFacet.js\":\"a1c015b5fcaff5bf\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/block.js\":\"990ec9e67164894e\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/focusedChild.js\":\"0016b0c15c1732aa\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/propertySchemas.js\":\"f087f3fa4567103c\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/typeRegistry.js\":\"64c2519b9d6af5f5\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAncestorCrumbs.js\":\"43b53dc1bc44318a\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAutocompleteListbox.js\":\"b9b7049e76035eb5\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedSearch.js\":\"e8f58cf00a1101b5\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedValue.js\":\"6235042c15f6dc0a\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useFacetValue.js\":\"e7f55b64ba6138c5\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsFocalRender.js\":\"dccfb67dd0517094\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsReadOnly.js\":\"ec29f6215d412ac9\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMaterializeBacklog.js\":\"67dc0abc07889348\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMinuteClock.js\":\"3df5e2e7a77cfda5\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePanelLayoutProjection.js\":\"b5f5d336c88c6de8\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePendingInvitations.js\":\"4d80854e094e54ea\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRendererRegistry.js\":\"06fccac144e62e46\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRetainedFieldRows.js\":\"951a53ed368cee5e\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useWorkspaces.js\":\"252a5b2467ac2285\",\"/knowledge-medium/pr-preview/pr-1912/src/lib/utils.js\":\"07545b615b2c0ed5\",\"/knowledge-medium/pr-preview/pr-1912/src/main.js\":\"23f7aea70a41e969\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/MarkdownImage.js\":\"d2d3e7bd8dc25c96\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/blockSeparators.js\":\"20860a7a509ee419\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/context.js\":\"02991c32890d6852\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/defaultMarkdownExtension.js\":\"1a9e92f01c1f71e4\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/extensions.js\":\"decd5665dc9caa40\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/renderMarkdownHtml.js\":\"22e9f4f0b6b451c4\",\"/knowledge-medium/pr-preview/pr-1912/src/minimal-editor.js\":\"9b830e98a048ab1f\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/armedCut.js\":\"03ffda9e475a437f\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/captureMediaVerb.js\":\"ec526428809beea7\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/clipboard.js\":\"92e9ca78aa0164c8\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/decision.js\":\"37bafca67bc8f9ab\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/operations.js\":\"f6c1ecab7c76131e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/AccountHeaderItem.js\":\"1e2fe53657bc8631\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/index.js\":\"f763b366db43f690\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"1d21f33bd82f00db\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askAgent.js\":\"c1662f1d22bdc80b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askedStore.js\":\"dc56d6a6395bc88b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6a7d0b9d248bed29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/chipState.js\":\"fd500bac9fe3ca8a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/dataExtension.js\":\"634a94969b50c4a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/index.js\":\"d7f41e2d635ba513\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e949ece07fd13c2a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/schema.js\":\"d6b5247b2c01c318\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8bda4a889b18036f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/BridgePairingDialog.js\":\"665421139872f137\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/addMedia.js\":\"9c4ec38257588b86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/backlinks.js\":\"485d917b48e6f913\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/block.js\":\"dfee09aa68cade85\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/context.js\":\"706fc9e38c15cf54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/displayIds.js\":\"942a74f0d9271705\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/index.js\":\"83a7fe563ea0737d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/outline.js\":\"fafcd362548bb5d5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/properties.js\":\"d363336768534678\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/refs.js\":\"1eab64197c465cc5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e0d939b9a3037549\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/search.js\":\"e132125dbf8b8db5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/shared.js\":\"83db66c6cf4fdf85\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"45406a40217f12a9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/text.js\":\"d90ba2308ed2eb31\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentWrites.js\":\"c65e78098eb87b7f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/authoringCatalog.js\":\"39e2c9678bd8135e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/blockRefTargets.js\":\"e2ef4d15bb96bf60\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridge.js\":\"dafbb9be56f54800\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridgeLoop.js\":\"0b640281fadd68b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/changeHistory.js\":\"e4a25241ec9d6283\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commands.js\":\"f42fa357dd6039ac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commentsCommands.js\":\"72ecfd72cf267615\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataExtension.js\":\"72428221e0e849ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataModelGuide.js\":\"4114ba7246b6aa8e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dayPropertyInputs.js\":\"00ffd6eb4ac3ffce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/describeRuntime.js\":\"4f88a6c2f23d813a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/extensionLint.js\":\"b5b2fc5b9053d2ac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/grainAudit.js\":\"cc7620b1e14b9a56\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/healthCommand.js\":\"af545110e10c7da6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/index.js\":\"52b63eb67f002229\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/presetIdentity.js\":\"2be2100b0541777d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"7e5900178773b147\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/readMedia.js\":\"9b7ccabdf0056cd2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/schema.js\":\"cf07f0df16c1d998\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/serialization.js\":\"176c3ca892039edb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/targets.js\":\"f8e5601cbafdeb38\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/tokens.js\":\"7e3b7fb030f78b50\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/watchEvents.js\":\"ded6e6f38acb6bc9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/workspaceGuard.js\":\"480a83d7d253fec2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/writeCommands.js\":\"01f56f2b7935be25\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/AliasCollisionToast.js\":\"e0a2b13ecea5bbab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/DuplicateNameBanner.js\":\"68825cbe5de6c4d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/collisionMerge.js\":\"36bafa28ec1fcf38\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/dataExtension.js\":\"61dfedef05c34c7f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/index.js\":\"aaf6014a020a8c75\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/mergeCollisionAction.js\":\"943ad8985c2cb2e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/pageStyling.js\":\"f4b860d56a14a910\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/rejectionToast.js\":\"7471f7564f72a98e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/syncProcessor.js\":\"821a285b3007a501\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/actions.js\":\"c08dac5d5e89f184\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/addComment.js\":\"f6d3f7f715f11497\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchor.js\":\"cbc1086a6f6ad501\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchorState.js\":\"ff3db2e54be728e6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/commentLinks.js\":\"afb0a2717414d578\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/confirmThreadDeletion.js\":\"1e2746461736cb80\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/container.js\":\"912cbe0c2be87e93\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/dataExtension.js\":\"bf07285129ec7452\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/deleteComment.js\":\"134f616672cf230f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/highlights.js\":\"3e501896d161ec5f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/index.js\":\"20abc62105c0cc91\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/linkedCommentsPill.js\":\"7a12f26c734b39b7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/margin.js\":\"aecad8c3d7b38a14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginAnchorLinks.js\":\"ad3087b9fc5ea4dd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginSchema.js\":\"0c706944917ffb70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/newComment.js\":\"38b3a1d29e390405\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ownThreadPicker.js\":\"b9af985dfc8ceb29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/placement.js\":\"46304388aeb9b284\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/queries.js\":\"73330886de90fb62\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotePosition.js\":\"2a5b52c52afb47ec\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedIn.js\":\"0360f4f0dd0d7e78\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedRange.js\":\"9acabcf554719c6c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/rangeRefs.js\":\"6fb0c9501f5403f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readHighlights.js\":\"d8c1868924eb0319\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelection.js\":\"5df9a40aa5ee7b66\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelectionUi.js\":\"55e06f30f93d92c0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/reanchor.js\":\"1f29ce9cac74f6fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/schema.js\":\"457b02695f4b1d3c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scope.js\":\"88f770424cc6454e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scopeThreads.js\":\"176af36567f6f81f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/splitRetarget.js\":\"0474294abff58367\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestionCard.js\":\"85d7aee4c7c66124\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestions.js\":\"3a6a2abf5c86665f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaries.js\":\"eb4571e87c78ffa8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaryBatch.js\":\"b102bbaff6b948d9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/surface.js\":\"e788922f2c525d70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threadNavigation.js\":\"cabeafa4e5f25f02\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threads.js\":\"90c439209a8db78e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ui.js\":\"f3141839f7a5743c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/uiStore.js\":\"67ef19b4a2cd4ea1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/appIntents.js\":\"37096ca8c5c54af7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/index.js\":\"b2f015caed8b1b64\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/index.js\":\"ad246298bc54028d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/status.js\":\"92a74c6774060535\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"d3cd6a7e9f67a03a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaBlockRenderer.js\":\"1ace75bcd686ea6b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8c1570df90c1403a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaUploadReconciler.js\":\"00ce3b51f0a54a03\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetDownLane.js\":\"b9dc6ba05e3bf9f6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetResolver.js\":\"bc22d5eefa32c01e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetUpload.js\":\"f9f5e05251e9c266\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/attachmentCleanerIO.js\":\"a2a536dfaa011303\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b95ca5e1e915e6a9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/blobStore.js\":\"a8c89be116dcdb37\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/browserMedia.js\":\"5080ae502ed00438\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/byteStore.js\":\"92cc125f03c0af1d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanerIO.js\":\"135b0f76136d3cce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanupAttachments.js\":\"3d4ecacb7b0511d8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/dataExtension.js\":\"74a5487604f300b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/downLane.js\":\"457d9bc0f4f4f359\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/index.js\":\"dd34519569292a8f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/insertImageContribution.js\":\"918add8986e9115a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneArming.js\":\"a6ad47787f047c71\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneLock.js\":\"ea09c5ce39987d61\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaBlock.js\":\"30cc15d6f668d870\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaCapture.js\":\"beb61ca5caeb1c70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaLanes.js\":\"500968f5e6dd93d9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewers.js\":\"1d5628cdd5fa34c4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewersFacet.js\":\"88d9faa585efcd4f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/pasteCapture.js\":\"e1c069f6b3e175e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/resolver.js\":\"c50e81bcc48562fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/retryUploadsAction.js\":\"c04c81fbf6b8c0d0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/storagePaths.js\":\"f3ce71ad79848942\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadDrain.js\":\"e430e9319f914fea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadLaneStatus.js\":\"ac296a5981e1bf1c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadReconcile.js\":\"d47e2787648b8181\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadRecovery.js\":\"67c5109d7c47f534\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadStore.js\":\"8aa59b4e9aba869e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/useAssetObjectUrl.js\":\"6e15d4758951e097\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"206beb31808d9738\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksViewSection.js\":\"8f1342174a7c56eb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/facet.js\":\"6b94bba7e9fab784\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/index.js\":\"403e6895674998d1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/prop.js\":\"c631db4ebd6075d8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinkFilters.js\":\"0af42d59b689d956\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"61e9be1c492470ec\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BlockEntry.js\":\"39069229faf76804\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/LinkedReferences.js\":\"c88b3eeadbd2a586\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"c9bdf6af0d7fde48\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dailyNoteDefaults.js\":\"fd0a6b8d54972468\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dataExtension.js\":\"b5927022b637e0f4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/edgeExclusions.js\":\"816e23dcfd087954\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/filterProperty.js\":\"a46b192923500739\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/index.js\":\"976584df347b9580\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7f8a236148531476\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/applies.js\":\"1e2c96be8d0be852\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/countQuery.js\":\"371cbeab956a7c8a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5fac7919595b4003\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/index.js\":\"ce244efebde18c99\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d600ef6add9591d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/presentationInvalidation.js\":\"aa952aeebc8849ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyEditorOverride.js\":\"2b650b57eac883cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyFilter.js\":\"1e4220aac6d5cdbb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/query.js\":\"f4864cceb529aca4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/resolveFilter.js\":\"cec199c83b0574c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sourceBatch.js\":\"7f8a827922100946\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sources.js\":\"93788865c7e1f73e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useBacklinks.js\":\"8a03d04b1237d991\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"95145b84f93787fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayCelebration.js\":\"f62c8846476039a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayOverlay.js\":\"475e6a9b209f5f30\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/gate.js\":\"c68db3df06c153cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/index.js\":\"d41eb5786ddcbd12\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/wolfTheme.js\":\"73207ed0b3d926f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/BlockDragLayer.js\":\"00230e3e84d3d230\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dragController.js\":\"51cab41b6e10ab28\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dropTarget.js\":\"3f79700c445b33e7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/index.js\":\"583869361ae078a2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/projection.js\":\"53b70d80999d0666\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/BlockMetaCard.js\":\"dda60f87790c0d4d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/index.js\":\"63ddd1c52709be23\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/AddTagDialog.js\":\"4df025d13e05c4a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"aebeddc9f979be6d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/TagNameIssueHint.js\":\"48647398aca399ac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/addTagAction.js\":\"6876b51978fa6a36\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/appendTag.js\":\"4a65b2b981991783\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/config.js\":\"48af2ef57c4f15ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/dataExtension.js\":\"1f8bd46b893d5016\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/index.js\":\"b4a981b67c2f4bce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/propertyEditorOverride.js\":\"8af1a3db9075f3d9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbList.js\":\"ba57c6b8a571fd78\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ac591dbef3fdcb50\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5ff624cb3a04e624\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6f0249aae057b245\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"f233f94fb50d98b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/index.js\":\"8f78cd39d898396a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1f5d1500da5bbe15\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/CharacterCountItem.js\":\"5eff6ef046c2c9e3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3d2bb74294d4864d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/actions.js\":\"0690ea6e4927ec79\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/blockType.js\":\"0d67e93972556aa7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/charCount.js\":\"5984cd3e9edd9fff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/dataExtension.js\":\"e2c4fe35167c8df0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/index.js\":\"2af0e599a9f1d2da\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/profiles.js\":\"edde3d18d5adce80\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/properties.js\":\"38c32770098b029f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/subtree.js\":\"5fd283a1e8fce780\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/textCounts.js\":\"3cfb3a0206c46f67\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/colemak-keybindings/index.js\":\"6e7a2fcf9e0e7913\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/CommandPalette.js\":\"5f64ac207a88b89e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/HeaderItem.js\":\"00755166ee441d29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/context.js\":\"389d3ddf55d1d73a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/index.js\":\"77f41275fdef59b4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/selection.js\":\"72632a33aa59724e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/toggleStore.js\":\"b3e2448137c1353d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/useCommandPaletteActions.js\":\"34b4bcc21ff8ef2e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ContributorBadges.js\":\"935f1a4b7156e2ac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ProfilePicture.js\":\"4aa51d2d0d887f2b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/author.js\":\"8df5cd2a092425ad\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/codeMirrorExtensions.js\":\"f0a210dc9e6fa671\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/dataExtension.js\":\"7b77625b493a3d09\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/index.js\":\"3a106430a668166d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/mentionAutocomplete.js\":\"3d5beb5eb72bd8be\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/processor.js\":\"09230cd9cd4175f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/profiles.js\":\"fdde85e3a20bc13b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/queries.js\":\"0e05c0d00c34f103\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/schema.js\":\"5c24cf15e20d0600\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/useCommentAuthor.js\":\"8d3a15e2727683b7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3ecd0310872a0e63\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b85e80cb660b0a96\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/index.js\":\"949735e6ae959d83\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d72c7dc655d2180e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"efa9cd54e603bac8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/CalendarGrid.js\":\"86d755f6224840b8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DailyNotePicker.js\":\"9aa8771ba0a70144\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"becd39a4fa63a9d1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateNavDecorator.js\":\"1c350675354ffc67\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateScrubOverlay.js\":\"baf2cc7456a7e65e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayPropertyControl.js\":\"d6187d0db0c71141\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayValueReferenceControl.js\":\"b7c72b8f6e7f3b61\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/HeaderItem.js\":\"12a8b247670a512f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/ReschedulePicker.js\":\"c1e316793366c415\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c908eabc3acd9235\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/actions.js\":\"3c049484c882c91f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/blockDateAdapter.js\":\"d174ae2c3e486ac4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/calendar.js\":\"28d9e5456fca3178\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dailyNotes.js\":\"25514cb09a9f74a1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dataExtension.js\":\"9246953b7c3c7776\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubActions.js\":\"fa188e7cd6a19f02\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGesture.js\":\"71cc754435c24636\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7bba00181381eaf8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f5b563137c7f4d7e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayProperty.js\":\"3d224293ca5cfd29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"f3ceca2e76998e27\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/deletionGuard.js\":\"7a17c60b8f1e7946\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dueQuery.js\":\"7e4c8cea3d924cf6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/index.js\":\"d292e84d1dba71e8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/landing.js\":\"09225aa5834f1717\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/localSchema.js\":\"9eb836a68a8b326d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/referenceDateAdapter.js\":\"db2175d53c9280a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/rescheduleAction.js\":\"1b3b137d8e4bd2c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/schema.js\":\"e5f90cd0beba0b08\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadBlockDates.js\":\"992556a313144947\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadDatesAction.js\":\"2f757d3b501c5cb7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/today.js\":\"fc69bf94de14abff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"bda33b5c3c60c337\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f984c2616a33b90e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/audit.js\":\"a2b57ba3e5f7b099\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditAction.js\":\"d183c6dc85e58a37\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditRanges.js\":\"846a6d53644d5c68\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/diagnosticsSource.js\":\"6674bc8c78762cbf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/divergenceScan.js\":\"64f617009d1b3da1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/index.js\":\"b0628b03b9be3228\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5b038f12ad151ba2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/referencesMirror.js\":\"738b499690b227fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/rowJson.js\":\"428d7ea6f931da93\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/schedule.js\":\"e7e177b4d43f34d5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/store.js\":\"3b14d9061727b32b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/action.js\":\"dba4adcdcf135579\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/index.js\":\"5aeb736fdb54a52a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/plugin.js\":\"7d13f88d24dc826a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e9c05ba666c36b59\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/actions.js\":\"127f0a8797f93a57\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/changeMarker.js\":\"7a22c66a8b088251\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/diagnostics.js\":\"52ccf0c02af9b7ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/fileSystemAccess.js\":\"acbb9a3717e94bdd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/filenames.js\":\"4ac1e20ff816354b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/index.js\":\"9fa1ea4e61ceffe1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/mirror.js\":\"794c06d40ff665e2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runLock.js\":\"9a28b99eb37f9c86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runtimeHealth.js\":\"15c171c4e9a8de05\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/schedule.js\":\"055fa136287eb072\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/store.js\":\"8d0e55cd29f10511\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/index.js\":\"3f093dfba1ec2339\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/themes.js\":\"3b991539d7486f86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/facet.js\":\"5d2f4dda1fc8e1af\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/useDiagnostics.js\":\"2ffd581328932a9b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/dismissals.js\":\"bacd0755d521bc6d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/index.js\":\"1113ff69cf851720\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/status.js\":\"8a7f05c6f9ac6e9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/store.js\":\"f48666d1aa63a007\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"ab07f9a60a521e62\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsSettings.js\":\"e0a7f233a82da943\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/actions.js\":\"3a06b8ea9a55d55b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/config.js\":\"624aa07bf6bafac9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/dataExtension.js\":\"197eada87660a94d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/effect.js\":\"405b7e6c06a955cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/index.js\":\"646ef11e661db464\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/propertyEditorOverride.js\":\"18f0674555469ab7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/useToggleTree.js\":\"ba47a7b7f2cb12ea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/ExtractTypeDialog.js\":\"9c9bfc0cb0a20d75\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"c018b870c08c1c53\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/PropertyShapePicker.js\":\"345c8953c5630677\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/action.js\":\"81c5febed646cc8f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/index.js\":\"c74e0bb4c82495c8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/FindReplaceDialog.js\":\"692b52d977ceb6eb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/HeaderItem.js\":\"f6d6ff0b2b0f7131\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/dataExtension.js\":\"29d44e97874f347d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/index.js\":\"f9176dbf339eb529\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/search.js\":\"b06cbfb381604294\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/toggleStore.js\":\"d068bf03a6286d53\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/LocationPropertyEditor.js\":\"4199c132b84b429a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/MapView.js\":\"cba3217464bacae4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/blockTypes.js\":\"8a4949f5681954bc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/codeMirrorExtensions.js\":\"a8d1c994dc8a7940\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/createOrFindPlace.js\":\"a29826c2dc8ea4a6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/currentLocation.js\":\"c1c7bd3cc5f28fad\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/dataExtension.js\":\"c4e87ec362a32548\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/geoContentDecorator.js\":\"5ddcb250df0a7b6a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/googlePlacesClient.js\":\"56482e19669bfd31\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/index.js\":\"de377de2c2c2fb82\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/locationsPage.js\":\"04334e9105639173\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/mapViewport.js\":\"87e2481621e8d7d5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/pickCurrentLocation.js\":\"d05111828feae408\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeAutocomplete.js\":\"d86db1b33844ac7a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeNameCollision.js\":\"c78b00f5059a8972\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/properties.js\":\"4fb905d842f8b5a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/propertyEditorOverrides.js\":\"f1301d73e7e005fb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/query.js\":\"2427f95d88b0bd16\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/usePlaceSearch.js\":\"0330d92c2e21c996\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5dd51015f26ff803\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a99d30b767320734\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"22bcad70c0ab6f25\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/config.js\":\"d9f69c669fc058e5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/dataExtension.js\":\"ec74caeefd5bdc22\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/facet.js\":\"e4cd657f63c83dab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/grouping.js\":\"ae62d7c44a86104f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/index.js\":\"1da25a420500a177\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"40f5624a28813c87\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/query.js\":\"c16fa41bdeb48d76\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/resolveConfig.js\":\"2fb01e89593660e6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c639b4012547c6f1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3f3a0e72bc9e4e8c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlDocumentContent.js\":\"ba95e8f72da17db7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlFrame.js\":\"454add6aab044b8a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/actions.js\":\"2418d481fcb46e91\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/blockType.js\":\"524473aaee95d901\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/confirmRunScripts.js\":\"501f772fc24f14a0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/dataExtension.js\":\"1b146bde0d7d3887\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameAnnotations.js\":\"0ebfcff232dfc2ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameDocument.js\":\"c5fd2195ec7e8325\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameTheme.js\":\"02e07d980c8c7871\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/index.js\":\"8e4110c7b97d55ae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/scriptConsent.js\":\"a1cb9affc61145e7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/sourceMap.js\":\"782ce9a356880208\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/useDocumentScripts.js\":\"51c3ee8e139400b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/index.js\":\"82ff1347c7b7a4ac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/record.js\":\"f846c0a566b64dfa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/recordStore.js\":\"6cb465442c3e541a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/responsiveness.js\":\"a2f0c1822921b58d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/schedule.js\":\"ea9c7af6dd66df3f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/sessionContext.js\":\"d2a87c5b648e01ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9341507903766abc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0814bb379535ace0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/actions.js\":\"99f8044ed2ff6dff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/config.js\":\"d7b643aae50df6dd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/dataExtension.js\":\"952a1e62b057c3c6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/effect.js\":\"da5bec527559caa2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/index.js\":\"1610571e5d9a2e45\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/keyCapture.js\":\"3083efe0d7b35f3c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/overrideStore.js\":\"681b0d738c8df92b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3b06ea5c528ae15c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/HeaderItem.js\":\"54367f8225194586\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/LeftSidebar.js\":\"22f3fc2b61ad98ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/actions.js\":\"4e4d3575d0cd4de4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/facet.js\":\"692e9e7fbd04cced\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/index.js\":\"ff4a1b73f8dd5b87\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/shortcuts.js\":\"daf3fe3392dda968\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/toggleStore.js\":\"f21ef5a706151017\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/MergePicker.js\":\"8ac4f7ffaf6375b3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/index.js\":\"7adf2b91277a7503\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/mergeAction.js\":\"bc6e36f420648c4f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/strategy.js\":\"d890c72fab1da483\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/Button.js\":\"3c9ab990a58b31d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0ceba90b4ceb4bcb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/defaultItems.js\":\"04bfdaa118c32181\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/facet.js\":\"7f900d30373e18ee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/index.js\":\"74d365a162938bab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ecbb7db42bf17fc5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/actions.js\":\"929ee1da25dbf696\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"5329b8880975f4b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/facet.js\":\"e4b68421c7220650\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/index.js\":\"8fd594f38995f42b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/MoveDestinationPicker.js\":\"909197e9460a929d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/blockSubtreeMembership.js\":\"7a86956c93a6871a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/contextMenuItem.js\":\"90a90e7db3143a55\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/index.js\":\"f92385613438baf1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveAction.js\":\"284a974a16562082\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveBlocks.js\":\"afdfc136cee92c88\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/selectionAfterMove.js\":\"26d7c1849311191b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/TutorialBanner.js\":\"c3675ba23c721a33\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/action.js\":\"df28d5b0d8e45429\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/bannerDismissal.js\":\"3ef4ca0365dc70e5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/documents/cheatSheet.js\":\"fece52673292563a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/index.js\":\"9e72a71d22a84d8c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/keys.js\":\"b5b7dc2b3bd842b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/landing.js\":\"aa5b572200c28e3d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/outline.js\":\"0cb6ad752bf17200\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/seed.js\":\"f0c23a594095820d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/PerfTrendDialog.js\":\"915e4be4786b06b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/analyze.js\":\"f9fc85297e60a6d0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/diagnosticsSource.js\":\"9513a68c3eea3a7c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/index.js\":\"15e60364f497f0b6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/load.js\":\"65b04c95ac112831\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/monitorRun.js\":\"ca66d7fdb13ca6c4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/schedule.js\":\"24cfb98ed1e9eb22\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/series.js\":\"ee59fc39e66a1aa6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/store.js\":\"efe54bf8b06ba87f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/trendAction.js\":\"10c6026944a9010e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/verdict.js\":\"b9322376074c0bd6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/clickToEditAction.js\":\"86336268fbf64656\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/index.js\":\"d86f7f3b8a2c256f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/interactions.js\":\"605ee6d899ac2e33\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d3af56adf5922439\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGate.js\":\"f2719fa9eb53e60d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGateDialog.js\":\"da2b9a6cb07cfe1d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/action.js\":\"eb94056e736361cc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/index.js\":\"db9920740a9d6abf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/localRunMessage.js\":\"aa52ec4ceaf77461\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/plugin.js\":\"72725ac043c27cfa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/progressReport.js\":\"9a67db669de12f3a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/sweepProgress.js\":\"ba809ec010eecdca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/FieldRowRenderer.js\":\"7d837976f4d91003\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/ValueRowRenderer.js\":\"b7f7db319086c8ad\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/actions.js\":\"0721307f7c9bf2b6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/autocomplete.js\":\"76ea8de539373644\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/fieldRow.js\":\"573b0f3650dd64ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/index.js\":\"0d05d73807d7bd5d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/referenceWarning.js\":\"d4e08bde9ae77500\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueAutocomplete.js\":\"b21d2485993a27b6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueSchema.js\":\"4d8fd68ff24cb808\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/HeaderItem.js\":\"d3ebef55039bbaa0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/QuickFind.js\":\"9ea8a360af36d34a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/index.js\":\"da097e1562fb142b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/recents.js\":\"175bd6ddbc114415\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/resultItems.js\":\"256e25e93cac7ce4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/selection.js\":\"ca6bfe700939c9a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/toggleStore.js\":\"0aa76bac080fd3c9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/HeaderItem.js\":\"9b4c00e3a0b36e22\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1140b20045c81b94\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/grouping.js\":\"bbe228ffc8a39c85\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/index.js\":\"504926c32432c017\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/target.js\":\"754977442601d1cc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/codeMirrorExtensions.js\":\"9924bd146c2a6bb5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/contentPrefill.js\":\"36450b4b056bda17\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/dataExtension.js\":\"7cf25117691156bc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/index.js\":\"585692319301e4f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"2131ba726d235150\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/invalidation.js\":\"4e6f1e96135a921f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/localSchema.js\":\"34f807782a42fff9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/index.js\":\"e28f3515b5ef0992\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"c50c3f9097a06296\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/index.js\":\"3a21bdf0aecabaeb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/referenceNode.js\":\"40e93b2a0dc6ee94\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/remark-reference-occurrences.js\":\"609d659ea47f8d84\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ccf5b2d6b21e0c8a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/index.js\":\"a68a6ea78fb02cd5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"0f877691aeaf5df8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"4fa30e259a31cace\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/mergeRetargetProcessor.js\":\"14d92c2a6f49083b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/parseFence.js\":\"45a302cae0548f11\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceParser.js\":\"231db2c0f6275610\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceProjection.js\":\"cf3e66afc913a704\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referencesProcessor.js\":\"89696ccbb6aadb11\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/renameProcessor.js\":\"dc07160e9293d3f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/spanReplacement.js\":\"0b055465fc3585b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/htmlToOutline.js\":\"0a0ad6f66fcca7f6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/index.js\":\"db89a700e3edddc7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/normalizeClipboardDom.js\":\"dbd99a2b918f16a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/pasteDecision.js\":\"01cbe26dcfbba3e2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/action.js\":\"b05091b816920582\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/blockIds.js\":\"e14ce73995e76c8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/content.js\":\"79d5fbc72f3f4ba7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/effect.js\":\"a3f7f5285df524a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/ids.js\":\"a373225357dc4bd4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/import.js\":\"6e72f258761633d3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/index.js\":\"470636cd97a184e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plan.js\":\"54441aa769d35b33\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plugin.js\":\"e5d4000b79865f9b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/promotion.js\":\"28d1be20117207f4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/properties.js\":\"3322ba4edc683330\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/references.js\":\"d2d4abf813348c27\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/report.js\":\"e8e4767429847ea9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/roamMemo.js\":\"f30e0784dc7ad6dd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/runtime.js\":\"314ea4c97bd1e8e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/schemaReconciliation.js\":\"97f3386e3186f120\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/srsMarkers.js\":\"2e4a4a216e898fc4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/todo.js\":\"8e579c8e803b21c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/typeCandidates.js\":\"70d870cca45cff08\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/types.js\":\"9f87890f7de1aeb7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/index.js\":\"5837b1d5fca0a8d4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/store.js\":\"88f5eb3a62e22438\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/HeaderItem.js\":\"309384bbc47ff2a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7f27a30734ce0028\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/index.js\":\"589ef3c6c3ff8132\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/model.js\":\"7de3cf5b24e236b6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/toggleStore.js\":\"8399f9e59fe47daa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/useKeyInspector.js\":\"82a27e8471d26f2f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3e7bbaf04a5b16fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/ShellDecorator.js\":\"83cd2978b1881547\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/actions.js\":\"48c66e2fff20c89f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/exclusionsFacet.js\":\"80a16329c826f452\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/index.js\":\"086ed1a34c7dd87f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/shell.js\":\"f2e0665a7d733f5b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/surface.js\":\"eed21d8eef5a7024\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/walker.js\":\"ef0d6bce528c23df\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7ac2800026e27f7b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/dataExtension.js\":\"3d5530cb6fa2a39c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/index.js\":\"4cf92a04e8fb744e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/indicator.js\":\"9e12594c36e27df9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/moveSrsState.js\":\"e745d4e7cded521e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e3746ec0dea888a0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/scheduler.js\":\"870b3c475cd42ddc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/schema.js\":\"3f3dae96d7396aa2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ed9f1511fa891506\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsClipboard.js\":\"ac4750cb68a0716a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b0060066fe1329d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DailyNoteReviewHint.js\":\"749cca30ec25ec06\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DeckPicker.js\":\"364b9046e4500c92\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewControls.js\":\"e4991004a08ff599\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewDeckRenderer.js\":\"389efc52999c7f9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewSession.js\":\"e853061f63994cba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/actions.js\":\"12a9987d58ee3ddd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/archive.js\":\"cd65168faf22c082\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dataExtension.js\":\"4fb14c3d3bb75d91\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/deck.js\":\"164e28d9b0bd4270\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dueQuery.js\":\"b050d1bba3c34bb8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/gradeDecision.js\":\"a0e0f4c7b89dadbb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/index.js\":\"43b2c9e8777dccd2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/keyHints.js\":\"802134146758f06a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewCardLayout.js\":\"91d48f76ce0e1926\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewProgress.js\":\"71f2494f9132c848\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/schema.js\":\"2189a1cb64456876\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/useDueCards.js\":\"44c6a801f7ea804d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/index.js\":\"b4b05c38449a6f00\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/record.js\":\"4ed835084ff336b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/index.js\":\"31dab9043fa01fc8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/persistenceStatus.js\":\"be2caf5d68b9afcf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/requestAction.js\":\"3f38c9bf1923de69\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/TypeChipsDecorator.js\":\"96b60e0021e156cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/codeMirrorExtensions.js\":\"b6e95d5cf82a74bf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/index.js\":\"1f57e6d7d1719b97\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/typeAutocomplete.js\":\"f07b84824b40b1b7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e66a9b630ac45b90\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/actions.js\":\"f2421d34a41edb55\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/anchor.js\":\"0c0a26a2e67de0ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/events.js\":\"0f771329421d1ab8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/gestureActions.js\":\"92b6562019f43e44\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/index.js\":\"c0ae66d5cf176906\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"67d7e8dc8e5a5e55\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/collect.js\":\"85a5df8f8dc9c993\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/index.js\":\"9d77d48f2e1392f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/record.js\":\"56d59e698f44c453\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/RejectionDialog.js\":\"b3660dff7f4001ed\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e6bfa3336cd3d4f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/index.js\":\"130a87987e5cc28c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/model.js\":\"cd121207b21a472f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/queueCounts.js\":\"9c824f46543e1dcd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rejectedHelpers.js\":\"559e54f21ba9d75f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rematerializeAction.js\":\"1cc6ae36a739e975\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/useHysteresis.js\":\"de6f287541bf4b54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/ColumnHeaders.js\":\"3891b4bd2dc98787\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/QueryUi.js\":\"028b111eebdcc61b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/TableLayout.js\":\"bb0210b8f57ab8f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/actions.js\":\"996097a8a6327ec6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/cellEdits.js\":\"ff0c098b76de8d7f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/childrenViews.js\":\"d5025e123ab70fea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/columns.js\":\"65f20eafe77cc103\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/controller.js\":\"b0227bd64d15ad4e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/convert.js\":\"b6c2593de9d9cc78\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/dataExtension.js\":\"afe001789f440db2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/index.js\":\"9c3da03ec107ac31\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/keys.js\":\"5deb9c6ccd2913fb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/model.js\":\"5deb195dbf0b5a12\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/QueryText.js\":\"325ae01a029d0505\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/backfill.js\":\"eb00838e51acb692\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/completion.js\":\"c88307abfde2bd36\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/format.js\":\"ffabf1d8d85c4660\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/parse.js\":\"aa868fac57a17d3b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/queryValue.js\":\"d9d14ea98171ae23\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/registrations.js\":\"5802e41da33cd09e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/source.js\":\"6f937a268f73d69a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/registry.js\":\"edbfcca4a5c47e2a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowGutter.js\":\"7b6601fc035e2ee9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowVerbs.js\":\"3e5e45b0af38166e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/schema.js\":\"fc349824956c4c05\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/sort.js\":\"b92e221ad707a39c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/effect.js\":\"1d20a4de9380e891\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/index.js\":\"c4026fb02f336cc6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/theme.js\":\"fb04c9f5311d4330\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/actions.js\":\"575e66ea68522b28\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/dataExtension.js\":\"bed331b30a234488\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/index.js\":\"4378fbd6b064008c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/schema.js\":\"448315094518f2b7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ff3da55858e3ea56\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/actions.js\":\"7d244f94a0a8a3d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/defaultItems.js\":\"5a2b79206bb42af3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/facet.js\":\"88e5fa76e59b0c32\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/holdRecognizer.js\":\"73b84f62f0756fae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/index.js\":\"045f768b091c2789\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/UpdateIndicator.js\":\"5d1e684db208916a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/index.js\":\"2c1025e7d0162387\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/loadTimes.js\":\"468c33c512b57fe0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoNotesRenderer.js\":\"7a49e6ba374fe085\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoPlayerRenderer.js\":\"e764ad8265151651\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoTimeStamp.js\":\"75f84a9e03661bd8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/actions.js\":\"96ee2d2148ba0692\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/index.js\":\"a3919a284493d916\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/markdown.js\":\"b6cf5d0962c559d5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/notes.js\":\"0114a6650d8535af\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/registry.js\":\"64e4aec3cac94895\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/remark-timestamps.js\":\"5a4daa620cf12a9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/view.js\":\"08ffdcc78df3b301\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/LinkHints.js\":\"35f39831b8b03cb7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/index.js\":\"b917a8ee2e82f32d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/model.js\":\"be3e4e65ad6ad7b0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/settings.js\":\"9bc641d9f51f2091\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/actions.js\":\"128a2f843c820872\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/index.js\":\"58a1eb43ea6c39e0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/interactions.js\":\"2491753e5df50c0e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/workspace-header/index.js\":\"346865fed84b7075\",\"/knowledge-medium/pr-preview/pr-1912/src/registerServiceWorker.js\":\"8b55f9258472c43d\",\"/knowledge-medium/pr-preview/pr-1912/src/requestPersistentStorage.js\":\"b7656f23d1ca03fe\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authRequestDeadline.js\":\"39f6338fe8fe3f29\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authStorage.js\":\"9ab772e3cf6b4b2d\",\"/knowledge-medium/pr-preview/pr-1912/src/services/powersync.js\":\"26fcc4d8873bbb31\",\"/knowledge-medium/pr-preview/pr-1912/src/services/supabase.js\":\"1f8d0455eb0b5d32\",\"/knowledge-medium/pr-preview/pr-1912/src/services/uploadErrorClassifier.js\":\"77fa2819bb396194\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/ActiveContexts.js\":\"86d94fa18fc60803\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/HotkeyReconciler.js\":\"5a75dac50b7793c5\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/WipeLocalDataDialog.js\":\"af35847f64067857\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionDispatch.js\":\"fb4549753a1cbb2b\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionRefItems.js\":\"28667a088ba36735\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/applyKeybindingOverrides.js\":\"2636ae589491d5a7\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockActions.js\":\"8559b3d42d0d3018\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockMergeGesture.js\":\"270a8e756668cfb2\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/canonicalizeChord.js\":\"8b7c7e6cd959b0a1\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultContexts.js\":\"9c752b53237ecfdf\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultShortcuts.js\":\"d351bcf09f467d0e\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/effectiveActions.js\":\"dcf0a6d327e6f03e\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureAction.js\":\"14b5d9f1c73030a4\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureBinding.js\":\"3d3a01c1cc92b3c1\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/holdRegistry.js\":\"1369f5d96e045a6b\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingConflicts.js\":\"4ca68b6ab4d7e0e4\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingOverrides.js\":\"a608bc2481a84062\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/pointerAction.js\":\"c1fe97465036bab1\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/resolve.js\":\"100d87d1ba6528f3\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/runAction.js\":\"282644a8aa96a873\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/sequenceMatcher.js\":\"b3b13547a6295903\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/types.js\":\"0026da51bb85564a\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionContext.js\":\"34569d6456d618ca\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionDiscovery.js\":\"a5b936becabea178\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/utils.js\":\"c00c11fed3f0da8c\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/bootStore.js\":\"34c7aa8a63f5a6f7\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/previewDatabases.js\":\"fb43ed9582ad7526\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/byteTransform.js\":\"17454a734eac06c8\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/attachmentCleaner.js\":\"2a3e15207dc6e2c0\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/attachmentParts.js\":\"12f5043b9db09052\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleParts.js\":\"5a41134186fb2d51\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleRecord.js\":\"661e2f5bf465202b\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/manifest.js\":\"40412c74ca127263\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/takeBundle.js\":\"2ee2161e27035823\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/verifyBundle.js\":\"9567baa5f08cd360\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/cleaningStage.js\":\"f59acfdce0289c38\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionKey.js\":\"bebd2f757d0976ad\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionServer.js\":\"fb2349305dd88dfe\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flip.js\":\"064853c70dc920d5\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flipAttempts.js\":\"0c2ac891e8abe07a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/pages.js\":\"774013d1fd588509\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/preflight.js\":\"e2b7bb2beccd01a2\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/reseal.js\":\"a6d59089c783d139\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runConversion.js\":\"ab946c207b4d1a9f\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runLock.js\":\"8c5ae214560863ed\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealing.js\":\"f944dc5319f49b7b\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealingStage.js\":\"8242c94aaea06aed\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/stage.js\":\"799f8a0a1618ff33\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/verifyReseal.js\":\"d782dfb951702a5a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aad.js\":\"7890bcfd3ba129f6\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aead.js\":\"172574811ec22ac1\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base32.js\":\"2d00ab298b3cd412\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base64url.js\":\"1509cbbf581ce1ba\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/binaryEnvelope.js\":\"e464b6a8af57b842\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/byteAead.js\":\"028a27ca47a710fb\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/canary.js\":\"5e74a72d0c7046e9\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentHash.js\":\"67de85172601f27a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentKey.js\":\"2cb0018428005c19\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/derivedIdNamespace.js\":\"1684ec80f4e13957\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/envelope.js\":\"ea31b29d90897d10\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/hex.js\":\"f631adf3068770d5\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/sha256Hex.js\":\"b9fae682fad4667d\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/workspaceKey.js\":\"748187a6aa10dd5a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/conversionState.js\":\"dba7de76344bd7b6\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/createEncryptedWorkspace.js\":\"59b70bd9118c539c\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/pastedKey.js\":\"d535ad8dfe019f34\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2ee81dd5091293c2\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c513018bf6bf16c4\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/keyStore.js\":\"90fe2c0caee8ebb7\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/mintWorkspaceKey.js\":\"64cf58f72ae79544\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/modePin.js\":\"c0d936dd9bc65c9d\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/openWorkspaceKeys.js\":\"f9bc5e66f1b09a13\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolveWorkspaceEntry.js\":\"5c365ad79e1b42ee\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolver.js\":\"fe2cca5b908251db\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/workspaceAccess.js\":\"787ed183dfc8616d\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/transform.js\":\"5d4127f81f1ea20b\",\"/knowledge-medium/pr-preview/pr-1912/src/themeBootDefaults.js\":\"3298e404727f5798\",\"/knowledge-medium/pr-preview/pr-1912/src/types.js\":\"7d29507e1ea02697\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/ClientLocalSettings.js\":\"26417c6aa2e36227\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/abortableSleep.js\":\"72bf4970d7748356\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/array.js\":\"e8e66864e4191f5e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/backlinkAutocomplete.js\":\"e645184400a565cc\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockCrumbs.js\":\"2112bfc922ae3fce\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockrefAutocomplete.js\":\"1be98198d8848e98\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/cadencedIdleJob.js\":\"77e1a2a0a667a09c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/callbackSet.js\":\"6ed6c7f81bad8abf\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/clientId.js\":\"501fc3dd4a9596a7\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirror.js\":\"4ea6f8f3aaea6642\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirrorCompletion.js\":\"998f07a13b79f456\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/copy.js\":\"e3e7f7799146944c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dailyPage.js\":\"b1a0cdf50015f864\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensics.js\":\"b9b4e2791283573e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensicsHooks.js\":\"cd1b9283a91ae986\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/deleteBlockThroughUi.js\":\"e3b72d09f64abc48\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dialogs.js\":\"78c4920d9d9e34d0\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dom.js\":\"18da27881e390ea1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/downloadBlob.js\":\"f7e28a03bd8996a1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/drawnWalk.js\":\"8b09ae5163f4de05\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/exportSqliteDb.js\":\"a5440ba12a15e814\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fileSystemAccess.js\":\"e2bdbcc98d3eba11\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/flipSlide.js\":\"47766534c935e062\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fnv1a.js\":\"75a246913c9c074f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/formatBytes.js\":\"21f70718b0e77d65\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fuzzyRank.js\":\"c708d28cda033265\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idbKeyedStore.js\":\"ee47d809c186b91a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idleCallbackPolyfill.js\":\"69325b2ba6674f10\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardAwareScroll.js\":\"5aeaa15544f9c628\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardViewport.js\":\"7e3c52e9c10d842b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/lastWorkspace.js\":\"4a0daf6e53328d8e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutColumns.js\":\"2732496a3e712b03\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionDom.js\":\"664309e68e55753a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionId.js\":\"594e3ba5bb7f9933\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkClickGestures.js\":\"7bd144d9827630de\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkTargetAutocomplete.js\":\"aca9ccec56dfad25\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbCorruption.js\":\"6cc9955c44fdb5cf\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbRecovery.js\":\"833dc00a8c33cff1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/markdownParser.js\":\"a9828ea71e844cfd\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/memoize.js\":\"1b968d629f05a993\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameFieldCommit.js\":\"7f07d147e15f4987\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameList.js\":\"4f78b8ba102af48e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/navigation.js\":\"7a53d17f1559df2c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/omnilinerNamespace.js\":\"23b11e62d1444c12\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/opfsPageScan.js\":\"6b72bb2405281fc4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelClearance.js\":\"99c3aabc84da7fb4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelHistory.js\":\"dc3b6bd9e91f991e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLanes.js\":\"77a66b76b6baa530\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLayoutProjection.js\":\"5253d7f76128db22\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelScrollAnchor.js\":\"b05c8c3a3cf8a0e2\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelUrlFlags.js\":\"56d6f79e0f85876a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/platform.js\":\"e207d8f840c3ca1d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/pluralize.js\":\"e0ab016b8820ffa3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyCreation.js\":\"6753102344a132c7\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyNavigation.js\":\"b0b5b472a2c7e1cc\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyValueContext.js\":\"00d30f0d061d25ad\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/react.js\":\"c0bff232e0e70bbf\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeDate.js\":\"406bbc067d4f40e1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeTime.js\":\"c42e4d234596ecdd\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/renderScope.js\":\"f1a8d3c22fd4917f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/resolvedThenable.js\":\"8e686b03d1d257f6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/routing.js\":\"ce44ee33966814d8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/safeMode.js\":\"551b36b6ed91313f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/scheduleIdle.js\":\"2319d34674784a38\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/screenWakeLock.js\":\"a9ecb20ccb84bd48\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/selection.js\":\"a4451757624795fc\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/softKeyboardGrab.js\":\"635bd89cca01ef76\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/startupTimeline.js\":\"d771a6cca78f965e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/state.js\":\"5c839709125371d1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/string.js\":\"67c85fc5b090c6a3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/surfaceZoom.js\":\"ce1d256f0306c5ec\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/time.js\":\"cb2f2698067ee505\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toast.js\":\"ce0611d7ac04d815\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toggleStore.js\":\"5412c4bfc3eaf16b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/untilStopped.js\":\"245d82d19adc4da1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/userActivity.js\":\"1f26e6b509338bfb\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewTransition.js\":\"4f45d2df7b135656\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewport.js\":\"0f0ba7285070a914\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/webLock.js\":\"0891fd6c48f018d6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceRecovery.js\":\"0817d116d8c821c7\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceSnapshotStore.js\":\"c6b3f9c4ee9c489f\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-compiler-runtime.js\":\"0f23161aa443eb05\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-client.js\":\"c5ebbd7f47a5c491\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server-edge.js\":\"d64e9ef657c02071\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server.js\":\"3e5d606e07998bb7\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static-edge.js\":\"6b697b3a666a7a2e\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static.js\":\"e89478fe8a3ce692\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-test-utils.js\":\"44f530743492ef92\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom.js\":\"0b78e830001740ff\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-runtime.js\":\"fc099809977783d7\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react.js\":\"43279e0301020f5b\",\"/knowledge-medium/pr-preview/pr-1912/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
