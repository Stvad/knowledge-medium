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
		buildId: "f0cc911a6633-891d51de",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/\":\"8fdab8b7de9bd68b\",\"/knowledge-medium/pr-preview/pr-1912/index.html\":\"8fdab8b7de9bd68b\",\"/knowledge-medium/pr-preview/pr-1912/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1912/assets/FacadeVFS-z0B0ZQDn.js\":\"d99dade86fe43df1\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSCoopSyncVFS-DoojieyI.js\":\"34f7f1cb4a56f51b\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSWriteAheadVFS-NsruLbjv.js\":\"87f5aa8e6785473d\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-4GSll1Mp.js\":\"6140e36f7dea7f67\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-BCRBXAqc.js\":\"018f6c8b2a143b45\",\"/knowledge-medium/pr-preview/pr-1912/assets/worker-BYg_2rPe.js\":\"fe9bc682b865cb6d\",\"/knowledge-medium/pr-preview/pr-1912/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1912/chunks/app-BD3cYXSo.js\":\"0368083db6beab2c\",\"/knowledge-medium/pr-preview/pr-1912/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1912/index.js\":\"e2874626c47f38bd\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1912/assets/AccessHandlePoolVFS-cQAAQGdG.js\":\"c4ec8efc6f0ab44e\",\"/knowledge-medium/pr-preview/pr-1912/assets/IDBBatchAtomicVFS-DdNRDtnV.js\":\"a07ba84f95d309a9\",\"/knowledge-medium/pr-preview/pr-1912/assets/MemoryVFS-Cezz5vZE.js\":\"edf30314a3479c94\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-B0dUFdPu.js\":\"eff18346372b58c8\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-CctxJKTs.js\":\"af5f140e179ca6c6\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1912/chunks/AccessHandlePoolVFS-CcUvF2AL.js\":\"85464b0ba22bea5f\",\"/knowledge-medium/pr-preview/pr-1912/chunks/FacadeVFS-DqJdqTIn.js\":\"aa5542bb401d639f\",\"/knowledge-medium/pr-preview/pr-1912/chunks/IDBBatchAtomicVFS-DNkqPm7s.js\":\"64f2695232300658\",\"/knowledge-medium/pr-preview/pr-1912/chunks/MemoryVFS-Cq1Z3QUe.js\":\"09a5d81081b80115\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSCoopSyncVFS-BCD8sjij.js\":\"58790715c0ccabc1\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSWriteAheadVFS-DdVJHoBr.js\":\"9dd1449c0cdf4fe7\",\"/knowledge-medium/pr-preview/pr-1912/chunks/Preview-DOk-ql44.js\":\"7c1578af3b93e326\",\"/knowledge-medium/pr-preview/pr-1912/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1912/chunks/card-dWuL4FHX.js\":\"8aa733130435ca94\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-DuO8tLYC.js\":\"0256e6599b10ce06\",\"/knowledge-medium/pr-preview/pr-1912/chunks/freezeExtensionImports-C66db4U_.js\":\"65b84e5e8429284a\",\"/knowledge-medium/pr-preview/pr-1912/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1912/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-DtQKssN8.js\":\"0da7da74c69c5d72\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-async-DVbvn30X.js\":\"ba92c11e09beea44\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-2mefHFm_.js\":\"750530b24c6cd43d\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-B-_e5MZx.js\":\"8b578a67a4734e7e\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-BTCZ_pVi.js\":\"eda49c76db78dd18\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-BfgNUgCg.js\":\"92acbf34210e6ce8\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-Bgs2FUc2.js\":\"0fe2d61fd36a5b02\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-D-TfkfQy.js\":\"cd9c1bbbf4b72725\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-Dth7eoE4.js\":\"c6a5691ab7c4a602\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-UZ6nmBHE.js\":\"25837447188759b6\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server-legacy.browser.production-7Gr96x1D.js\":\"341b86b228bddc89\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.browser.production-BW2Wa3Vo.js\":\"3c5ebf952f480221\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.edge.production-B4G5KXWy.js\":\"872b08bf2abba893\",\"/knowledge-medium/pr-preview/pr-1912/chunks/server.browser-Bou07f--.js\":\"a450d2d609415487\",\"/knowledge-medium/pr-preview/pr-1912/chunks/textarea-BWY0P-yW.js\":\"601efd5675c8a081\",\"/knowledge-medium/pr-preview/pr-1912/chunks/ui-s8AjwsDF.js\":\"ead67fc35d8a21f9\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-DIvmIEH6.js\":\"726811a0d8d04043\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-async-DCuUfx99.js\":\"8b4ab71b9536f2e4\",\"/knowledge-medium/pr-preview/pr-1912/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1912/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/src/App.js\":\"d8dd74c4e810085e\",\"/knowledge-medium/pr-preview/pr-1912/src/appUpdate.js\":\"373d0b81c8b35fda\",\"/knowledge-medium/pr-preview/pr-1912/src/appVersion.js\":\"31cadbafc48df537\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/initialLayout.js\":\"16e9f11d2d45255a\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/openWorkspaceData.js\":\"4ae86e52c0e0d78b\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/resolveWorkspace.js\":\"cb6a2ab63d889e86\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/workspaceBootstrap.js\":\"7ca295e675e88339\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockComponent.js\":\"baf300503d562431\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockCrumbs.js\":\"1ce1f72e735922ca\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockEditor.js\":\"1abd3f0c49e1b551\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockLoadingPlaceholder.js\":\"dd2ae2d49c256700\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockProperties.js\":\"2aba0f70d9b5a0aa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockSearchPicker.js\":\"6e43f646b1b416ff\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ConfirmBulkDeleteDialog.js\":\"e8c79f7efd71d50a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DividerHandle.js\":\"f1a3ea08ec7c2a1c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DraftEditor.js\":\"257efc9417d9a6dd\",\"/knowledge-medium/pr-preview/pr-1912/src/components/GutterPill.js\":\"f1804cf7ab774ca9\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Header.js\":\"ed6a458c7a790e09\",\"/knowledge-medium/pr-preview/pr-1912/src/components/LazyBlockComponent.js\":\"9cfe595a416c136a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Login.js\":\"9f8eae9e36d872f4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ZoomableSurface.js\":\"3d4d02d85cf6b0bc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/editModeKeepalive.js\":\"4c54127baa0f6ed6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyDisplay/PropertyDisplayScope.js\":\"cc4ef460a0c3889a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"c99d417de788bf78\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefPropertyEditor.js\":\"0021a7603de0a278\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefTargetTypePicker.js\":\"d1b9d3e7632bfb9f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/SelectPropertyEditor.js\":\"9abf16702e5375cd\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/TypesPropertyEditor.js\":\"ef5b12d3b3396b15\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/defaults.js\":\"1ef930bd3c31e539\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/kernelValuePresets.js\":\"9ba42a61f5a32307\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/selectablePresets.js\":\"aae947ff1b82b0da\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/typesPropertyUi.js\":\"0c518772d9abe869\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/AddPropertyForm.js\":\"8f60fa365f876ab8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyPicker.js\":\"44855557398c0d95\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyRow.js\":\"8fed8be6848c2cfa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/Rows.js\":\"2de7d7e0681cb807\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/actions.js\":\"41760f82d8a19cea\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/declarationOnly.js\":\"4a319f6a31e56723\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/layout.js\":\"28ba4a210d2b3aa1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/model.js\":\"6c7db86cf6004736\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapeUi.js\":\"11585067807493f4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapes.js\":\"77d4fd37e3690dca\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/usePropertyEditingActivation.js\":\"3a1088d4b8035a93\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/visibility.js\":\"7a33d84ee3cf22e5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanelSections.js\":\"62c990988976a917\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockEmbed.js\":\"effd52a3bdda02a9\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockLink.js\":\"7f32c6977de10378\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockRef.js\":\"4be69c27f122a01a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/CompactReferenceLink.js\":\"368c4c1485490c5d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/ReferenceLink.js\":\"f62ea66d57d5cce3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuard.js\":\"078acc8633f99106\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuardContext.js\":\"5798429b9cebf612\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/linkInteraction.js\":\"de2aa8fea7cc9dbf\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/referenceLayout.js\":\"3bb103825da019db\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/useBlockRefAncestors.js\":\"1151e61fc74c8e51\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockGutter.js\":\"f8dc4f50d03935d6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockInfoDialog.js\":\"af2e36fc53779817\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockReadText.js\":\"0e80e4a83df00155\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockTypeBlockRenderer.js\":\"097be47432495c0c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BulletHoverCard.js\":\"f8896decf81f85b1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorContentRenderer.js\":\"c28c8a9d1fb1c5e7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2315a27e3f563bca\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ColumnResizeHandles.js\":\"17c62aa7b00b65f7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"c0251dae2ae73f7d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/DefaultBlockRenderer.js\":\"5c4b895e06db8c15\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/LayoutRenderer.js\":\"6f0d2cf7897c095b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MarkdownContentRenderer.js\":\"b0896dc4b72ec56e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MissingDataRenderer.js\":\"ef0486f5fe9dbee4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PanelRenderer.js\":\"0b9e64843f96d874\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PropertySchemaBlockRenderer.js\":\"fc9812560b19bc56\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/TopLevelRenderer.js\":\"5cbbdaba6ef1f0b6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockGutterMode.js\":\"dd6a2b6e9fcde09f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockTitleText.js\":\"25f1e87036c8f083\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/fieldCreationKeydown.js\":\"9c2ac3cb77c92918\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/layoutRootContext.js\":\"7f4269e77599176f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/TypeChip.js\":\"06de24be8bd52f4e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/chipStyle.js\":\"c8bc7dea2eb2d03e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/anchored-floating.js\":\"a2991f1c602b38a9\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/button.js\":\"6e47e67da409e87d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/card.js\":\"57d9294691f337fc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/checkbox.js\":\"7e377d95d771b9b8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/collapsible.js\":\"5942e3d056f0ae29\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/command.js\":\"2f49c713a5da012b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/context-menu.js\":\"9f9618f537d549c3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dialog.js\":\"93a7793a6420ea97\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dropdown-menu.js\":\"4fb717a0e6a6fdfd\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/floating-listbox.js\":\"6658e83f66b2bbd7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/index.js\":\"2bf2fd73699ed852\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/input.js\":\"2b5f6db35eb6a267\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/kbd.js\":\"ff39a0024437d494\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/label.js\":\"9d1b99313f3dc5b6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/textarea.js\":\"04ac894c95960c0b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/useEditModeYieldKeepalive.js\":\"d4e67e6be92f3bb2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/BootFallback.js\":\"f431c5a3adea30fc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/FocusedRowLazyMount.js\":\"c4d9dbb49b68d81b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LazyViewportMount.js\":\"f6481bc1cd9f0c57\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LocalDbCorruptionFallback.js\":\"c32cb7fad2e1b90e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/error.js\":\"7acfbd2000657e85\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/lazyMountRegistry.js\":\"f2294b4c819b743a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/suspense.js\":\"0d59d52835faa42e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/CreateWorkspaceDialog.js\":\"8c90307d24c0ac7a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/PendingInvitations.js\":\"56dde062765720c3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/SyncProgress.js\":\"6000defc23c54ecc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/UnlockProgress.js\":\"9e9b0dcab5e34f59\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceKeyGate.js\":\"74eca7be7104e951\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSettingsDialog.js\":\"47b6ce3836a670db\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSwitcher.js\":\"c1c8a55b890c5664\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSyncGate.js\":\"aabaa53112b0d6f8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlow.js\":\"73014d4732a62bd8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlowHost.js\":\"f749d21850b07fcc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/EncryptionSection.js\":\"8d9c5075b6a22adc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/attachmentPrompts.js\":\"0b064178a9e88dce\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/bundleFolderPrompts.js\":\"c91ed2f8e3d86666\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowDeps.js\":\"f6891302416094fc\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowStore.js\":\"f9772fd31495787f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/flowUi.js\":\"7b4d8ea2dc4fc72a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/useConversionRun.js\":\"09929aec5dff2e69\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/keyUi.js\":\"21c672fd881079b4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnKeyLoss.js\":\"2f2377aeba25ce45\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnServerE2ee.js\":\"bc40fdc64a217da3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/workspaceUnlocked.js\":\"58e066cd02e4ab7d\",\"/knowledge-medium/pr-preview/pr-1912/src/context/backgroundSubtree.js\":\"d58a064d5646b9df\",\"/knowledge-medium/pr-preview/pr-1912/src/context/block.js\":\"dd16138ca92ac594\",\"/knowledge-medium/pr-preview/pr-1912/src/context/layoutWsContext.js\":\"7ba0e7a3e593638d\",\"/knowledge-medium/pr-preview/pr-1912/src/context/propertyDisplay.js\":\"34ea8a43ec377bb8\",\"/knowledge-medium/pr-preview/pr-1912/src/context/repo.js\":\"390fd993e041ab5a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasClaim.js\":\"4489a4d3d1a2b6f9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasSeatNamespace.js\":\"1b31aa6ca40e6920\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockData.js\":\"1f00fa50e1f87344\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockType.js\":\"b396a59cf2c076e9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/changeScope.js\":\"ae10ecfca1d29df1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/codecs.js\":\"7af9278b10b29bdd\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/derivedData.js\":\"ea742cdd4e8b029d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/errors.js\":\"de0f9ebfa59ca6fe\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/events.js\":\"f458286cbe36cde4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/handle.js\":\"f402b8aae9c8c01c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/index.js\":\"556fd8c4c8b870bb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/mutator.js\":\"56caf4e997a815e2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/processor.js\":\"316e55be28848068\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/propertySchema.js\":\"2fd70b87e0dbf29d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/query.js\":\"caf67e6dfb683b0f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/sameTxProcessor.js\":\"1088c29dca81b747\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/schema.js\":\"f402b8aae9c8c01c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/tx.js\":\"f402b8aae9c8c01c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/typedBlockQuery.js\":\"78de78bd4013a2ec\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/user.js\":\"039e5d9d8a2d8686\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresetCore.js\":\"f44358f3a7098cf8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresets.js\":\"cc2591ab312f205f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/attachmentCleanerIOVerb.js\":\"9e9fc719d988a8c3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/block.js\":\"ba31042785076cdd\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockCache.js\":\"b2224ad0aa2d2c22\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockId.js\":\"47a69a7bf65e323d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockLiveness.js\":\"22bb8ee80c9567bc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockMerge.js\":\"cf659d6ff8834ed3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockSchema.js\":\"bc567a10c0d9e7fe\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypeLookup.js\":\"79a1de6ab6690f48\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypes.js\":\"b48901a6cb277741\",\"/knowledge-medium/pr-preview/pr-1912/src/data/childrenView.js\":\"783be3f8a39a0f13\",\"/knowledge-medium/pr-preview/pr-1912/src/data/clientContext.js\":\"d42fa5948fcdae3a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/dbFileSiblings.js\":\"1be25ef4c0ebf583\",\"/knowledge-medium/pr-preview/pr-1912/src/data/definitionSeeds.js\":\"4007fe003aa91d08\",\"/knowledge-medium/pr-preview/pr-1912/src/data/derivedIds.js\":\"face410b3815e206\",\"/knowledge-medium/pr-preview/pr-1912/src/data/drawnSubtree.js\":\"d91265a5becad286\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facetBridge.js\":\"77f025000b780bb2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facets.js\":\"719c86100bd055fb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/globalState.js\":\"c6f7d0bfecc453df\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/aliasClaimRederiveProcessor.js\":\"bb66a7e5637c16d7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/ancestorBatch.js\":\"77fc4cfaa92ad913\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/blockTypeTypeifyProcessor.js\":\"14c720a4eb4c957d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/clientSchema.js\":\"c0b17a3cf0174cf2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/commitPipeline.js\":\"85686ba7ee6a653f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/devAssertions.js\":\"8540fa0e6e0655d5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/firstSync.js\":\"8f3dd4403c6b6b27\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/freshInitialLoad.js\":\"ced9f6e35ccf3fd7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/graphBackfillClaim.js\":\"d7e78367f45a81b2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/handleStore.js\":\"6c15b8a432c7c0e4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/idleMarkerJobs.js\":\"7032fd62f4aaf5ae\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initialDownload.js\":\"fc75c4888c4a5af9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initializeClientDatabase.js\":\"43c921aaa12bca13\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/jsonCanonical.js\":\"2db0ab6ade5f3cb6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelInvalidation.js\":\"66bf04696b2ca38e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelProcessors.js\":\"64071f18ff8e022d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelQueries.js\":\"d7b5d9dd3a8b00d5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/mergeTypeMembershipProcessor.js\":\"e343969cd785d7d7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/normalizeReferencesProcessor.js\":\"01744cbabff40b8b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/poolInstrumentation.js\":\"f23201761e121291\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/processorRunner.js\":\"f70a033952f755f7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyCellBackfill.js\":\"dd2678d097e501b3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildMint.js\":\"9763649f67d3874c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildrenProcessor.js\":\"0f83bbbaba601e25\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionChangeProcessor.js\":\"96d6c41c06c3af4b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionSynthesis.js\":\"52fc08207157a794\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyKeyScan.js\":\"a11c5313e35ac083\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertySchemaResolution.js\":\"bf80c5c4ba2dc1a9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyValueEdits.js\":\"eac36b28524eb726\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/raiseProtocol.js\":\"16ee10f1bb3bd7c1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/readBatch.js\":\"57d59f35299237e7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/refProjection.js\":\"6394056b8eee6344\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetLookups.js\":\"82a75f4c0cabe3a3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetProcessor.js\":\"62a7adfd7f68aeed\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/replayMerge.js\":\"7f51e9473cd9c236\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/sqlBinds.js\":\"3f3c1640f5ffd9ba\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"01d09baf607af08c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/arrivalProcessors.js\":\"76f52cfe1e0da3f5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/invalidate.js\":\"7b72b0c15cee8514\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/materialize.js\":\"f2840b02e35677e3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/observer.js\":\"45ac7e714d6ac943\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/reconcile.js\":\"8a10bba60d2fb1b5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/timingMetrics.js\":\"c27ef4b4b7c12b7a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/treeQueries.js\":\"8852c951d5d6ae39\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txEngine.js\":\"d5434d24e086d16c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txSnapshots.js\":\"179c11bad15be822\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/typedBlockQuery.js\":\"4bb1260eca869b30\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/undoManager.js\":\"bd0ec2ad008f623e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/invalidation.js\":\"943fba546ea4e6ed\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelDataExtension.js\":\"016b8f5e098b4800\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelPage.js\":\"98aabdcb9bda5d6b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelValuePresetCores.js\":\"070ddc28aafadbb7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbCorruptionSignal.js\":\"3359bf3de9360e1f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbStorage.js\":\"b41e420855bb158b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbVfs.js\":\"f7b198351cecb174\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localSchema.js\":\"fd589fd20c11941f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/maintenance.js\":\"e6f46024aaa8b55c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mergeProperties.js\":\"11202aac92d33476\",\"/knowledge-medium/pr-preview/pr-1912/src/data/metricsConsoleHook.js\":\"98648bc310483bcf\",\"/knowledge-medium/pr-preview/pr-1912/src/data/migrationsPage.js\":\"0bbeda399ff26237\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mutators.js\":\"fd3afd40e3674ea2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKey.js\":\"c7a5fe577a04afab\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKeyPlacement.js\":\"2cd3a0741190f017\",\"/knowledge-medium/pr-preview/pr-1912/src/data/outlineSurface.js\":\"01d0f38d7acb5da6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingEditorContent.js\":\"fb4d0eedf800db47\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingUploadsSql.js\":\"5fb525fe12e9473d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pluginStateExtensions.js\":\"e82ab6d6b3a5f842\",\"/knowledge-medium/pr-preview/pr-1912/src/data/powerSyncLogger.js\":\"27894c6a9a208d33\",\"/knowledge-medium/pr-preview/pr-1912/src/data/projectorRuntime.js\":\"e0138dc93f5e9784\",\"/knowledge-medium/pr-preview/pr-1912/src/data/properties.js\":\"d665f5328ce1b6c9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertiesPage.js\":\"2a77fa84d1e8c7c9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyChildren.js\":\"1488cb94a35f2210\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionFanout.js\":\"e2df0bd0cd514d7e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionMetadata.js\":\"252bc1d5dd5dd945\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionRegistry.js\":\"66032d59d8d8686e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDisplayMode.js\":\"15fe7867d5cb8457\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyRowCreation.js\":\"cc0ddf6d5a39cca8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySchemaCreation.js\":\"e6828cf5ac68c4cc\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySeeds.js\":\"69df931d4dc5b1d8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/recentsPage.js\":\"4b8e7fc632a29952\",\"/knowledge-medium/pr-preview/pr-1912/src/data/refTargetComparableProperty.js\":\"b5c65ef704cb2896\",\"/knowledge-medium/pr-preview/pr-1912/src/data/referenceBlock.js\":\"bb54f2f4223b5c0e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rejectedUploads.js\":\"3c599ce27bb1da83\",\"/knowledge-medium/pr-preview/pr-1912/src/data/releasePowerSyncConnection.js\":\"090ae88f466ac7bf\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repo.js\":\"3fca92e12d7d27a0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repoProvider.js\":\"eee37fb63455c258\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rowProperty.js\":\"a6d26b9c645f822f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/searchFilter.js\":\"0ff60aa889d81031\",\"/knowledge-medium/pr-preview/pr-1912/src/data/seedIdentityLedger.js\":\"b8a40941f233bd26\",\"/knowledge-medium/pr-preview/pr-1912/src/data/stateBlocks.js\":\"f76173171821761f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralEditPolicy.js\":\"39f853a1ed467d1c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralInsert.js\":\"394bead7eeae2bd4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/subtreeDelete.js\":\"5fb9de2294d3a139\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncStreamLock.js\":\"ca5eb7f2fe489844\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableSqlRecognizer.js\":\"1bb76d75657f37a6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableWriteGuard.js\":\"a4e9aa134fe255a2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/targets.js\":\"908693d4717dea5d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeColors.js\":\"bda65635ada14ad1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionMetadata.js\":\"5444a39b5a8527f4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionRegistry.js\":\"b89c1360d10212b5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeExtraction.js\":\"df4c35a82c1f68eb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeInitialValues.js\":\"162bdd7ee8e4e656\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typePropertyGroups.js\":\"df3158646b135ac3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeSeeds.js\":\"d8693120416d0be2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeTagger.js\":\"fa826ad55aed704a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typedRecords.js\":\"cb55fee6f51103a3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typesPage.js\":\"2994b6082c8c91e5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userPrefs.js\":\"9c25ff4439c3dbb1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userSchemasService.js\":\"736c26c9a6c37437\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userTypesService.js\":\"24f2c418571932c0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/valuePresetRegistry.js\":\"a74eec814890c77e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/visibleChildren.js\":\"ddc2b4544e88d8e6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceConversion.js\":\"7385a546dbfe4839\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceFirstSync.js\":\"66f16a079c6a9ac9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceIdNamespace.js\":\"bdc715788883cbd8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceSchema.js\":\"80ee8c4f092ce7b5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaces.js\":\"d16944ef16d42f4a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadLog.js\":\"29d993acc03fede9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/BlockPasteShellDecorator.js\":\"ce5098b527e1f2e3\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/atTrigger.js\":\"8d7594fa20489af4\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/autocomplete.js\":\"06930c6d9884f557\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/codeMirrorExtensions.js\":\"ddecb518e322a364\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/contentFlush.js\":\"f1a4eee502316a8f\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/defaultInteractions.js\":\"5d935f133f4be563\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/editSettleSignal.js\":\"176a448f63f5af2f\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/insertImage.js\":\"334064815de80cc2\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceCompletionRange.js\":\"0baaf711b7f96ca4\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceTargetTypes.js\":\"fdd2955a4db3d9d6\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/syntaxContext.js\":\"03c555f25fcf913c\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/triggerMatch.js\":\"d5ad2de9c1d9cf6d\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/AppRuntimeProvider.js\":\"8bf80c411f7e0507\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/BlockFocusShellDecorator.js\":\"f1bcfedce271a35e\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/ExtensionRenderBoundary.js\":\"2fd7494a7cfa33f6\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/PanelContentRecovery.js\":\"2b0b884140cf30d6\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/apiCatalog.js\":\"eec78294832c4ca7\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/approveExtensionHere.js\":\"cde2a0e2acf0fd17\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/armedCutAppMount.js\":\"8e209dbc3fd73b0d\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/batchableKeyedStore.js\":\"eee61099ee1c5118\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockInteraction.js\":\"9f338dcd94fcedef\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockSelectionAction.js\":\"5662054168ab33c8\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compileExtensionModule.js\":\"39a6e2b8098a80f2\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compiledModuleCache.js\":\"8072b3dd8816a5b9\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/continuousGestures.js\":\"4f9c7a0a884adfe0\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/core.js\":\"5678a6819f2b8bd3\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/defaultRenderers.js\":\"f5b2311ea75c8c61\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/definitionFanoutAppMount.js\":\"5b28087ef5f5ea58\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dialogAppMount.js\":\"c8405c9870d62068\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensionSeeds.js\":\"dcdea041ff90ac57\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensions.js\":\"76a0c95231ace6e4\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/exampleExtensions.js\":\"e5611ed0f961b6d1\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionApprovalStatus.js\":\"3e2deab16a1018f1\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionImportPolicy.js\":\"0faa4212b2922cfe\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrorToast.js\":\"9b64ccd2675be23f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrors.js\":\"f0c6b43b43eb5c2f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLookup.js\":\"ce4a908766557cb9\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionToggles.js\":\"4d84ddc49dd9af3f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionUtilitiesCss.js\":\"eb54dddc5bafc88f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/kernelPageDeletionGuard.js\":\"5c45fdb64f15a4b9\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/liveRuntime.js\":\"921bf8e394c3c171\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/normalizeExtensionSource.js\":\"b08594a9a8dd7644\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/openExtensionsSettings.js\":\"03993a17332e73e5\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/overridesCache.js\":\"ed96d0e791eef27b\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/pluginIds.js\":\"2c8e41ca56b273ba\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/processorRejectionToast.js\":\"b151b1c5897f8e36\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeActions.js\":\"139a4157d788345b\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeContext.js\":\"6be8a33602c8ccc8\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticAppExtensions.js\":\"b238402c37ce879a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticDataExtensions.js\":\"336e0795c3acb25f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/toastAppMount.js\":\"b648ee57ec7498fb\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/transpileExtension.js\":\"85671792725106a3\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useOverrides.js\":\"248f01e67d903b24\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useShortcutSurfaceActivations.js\":\"5ccbe87ccd66e730\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/discoverToggleTree.js\":\"ff7b6eb71921273a\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/facet.js\":\"e7558fd26c502d73\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/resolveAppRuntime.js\":\"c08847fc9d2f60e8\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/runtimeEvents.js\":\"c444b8d938a02764\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/togglable.js\":\"542ae5b860ac9c6d\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/variantFacet.js\":\"afd05a09baccdc3a\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/verbFacet.js\":\"86ffd4849da86487\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/block.js\":\"90e80f9b9de0e39f\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/focusedChild.js\":\"a48c05bf2c5da61c\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/propertySchemas.js\":\"67a0e88e688df5c9\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/typeRegistry.js\":\"8e372b1f6c3b052a\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAncestorCrumbs.js\":\"3458adbd1b5792f7\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAutocompleteListbox.js\":\"a639656fe46d2967\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedSearch.js\":\"e573e0bc291c36fa\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedValue.js\":\"0d7ce47f7b5f9e88\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useFacetValue.js\":\"b65f52ef611f00fd\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsFocalRender.js\":\"8d69b9c737f8eaa9\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsReadOnly.js\":\"6fba3eb2cf3d21d4\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMaterializeBacklog.js\":\"5286a586e5084458\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMinuteClock.js\":\"4863e2e1b685f5b4\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePanelLayoutProjection.js\":\"68bfb991ffed2e9b\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePendingInvitations.js\":\"7c0e99e6b9aff0e7\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRendererRegistry.js\":\"7568e022148cca43\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRetainedFieldRows.js\":\"6d8af17a9d82be50\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useWorkspaces.js\":\"76d2191300edab6d\",\"/knowledge-medium/pr-preview/pr-1912/src/lib/utils.js\":\"b5f6fe0d6e2687aa\",\"/knowledge-medium/pr-preview/pr-1912/src/main.js\":\"4c69332b5aa4cb97\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/MarkdownImage.js\":\"af8e227dd0746975\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/blockSeparators.js\":\"93b68f74eb3386d0\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/context.js\":\"8bbc72bb85148a69\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/defaultMarkdownExtension.js\":\"3415005f49a0a441\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/extensions.js\":\"4a4a951f852921f6\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/renderMarkdownHtml.js\":\"93ab521a8da21012\",\"/knowledge-medium/pr-preview/pr-1912/src/minimal-editor.js\":\"0a37d94e549d87c1\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/armedCut.js\":\"34cf6aabc9457f5c\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/captureMediaVerb.js\":\"830b0839ba5843c0\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/clipboard.js\":\"6492785c95f0b92f\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/decision.js\":\"f38f936cd0dc0f18\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/operations.js\":\"25608b940427d4e4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/AccountHeaderItem.js\":\"7e9a84c39c6b4188\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/index.js\":\"a05fa0fe2dba4dbf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"dbc408a781d44e54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askAgent.js\":\"45f3800aa6eda2f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askedStore.js\":\"9a3578fa561ba690\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"17d2edde588bc9aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/chipState.js\":\"b95ac7c3b112acbc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/dataExtension.js\":\"88b7c727fc2214d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/index.js\":\"5bbdc2b7b76285ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"bb8e1eb456fe521c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/schema.js\":\"213993a94d63b236\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8a693eb95d7594f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/BridgePairingDialog.js\":\"d643511262e006d0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/addMedia.js\":\"4c443a72564d7966\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/backlinks.js\":\"58ba1b961f4a09bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/block.js\":\"e52e16fe21e50b42\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/context.js\":\"c477445acd393d80\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/displayIds.js\":\"275199d8ca8695f6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/index.js\":\"bdfd4e4c1a7fae10\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/outline.js\":\"a603e13f8299a7de\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/properties.js\":\"42945f0eab7cd953\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/refs.js\":\"40160ceb2a5755ae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"17c108475c8281b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/search.js\":\"e314ff52622a3248\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/shared.js\":\"d3df5f4952350464\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"435376d4c4ede1e0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/text.js\":\"3679c6420644db97\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentWrites.js\":\"382b4ddfb0987187\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/authoringCatalog.js\":\"88418004ef4c00e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/blockRefTargets.js\":\"c08c4e55cb2d7b33\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridge.js\":\"cddbaef0f1ae5cfc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridgeLoop.js\":\"fbe533aae85ab4c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/changeHistory.js\":\"e0e1669592d816f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commands.js\":\"74152017fae7b20a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commentsCommands.js\":\"2abd2bb384b4e0da\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataExtension.js\":\"61e50c8f54736920\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataModelGuide.js\":\"640eb0be29ab6b6c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dayPropertyInputs.js\":\"37578b5aeee3e117\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/describeRuntime.js\":\"c1495fb748fd2e2f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/extensionLint.js\":\"0cea492f3b6c4e30\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/grainAudit.js\":\"831f319f5985a5b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/healthCommand.js\":\"52919060087b2e9c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/index.js\":\"9b7899b50452e767\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/presetIdentity.js\":\"e2c9c23fe3bde171\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"170c2b8fcf79e20b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/readMedia.js\":\"64e08fc9852222a9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/schema.js\":\"83c24eb837928be4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/serialization.js\":\"4f218de5103ee964\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/targets.js\":\"f1bfee439a554ec0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/tokens.js\":\"14b5528ff75294bc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/watchEvents.js\":\"587bc85dfd12c093\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/workspaceGuard.js\":\"d985caaee255adc2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/writeCommands.js\":\"eee233062c10a6e0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/AliasCollisionToast.js\":\"08885081688f893f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/DuplicateNameBanner.js\":\"a6775a71c8c09fe8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/collisionMerge.js\":\"fae0d98ff3eb6e94\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/dataExtension.js\":\"bdd840a783aa91ae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/index.js\":\"08d917dfa74e2e56\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/mergeCollisionAction.js\":\"6732307c77bb8130\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/pageStyling.js\":\"47b2bf19f38a022c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/rejectionToast.js\":\"7714a2d0ab08b224\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/syncProcessor.js\":\"0ed33dcb08c9bed4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/actions.js\":\"deeb3c0064a5eb1d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/addComment.js\":\"ef1dda64fe8de245\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchor.js\":\"e857af83f6357ba6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchorState.js\":\"c987365937e8aef2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/commentLinks.js\":\"60752fa653ca54a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/confirmThreadDeletion.js\":\"e60a2092dbcb719b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/container.js\":\"d4cba8dd09c505ee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/dataExtension.js\":\"64c010de36461178\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/deleteComment.js\":\"a13108d48543bda1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/highlights.js\":\"bbe29e66b6635771\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/index.js\":\"a5910b73a426e1b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/linkedCommentsPill.js\":\"30c73adcf7dcf584\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/margin.js\":\"9a5569d1ca374a5e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginAnchorLinks.js\":\"1002ce2283115fd8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginSchema.js\":\"694945e985dd3ab4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/newComment.js\":\"8df242ece548fc8d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ownThreadPicker.js\":\"fb37596c68c28697\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/placement.js\":\"f6652dfd31537256\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/queries.js\":\"de8ecc14fba36d21\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotePosition.js\":\"062f60fb9ace51af\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedIn.js\":\"75cd1eea410ef4b0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedRange.js\":\"8c62eccd69c87f27\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/rangeRefs.js\":\"496ece9a579f6448\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readHighlights.js\":\"9e442115a177d44e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelection.js\":\"96b0dffa68d11c9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelectionUi.js\":\"2c8c528999ea3404\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/reanchor.js\":\"e583380280557201\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/schema.js\":\"ba3fd925fdb9c669\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scope.js\":\"74ad0dd6aad79526\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scopeThreads.js\":\"0fe31b18ac99a3aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/splitRetarget.js\":\"b50a3de2864daf89\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestionCard.js\":\"157e9cee4b92d4a8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestions.js\":\"e997152cdea3b0b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaries.js\":\"7a99e60629b9300f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaryBatch.js\":\"766aafc9331a7879\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/surface.js\":\"1ec7479ae34dc659\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threadNavigation.js\":\"92424654bec5cd5a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threads.js\":\"6146b662670a6074\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ui.js\":\"4c9cc1ff4f44056b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/uiStore.js\":\"d42dd0d629748caf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/appIntents.js\":\"354eb8f780750591\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/index.js\":\"a1276290ca9f072f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/index.js\":\"91f673ebced8a2fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/status.js\":\"0bdeb41e61f5d9f4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0fe1aef38d8d7e7e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaBlockRenderer.js\":\"1e90c3353a3b6283\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaDownLaneReplicator.js\":\"204959e1add2bdfd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaUploadReconciler.js\":\"80cd0c98ad5a0c75\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetDownLane.js\":\"a44da627ad75c4e8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetResolver.js\":\"a41bbec83895f32f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetUpload.js\":\"64cd78f210d14a2f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/attachmentCleanerIO.js\":\"54e1aaaebd6b54a9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/supabaseAuditIO.js\":\"6e15a7855c649942\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/blobStore.js\":\"fe7603146f08396d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/browserMedia.js\":\"a87268029636356d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/byteStore.js\":\"2d03625454181e7a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanerIO.js\":\"390690f7b0e959c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanupAttachments.js\":\"575c431a42b4f80f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/dataExtension.js\":\"26356b6c4cd5115e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/downLane.js\":\"9042dcbec41629b4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/index.js\":\"167579fb876dd7f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/insertImageContribution.js\":\"0483d0031c0f7797\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneArming.js\":\"f33fe36588c1a6af\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneLock.js\":\"9142882369862a12\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaBlock.js\":\"ce2590742d7051fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaCapture.js\":\"ff8664ab4913f543\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaLanes.js\":\"d2e8ebff70e1eb3c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewers.js\":\"ea459b243cd24235\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewersFacet.js\":\"42c647a3e301c33f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/pasteCapture.js\":\"afd2fd3b25eff7e2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/resolver.js\":\"f9df7b319162edd0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/retryUploadsAction.js\":\"f7b853703757c983\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/storagePaths.js\":\"998a5236aa7e58aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadDrain.js\":\"974ee25391c4f295\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadLaneStatus.js\":\"675850ec236c7c0a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadReconcile.js\":\"121ce7ab1e0be06d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadRecovery.js\":\"ffcc7115b7780211\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadStore.js\":\"e314acc44a6e0f94\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/useAssetObjectUrl.js\":\"e90c9d02092f3d7f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"30a24770f4cc664a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3264031367229303\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/facet.js\":\"3c16fcb5d0e8a0a5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/index.js\":\"875961ff478fc373\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/prop.js\":\"82189d48fd9bd1fb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinkFilters.js\":\"526c10b61f1f86d3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"6d79c7302c161adc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BlockEntry.js\":\"33c4b80c5878d646\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/LinkedReferences.js\":\"23bb6848c2d4840a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"3236dca29a14131d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dailyNoteDefaults.js\":\"7193372677996b22\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dataExtension.js\":\"ddca792ae2ec401b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/edgeExclusions.js\":\"953c9fb45b8b9269\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/filterProperty.js\":\"d5584cbf3b630a63\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/index.js\":\"31425bd864d6a93c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"99a97b2dc36ec5d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/applies.js\":\"372e97bd56e7483d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/countQuery.js\":\"a5738190a4ec8fba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/expansionStore.js\":\"06a9fa8fe2ec42f7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/index.js\":\"902d3cbb0181b9ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"50a7a7a5f4e503c1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/presentationInvalidation.js\":\"487a2ffc3dc59fca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyEditorOverride.js\":\"8d52e9f2c483626f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyFilter.js\":\"61429964bf2312d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/query.js\":\"baea6317616506fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/resolveFilter.js\":\"e0759c4e9111438e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sourceBatch.js\":\"a0400d9ea921f387\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sources.js\":\"f6470001a8cd3ef5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useBacklinks.js\":\"621b51a711b4a9c9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2316d10e319c0c1c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayCelebration.js\":\"42a84e01a493397f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayOverlay.js\":\"535d260f524eb0b8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/gate.js\":\"4f39f276647ab704\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/index.js\":\"41957c3502c21c56\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/wolfTheme.js\":\"47922501060406f6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/BlockDragLayer.js\":\"652eb02f9cca039b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dragController.js\":\"307cd3b6fa1c49ac\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dropTarget.js\":\"d0fcb08792131edf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/index.js\":\"c35790e283521f50\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/projection.js\":\"9584c8d00b13a024\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/BlockMetaCard.js\":\"7d18f956e094c7d0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/index.js\":\"048d81eb6b1ce3a0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/AddTagDialog.js\":\"264e2c5d61685d42\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e08edcfb8ca29e08\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/TagNameIssueHint.js\":\"288a0801e3339d7f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/addTagAction.js\":\"241ff49b3a9c79f4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/appendTag.js\":\"30120353e2b1cf62\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/config.js\":\"ecac98b272fd4655\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/dataExtension.js\":\"ce44b78002688118\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/index.js\":\"397a508e78a1757a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/propertyEditorOverride.js\":\"0a10f0f29b8135d9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbList.js\":\"4ebb7efc3f9f3386\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"28711d236fd7cc66\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/Breadcrumbs.js\":\"b03e969e9d4da0d8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"ee0276afa27983a5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"942dfcadacc84941\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/index.js\":\"06f36019478e3046\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"332c54d7a990cffa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/CharacterCountItem.js\":\"0cca3acaa6161388\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/ProfilePropertyEditor.js\":\"a2aaebe35182d1f4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/actions.js\":\"8bbada0204860b0f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/blockType.js\":\"ebcafb46e3ebd3db\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/charCount.js\":\"65d4997b9b3f4679\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/dataExtension.js\":\"62ef286eb5008a47\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/index.js\":\"0a507395fe7906a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/profiles.js\":\"17a3e3b892b35952\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/properties.js\":\"9d6041f6490668fa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/subtree.js\":\"fc974eb445a5d797\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/textCounts.js\":\"6b30993703a861bc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/colemak-keybindings/index.js\":\"fd28f61f0016234b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/CommandPalette.js\":\"a5576f4cd0bccb81\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/HeaderItem.js\":\"ee9662f8baa4e943\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/context.js\":\"6b59a59a74c81f74\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/index.js\":\"6a05ec5c08f67b38\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/selection.js\":\"8772033bacb6a498\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/toggleStore.js\":\"6b35612c219f33b3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/useCommandPaletteActions.js\":\"a42dd3740d00364f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ContributorBadges.js\":\"6e734f1cf5e4f5ad\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ProfilePicture.js\":\"a88f0bb73679c5d6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/author.js\":\"476ba235c8eba3aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/codeMirrorExtensions.js\":\"31721d8dc3966d1d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/dataExtension.js\":\"35e2a29e710700ae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/index.js\":\"366a6a4396c92ae1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/mentionAutocomplete.js\":\"e268f420183d31cb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/processor.js\":\"8eae228e35a8ce50\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/profiles.js\":\"5acd464438d3d6fa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/queries.js\":\"6c4661a91baf9a87\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/schema.js\":\"34f5fa550ced235f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/useCommentAuthor.js\":\"e8e57d8f363577cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"59b7a96c05288df0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/followOrigin.js\":\"2c40f229fa9197d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/index.js\":\"26fd09e2bfd03682\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1c4ab3e4ad841456\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"f537bae6955bac57\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/CalendarGrid.js\":\"07d3fa369e80269e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DailyNotePicker.js\":\"3aafa6e961993eae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9827b4edfe12bdfe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateNavDecorator.js\":\"77464e858e5d0947\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateScrubOverlay.js\":\"f064edfc74d1255e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayPropertyControl.js\":\"b29d040de2da2509\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayValueReferenceControl.js\":\"e2a26293ffb608ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/HeaderItem.js\":\"3f581693c75c3981\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/ReschedulePicker.js\":\"de6d1f3cd955f325\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c5e7b321b3f1fda9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/actions.js\":\"c62367a685ad18c1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/blockDateAdapter.js\":\"9d13fe149992b30d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/calendar.js\":\"b0ef66fe6836f885\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dailyNotes.js\":\"8318db7b4639c2be\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dataExtension.js\":\"f4ae7eca75cebe07\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubActions.js\":\"121cc7f5ddbb3583\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGesture.js\":\"26e9f59ecf8f11b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGestureActions.js\":\"4d9d3dda24b6d312\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubRecognizer.js\":\"24f62a2b0ef1e175\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayProperty.js\":\"c7cc00fa890b2744\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"a46c57d99a07df0c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/deletionGuard.js\":\"4a493c988c285784\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dueQuery.js\":\"29f091991cc9978a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/index.js\":\"477c9699c2a84cbb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/landing.js\":\"688eff457fd32dda\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/localSchema.js\":\"73abc2e65eb19ff5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/referenceDateAdapter.js\":\"5144291d3a426ed2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/rescheduleAction.js\":\"c0f526f547b45bd6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/schema.js\":\"a1a5ca0278b4d651\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadBlockDates.js\":\"9032cdcae51dfca8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadDatesAction.js\":\"47d9f16e2dc314f1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/today.js\":\"5236dabfbfd5f6ed\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c11315426b40e63c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"be2894c06e26c723\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/audit.js\":\"09f790a66c00d8f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditAction.js\":\"e66a9bf222986ab2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditRanges.js\":\"a7b75ba99b0fca70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/diagnosticsSource.js\":\"a72e0951595c27bb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/divergenceScan.js\":\"5b8ee6df0c996635\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/index.js\":\"f806c6a6cf2e5292\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/propertyChildrenChecks.js\":\"9dfdf5dfef08b7f4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/referencesMirror.js\":\"6c12b11daad9e97f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/rowJson.js\":\"c88fa035fc958e29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/schedule.js\":\"8a4226e4fc0c3c06\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/store.js\":\"cf4aa0af085de992\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/action.js\":\"2c1090b48aa56371\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/index.js\":\"2c18fc9f6353c896\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/plugin.js\":\"8801ab89501324df\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5b3c8e8fb0ddc3d5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/actions.js\":\"f980f325eb0f0342\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/changeMarker.js\":\"4acab1e7ab3e1be5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/diagnostics.js\":\"464beae12f99ec3f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/fileSystemAccess.js\":\"ef967a6a1cf07389\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/filenames.js\":\"46887c629ec188de\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/index.js\":\"4c8890ee698ac92b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/mirror.js\":\"507334fbc0c1ff0a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runLock.js\":\"c331757cc320ea25\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runtimeHealth.js\":\"aa3839621368899e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/schedule.js\":\"b939a3c463241a09\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/store.js\":\"d67b303144c15321\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/index.js\":\"a0c08eb60765734c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/themes.js\":\"93ae837d1e3faf6b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/facet.js\":\"e39a813d45307aef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/useDiagnostics.js\":\"5ae7e2371147c1bb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/dismissals.js\":\"97202a5bcaa4df12\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/index.js\":\"c63510231e91f1dc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/status.js\":\"3bddb71c9ff96e5b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/store.js\":\"72a13b3069f6cff7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c170b4cc431a9c79\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsSettings.js\":\"fe0b3132cd5319d8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/actions.js\":\"026828350bcaba56\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/config.js\":\"62b7c54e30e1725a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/dataExtension.js\":\"bd112ab5302229dc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/effect.js\":\"66816718f7fce8f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/index.js\":\"413d4f952c161aa8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a461912304ca5705\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/useToggleTree.js\":\"6fa4ce58e40c544a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/ExtractTypeDialog.js\":\"93b7d01b6a604253\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"77b9845b7be04d71\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/PropertyShapePicker.js\":\"52cf1aa760703c3d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/action.js\":\"f0599a3fd39da923\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/index.js\":\"3ac261bab207d336\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/FindReplaceDialog.js\":\"333e6223ec7beada\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/HeaderItem.js\":\"391ed181a70b8d88\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/dataExtension.js\":\"495b9d43ef892152\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/index.js\":\"9af2086e81de2631\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/search.js\":\"3db64c5d041f3e3a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/toggleStore.js\":\"7d4a9fbfb5aa58a8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/LocationPropertyEditor.js\":\"a1f85e187bba736d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/MapView.js\":\"be3dd430f59d3ab9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/blockTypes.js\":\"0338a1ac592c0e46\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/codeMirrorExtensions.js\":\"8baab18783f3bb1c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/createOrFindPlace.js\":\"8a5605168823f9ea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/currentLocation.js\":\"f1b54a030e7b3be8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/dataExtension.js\":\"9d0995e80f5ab75b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/geoContentDecorator.js\":\"233d2487e03d175d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/googlePlacesClient.js\":\"c7ec318e863108f8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/index.js\":\"bfd5447fbc3aad37\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/locationsPage.js\":\"4c89b3875804e075\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/mapViewport.js\":\"3354fee7c28c1649\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/pickCurrentLocation.js\":\"471344c8920ba838\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeAutocomplete.js\":\"92e5e2da0b9508ab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeNameCollision.js\":\"cc29c5068c66852b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/properties.js\":\"03bcf312ba9f0256\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/propertyEditorOverrides.js\":\"d1fcdd199a92c665\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/query.js\":\"3e632c2ab090fc85\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/usePlaceSearch.js\":\"9193b34a895885ce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1a18735a5a23e90d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"411ec1be8c006549\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"03711dabb8b96278\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/config.js\":\"d961de7bf63f5abf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/dataExtension.js\":\"6d3f615bdb058b29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/facet.js\":\"406a9d95b055350d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/grouping.js\":\"d98711873187455a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/index.js\":\"45380e3b3ae2b98d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f4c15ea85039401c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/query.js\":\"861dbb02c283869a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/resolveConfig.js\":\"104e0d521e899263\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d8d466590b402e79\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"e24220ecae8a0785\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlDocumentContent.js\":\"debf90efc732305c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlFrame.js\":\"8c58108b9958e4c3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/actions.js\":\"a4774262c9286ab3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/blockType.js\":\"4f98356753ba35bf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/confirmRunScripts.js\":\"95d2adf23df92451\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/dataExtension.js\":\"d94795bd90fafb47\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameAnnotations.js\":\"f521618247846f54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameDocument.js\":\"0e21445772228ac5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameTheme.js\":\"7533d132064f6510\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/index.js\":\"1254ea32cfb0695f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/scriptConsent.js\":\"60d5bcd1f068145e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/sourceMap.js\":\"997a9d35515aa4f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/useDocumentScripts.js\":\"9591f26a9496cfe1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/index.js\":\"ebaf9777c9de9615\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/record.js\":\"de1d37b53013cdeb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/recordStore.js\":\"0e2ee1894a1c52b6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/responsiveness.js\":\"b4dbc5cdf630de41\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/schedule.js\":\"bafdee5a3b97a60d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/sessionContext.js\":\"7b9af7a7a78ae6cc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"0c410bb9235b8a63\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"7e8b620012aa8f1a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/actions.js\":\"e3d4a1429da2ac96\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/config.js\":\"ca60f8d2e303264f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/dataExtension.js\":\"84d55c97423e973b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/effect.js\":\"b94fb28a1afb872b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/index.js\":\"1e55229533fb6a39\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/keyCapture.js\":\"673f11aa2f803eb2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/overrideStore.js\":\"72094e13e66a04ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"a7644b006d8131c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/HeaderItem.js\":\"4373adb8fb65ee29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/LeftSidebar.js\":\"165f33f00857d476\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/actions.js\":\"ac2208e6e1e7adab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/facet.js\":\"ded2be9f45a3218b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/index.js\":\"a2e28820464aea7a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/shortcuts.js\":\"f37a190c28a6f07e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/toggleStore.js\":\"eb8ed50fb1dd893a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/MergePicker.js\":\"6b67a285617529f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/index.js\":\"2e9cb2197ce59987\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/mergeAction.js\":\"45c3236a17dbdd1d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/strategy.js\":\"53ab59229ef3bcce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/Button.js\":\"4ee9e92941c15b44\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"43b46de7c3a29f3b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/defaultItems.js\":\"83d40027d770ac54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/facet.js\":\"31f015ebba9b5daa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/index.js\":\"503f1e306575e41d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"15b280e604a99187\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/actions.js\":\"053bcf69b3ca4c1c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"db807a975195f42c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/facet.js\":\"111cad47cdd558bf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/index.js\":\"fa292f2eae4be1e3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/MoveDestinationPicker.js\":\"6d58fc4179f2cdbc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/blockSubtreeMembership.js\":\"3efa6592bc0cbb9a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/contextMenuItem.js\":\"a893e902fdee180b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/index.js\":\"db6e6c63dcceb743\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveAction.js\":\"a4f4d0d9465663d1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveBlocks.js\":\"74a82d5f6444825b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/selectionAfterMove.js\":\"5b7a92416ed5b378\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/TutorialBanner.js\":\"40a7d80f60dcf8d8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/action.js\":\"54119b05bb8f0a30\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/bannerDismissal.js\":\"be6222376e7f6ac4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/documents/cheatSheet.js\":\"b751cb5388e7c5c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/index.js\":\"16b7084c0c494d4c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/keys.js\":\"b090d847a4f85990\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/landing.js\":\"5efcfe29b84b86d5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/outline.js\":\"9819a6b0c08896ee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/seed.js\":\"a21a6b2d1eb85006\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/PerfTrendDialog.js\":\"798b7d189b9a6851\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/analyze.js\":\"f807d262c21e9a9e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/diagnosticsSource.js\":\"e71aa8e263d75aee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/index.js\":\"f535994995f8af09\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/load.js\":\"0becacc1622ea6c9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/monitorRun.js\":\"5fa13df68320878b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/schedule.js\":\"8e1550b9a664a8e5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/series.js\":\"0fd4959c6f2f1fd8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/store.js\":\"845c00e842640fcd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/trendAction.js\":\"2b9706b14343a3e4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/verdict.js\":\"025ad42e414cc29c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/clickToEditAction.js\":\"7cfd56ccf28a4d60\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/index.js\":\"94ecf64196a00328\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/interactions.js\":\"42a583bc352c0bee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"0f1f70df116f9346\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGate.js\":\"9d2cce454f6cdaea\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGateDialog.js\":\"0be7a941425c7172\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/action.js\":\"5450dc170219e235\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/index.js\":\"b4995d51274d479e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/localRunMessage.js\":\"f9bee7a388a019b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/plugin.js\":\"e0c5d7a6de831822\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/progressReport.js\":\"5c9001f78e319d8c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/sweepProgress.js\":\"b75adbc8655089a2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/FieldRowRenderer.js\":\"ce73269973f82a0f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/ValueRowRenderer.js\":\"f51edb91c86574bb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/actions.js\":\"1f664a3a4e7c4db1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/autocomplete.js\":\"2708f5b2696a8132\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/fieldRow.js\":\"c0df97c25f6b77cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/index.js\":\"f4ab74ff4b7cec6f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/referenceWarning.js\":\"80cb4d7d313dbbd2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueAutocomplete.js\":\"7061ce5871571440\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueSchema.js\":\"0bdcdb3a74139a80\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/HeaderItem.js\":\"d0b1be5d59f31d92\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/QuickFind.js\":\"2afc9f8e64b81281\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/index.js\":\"19e4242046a3c5f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/recents.js\":\"b393120dfda108e4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/resultItems.js\":\"11b09a377b6a121f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/selection.js\":\"363043d7111f50fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/toggleStore.js\":\"166c2a75da96c6d0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/HeaderItem.js\":\"2c4a74bec26f5b9c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9d78dddbc22f1ae4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/grouping.js\":\"560f91586f6ad17f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/index.js\":\"a3d1ed041526928b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/target.js\":\"bbee4a517f967a19\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/codeMirrorExtensions.js\":\"2b8aed18eaa97177\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/contentPrefill.js\":\"8c0ae9af133987b4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/dataExtension.js\":\"b61b74e85881dd30\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/index.js\":\"6f2d3fb991e3d3d6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"f4d7a43ab2ef5066\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/invalidation.js\":\"9a5fec89f584af4b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/localSchema.js\":\"c019cdb23288503f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/index.js\":\"8bf9adf73424e01a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"097689c3925b250a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/index.js\":\"9701136552dec41a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/referenceNode.js\":\"9f43b2e4f957a2cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4a84e270c130d944\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b3222a0b539bff20\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/index.js\":\"7c19c215a37d466a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c1c2bf8d5c631e16\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a3b2d9172ea983af\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/mergeRetargetProcessor.js\":\"878a31787cc84ab8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/parseFence.js\":\"a0728e54c747fc74\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceParser.js\":\"10d9b24dca7eddee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceProjection.js\":\"53eea0056e2f1210\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referencesProcessor.js\":\"6faf4d87120d7ddf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/renameProcessor.js\":\"07b462c369bab4ed\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/spanReplacement.js\":\"fc46a2b08703dfb2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/htmlToOutline.js\":\"c6db58834972acc1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/index.js\":\"ab9d7d13cc7bc95f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/normalizeClipboardDom.js\":\"014b0530584cc66c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/pasteDecision.js\":\"91c8ec750048b509\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/action.js\":\"46a42cf5eb28216b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/blockIds.js\":\"20d7689961d71a7a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/content.js\":\"334c5f79d646540e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/effect.js\":\"d7218b3023918783\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/ids.js\":\"19bf9790dd2f9d72\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/import.js\":\"f19abdff796c1ebc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/index.js\":\"c664bbb76dfaccab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plan.js\":\"1cf6ec7cae7e9a47\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plugin.js\":\"e86bfb1a9e722b45\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/promotion.js\":\"2240e20cb0ca19c6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/properties.js\":\"33426d78fde971f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/references.js\":\"808613bb22338ba4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/report.js\":\"945e9ae519b3bf8f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/roamMemo.js\":\"61d2258c68ffdbd9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/runtime.js\":\"b078e518229918fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/schemaReconciliation.js\":\"13902cac42ba8bc6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/srsMarkers.js\":\"a097575bc17c0d61\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/todo.js\":\"e1ea1285a7e8dc23\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/typeCandidates.js\":\"6c77dab5cd0aff26\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/types.js\":\"37701f4332260c6c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/index.js\":\"d9e0b87772c6b257\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/store.js\":\"77525b57d50172e6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/HeaderItem.js\":\"b6c1fdde7b28a417\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"64f649ef05f495b8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/index.js\":\"f2e1f86069890936\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/model.js\":\"c66a06b3072c3889\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/toggleStore.js\":\"037bdfe10b5af4be\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/useKeyInspector.js\":\"ff7014ff206ac3c9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1897f7870a309c78\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/ShellDecorator.js\":\"0d5e0069549e4e42\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/actions.js\":\"cfa556464126d904\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/exclusionsFacet.js\":\"3f18fdbdf7aa1624\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/index.js\":\"330cfaf27835d1b6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/shell.js\":\"900e42881c882302\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/surface.js\":\"be11ac48ed8dce1e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/walker.js\":\"0c49e8f83a20f095\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e8401cb72274d708\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/dataExtension.js\":\"b64d628d5c6ca385\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/index.js\":\"157d3a9d65941ae5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/indicator.js\":\"8c5b5284c434548e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/moveSrsState.js\":\"899050a709d4c1ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6d15558e6f9e72a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/scheduler.js\":\"de1498abc2e74cab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/schema.js\":\"89bfb1ae27757161\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"a3269bc834903d18\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsClipboard.js\":\"3d5e8613813e7eff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"64dfe184496788df\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DailyNoteReviewHint.js\":\"07d0920cd8f613fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DeckPicker.js\":\"fa956d9e3acf69df\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewControls.js\":\"8d94406f35f04c87\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewDeckRenderer.js\":\"238444cb64873dda\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewSession.js\":\"b9ce4d52b04dd65e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/actions.js\":\"6b2bc25c6ce983cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/archive.js\":\"0b1d13e0d5e69884\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dataExtension.js\":\"b8cd789134590c2d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/deck.js\":\"079890be89949a89\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dueQuery.js\":\"8dec1935ab210857\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/gradeDecision.js\":\"63cd649fa3d056fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/index.js\":\"b46dded92479f8df\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/keyHints.js\":\"2ea72ab06007f713\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewCardLayout.js\":\"5ef9368f6cdde410\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewProgress.js\":\"b98d4596965167e8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/schema.js\":\"ff51ec6bad059510\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/useDueCards.js\":\"67c585af37cae3d1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/index.js\":\"1427970ed32c5fd1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/record.js\":\"b54f46edbdbff44b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/index.js\":\"b838b8884299a9f6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/persistenceStatus.js\":\"5eeba4a1d78a84c8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/requestAction.js\":\"16a7de5b524ea1a2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/TypeChipsDecorator.js\":\"532f54dff555ae2b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/codeMirrorExtensions.js\":\"f1b9f94757dfe35b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/index.js\":\"2861ed0305c2cff1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/typeAutocomplete.js\":\"09873100deeadd8f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"aafa7f4115e728ca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/actions.js\":\"fbc93832d510cbe9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/anchor.js\":\"90d795e055508d83\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/events.js\":\"deb38b6230606b58\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/gestureActions.js\":\"3db62cceaa6b86a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/index.js\":\"889dd66b5ecb4cc9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"03698e3788d4e108\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/collect.js\":\"5b162f96c1bc6bda\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/index.js\":\"23b03a6b740bd52f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/record.js\":\"a74467af758b1e5e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/RejectionDialog.js\":\"e02f62b1a3c5443b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/SystemStatusHeaderItem.js\":\"759db53115f422a2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/index.js\":\"e95fd54002de0909\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/model.js\":\"65e2f0ff2ab83ddd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/queueCounts.js\":\"a58c335f8d83806c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rejectedHelpers.js\":\"85308ebb3c07e1ec\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rematerializeAction.js\":\"f0e2b6d19777df18\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/useHysteresis.js\":\"7e119f9d386de88f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/ColumnHeaders.js\":\"0bc4d93243c35cd4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/QueryUi.js\":\"59ad55e4250f8a6a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/TableLayout.js\":\"ef302d64fe5e600e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/actions.js\":\"25bcbf36b75a1c37\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/cellEdits.js\":\"1911e520aa8c0a15\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/childrenViews.js\":\"449af02b548b5404\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/columns.js\":\"68ee9c0fec395136\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/controller.js\":\"32cdf7e4e829ccb9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/convert.js\":\"cc0ed81104ba54a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/dataExtension.js\":\"e7ad04ba07193005\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/index.js\":\"3747b6e38ff98649\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/keys.js\":\"2b708067207cbf33\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/model.js\":\"87c7579a607e6e98\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/QueryText.js\":\"8dc39cb67eb618d9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/backfill.js\":\"4d3600052d2c912d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/completion.js\":\"c6ffb11f1d346846\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/format.js\":\"bc76eb79ea0673d0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/parse.js\":\"41954647c6d0304a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/queryValue.js\":\"f3c3d88109795dcd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/registrations.js\":\"00fc84a3c5c5a25f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/source.js\":\"fae35a13f460c0f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/registry.js\":\"e4bfcc80844d3702\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowGutter.js\":\"27b60f9d48f7c4fe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowVerbs.js\":\"13b03f5fe9e0ac44\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/schema.js\":\"cc354d89ca9ac8a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/sort.js\":\"9f2e06c8657ec784\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/effect.js\":\"d9dd920a94619007\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/index.js\":\"d5db306bc052e9a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/theme.js\":\"a0a463dee4d6b351\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/actions.js\":\"faad48c2a91b34fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/dataExtension.js\":\"2645bbb986247894\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/index.js\":\"f04bfe15b5d38d28\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/schema.js\":\"d99f34faa740cae2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/TouchSelectionLayer.js\":\"85e627f14c6ae039\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/actions.js\":\"967570e3f3db1894\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/defaultItems.js\":\"5204fb8ef476e337\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/facet.js\":\"5c051740c80e34c3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/holdRecognizer.js\":\"e5ac9dff06efc44b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/index.js\":\"ad0b4f12109ea004\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/UpdateIndicator.js\":\"37df5c05a1f0bb2d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/index.js\":\"7e917136b0748751\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/loadTimes.js\":\"209eff969a358d86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoNotesRenderer.js\":\"4a025e424f4cbab1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoPlayerRenderer.js\":\"8c24fcf6f773368d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoTimeStamp.js\":\"e59fb1c505c6c0ba\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/actions.js\":\"2012d7f6078c7432\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/index.js\":\"d9d55ee83d9c89be\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/markdown.js\":\"a71c6b2aa3e60b1e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/notes.js\":\"9f3f6daebe8f947c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/registry.js\":\"cd9968400f7216dd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/remark-timestamps.js\":\"c2190927c0024299\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/view.js\":\"e71ae8082d09a11d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/LinkHints.js\":\"e810f09b7116a98d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/index.js\":\"689d27118369481e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/model.js\":\"9ece93f7da192c7a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/settings.js\":\"91163e3e14aa88bf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/actions.js\":\"7ec2f7225ddd9cae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/index.js\":\"2c5ab43a13511481\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/interactions.js\":\"b61d33d7dc6cf18b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/workspace-header/index.js\":\"1d437dd8e312d800\",\"/knowledge-medium/pr-preview/pr-1912/src/registerServiceWorker.js\":\"0f2609134d47c83e\",\"/knowledge-medium/pr-preview/pr-1912/src/requestPersistentStorage.js\":\"a0e19b8df5a87fbc\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authRequestDeadline.js\":\"85c2ad347553c7de\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authStorage.js\":\"dd2841385ed8f944\",\"/knowledge-medium/pr-preview/pr-1912/src/services/powersync.js\":\"f9dca349f4a07b3c\",\"/knowledge-medium/pr-preview/pr-1912/src/services/supabase.js\":\"8ff68300b2015172\",\"/knowledge-medium/pr-preview/pr-1912/src/services/uploadErrorClassifier.js\":\"0801d9340a5a706b\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/ActiveContexts.js\":\"542c376fb2c4318c\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/HotkeyReconciler.js\":\"41d31e30016b6140\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/WipeLocalDataDialog.js\":\"25776a780f3c00bb\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionDispatch.js\":\"318742ebcd5596a4\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionRefItems.js\":\"de8fb3837d666716\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/applyKeybindingOverrides.js\":\"bdbc2e656b5ccd65\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockActions.js\":\"af8f636ad274ff1f\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockMergeGesture.js\":\"e0c5a255399d2a99\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/canonicalizeChord.js\":\"7df903c3329ae1fa\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultContexts.js\":\"22355a58c55eb6d2\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultShortcuts.js\":\"8fb4306300842da8\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/effectiveActions.js\":\"8e4061e2daf8a639\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureAction.js\":\"00357febab14a5fc\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureBinding.js\":\"f2553f8b316261db\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/holdRegistry.js\":\"cbb73d94fb88b6ef\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingConflicts.js\":\"d95431d62de02a08\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingOverrides.js\":\"788e76e4c5a79f46\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/pointerAction.js\":\"a4883f17890027b5\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/resolve.js\":\"cc3954a3723ecaf2\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/runAction.js\":\"7f4c157c44365058\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/sequenceMatcher.js\":\"cc1e1b208b02657f\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/types.js\":\"6d8e4d0b0fa49b8f\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionContext.js\":\"20c21d6a60190162\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionDiscovery.js\":\"b2af11fe1bd961d3\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/utils.js\":\"c741d87157cc2a42\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/bootStore.js\":\"9037f6b3d331fad3\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/previewDatabases.js\":\"31a213fa40822516\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/byteTransform.js\":\"6782e6785e976b83\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/attachmentCleaner.js\":\"63330cd49dae3e89\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/attachmentParts.js\":\"c01c51b598f1527a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleParts.js\":\"6059816f86f038f3\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleRecord.js\":\"f1aee00aa8e016cf\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/manifest.js\":\"17553cf4aac5421b\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/takeBundle.js\":\"71d5693c546f8b5f\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/verifyBundle.js\":\"a0e5c039ba79377a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/cleaningStage.js\":\"97d901bce2e09c6e\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionKey.js\":\"4f38a7b8ad36e2f5\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionServer.js\":\"997912e0700ee9b2\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flip.js\":\"f7acc97630766254\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flipAttempts.js\":\"fa9988ade40701ef\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/pages.js\":\"881311d3b44bc455\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/preflight.js\":\"c13a04d45440412b\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/reseal.js\":\"b901b573e11f5896\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runConversion.js\":\"afb5525525f530bf\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runLock.js\":\"f5958f882bace464\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealing.js\":\"6a41066cfe8ba38c\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealingStage.js\":\"67fae32f6c50f2bf\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/stage.js\":\"c020850d84305fc3\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/verifyReseal.js\":\"f328ade2fb935339\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aad.js\":\"e0240c30e08b75d2\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aead.js\":\"a6b56a19e2659d52\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base32.js\":\"b887e148445b60fa\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base64url.js\":\"b6de2ac5fdb16375\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/binaryEnvelope.js\":\"e4ddec183a159e4f\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/byteAead.js\":\"c340baeceae0c907\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/canary.js\":\"b5d08e98f82987f6\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentHash.js\":\"88fc5646c244d11a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentKey.js\":\"9f42c53564028c75\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/derivedIdNamespace.js\":\"875379d0362e3502\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/envelope.js\":\"cf5a2e1786ace960\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/hex.js\":\"8115f978d0e36764\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/sha256Hex.js\":\"67b31759d5e810ba\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/workspaceKey.js\":\"2470952d3c9d0bec\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/conversionState.js\":\"95b19d8820846b97\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/createEncryptedWorkspace.js\":\"02daafa634e889d5\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/pastedKey.js\":\"6c9a6e347d57f3c4\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"ab3387858a896af1\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/upgradeWorkspacePin.js\":\"15b75eb13d36a302\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/keyStore.js\":\"814713d0e2bba7c0\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/mintWorkspaceKey.js\":\"31844c5ca70d5df2\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/modePin.js\":\"b000c97af9797fff\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/openWorkspaceKeys.js\":\"a78246e1fb4a64c8\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolveWorkspaceEntry.js\":\"3ef9e96e3e5f2543\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolver.js\":\"b76ba90951a2e0b9\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/workspaceAccess.js\":\"644b5dfc0f605435\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/transform.js\":\"c8622ce6c76b68dd\",\"/knowledge-medium/pr-preview/pr-1912/src/themeBootDefaults.js\":\"a7a94916db6a0293\",\"/knowledge-medium/pr-preview/pr-1912/src/types.js\":\"6fd2bb0cec61c091\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/ClientLocalSettings.js\":\"67fb5f39b5dd6c78\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/abortableSleep.js\":\"3528fe497a0c0b03\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/array.js\":\"aafe7c54b04d1f7a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/backlinkAutocomplete.js\":\"6dd2a611c961923b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockCrumbs.js\":\"93011efb0cafb485\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockrefAutocomplete.js\":\"7448250d806b9b69\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/cadencedIdleJob.js\":\"705a5473e1db9182\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/callbackSet.js\":\"3605c9d6523ef8e8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/clientId.js\":\"ee55a75c9e61500e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirror.js\":\"8ecf4ff5aa19a574\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirrorCompletion.js\":\"3b21e33384fb7a45\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/copy.js\":\"58b0406396c442e4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dailyPage.js\":\"62b8c8f46c4bda7e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensics.js\":\"d2d5e782787c1106\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensicsHooks.js\":\"60a151b22e75f5b8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/deleteBlockThroughUi.js\":\"068cf7b13940ea49\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dialogs.js\":\"515f2063d47c5aec\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dom.js\":\"ff1cfc14b7e787ec\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/downloadBlob.js\":\"52f586c6a207c861\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/drawnWalk.js\":\"bb1def5056f14518\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/exportSqliteDb.js\":\"5fdb36fb6fc4a77d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fileSystemAccess.js\":\"f55a480ea515dd3e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/flipSlide.js\":\"5086fb147a1a4fec\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fnv1a.js\":\"00b541dd9ac4bd55\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/formatBytes.js\":\"0093bdcaf656e931\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fuzzyRank.js\":\"4a5e2e9e3ba376de\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idbKeyedStore.js\":\"51ec402c0a5724b4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idleCallbackPolyfill.js\":\"8763e29223a4ac15\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardAwareScroll.js\":\"fe54671bb9aaa920\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardViewport.js\":\"5b8d69688d58c751\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/lastWorkspace.js\":\"fd8b6005fbd08135\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutColumns.js\":\"98a52d7cd1b79a75\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionDom.js\":\"205bd54d341a7254\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionId.js\":\"2b3e03c4fd4038e0\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkClickGestures.js\":\"5cd5b85418f72dfa\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkTargetAutocomplete.js\":\"6b5b53c8206636d1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbCorruption.js\":\"da930837966db2b6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbRecovery.js\":\"e41d37332c2d9052\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/markdownParser.js\":\"11fa29968c510a6c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/memoize.js\":\"5b69c8a1419b924c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameFieldCommit.js\":\"32af232c3d540968\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameList.js\":\"5077130d9cf2fc3d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/navigation.js\":\"31d94b39fd02b185\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/omnilinerNamespace.js\":\"a020078f6af2bb71\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/opfsPageScan.js\":\"ab567d5fb3a3d8be\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelClearance.js\":\"3907be3243aae758\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelHistory.js\":\"11c75f6a37aa03b9\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLanes.js\":\"79950e51fee9a6b4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLayoutProjection.js\":\"ce6ad2a3b803c3a0\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelScrollAnchor.js\":\"80bb9e26a802990a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelUrlFlags.js\":\"3f48dbc3c320fe8f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/platform.js\":\"a94214a821937a6d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/pluralize.js\":\"c33c818be3304a5e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyCreation.js\":\"2bca1ed8e4b9a2a8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyNavigation.js\":\"516af690058547ef\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyValueContext.js\":\"b3f9d39c127065da\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/react.js\":\"cf4da18713745e6a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeDate.js\":\"5b42cb50b65d3c6d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeTime.js\":\"c7e1add4fe676bef\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/renderScope.js\":\"9d5e400fc2855c7c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/resolvedThenable.js\":\"e94d52a5e4ba495e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/routing.js\":\"9dfbcb7dda665234\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/safeMode.js\":\"2bea738e74e602f3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/scheduleIdle.js\":\"f9d2dd702b46195c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/screenWakeLock.js\":\"0e33d4c3115d59f5\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/selection.js\":\"ea54a136f64a0431\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/softKeyboardGrab.js\":\"e8a2b683f05ee953\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/startupTimeline.js\":\"698b1036e069f7a4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/state.js\":\"ff8a01a4593ece99\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/string.js\":\"25c91f705811f395\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/surfaceZoom.js\":\"b875445ea3bc8790\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/time.js\":\"5fb895905e8c83ce\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toast.js\":\"db3a340981d747db\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toggleStore.js\":\"f4d6adcd5b24f1d1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/untilStopped.js\":\"4ce996d5c7cf6f05\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/userActivity.js\":\"6156e60455ff6f2f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewTransition.js\":\"834c5164c57a7106\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewport.js\":\"0dff5cb2683f8e74\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/webLock.js\":\"a1406f2db106380b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceRecovery.js\":\"fde8c081031aa5d6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceSnapshotStore.js\":\"9ee33b38c87e15d7\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-compiler-runtime.js\":\"bf5641bb2e04febf\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-client.js\":\"482ae8157083e395\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server-edge.js\":\"392fea5a4eba0845\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server.js\":\"91cbdc5d64a5f5e1\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static-edge.js\":\"986071a42ca391ac\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static.js\":\"774e5991ceabd99f\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-test-utils.js\":\"a4b277877f1afa44\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom.js\":\"9cce38f310e3bfb2\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-runtime.js\":\"6c95b5a97153d7f5\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react.js\":\"01c08e08fa344df2\",\"/knowledge-medium/pr-preview/pr-1912/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
