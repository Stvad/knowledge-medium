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
		buildId: "48538abd4e9b-c31a609d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/\":\"82279632d3e051fc\",\"/knowledge-medium/pr-preview/pr-1912/index.html\":\"82279632d3e051fc\",\"/knowledge-medium/pr-preview/pr-1912/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1912/assets/FacadeVFS-z0B0ZQDn.js\":\"d99dade86fe43df1\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSCoopSyncVFS-DoojieyI.js\":\"34f7f1cb4a56f51b\",\"/knowledge-medium/pr-preview/pr-1912/assets/OPFSWriteAheadVFS-NsruLbjv.js\":\"87f5aa8e6785473d\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-4GSll1Mp.js\":\"6140e36f7dea7f67\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/assets/wa-sqlite-async-BCRBXAqc.js\":\"018f6c8b2a143b45\",\"/knowledge-medium/pr-preview/pr-1912/assets/worker-BYg_2rPe.js\":\"fe9bc682b865cb6d\",\"/knowledge-medium/pr-preview/pr-1912/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1912/chunks/app-BMlFC6Tg.js\":\"a8148bdd9d5e7592\",\"/knowledge-medium/pr-preview/pr-1912/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1912/index.js\":\"1be9ed6aff584cf4\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1912/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1912/assets/AccessHandlePoolVFS-cQAAQGdG.js\":\"c4ec8efc6f0ab44e\",\"/knowledge-medium/pr-preview/pr-1912/assets/IDBBatchAtomicVFS-DdNRDtnV.js\":\"a07ba84f95d309a9\",\"/knowledge-medium/pr-preview/pr-1912/assets/MemoryVFS-Cezz5vZE.js\":\"edf30314a3479c94\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-B0dUFdPu.js\":\"eff18346372b58c8\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-CctxJKTs.js\":\"af5f140e179ca6c6\",\"/knowledge-medium/pr-preview/pr-1912/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1912/chunks/AccessHandlePoolVFS-DyNFrxdx.js\":\"4b86b74b007725a6\",\"/knowledge-medium/pr-preview/pr-1912/chunks/FacadeVFS-BAwSL3UO.js\":\"ef6f05db4882bb0f\",\"/knowledge-medium/pr-preview/pr-1912/chunks/IDBBatchAtomicVFS-BXaSP3ge.js\":\"7dcbd49608f7a213\",\"/knowledge-medium/pr-preview/pr-1912/chunks/MemoryVFS-CZSTikcD.js\":\"04bf8805de42291a\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSCoopSyncVFS-m1V13URq.js\":\"04072087ef28ad74\",\"/knowledge-medium/pr-preview/pr-1912/chunks/OPFSWriteAheadVFS-_txw1Iyi.js\":\"acf34c4420189d2d\",\"/knowledge-medium/pr-preview/pr-1912/chunks/Preview-DphDbeqb.js\":\"5ba582a241bf79b2\",\"/knowledge-medium/pr-preview/pr-1912/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1912/chunks/card-C29y4Wsl.js\":\"695fa98b44119056\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1912/chunks/dist-C9IVZahU.js\":\"299e4622c1d6de3d\",\"/knowledge-medium/pr-preview/pr-1912/chunks/freezeExtensionImports-IfTPqh9z.js\":\"b38914eac181e294\",\"/knowledge-medium/pr-preview/pr-1912/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1912/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-DtQKssN8.js\":\"0da7da74c69c5d72\",\"/knowledge-medium/pr-preview/pr-1912/chunks/mc-wa-sqlite-async-DVbvn30X.js\":\"ba92c11e09beea44\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-BWSXke9d.js\":\"d2217103dac22d06\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-CHlBZE2n.js\":\"652f3cd6ca58570a\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-CY-6gw_1.js\":\"63f13592b2421862\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-Cw_YahNu.js\":\"1c4cec6ae44ddc31\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-DKy_2RHz.js\":\"966a3d56e481605d\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-DhzeQ-sh.js\":\"64245c124a11c5b4\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-cTKBCu-o.js\":\"3e90b6497bf97b9d\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server-legacy.browser.production-jmTYfXjW.js\":\"dc9aa5b9b65fcd60\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.browser.production-BRFft4BH.js\":\"4ca13eee3e398d8f\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-dom-server.edge.production-CuKqrib6.js\":\"6593a771869a1842\",\"/knowledge-medium/pr-preview/pr-1912/chunks/react-wodnQKRh.js\":\"4906e3612911a8e8\",\"/knowledge-medium/pr-preview/pr-1912/chunks/server.browser-CRMaLTf5.js\":\"0a261b11824c6420\",\"/knowledge-medium/pr-preview/pr-1912/chunks/textarea-DxhDaWTH.js\":\"6cabd4ec5b5246b2\",\"/knowledge-medium/pr-preview/pr-1912/chunks/ui-BxOQWL8j.js\":\"3f33278d23bc23a7\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-DIvmIEH6.js\":\"726811a0d8d04043\",\"/knowledge-medium/pr-preview/pr-1912/chunks/wa-sqlite-async-DCuUfx99.js\":\"8b4ab71b9536f2e4\",\"/knowledge-medium/pr-preview/pr-1912/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1912/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1912/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1912/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1912/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1912/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1912/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1912/src/App.js\":\"9a3c780384db8f37\",\"/knowledge-medium/pr-preview/pr-1912/src/appUpdate.js\":\"36604c75e80c7927\",\"/knowledge-medium/pr-preview/pr-1912/src/appVersion.js\":\"709403525fb237f8\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/initialLayout.js\":\"48217dfdd45545fa\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/openWorkspaceData.js\":\"26ef7fdf8bb468d0\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/resolveWorkspace.js\":\"a476610dd9c0eb67\",\"/knowledge-medium/pr-preview/pr-1912/src/bootstrap/workspaceBootstrap.js\":\"17fe9dfc5acce6ed\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockComponent.js\":\"00416f997a28a60b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockCrumbs.js\":\"20188faf3462fa13\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockEditor.js\":\"b6ec53c08ecc1777\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockLoadingPlaceholder.js\":\"893c4b22c2af1431\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockProperties.js\":\"cd72dcb92c0552f1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/BlockSearchPicker.js\":\"75291342f5dca42a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ConfirmBulkDeleteDialog.js\":\"a12fd3f8f33f489b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DividerHandle.js\":\"61ec9d3fdf196bc9\",\"/knowledge-medium/pr-preview/pr-1912/src/components/DraftEditor.js\":\"061fd406e15d3d20\",\"/knowledge-medium/pr-preview/pr-1912/src/components/GutterPill.js\":\"888d613939e19264\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Header.js\":\"1bc684bb2702ff38\",\"/knowledge-medium/pr-preview/pr-1912/src/components/LazyBlockComponent.js\":\"ba0db7d2ca694212\",\"/knowledge-medium/pr-preview/pr-1912/src/components/Login.js\":\"85f322cc978f2b98\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ZoomableSurface.js\":\"ee41b13c7acb2a3f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/editModeKeepalive.js\":\"1094b5bd02959515\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e0fa5dfe565b5ded\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"9cb3a6bba6ffeb3c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefPropertyEditor.js\":\"a291b3e970a69c76\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/RefTargetTypePicker.js\":\"32ff09c45f007b02\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/SelectPropertyEditor.js\":\"dae3855b2db185e6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/TypesPropertyEditor.js\":\"9516c6b02d690257\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/defaults.js\":\"d40f558af95f503d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/kernelValuePresets.js\":\"a39afbdd13355011\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/selectablePresets.js\":\"ea4ebd3be6f15f3a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyEditors/typesPropertyUi.js\":\"c8707fe27eb2ac94\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/AddPropertyForm.js\":\"ecd921da84a6c5fa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyPicker.js\":\"68ca2cb3bde6f265\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/PropertyRow.js\":\"54202fe8a1452750\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/Rows.js\":\"0feaca83683ae896\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/actions.js\":\"6b38ad8c25a43856\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/declarationOnly.js\":\"390d05ebb2974e61\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/layout.js\":\"408d3eaac4ecec4c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/model.js\":\"e463bb8d9a8d4fc6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapeUi.js\":\"141d7fb137cdbdb4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/shapes.js\":\"1ed3f0d59746a37c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e1db33663916eea6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanel/visibility.js\":\"9140eeb5aa74db22\",\"/knowledge-medium/pr-preview/pr-1912/src/components/propertyPanelSections.js\":\"ae1098927ea3cd86\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockEmbed.js\":\"58525e0db5a1fd3c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockLink.js\":\"82cbf0bfce13abfa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/BlockRef.js\":\"0a980b3fafd57609\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/CompactReferenceLink.js\":\"454a303faa2cb4e6\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/ReferenceLink.js\":\"4db34f7baed7ff77\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuard.js\":\"9581a08e7c9e5aab\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/cycleGuardContext.js\":\"df5a7b10d77a7999\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/linkInteraction.js\":\"e9e79d43565fc4d7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/referenceLayout.js\":\"f354a0d9a969e159\",\"/knowledge-medium/pr-preview/pr-1912/src/components/references/useBlockRefAncestors.js\":\"f8f4115ca516a99d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockGutter.js\":\"0b52d8ef3a057d8c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockInfoDialog.js\":\"2922221b68da3e5f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockReadText.js\":\"a726bb93320a147b\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BlockTypeBlockRenderer.js\":\"9f1f99430215ad84\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/BulletHoverCard.js\":\"23fba8f6bf57b1db\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorContentRenderer.js\":\"07c849394d184a58\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ad4ce2acc8735ed1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ColumnResizeHandles.js\":\"08a6d00936a7ecc0\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ef630709285ee4ae\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/DefaultBlockRenderer.js\":\"2c71f9c4634e6627\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/LayoutRenderer.js\":\"60c9930fd3e1caa2\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MarkdownContentRenderer.js\":\"ae7f8ddd8a5b866a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/MissingDataRenderer.js\":\"2e8fc95235dc927c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PanelRenderer.js\":\"46f58435a9a6730d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b8f729dbeff03d86\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/TopLevelRenderer.js\":\"da4378b002ca5984\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockGutterMode.js\":\"8b9e8d30b695906d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/blockTitleText.js\":\"3550272825582179\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/fieldCreationKeydown.js\":\"4bda2e455489daaf\",\"/knowledge-medium/pr-preview/pr-1912/src/components/renderer/layoutRootContext.js\":\"8f24f4233d7dc8f8\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/TypeChip.js\":\"2ff83f8e4607bf15\",\"/knowledge-medium/pr-preview/pr-1912/src/components/typeChip/chipStyle.js\":\"c6a79c39fc268951\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/anchored-floating.js\":\"56eb8256047a43ee\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/button.js\":\"1efb37c66e38b1c3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/card.js\":\"29d197eb951d8a31\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/checkbox.js\":\"7cd841e567028623\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/collapsible.js\":\"b33a86c6394e46fa\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/command.js\":\"3ae5da6d6fc75654\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/context-menu.js\":\"401adbf9537b6d25\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dialog.js\":\"3449465a0221daf5\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/dropdown-menu.js\":\"98e54de939bf3c17\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/floating-listbox.js\":\"59460b74052ce190\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/index.js\":\"bfa311d7390278fd\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/input.js\":\"94b0160fec8330d3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/kbd.js\":\"7a8af5c6c7ac8ac3\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/label.js\":\"a678ecbef3274818\",\"/knowledge-medium/pr-preview/pr-1912/src/components/ui/textarea.js\":\"3defb891f7e56fb1\",\"/knowledge-medium/pr-preview/pr-1912/src/components/useEditModeYieldKeepalive.js\":\"4ae899946a2b845e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/BootFallback.js\":\"13b84edd2ab850c4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/FocusedRowLazyMount.js\":\"279a2347b939160c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LazyViewportMount.js\":\"6fb3784c2cb91336\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/LocalDbCorruptionFallback.js\":\"fa40c10d576cdc83\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/error.js\":\"725c70896b017e11\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/lazyMountRegistry.js\":\"386e00e41bceee8f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/util/suspense.js\":\"05eed3af0a032cf7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/CreateWorkspaceDialog.js\":\"ff12177a0d784e56\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/PendingInvitations.js\":\"3baeae2cd6542185\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/SyncProgress.js\":\"9bef97b8926bde3a\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/UnlockProgress.js\":\"488e8f75a1301421\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceKeyGate.js\":\"4ac25b431d661a06\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSettingsDialog.js\":\"74da8334ab760f7f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSwitcher.js\":\"b04e6c764ba6e24e\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/WorkspaceSyncGate.js\":\"bd1159b70ecb6f93\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlow.js\":\"5b41b62c6b06b4f4\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/ConversionFlowHost.js\":\"f4fdc983cd61f77c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/EncryptionSection.js\":\"f584603db4558dcd\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/attachmentPrompts.js\":\"031cef8dab19146f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/bundleFolderPrompts.js\":\"a0ac6459990e4442\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowDeps.js\":\"4d484e354709ce57\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/conversionFlowStore.js\":\"b57f950e206ba81d\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/flowUi.js\":\"ceb1c63a1c21a30f\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/conversion/useConversionRun.js\":\"2a9e7e688b5ef55c\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/keyUi.js\":\"04fd393c7d4ffc49\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnKeyLoss.js\":\"31bbdae0798f09d7\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/useCloseOnServerE2ee.js\":\"42d2e441eddb6198\",\"/knowledge-medium/pr-preview/pr-1912/src/components/workspace/workspaceUnlocked.js\":\"423eecd216abfb3c\",\"/knowledge-medium/pr-preview/pr-1912/src/context/backgroundSubtree.js\":\"b0e38eced5ce4c43\",\"/knowledge-medium/pr-preview/pr-1912/src/context/block.js\":\"914c5bb3d4a96cbe\",\"/knowledge-medium/pr-preview/pr-1912/src/context/layoutWsContext.js\":\"be8d2b6ea9150fb4\",\"/knowledge-medium/pr-preview/pr-1912/src/context/propertyDisplay.js\":\"555d8c007196b1d3\",\"/knowledge-medium/pr-preview/pr-1912/src/context/repo.js\":\"dbaf06ac5e4ce1cd\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasClaim.js\":\"030baaa30adb843a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/aliasSeatNamespace.js\":\"57246835580f50dd\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockData.js\":\"92bd4b36260def77\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/blockType.js\":\"f4aa8d39b1abd94b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/changeScope.js\":\"8c323483f3e687e5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/codecs.js\":\"f78f3037d0a610b5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/derivedData.js\":\"35db5a7eabcfad11\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/errors.js\":\"94d26fd5bf993f65\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/events.js\":\"c3e6787a789183ee\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/handle.js\":\"edc88660ce09d101\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/index.js\":\"1ba755013db029c1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/mutator.js\":\"eb9ef823778548bf\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/processor.js\":\"d5a518d83520da7c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/propertySchema.js\":\"5479a6b853135157\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/query.js\":\"acdb858cc6b513f2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/sameTxProcessor.js\":\"1fba9be4315b7f12\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/schema.js\":\"edc88660ce09d101\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/tx.js\":\"edc88660ce09d101\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/typedBlockQuery.js\":\"681bbac034cf810a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/user.js\":\"a83becb9370f0580\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresetCore.js\":\"c3c7f2f9aa8e503f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/api/valuePresets.js\":\"51ec62e2a1430a48\",\"/knowledge-medium/pr-preview/pr-1912/src/data/attachmentCleanerIOVerb.js\":\"a9a4322eecd3bdbf\",\"/knowledge-medium/pr-preview/pr-1912/src/data/block.js\":\"be978295727cdea8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockCache.js\":\"806f4bf5639a0067\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockId.js\":\"bf73c67c696e061e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockLiveness.js\":\"b6733e4aacde6099\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockMerge.js\":\"32e2a2e774cc702c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockSchema.js\":\"e18846f24a8223d9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypeLookup.js\":\"3ec1c14a69ddbd93\",\"/knowledge-medium/pr-preview/pr-1912/src/data/blockTypes.js\":\"8dff1d65de60bc9f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/childrenView.js\":\"473ccd8cd021dae2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/clientContext.js\":\"f7dd2047c8dfb3a3\",\"/knowledge-medium/pr-preview/pr-1912/src/data/dbFileSiblings.js\":\"95c15a2c9c04805e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/definitionSeeds.js\":\"3f636886cff29fd9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/derivedIds.js\":\"b85558f3089519da\",\"/knowledge-medium/pr-preview/pr-1912/src/data/drawnSubtree.js\":\"ca3268c918351593\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facetBridge.js\":\"acc43c6bcf25c986\",\"/knowledge-medium/pr-preview/pr-1912/src/data/facets.js\":\"fcde2fc7aaee48e1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/globalState.js\":\"216064a0957656d0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/aliasClaimRederiveProcessor.js\":\"9f425a3ae650035d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/ancestorBatch.js\":\"9166d56a66928973\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/blockTypeTypeifyProcessor.js\":\"c5d60d227e93377d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/clientSchema.js\":\"0c1c1edd982d88d9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/commitPipeline.js\":\"c8080a6373636826\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/devAssertions.js\":\"2d364e6db7851185\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/firstSync.js\":\"e439991300772c7b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/freshInitialLoad.js\":\"8bfa6ed3c4c60a4b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/graphBackfillClaim.js\":\"a915f123d7a4a5db\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/handleStore.js\":\"b3bd6733b711ce70\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/idleMarkerJobs.js\":\"17461c056da47f77\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initialDownload.js\":\"876ccd814a142b84\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/initializeClientDatabase.js\":\"dadce4c9d114c09b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/jsonCanonical.js\":\"be2e9b9946419877\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelInvalidation.js\":\"33cb0a4378602607\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelProcessors.js\":\"36a9567f4035f636\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/kernelQueries.js\":\"54868e86a62e0260\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/mergeTypeMembershipProcessor.js\":\"efdc680bc0d61840\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/normalizeReferencesProcessor.js\":\"da97c27ccdf3d278\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/poolInstrumentation.js\":\"48bc61ba21182343\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/processorRunner.js\":\"5f15dc1fe35ac51b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyCellBackfill.js\":\"1548617e48262a76\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildMint.js\":\"5e2ee350e6c25123\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyChildrenProcessor.js\":\"c3d39617b8a9f6f9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionChangeProcessor.js\":\"527ee93a1ead355a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyDefinitionSynthesis.js\":\"5cfcd9d4049371f2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyKeyScan.js\":\"8afbeb8643f9d3ad\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertySchemaResolution.js\":\"d7751a3e07a28952\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/propertyValueEdits.js\":\"b1faca2ec00299c8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/raiseProtocol.js\":\"320242a4d8c82046\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/readBatch.js\":\"f593d94afe2ef089\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/refProjection.js\":\"4f8d31d931e9e279\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetLookups.js\":\"bf6796d52a1015f5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/referenceTargetProcessor.js\":\"beaba41cd960540d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/replayMerge.js\":\"450bed98f89c2dd4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/sqlBinds.js\":\"8b84340e54ae0503\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ef3a9ee97ef08455\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/arrivalProcessors.js\":\"6beb9cfb41634add\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/invalidate.js\":\"133017966240577f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/materialize.js\":\"79965c5a36442cd0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/observer.js\":\"d2317ed334314a33\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/syncObserver/reconcile.js\":\"ba93a6fa8d8d78e4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/timingMetrics.js\":\"d79184d3c53b3ed4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/treeQueries.js\":\"e14a213d4dfe73f8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txEngine.js\":\"bf1671decce6402a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/txSnapshots.js\":\"3972566d07048ed2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/typedBlockQuery.js\":\"ce8197749ac5c501\",\"/knowledge-medium/pr-preview/pr-1912/src/data/internals/undoManager.js\":\"6655cb21ee7dc14e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/invalidation.js\":\"bbcd5e657713fac8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelDataExtension.js\":\"8cfd2ec603a92c05\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelPage.js\":\"6eaf678f260fb44e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/kernelValuePresetCores.js\":\"c0da0ce488a69f50\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbCorruptionSignal.js\":\"4cc4a01834da51e1\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbStorage.js\":\"ac87f4f28725869d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localDbVfs.js\":\"34b71a0d437c774c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/localSchema.js\":\"ec1234ee38bcb6e6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/maintenance.js\":\"65248cd837b6f53f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mergeProperties.js\":\"42f988e538b77f81\",\"/knowledge-medium/pr-preview/pr-1912/src/data/metricsConsoleHook.js\":\"c63ad01fd8e56644\",\"/knowledge-medium/pr-preview/pr-1912/src/data/migrationsPage.js\":\"183d0164f7e6b23b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/mutators.js\":\"1d60dfd9c4753233\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKey.js\":\"d95ed6a50b811e0b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/orderKeyPlacement.js\":\"f6528a9349a4c25f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/outlineSurface.js\":\"cff487633344b104\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingEditorContent.js\":\"5cd147627eedc970\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pendingUploadsSql.js\":\"5ec684fb09832235\",\"/knowledge-medium/pr-preview/pr-1912/src/data/pluginStateExtensions.js\":\"96eec1a98c6594b8\",\"/knowledge-medium/pr-preview/pr-1912/src/data/powerSyncLogger.js\":\"a11818e2881dbfeb\",\"/knowledge-medium/pr-preview/pr-1912/src/data/projectorRuntime.js\":\"37955478ecb913e2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/properties.js\":\"b10a70dbd8cd0447\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertiesPage.js\":\"03d2582fc616f055\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyChildren.js\":\"84e7b93f1f156c14\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionFanout.js\":\"a55ad9bfce2fc155\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionMetadata.js\":\"ac08b7c02e7735f5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDefinitionRegistry.js\":\"35a153ba52375a9e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyDisplayMode.js\":\"ae29446e7fae57a9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertyRowCreation.js\":\"cc66a7f0389bc94d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySchemaCreation.js\":\"d6b459a7bbb2fe94\",\"/knowledge-medium/pr-preview/pr-1912/src/data/propertySeeds.js\":\"e55ed9b3869c16a2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/recentsPage.js\":\"b5d52602462cdc39\",\"/knowledge-medium/pr-preview/pr-1912/src/data/refTargetComparableProperty.js\":\"fd7a0eb9ca1f2a20\",\"/knowledge-medium/pr-preview/pr-1912/src/data/referenceBlock.js\":\"1ebc8bf80c668682\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rejectedUploads.js\":\"1531af44f7a486de\",\"/knowledge-medium/pr-preview/pr-1912/src/data/releasePowerSyncConnection.js\":\"63412b98c759d67c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repo.js\":\"23088bc73378307d\",\"/knowledge-medium/pr-preview/pr-1912/src/data/repoProvider.js\":\"ba4c339584bbdd26\",\"/knowledge-medium/pr-preview/pr-1912/src/data/rowProperty.js\":\"2a9135e9651f92d2\",\"/knowledge-medium/pr-preview/pr-1912/src/data/searchFilter.js\":\"2a830937d8087489\",\"/knowledge-medium/pr-preview/pr-1912/src/data/seedIdentityLedger.js\":\"fcf045ee52e5663a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/stateBlocks.js\":\"6acccc47d1c4c86a\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralEditPolicy.js\":\"8d7f78438034f071\",\"/knowledge-medium/pr-preview/pr-1912/src/data/structuralInsert.js\":\"5cb7b8c9bfbd31f7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/subtreeDelete.js\":\"30977697ce9cf056\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncStreamLock.js\":\"163445203a5954ca\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableSqlRecognizer.js\":\"36ad693ade2321a7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/syncedTableWriteGuard.js\":\"a3580aff5dddd384\",\"/knowledge-medium/pr-preview/pr-1912/src/data/targets.js\":\"3111bc33e47a8a7b\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeColors.js\":\"f3f18ac3061a4ddf\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionMetadata.js\":\"3f683e8670ad59f0\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeDefinitionRegistry.js\":\"64a4899cdeca7ced\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeExtraction.js\":\"39de4b3f12dca0ac\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeInitialValues.js\":\"e1ab368f34500e0f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typePropertyGroups.js\":\"757dc99312e75d94\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeSeeds.js\":\"7d177d584949ca05\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typeTagger.js\":\"bae972558de21749\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typedRecords.js\":\"e558f6d6638b1d2e\",\"/knowledge-medium/pr-preview/pr-1912/src/data/typesPage.js\":\"b70e87a65bbbd7e9\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userPrefs.js\":\"f5db364d01b4339f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userSchemasService.js\":\"3a2f4c9343c375b7\",\"/knowledge-medium/pr-preview/pr-1912/src/data/userTypesService.js\":\"1bcc4b59ab12f755\",\"/knowledge-medium/pr-preview/pr-1912/src/data/valuePresetRegistry.js\":\"8a5c7749e33e1700\",\"/knowledge-medium/pr-preview/pr-1912/src/data/visibleChildren.js\":\"499966d994796a34\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceConversion.js\":\"ea9f1597010f36d6\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceFirstSync.js\":\"10e3e68ec4a2e9f4\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceIdNamespace.js\":\"b77fdbafda1c252f\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaceSchema.js\":\"99abea45d0ed840c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/workspaces.js\":\"1591c98b8a351ce5\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadLog.js\":\"9379f76e4d98f63c\",\"/knowledge-medium/pr-preview/pr-1912/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/BlockPasteShellDecorator.js\":\"59ee3bf3e8aa7ea5\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/atTrigger.js\":\"46d3eccf46490a46\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/autocomplete.js\":\"2b887f3e377743cc\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/codeMirrorExtensions.js\":\"082a6bf3708a097b\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/contentFlush.js\":\"a5a251b2134474a7\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/defaultInteractions.js\":\"b93c1c6d82f21a7a\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/editSettleSignal.js\":\"a2b056dc9e2b61c3\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/insertImage.js\":\"4b31f0582deefd30\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceCompletionRange.js\":\"a98bd336bc286df6\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/referenceTargetTypes.js\":\"0cd9a0195dbe91c6\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/syntaxContext.js\":\"8428cea7e08d33b2\",\"/knowledge-medium/pr-preview/pr-1912/src/editor/triggerMatch.js\":\"5427602aff2e602c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/AppRuntimeProvider.js\":\"88c46edfb18f6bed\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/BlockFocusShellDecorator.js\":\"cf8abb30e1532264\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/ExtensionRenderBoundary.js\":\"e227410352ac2c42\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/PanelContentRecovery.js\":\"fc638961a0b9de8e\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/apiCatalog.js\":\"2107d12a5e887593\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/approveExtensionHere.js\":\"bcae0f14123b3522\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/armedCutAppMount.js\":\"e2f464e0dcec5078\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/batchableKeyedStore.js\":\"de2cb12226ac6e83\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockInteraction.js\":\"5e09c24b0db52dee\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/blockSelectionAction.js\":\"55d82743634d489b\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compileExtensionModule.js\":\"3dda33f16c9c85bb\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/compiledModuleCache.js\":\"785089a56e40fa0c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/continuousGestures.js\":\"04d044a7940d1ce7\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/core.js\":\"55c91bc79f136aed\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/defaultRenderers.js\":\"b215b3324f0db0cd\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/definitionFanoutAppMount.js\":\"08765cee3e2c3304\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dialogAppMount.js\":\"ed15ff3720751017\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensionSeeds.js\":\"f68e8d6eaab998f8\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/dynamicExtensions.js\":\"f36f2a4787eac217\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/exampleExtensions.js\":\"aa4422e9a6ef2c6f\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionApprovalStatus.js\":\"81fbafbb4c7911c4\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionImportPolicy.js\":\"8b79e8e8f876701d\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrorToast.js\":\"6cf7c1d33f7509e3\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLoadErrors.js\":\"c3b32d06ab2fb011\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionLookup.js\":\"9f77b4d565114a15\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionToggles.js\":\"5b293f28e779df5c\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/extensionUtilitiesCss.js\":\"dbfaf89d65a26a38\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/kernelPageDeletionGuard.js\":\"eac69fb7a756fc2a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/liveRuntime.js\":\"eb71668e3a8a79e4\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/normalizeExtensionSource.js\":\"196b3336a364b2f9\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/openExtensionsSettings.js\":\"86e35273ed78cca7\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/overridesCache.js\":\"fe70910e26b7c34e\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/pluginIds.js\":\"f3cc16b3d0a6f951\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/processorRejectionToast.js\":\"65a2645086aa13f3\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeActions.js\":\"8f5d78b4b753fb82\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/runtimeContext.js\":\"18cabc17e27cc2b1\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticAppExtensions.js\":\"7d7d797bb737d1d4\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/staticDataExtensions.js\":\"f7b823aef2fb5aa0\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/toastAppMount.js\":\"6957871b81acc719\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/transpileExtension.js\":\"cc32e445c879645a\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useOverrides.js\":\"2d5ebb590aab7183\",\"/knowledge-medium/pr-preview/pr-1912/src/extensions/useShortcutSurfaceActivations.js\":\"54f3d5250feabefa\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/discoverToggleTree.js\":\"3b9bf893d2ba2527\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/facet.js\":\"762e560cef7dd350\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/resolveAppRuntime.js\":\"3cd3bc95958d1a9b\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/runtimeEvents.js\":\"543194e032640be8\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/togglable.js\":\"00280fa338c987cf\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/variantFacet.js\":\"b7a1dbbbb8050ef0\",\"/knowledge-medium/pr-preview/pr-1912/src/facets/verbFacet.js\":\"d7147093ee4a970b\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/block.js\":\"47e7336911992f0e\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/focusedChild.js\":\"db971ee571dbe654\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/propertySchemas.js\":\"e884e9360b8e8646\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/typeRegistry.js\":\"d073b4b67c275064\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAncestorCrumbs.js\":\"e3e3b2d63e6617d6\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useAutocompleteListbox.js\":\"0940f37bc15df823\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedSearch.js\":\"eb03b7ff9cabaf0d\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useDebouncedValue.js\":\"337790c05ffa1376\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useFacetValue.js\":\"e672ce6f0b4a927b\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsFocalRender.js\":\"b1ad2f2126c96da4\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useIsReadOnly.js\":\"daae3c2504098fa1\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMaterializeBacklog.js\":\"41cab8b02f70284e\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useMinuteClock.js\":\"be77ab29ea857ea0\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePanelLayoutProjection.js\":\"95bdbf770b9366a5\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/usePendingInvitations.js\":\"9325a45eea47aaa5\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRendererRegistry.js\":\"3868c5eab218691e\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useRetainedFieldRows.js\":\"381b73a6a6223abf\",\"/knowledge-medium/pr-preview/pr-1912/src/hooks/useWorkspaces.js\":\"ff4402ddf1b76fab\",\"/knowledge-medium/pr-preview/pr-1912/src/lib/utils.js\":\"0634b7a72f087a5f\",\"/knowledge-medium/pr-preview/pr-1912/src/main.js\":\"bfe8525059e7e3bd\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/MarkdownImage.js\":\"3b2d67f9e463fbea\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/blockSeparators.js\":\"cf956f583de23776\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/context.js\":\"ecc24c37cbc7ce17\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/defaultMarkdownExtension.js\":\"3fe334deb0490025\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/extensions.js\":\"ffff7921ea3e2c18\",\"/knowledge-medium/pr-preview/pr-1912/src/markdown/renderMarkdownHtml.js\":\"3626d83057d999a9\",\"/knowledge-medium/pr-preview/pr-1912/src/minimal-editor.js\":\"e9e6914de0f206a6\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/armedCut.js\":\"fb35149ad3aafe3b\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/captureMediaVerb.js\":\"a4ef64e22f9971f5\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/clipboard.js\":\"af600070c5892a34\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/decision.js\":\"63bc0f9f45aa4678\",\"/knowledge-medium/pr-preview/pr-1912/src/paste/operations.js\":\"95f20702d3c7e8fb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/AccountHeaderItem.js\":\"5168e8fa813aaaa8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/account-header/index.js\":\"676ce6a4e7740dc7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"4953fdf54302c13f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askAgent.js\":\"433810726d4230dd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/askedStore.js\":\"8a17ba01675aaa98\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5235fd22ccd97030\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/chipState.js\":\"e20579db5378bb81\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/dataExtension.js\":\"d8fc5a5bd7a74853\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/index.js\":\"64f81fbd6d80823d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"2bd1c4c919a4b288\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-dispatch-companion/schema.js\":\"3c144d83829928ef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9b465c1aeb6d694b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/BridgePairingDialog.js\":\"b6cdfff1db30b6ad\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/addMedia.js\":\"28ecfff5bc46b6a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/backlinks.js\":\"5549482e58bfa44f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/block.js\":\"cb217eaf224a773b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/context.js\":\"c097bb553f7d883f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/displayIds.js\":\"286593d2e4966784\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/index.js\":\"2ad775f939a621c4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/outline.js\":\"5b09cbacd85e0da0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/properties.js\":\"73a2bacc764aea95\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/refs.js\":\"d1e0833b3a85db4f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3e03200d2d6e7cfe\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/search.js\":\"d670ac310c16b685\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/shared.js\":\"1e1c2a2b33bdc575\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"d6bb76f76c577273\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentViews/text.js\":\"0c53da0656ccbd0a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/agentWrites.js\":\"b8449b8f05841829\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/authoringCatalog.js\":\"fc469a1a65a94cab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/blockRefTargets.js\":\"3c89354ab09460e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridge.js\":\"0e6bc504223f0051\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/bridgeLoop.js\":\"a0472e0aec8da087\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/changeHistory.js\":\"89ad056ca3339d0d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commands.js\":\"ee1e198d6d2c8af5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/commentsCommands.js\":\"0e0352713e30bacf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataExtension.js\":\"ae2d45ee12929444\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dataModelGuide.js\":\"d0fe0ba6dfeee45b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/dayPropertyInputs.js\":\"73fcab85b14e8f7d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/describeRuntime.js\":\"f48720c3a365212f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/extensionLint.js\":\"c8237744e722347f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/grainAudit.js\":\"dc6c0b02e5e340cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/healthCommand.js\":\"2f90ad2fcc8d207a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/index.js\":\"be83ced9eb27367f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/presetIdentity.js\":\"03256001e7bd7181\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b43239fd235d9542\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/readMedia.js\":\"8ffcd467ecb5ecd6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/schema.js\":\"c778d4e49d7d2d75\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/serialization.js\":\"2681e9b2604c5665\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/targets.js\":\"89eb25173bc3daa4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/tokens.js\":\"06fa426f66cea79c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/watchEvents.js\":\"0ed2307454c96354\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/workspaceGuard.js\":\"c7f6cc4c79a7b608\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/agent-runtime/writeCommands.js\":\"2043b2dddef1b849\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/AliasCollisionToast.js\":\"bfa05ab114750d06\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/DuplicateNameBanner.js\":\"e102ccc4320dc5e9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/collisionMerge.js\":\"ed03d9ae6b9bce3b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/dataExtension.js\":\"621afd82678373f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/index.js\":\"3bf7c2487d287acf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/mergeCollisionAction.js\":\"1387b293e932bec3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/pageStyling.js\":\"1f0c553e6122bb40\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/rejectionToast.js\":\"7ac780740dc71fa5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/alias/syncProcessor.js\":\"f3db902441b3a738\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/actions.js\":\"8a343427b9259934\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/addComment.js\":\"ea93702f63ae8782\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchor.js\":\"dd9de928ac2bfdab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/anchorState.js\":\"d296c51480639cb7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/commentLinks.js\":\"481c88c2aa3c528b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/confirmThreadDeletion.js\":\"6812a34ec81d85bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/container.js\":\"55502b736aa438c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/dataExtension.js\":\"4842c1491a922c5c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/deleteComment.js\":\"2f36968742e55898\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/highlights.js\":\"40a2942d2c35e9b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/index.js\":\"26b435db61b13747\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/linkedCommentsPill.js\":\"129e28cc954faf93\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/margin.js\":\"a46b5ba8df053654\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginAnchorLinks.js\":\"e22eb1ebf0d31ffb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/marginSchema.js\":\"b52a0257f1340848\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/newComment.js\":\"b144423414985115\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ownThreadPicker.js\":\"164be0f555c56c43\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/placement.js\":\"cabe211062fd769b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/queries.js\":\"75fc043353a6c966\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotePosition.js\":\"32f0fa9968fc5b30\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedIn.js\":\"13e5f682886b9c4d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/quotedRange.js\":\"20c1690e8f351055\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/rangeRefs.js\":\"98c48614dc8e18bf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readHighlights.js\":\"9e898bdb2d80dabb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelection.js\":\"79c8b0eca976721f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/readSelectionUi.js\":\"6a1bbe8bea5518fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/reanchor.js\":\"00b9092cf59c0ed0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/schema.js\":\"a7ef0b315a4daac0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scope.js\":\"8b7060e6fc23b9fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/scopeThreads.js\":\"f3e7bf7275d61e69\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/splitRetarget.js\":\"cdca41fce2cbb5b6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestionCard.js\":\"45b7c5eb73d50f48\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/suggestions.js\":\"231a4109e707530b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaries.js\":\"6a388166782196aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/summaryBatch.js\":\"8f565b32e9d0fd77\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/surface.js\":\"fe84e168931ff8cc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threadNavigation.js\":\"7277e42a7500783b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/threads.js\":\"99c954fe1d29222d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/ui.js\":\"8d9ab48bacf0b29d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/annotations/uiStore.js\":\"1fa5acdc4349932a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/appIntents.js\":\"e54b93105d6838f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-intents/index.js\":\"279e15809e8bc96c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/index.js\":\"3050b73c5df99cf5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/app-update-prompt/status.js\":\"2e2e18d474e2f723\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"bd1b93be91432ede\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaBlockRenderer.js\":\"7e93fa7faba4e436\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaDownLaneReplicator.js\":\"14d294f23de4775f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/MediaUploadReconciler.js\":\"fe17f184f909a06e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetDownLane.js\":\"5a5c6174ab1ce25c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetResolver.js\":\"730fac03e51ad196\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/assetUpload.js\":\"0804157855f0b720\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/attachmentCleanerIO.js\":\"51105ba53954271c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/supabaseAuditIO.js\":\"3c0e48d3cf20c95b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/blobStore.js\":\"f17e0d9e6dcbf9f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/browserMedia.js\":\"ec4d66afde58ff20\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/byteStore.js\":\"0a42c601930c66d6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanerIO.js\":\"c41a714cb495acff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/cleanupAttachments.js\":\"886a57b78f065fd6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/dataExtension.js\":\"c6cd39dddef9b982\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/downLane.js\":\"18f2e9570296b0a6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/index.js\":\"47ff9afa6a6d9a86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/insertImageContribution.js\":\"d1a6b1b410066e6f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneArming.js\":\"c1af2a4b311b6413\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/laneLock.js\":\"07e5da564d61b537\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaBlock.js\":\"9f7e8890185f41c8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaCapture.js\":\"6b28db488c42e188\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaLanes.js\":\"3745727075d289c1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewers.js\":\"b2471188e24a9b87\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/mediaViewersFacet.js\":\"392aa51fe3927954\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/pasteCapture.js\":\"3130612aff86b6ee\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/resolver.js\":\"d07ad73c4bdc3c52\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/retryUploadsAction.js\":\"2b8f9957677278a7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/storagePaths.js\":\"1c75fd6cb87864cc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadDrain.js\":\"e1a690be8f4dd4b1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadLaneStatus.js\":\"7411cf1381096311\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadReconcile.js\":\"35a85e29abda4833\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadRecovery.js\":\"3f95ea69355da6fa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/uploadStore.js\":\"25dffeff9efa15e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/attachments/useAssetObjectUrl.js\":\"80f437e333425205\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d24ec59e6d94066f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ea430272c015219e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/facet.js\":\"33ea212af09191fd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/index.js\":\"b03993105acf8194\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks-view/prop.js\":\"a4c86d4295e7a9d0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinkFilters.js\":\"577ace587ea20db6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ca574a5ec313df28\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/BlockEntry.js\":\"ed638bc5dd450b39\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/LinkedReferences.js\":\"4a06c210ad563e45\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"2e536a148956cc83\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dailyNoteDefaults.js\":\"e34506c072e8a973\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/dataExtension.js\":\"4bbdf205cd479810\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/edgeExclusions.js\":\"1650aa949edc1886\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/filterProperty.js\":\"f2e2e3af9879c335\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/index.js\":\"e166c4b16b83d62b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"572b0261caaefa4e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/applies.js\":\"6112b6952b2e45f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/countQuery.js\":\"1e1b90f574bf5326\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/expansionStore.js\":\"978b3bb9a06aeb63\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/index.js\":\"6f14ac7695a2b4e8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e60bbaa7abf59414\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/presentationInvalidation.js\":\"906e2571811c00dc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyEditorOverride.js\":\"d19a45939d95fd9d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/propertyFilter.js\":\"516bd0cd9a36778e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/query.js\":\"c090fc05aa486cf3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/resolveFilter.js\":\"462421da0feebfb1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sourceBatch.js\":\"c7b87fa6a25e9c79\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/sources.js\":\"18b0b639e4fb4cf1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useBacklinks.js\":\"87881024e5bd539a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5df989f2c237c843\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayCelebration.js\":\"208beab4dab2a44d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/BirthdayOverlay.js\":\"bef0385b908de540\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/gate.js\":\"f901f28385f182f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/index.js\":\"9b225db6a55650b4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/birthday/wolfTheme.js\":\"2d63c16496422544\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/BlockDragLayer.js\":\"b3643d3eef02542f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dragController.js\":\"4d62f88da7c11a31\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/dropTarget.js\":\"83c9ac118b9babc2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/index.js\":\"01a43085317b73c8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-drag/projection.js\":\"09a9798e5e586ec0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/BlockMetaCard.js\":\"994a06f7724d37b0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-info/index.js\":\"bd1f7788e1445261\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/AddTagDialog.js\":\"7671138b7a921e18\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"fe33b3e3e0504639\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/TagNameIssueHint.js\":\"672330074fcb0f80\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/addTagAction.js\":\"67f11be962f0e664\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/appendTag.js\":\"231f0ab507416109\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/config.js\":\"49bac603acd44e82\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/dataExtension.js\":\"2beee614e1cd2afa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/index.js\":\"b3472d223bb20816\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/block-tagging/propertyEditorOverride.js\":\"f849a5ef2f68ebda\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbList.js\":\"1205ba242e911640\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"e992d5ef13577bb4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ff3d862dcde0ee9d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1d2a4f730a37a505\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"5e31a1d1b8a9694a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/index.js\":\"9f518b685c84b60c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1433da727ddf2cef\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/CharacterCountItem.js\":\"6b2e9e390e068226\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/ProfilePropertyEditor.js\":\"7a615e131f7eaae1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/actions.js\":\"7a696197994ed48c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/blockType.js\":\"0869b94c6cc52c0d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/charCount.js\":\"0b308fb87ecde8a6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/dataExtension.js\":\"dec53e3d14505081\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/index.js\":\"afe03cb783e7a98d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/profiles.js\":\"2887c8981f7977f2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/properties.js\":\"2ee1ee10c7544be0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/subtree.js\":\"57ab391bc7a62b79\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/character-counter/textCounts.js\":\"f883490fb8281a7d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/colemak-keybindings/index.js\":\"7e81294b3529a938\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/CommandPalette.js\":\"b9f16f288e86b3d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/HeaderItem.js\":\"b71783dba33b78cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/context.js\":\"9130e6ad95629b63\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/index.js\":\"76e83a5bd39ab324\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/selection.js\":\"58a971eec2104077\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/toggleStore.js\":\"4d1802d822315da6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/command-palette/useCommandPaletteActions.js\":\"987c21aac1b103d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ContributorBadges.js\":\"fb0f8df22f9feaad\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/ProfilePicture.js\":\"f33b9772d60700e6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/author.js\":\"cdf9390c56aed2b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/codeMirrorExtensions.js\":\"d55ab7e4a6e4d828\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/dataExtension.js\":\"094def353d22dca0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/index.js\":\"9efcf3e9290ead67\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/mentionAutocomplete.js\":\"68c93cf635274dd4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/processor.js\":\"72d0e2887b202247\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/profiles.js\":\"99beec93bd03fa92\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/queries.js\":\"e96ec6fc49670688\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/schema.js\":\"76c2e55b42743121\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/contributors/useCommentAuthor.js\":\"528221304abb76f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1b4c881cb6598dca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7fb560c271e1a71c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/index.js\":\"3ab5f859a9ebc004\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"ccefa29c3d2c1dcc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d48f51eb370cc8f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/CalendarGrid.js\":\"8d63e1c791655117\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DailyNotePicker.js\":\"0cd019cd58de6d70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"d0c068fdc3e785f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateNavDecorator.js\":\"a2683af97092ed70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DateScrubOverlay.js\":\"09a1e9bdf663a227\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayPropertyControl.js\":\"5030c73bc398ee80\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/DayValueReferenceControl.js\":\"d6e5ffc1c0d7ccc7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/HeaderItem.js\":\"1d16688ae52f57b4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/ReschedulePicker.js\":\"d39a0fcd5acf8f81\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0ae8c2f841f1a49a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/actions.js\":\"778a130a002559a9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/blockDateAdapter.js\":\"ae708ed1bde8ac7c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/calendar.js\":\"806ecccb5b527cad\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dailyNotes.js\":\"9b05cb63934ea014\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dataExtension.js\":\"4d2a6da7e6187769\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubActions.js\":\"5ac4ab40eabb015b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGesture.js\":\"20c9086bb53453b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubGestureActions.js\":\"55ab26acf2ff221c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4ab49e2e13b990d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayProperty.js\":\"48f91f5884f60cf1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"415b9508b6a3d4c4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/deletionGuard.js\":\"3f00a2289c26d2bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/dueQuery.js\":\"6e0dfcee5df36b6d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/index.js\":\"2442ed9fd2e898e3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/landing.js\":\"3597f71e4789cdd3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/localSchema.js\":\"4f294b15f6bdd09b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/referenceDateAdapter.js\":\"b44fdef74e924dd3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/rescheduleAction.js\":\"b2d91bcc0b87e1a9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/schema.js\":\"ea0315845f187b90\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadBlockDates.js\":\"db6809056d7c80cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/spreadDatesAction.js\":\"24a2567921653fc1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/today.js\":\"1df5b4ce4cfc5c54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"21f69ccf7ca843a1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f6fc514eeb43d9df\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/audit.js\":\"2bac44f21278a6d6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditAction.js\":\"cb03fb61995ccccc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/auditRanges.js\":\"7d092d55dff12d15\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/diagnosticsSource.js\":\"b3b981b3f4fe693e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/divergenceScan.js\":\"09d25c832272d3ae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/index.js\":\"abf571d02ca1fcad\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/propertyChildrenChecks.js\":\"669e5d5972ae5e0f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/referencesMirror.js\":\"03cf24144e4be161\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/rowJson.js\":\"943e165ed3f02af3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/schedule.js\":\"2b38fa88d1daf2b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/data-integrity/store.js\":\"3f7fd1eb7aa42de0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/action.js\":\"73336b7ed8e61d79\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/index.js\":\"4813f785b733568b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-maintenance/plugin.js\":\"6551c47acaac91c1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5d773a506c5facc1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/actions.js\":\"1c1f7859fad15300\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/changeMarker.js\":\"947a79dcd2be2091\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/diagnostics.js\":\"c637e46795a22b4b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/fileSystemAccess.js\":\"149549684585de0b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/filenames.js\":\"5d01c3a18c40cc91\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/index.js\":\"c855c03bfe8b18e2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/mirror.js\":\"6c3180ddeea39060\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runLock.js\":\"51fff17ac40011a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/runtimeHealth.js\":\"c25f62d89f9eb956\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/schedule.js\":\"e2ca96ed55dcab4e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/db-mirror/store.js\":\"aea4e7e69b17a7b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/index.js\":\"bb4aabfd74f3f85b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/default-themes/themes.js\":\"60830fc90c4f61aa\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/facet.js\":\"23f470a314f4a5cb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/diagnostics/useDiagnostics.js\":\"7f3fec84bf83e5bd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/dismissals.js\":\"cf244eb794430373\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/index.js\":\"6e3edb2ad814629d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/status.js\":\"5dbd6842dd8a0b0d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extension-prompts/store.js\":\"cf11f707eec48be1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"38096b5b68a6f3ab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/ExtensionsSettings.js\":\"c18746e4243d4478\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/actions.js\":\"e5b5243562123921\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/config.js\":\"6ccb2df47fb54ac7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/dataExtension.js\":\"f4c84b94224c6557\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/effect.js\":\"415a9b558e67ce87\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/index.js\":\"5f63c64156de4d6b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a973873a669b651e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extensions-settings/useToggleTree.js\":\"64dc89ec807d4b98\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/ExtractTypeDialog.js\":\"6c94f0a432fcf1a4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"19d1b2a35455b1cf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/PropertyShapePicker.js\":\"c9871bfc9ee9adc5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/action.js\":\"063a14f55988493b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/extract-type/index.js\":\"dbca9098a7c03832\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/FindReplaceDialog.js\":\"6a9a492f02e01f8b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/HeaderItem.js\":\"61d5990667b22121\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/dataExtension.js\":\"4cea5d1798cdbb4e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/index.js\":\"d935e9dcbf862ad5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/search.js\":\"ceebe8452de6dac7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/toggleStore.js\":\"11a3dfeba4fbe22e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/LocationPropertyEditor.js\":\"846aa99e033e48f3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/MapView.js\":\"ce85abca20a9cfd8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/blockTypes.js\":\"90ab56a3ffdf2074\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/codeMirrorExtensions.js\":\"527dd6c88141e6b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/createOrFindPlace.js\":\"ef9f79a5c4d6fa17\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/currentLocation.js\":\"3c60205ec56a9e07\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/dataExtension.js\":\"d8d18807d43b708d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/geoContentDecorator.js\":\"d8a6a2567932e45c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/googlePlacesClient.js\":\"1db377ab7d52eb4a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/index.js\":\"dacede4764c8a31b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/locationsPage.js\":\"af92a50856e41b0c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/mapViewport.js\":\"c13208bd21c05c67\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/pickCurrentLocation.js\":\"5998366315a7e55b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeAutocomplete.js\":\"c369261652884de3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/placeNameCollision.js\":\"de3d548b4184a398\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/properties.js\":\"f3e985a4cbfaedb0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/propertyEditorOverrides.js\":\"68a8241c805c7f00\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/query.js\":\"35425a55f8946bbd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/geo/usePlaceSearch.js\":\"15f117daa779f3b5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a9c058dea5c4e52f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"93ed6392b4d26598\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e5d359fa9807b386\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/config.js\":\"0e28158903293a37\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/dataExtension.js\":\"062cb98d6cd52577\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/facet.js\":\"f958cf15a2c7eb21\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/grouping.js\":\"bda3ed4fc6cdc0f5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/index.js\":\"4cf8428044f30a2e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f76d14d2c61ec02b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/query.js\":\"4b6d7d4db9b318d8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/resolveConfig.js\":\"83d3d59cdd05efc8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"7f67cb144a28b8e4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"53712d9606a0af53\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlDocumentContent.js\":\"a8cac9bd766b9196\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/HtmlFrame.js\":\"f5fe6671d439fe4e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/actions.js\":\"b5758c8987fd055e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/blockType.js\":\"ce1a22536d029924\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/confirmRunScripts.js\":\"233b81dbdc8d8ab4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/dataExtension.js\":\"4bd199e07b375fb9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameAnnotations.js\":\"e4c7aa34e35cbbbf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameDocument.js\":\"28e96417e0de3bc3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/frameTheme.js\":\"f7c0687a13afe96d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/index.js\":\"9eee38036843a65a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/scriptConsent.js\":\"b1f3ddf7e50c28a4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/sourceMap.js\":\"abcdadd1c7c80e3a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/html-document/useDocumentScripts.js\":\"24376acfeb45879c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/index.js\":\"2ead480b569c2750\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/record.js\":\"8477f3b9dd892f86\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/recordStore.js\":\"e7ef2a8167c8c81a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/responsiveness.js\":\"51caaf0725cd8328\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/schedule.js\":\"f67aa6f0124e0328\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/interaction-metrics/sessionContext.js\":\"f1960825c544d190\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a890610d53fcf03b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6b587f8b4c8c2c73\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/actions.js\":\"2ae6ad788cc2a1f7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/config.js\":\"8d3c7c6fe1260457\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/dataExtension.js\":\"a311e7a8a9173514\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/effect.js\":\"2f720c735ec07465\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/index.js\":\"1943411f183b4825\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/keyCapture.js\":\"8290e0c2d0e9650f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/overrideStore.js\":\"7b410059b6b9d9b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6d9e76f537fcb99f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/HeaderItem.js\":\"179ca0ecdc0a1a58\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/LeftSidebar.js\":\"ef5ef9c1e0091737\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/actions.js\":\"1ce1ab25854a868c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/facet.js\":\"5e3053c16ca39eda\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/index.js\":\"fc047b08ee9c02d7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/shortcuts.js\":\"8ce0d6d11caa0435\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/left-sidebar/toggleStore.js\":\"753f570cb1ad7fd8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/MergePicker.js\":\"feaf5aaaef81a92b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/index.js\":\"1aa24dedd83e63ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/mergeAction.js\":\"076d7e1e48f68d3c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/merge-blocks/strategy.js\":\"2977e001168989bf\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/Button.js\":\"1007277e9dcc1b1b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d34e05cbe507b1e8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e5085ccb339370ed\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/facet.js\":\"8069c3a21f4baad5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-bottom-nav/index.js\":\"c2126f96560c8bf5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a1bf99d272c8dc89\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8716e2bf694e82c6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"63ef22597c403f9c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/facet.js\":\"314b7a9f259497b0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/mobile-keyboard-toolbar/index.js\":\"fd8356977a0e247a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f155e9079d1eef87\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/blockSubtreeMembership.js\":\"a668df12d792a29c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/contextMenuItem.js\":\"1f1a309121004a40\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/index.js\":\"9c32043f7b82bb93\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveAction.js\":\"3c9f6c4dc1aec7ae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/moveBlocks.js\":\"6419afa9736945ed\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/move-blocks/selectionAfterMove.js\":\"52941c7ab6f72bfd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/TutorialBanner.js\":\"b900b55fd05b3345\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/action.js\":\"808e150916935020\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/bannerDismissal.js\":\"2222ccd349da212a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/documents/cheatSheet.js\":\"38bf05b0297bd454\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/index.js\":\"eaf4ad58734f81d2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/keys.js\":\"7afd6876e1a84ab8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/landing.js\":\"8104adf35e6995bc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/outline.js\":\"15f310cf5cc0ce92\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/onboarding/seed.js\":\"d50cbe3d4fc752c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e03d20157c9e3280\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/analyze.js\":\"a0b224f2ec20539c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/diagnosticsSource.js\":\"edec7b2796e7f1b7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/index.js\":\"905b4ea622061896\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/load.js\":\"ddc0b9c8cf7a9277\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/monitorRun.js\":\"ee4c09dc77b6058e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/schedule.js\":\"19e1de32362b6164\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/series.js\":\"806be060f360e5ae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/store.js\":\"8696a3ca4b6b9898\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/trendAction.js\":\"467ed5de92d55014\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/perf-monitor/verdict.js\":\"a1b5f3b548f1d1a3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/clickToEditAction.js\":\"262e2d0a52a619c8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/index.js\":\"534f7937d5b6c661\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/plain-outliner/interactions.js\":\"d2d3506f907519ce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"267a711a8e3b307d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGate.js\":\"6cb6e5f144156403\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/MigrationGateDialog.js\":\"121ddd9b54865130\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/action.js\":\"c832ff765a732fae\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/index.js\":\"67c11074b54496a8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/localRunMessage.js\":\"95bc5265f67c2456\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/plugin.js\":\"a2f9f69ebfb10a36\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/progressReport.js\":\"6f7a3435d006f8af\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/properties-migration/sweepProgress.js\":\"e60de5c321e9fff6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/FieldRowRenderer.js\":\"496b7f24fba325eb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/ValueRowRenderer.js\":\"18566542393070a4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/actions.js\":\"932403bd238a8441\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/autocomplete.js\":\"fcd00b279e0f5441\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/fieldRow.js\":\"4e8180642e1d1419\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/index.js\":\"6dbefffdb735db16\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/referenceWarning.js\":\"8f3973c346bcd54b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueAutocomplete.js\":\"506357dc39c728f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/property-rows/valueSchema.js\":\"3d3e03da13ec4bd0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/HeaderItem.js\":\"05fd09b8c9407d11\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/QuickFind.js\":\"07856594dc17df45\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/index.js\":\"9f79e5ac5bb4e1a1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/recents.js\":\"2a624248c8d8b732\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/resultItems.js\":\"0a007b425de8f19d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/selection.js\":\"cc29692a9d5ddabd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/quick-find/toggleStore.js\":\"0500c34a1c5ab25d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/HeaderItem.js\":\"22c54cee53aec25b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/RecentsPageBlockRenderer.js\":\"99190620520a29b8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/grouping.js\":\"c9df2d6935b32cd6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/index.js\":\"856e9ba2fa426d21\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/recents/target.js\":\"87fda0ea26756c3c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/codeMirrorExtensions.js\":\"a8dfedb282f05290\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/contentPrefill.js\":\"204e32de564d3c55\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/dataExtension.js\":\"949baf3afadd669f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/index.js\":\"cb3eb25214643020\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"1830ceee7f72c5a0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/invalidation.js\":\"866f2105e52cd637\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/localSchema.js\":\"ad46b423efc8d804\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/index.js\":\"b9e6496bb3831671\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"57dd44b8548fb427\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/index.js\":\"08ab5355998352b8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/referenceNode.js\":\"8ed6644782ff1b98\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/remark-reference-occurrences.js\":\"e7ae6d605bcc8a4d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ef010ab9854328dc\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/index.js\":\"bed788293898e309\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"41a67b5f04858f94\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"5154fd3787f85178\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/mergeRetargetProcessor.js\":\"0d80492021dc99a9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/parseFence.js\":\"722bb9fa5e40986a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceParser.js\":\"e7fcb341cd9d9678\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referenceProjection.js\":\"59e1d9b3af81b074\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/referencesProcessor.js\":\"58fc2a4447450c0c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/renameProcessor.js\":\"d0aaa82572768e2d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/references/spanReplacement.js\":\"bb13d0ed90e8519f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/htmlToOutline.js\":\"ecec72ebd7a4d38c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/index.js\":\"96d2f4086f370d33\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f8d25a9e0b96188b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/rich-paste/pasteDecision.js\":\"a9ea98006aa9ffe3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/action.js\":\"d6a6b8500e18e1e4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/blockIds.js\":\"93276c9175f877c9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/content.js\":\"1affd6a22e224c59\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/effect.js\":\"ebb4dffcee5f1b2e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/ids.js\":\"b0a51f84330b3d88\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/import.js\":\"b751ecb8e930f1db\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/index.js\":\"8fe426af74e4db8c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plan.js\":\"cb7f377e15dc065b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/plugin.js\":\"b7c3c3e830a7a852\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/promotion.js\":\"24a1f90e0eaf3ddd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/properties.js\":\"297d9c7b0f7407be\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/references.js\":\"2e87e00afe1e3b12\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/report.js\":\"73f5030a3558fe98\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/roamMemo.js\":\"bb4e10c6e861ed97\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/runtime.js\":\"e32b58fc06c2d031\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/schemaReconciliation.js\":\"7161125ffdfabf8e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/srsMarkers.js\":\"324e125fb87d3927\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/todo.js\":\"215ce21009fd4173\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/typeCandidates.js\":\"67519b2192f896f9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/roam-import/types.js\":\"ab0601ae28d7cead\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/index.js\":\"694f4304b3642c3b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/search-health/store.js\":\"071e88b4da9daf28\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/HeaderItem.js\":\"8e783d1af64c438e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"904917ad96f194b7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/index.js\":\"99ff510d3f644287\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/model.js\":\"2c2af77b3cd65ce9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/toggleStore.js\":\"6f3d06aa345bb722\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/shortcut-help/useKeyInspector.js\":\"786ecfaecf022d3f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1c9192329ba72108\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/ShellDecorator.js\":\"08d3c38d2bc36123\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/actions.js\":\"0eb237dbbb5ba331\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d35e0fd07435d945\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/index.js\":\"7a9da45a0b659280\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/shell.js\":\"aae629a20956e3a0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/surface.js\":\"4de909f34c7b5aa5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/spatial-navigation/walker.js\":\"89c5fd18063616e5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/RescheduleToast.js\":\"38865a9f76352067\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/dataExtension.js\":\"93f6b932ee7ee578\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/index.js\":\"cff3f3b58554f366\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/indicator.js\":\"2a27ef8410bbf3c8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/moveSrsState.js\":\"3e5d2f79ca8a42f0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"048f3bd0d8e7f811\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/scheduler.js\":\"7b5f069487ea1cff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/schema.js\":\"2e222e4f2c6d706b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f70f14edb60b9a57\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/srsClipboard.js\":\"60f6d737735c43c0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7b3c2c6fbc82eeca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DailyNoteReviewHint.js\":\"fcc56e3d753f15b3\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/DeckPicker.js\":\"1918252f1def623e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewControls.js\":\"3ccea4a15d6a9c81\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewDeckRenderer.js\":\"0b973aa88764f945\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/ReviewSession.js\":\"3f5c8696ccbf5b38\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/actions.js\":\"646dcb05cd02112e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/archive.js\":\"020692cca4ea7aa4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dataExtension.js\":\"ada77fcfe08f2186\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/deck.js\":\"90c9ccdba2db49f4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/dueQuery.js\":\"3195386864246e12\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/gradeDecision.js\":\"02da8f8f8735f71c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/index.js\":\"7516b0d7705b8c4a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/keyHints.js\":\"a88a9f7511f6d56a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewCardLayout.js\":\"e907ffad0c54ef1c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/reviewProgress.js\":\"602ce5396a63f58d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/schema.js\":\"2f85f06c8f754397\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/srs-review/useDueCards.js\":\"b118790be50817cb\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/index.js\":\"294612ad9d9ea0b2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/startup-metrics/record.js\":\"62aaa7f2053c2cd6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/index.js\":\"5aba4203544efd4f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/persistenceStatus.js\":\"a63eeda61179fd54\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/storage-persistence/requestAction.js\":\"7ab3cf3faaa010cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/TypeChipsDecorator.js\":\"4073842f78310116\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/codeMirrorExtensions.js\":\"3c74e0965b14ef14\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/index.js\":\"f6b2a70981172ca0\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/supertags/typeAutocomplete.js\":\"7c92615153be6d40\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"2a29623ebf913f0d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/actions.js\":\"03e4dfeb0172f373\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/anchor.js\":\"e3e369ff3de2b466\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/events.js\":\"5bdc1846bd1b8e67\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/gestureActions.js\":\"a80340b4d2d84a6b\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/index.js\":\"2e732b054c017730\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"6e5c30b6b7df8b0a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/collect.js\":\"29a31493d5a7fc3a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/index.js\":\"cde651ef0a5ccc77\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/sync-metrics/record.js\":\"9606483677c60361\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/RejectionDialog.js\":\"fd3593b8e63fe45d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f9b1b35808105035\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/index.js\":\"a1e8b243db7559c5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/model.js\":\"a36a96ac02cdeb56\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/queueCounts.js\":\"64d37319180505e2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rejectedHelpers.js\":\"9707a5e5d5429d07\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/rematerializeAction.js\":\"a47723b7f2ac6f4c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/system-status/useHysteresis.js\":\"a32f3a51eaa896c9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/ColumnHeaders.js\":\"b2827a2bba98085a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/QueryUi.js\":\"cde845a17e737168\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/TableLayout.js\":\"6fbcdf2fbac641ca\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/actions.js\":\"2882625e0358aa7e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/cellEdits.js\":\"6be2e4689ab4f6e1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/childrenViews.js\":\"d8e665d360f9bcd2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/columns.js\":\"1ffd30251eb47698\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/controller.js\":\"0e2525ff3914f195\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/convert.js\":\"ceb94995077275a1\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/dataExtension.js\":\"199352fbd84813e6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/index.js\":\"8a7d51038f284d17\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/keys.js\":\"217c3a66df69bf69\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/model.js\":\"7632b3f45b87b610\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/QueryText.js\":\"0befc00350808096\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/backfill.js\":\"b0f8fff82aa31624\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/completion.js\":\"c87d6a44d3c79022\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/format.js\":\"c8cf1aa2576fa5b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/parse.js\":\"f18c02fa9880487c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/queryValue.js\":\"b00f8005eed5c4b9\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/registrations.js\":\"40eae915372f9190\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/query/source.js\":\"6c73b83acb5685cd\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/registry.js\":\"eefbd052ce9c940a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowGutter.js\":\"34bcd1c603a047a5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/rowVerbs.js\":\"edaa25246a9c7265\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/schema.js\":\"7cd81a155694d337\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/tables/sort.js\":\"4f024efb734c1f26\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/effect.js\":\"8e5a26fc3dbb5592\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/index.js\":\"3c747d6332784883\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/theme-toggle/theme.js\":\"95d44ae1a25c48e4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/actions.js\":\"a67ccb4dbaa9250d\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/dataExtension.js\":\"05fe454e6bef67e5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/index.js\":\"c48a81fc21d24291\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/todo/schema.js\":\"716f7a01c0bb0269\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ebf461d3add05549\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/actions.js\":\"763595ade008aab7\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/defaultItems.js\":\"28e4450fc42c5c20\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/facet.js\":\"eaf1f3c1c3a83469\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/holdRecognizer.js\":\"bbfa768d3ae26e60\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/touch-selection/index.js\":\"d167e636ae06524a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/UpdateIndicator.js\":\"c23b941c0243865c\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/index.js\":\"d27dae0500642a4e\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/update-indicator/loadTimes.js\":\"45cb0d0a7c770a65\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoNotesRenderer.js\":\"7a44383fefb6322a\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoPlayerRenderer.js\":\"55795eabc131caa4\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/VideoTimeStamp.js\":\"93268f7afabe87c2\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/actions.js\":\"a43592e5a2f01f71\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/index.js\":\"4cd4da02234b4313\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/markdown.js\":\"6f40c3e79a973cf8\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/notes.js\":\"8cca4d692d4b9ee5\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/registry.js\":\"765feae1c54897ff\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/remark-timestamps.js\":\"a0ffc673c9a39410\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/video-player/view.js\":\"ec4d1f059ceb33ab\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/LinkHints.js\":\"027df4f01efe2b70\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/index.js\":\"19500c56f0d6425f\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/model.js\":\"9a2ab8da0a6f2d27\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-link-hints/settings.js\":\"893201ab423137da\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/actions.js\":\"22ad593476925a29\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/index.js\":\"4de202ce6712f6c6\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/vim-normal-mode/interactions.js\":\"764d2c8124dfbdce\",\"/knowledge-medium/pr-preview/pr-1912/src/plugins/workspace-header/index.js\":\"8d2dd3797cf8f0c0\",\"/knowledge-medium/pr-preview/pr-1912/src/registerServiceWorker.js\":\"92eb572348463fc3\",\"/knowledge-medium/pr-preview/pr-1912/src/requestPersistentStorage.js\":\"1ac6f8f3cd026d7b\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authRequestDeadline.js\":\"c26ef98ff74ed311\",\"/knowledge-medium/pr-preview/pr-1912/src/services/authStorage.js\":\"df24d451db21a0ab\",\"/knowledge-medium/pr-preview/pr-1912/src/services/powersync.js\":\"7c330173f96cd9ad\",\"/knowledge-medium/pr-preview/pr-1912/src/services/supabase.js\":\"a4685dfbb4732c4f\",\"/knowledge-medium/pr-preview/pr-1912/src/services/uploadErrorClassifier.js\":\"74aebb1a0473ebb1\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/ActiveContexts.js\":\"531f0f7ea2b58997\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/HotkeyReconciler.js\":\"f430f2e3fe7bae14\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/WipeLocalDataDialog.js\":\"c832d72068b05dae\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionDispatch.js\":\"5b00efeb61daa780\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/actionRefItems.js\":\"4b83ad7d3bed44b8\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/applyKeybindingOverrides.js\":\"d843d8a0155e12f3\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockActions.js\":\"b4fbea25e055e666\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/blockMergeGesture.js\":\"c9f4721ed928f3c2\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/canonicalizeChord.js\":\"9b088c5a60cf0ee1\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultContexts.js\":\"e100938c1011da8b\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/defaultShortcuts.js\":\"7bbd568e703b7b5c\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/effectiveActions.js\":\"ae48496ef396463c\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureAction.js\":\"2f05f819737ca127\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/gestureBinding.js\":\"ccb419e7467bc6f2\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/holdRegistry.js\":\"b3e6120b716aea71\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingConflicts.js\":\"2cb640c07ace294e\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/keybindingOverrides.js\":\"e2a1d35f2d4b8254\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/pointerAction.js\":\"a98808365807a016\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/resolve.js\":\"67bfdb99a9c35b24\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/runAction.js\":\"5ebc55b67a374929\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/sequenceMatcher.js\":\"99f7fb6f77d3a195\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/types.js\":\"1968c41cb9eb5c1e\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionContext.js\":\"cd33aa7a7e1c6441\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/useActionDiscovery.js\":\"ac74391c0edafd1c\",\"/knowledge-medium/pr-preview/pr-1912/src/shortcuts/utils.js\":\"dfb1a67d6f7b8597\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/bootStore.js\":\"1de29caac318551b\",\"/knowledge-medium/pr-preview/pr-1912/src/sw/previewDatabases.js\":\"d0846c88a17f621a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/byteTransform.js\":\"a5d979ffe971c218\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/attachmentCleaner.js\":\"84984f597a70c63a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/attachmentParts.js\":\"dcf8fde1eb89f8c5\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleParts.js\":\"50e9d5d4c4b7e0fb\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/bundleRecord.js\":\"b8dafbef559f85b3\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/manifest.js\":\"9259081b9d2f4f86\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/takeBundle.js\":\"61eaef38da26f88e\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/bundle/verifyBundle.js\":\"e7af8d9926182b99\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/cleaningStage.js\":\"20a8d17904f3a4bc\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionKey.js\":\"3f4a4f2816f5cfb0\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/conversionServer.js\":\"828d30da5f5ded25\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flip.js\":\"f4e752f1bd719836\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/flipAttempts.js\":\"3c9c7a0a2acad830\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/pages.js\":\"79a3569ea8db2ad1\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/preflight.js\":\"0763a7eb922a78bf\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/reseal.js\":\"36b5b2f80f8413eb\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runConversion.js\":\"8edcb43511c631ae\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/runLock.js\":\"3509eb881397e141\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealing.js\":\"c8669d170557cee4\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/sealingStage.js\":\"5d98f715d05bc85b\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/stage.js\":\"27722388d20d80c2\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/conversion/verifyReseal.js\":\"64e42a5194a90bb1\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aad.js\":\"09e2fe4e77cbfebe\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/aead.js\":\"feb7c357754bddb8\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base32.js\":\"3d51c2c8b4bdd5bc\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/base64url.js\":\"2fc3cf32fbda15b0\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/binaryEnvelope.js\":\"aac95802ac89c752\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/byteAead.js\":\"fbf4ef11263b0d36\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/canary.js\":\"a4530e3c42c5d749\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentHash.js\":\"d5455ebc87d6f4f4\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/contentKey.js\":\"e2ebe379b310c0dc\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/derivedIdNamespace.js\":\"e0e3efafc6b8f32a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/envelope.js\":\"8a13bc3d0635ff7b\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/hex.js\":\"13ad267ed1b971c6\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/sha256Hex.js\":\"c8f7314565d92f52\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/crypto/workspaceKey.js\":\"cf3cd236a434fdfc\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/conversionState.js\":\"256fb96927c249ea\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/createEncryptedWorkspace.js\":\"4568c76634edc6b8\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/pastedKey.js\":\"dc0b0c44ef6c9613\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2ed587f8e617051f\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8c29ae58aac0ecb2\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/keyStore.js\":\"ba241b4f1c20f602\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/mintWorkspaceKey.js\":\"4e5ed21d7e72cb5b\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/modePin.js\":\"ebe8a841b73e2404\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/openWorkspaceKeys.js\":\"973ed2648998157f\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolveWorkspaceEntry.js\":\"50a14536c9a7ef8e\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/resolver.js\":\"8c9d0fc130547f8a\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/keys/workspaceAccess.js\":\"32c05ed241d2bd00\",\"/knowledge-medium/pr-preview/pr-1912/src/sync/transform.js\":\"a973253c42a44a42\",\"/knowledge-medium/pr-preview/pr-1912/src/themeBootDefaults.js\":\"c4fefe0f21d1af87\",\"/knowledge-medium/pr-preview/pr-1912/src/types.js\":\"e258bfc7a9a4c1f4\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/ClientLocalSettings.js\":\"91d40d5873b16044\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/abortableSleep.js\":\"be4a1f0bc61ff032\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/array.js\":\"2f3f7ff0c0848fdd\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/backlinkAutocomplete.js\":\"f3318f0e59d58c48\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockCrumbs.js\":\"eb1a8375c659c0a1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/blockrefAutocomplete.js\":\"4f7b013e8f84f6a8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/cadencedIdleJob.js\":\"86ff6133343bac1f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/callbackSet.js\":\"9bc73116c8e51aaa\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/clientId.js\":\"11eccabebc0a01b7\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirror.js\":\"f248b5c24c283caa\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/codemirrorCompletion.js\":\"eb5a9bf5d39558ac\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/copy.js\":\"33c746ee5f8684cf\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dailyPage.js\":\"f46d8ee94ceef8be\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensics.js\":\"b503d90b68f75104\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dbForensicsHooks.js\":\"75f7098c934f751f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/deleteBlockThroughUi.js\":\"c744e8382021b70d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dialogs.js\":\"8feb99937a16ad06\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/dom.js\":\"5c1e10c1363299a7\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/downloadBlob.js\":\"48c4eac38ada91b3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/drawnWalk.js\":\"c73ed536c02f2f15\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/exportSqliteDb.js\":\"dee2d4927b4a5ff6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fileSystemAccess.js\":\"3deb1428aa9bbee0\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/flipSlide.js\":\"8b21bc315905455f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fnv1a.js\":\"20c24e346d5f9092\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/formatBytes.js\":\"328155b1e7f60654\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/fuzzyRank.js\":\"9783f22e450cb565\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idbKeyedStore.js\":\"4dc00c593bd2919d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/idleCallbackPolyfill.js\":\"86ed0f75979e9130\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardAwareScroll.js\":\"2e0b64a09cd4b1de\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/keyboardViewport.js\":\"99e9ad8463f3fa41\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/lastWorkspace.js\":\"7c8fad56f1caccf1\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutColumns.js\":\"6580cb78ab94e30e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionDom.js\":\"84780be43c028695\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/layoutSessionId.js\":\"1f0f3e70784fd590\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkClickGestures.js\":\"e5b9541a40a058d3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/linkTargetAutocomplete.js\":\"4a5fd48ca2070d9c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbCorruption.js\":\"b865f1b980c0eb62\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/localDbRecovery.js\":\"68b966880ded4413\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/markdownParser.js\":\"8838c197b5b52c09\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/memoize.js\":\"dc6354550a524382\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameFieldCommit.js\":\"f47a89f08b69d7d2\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/nameList.js\":\"4d04b2e5d8df111c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/navigation.js\":\"f319246741c0bff2\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/omnilinerNamespace.js\":\"d7fc560604889a9f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/opfsPageScan.js\":\"f24a9768263ae88c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelClearance.js\":\"e3a9e460dbd8e673\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelHistory.js\":\"a1da514e85906efc\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLanes.js\":\"220e355642f1256a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelLayoutProjection.js\":\"fa32d5201f3ec580\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelScrollAnchor.js\":\"684aca9e8d37a0df\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/panelUrlFlags.js\":\"53284567b3d48dc7\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/platform.js\":\"b0adc7c1e1f0f6e2\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/pluralize.js\":\"e531a16d766f7318\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyCreation.js\":\"b63e72382716083f\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyNavigation.js\":\"52e20a74b1dba948\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/propertyValueContext.js\":\"5f7631e12daed8c2\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/react.js\":\"3b8569315a4e670d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeDate.js\":\"f4e028648065c5fe\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/relativeTime.js\":\"91242500c61af2a0\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/renderScope.js\":\"2048ab6bc9e9442a\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/resolvedThenable.js\":\"031151850e3fdc3c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/routing.js\":\"a67e3c8039b71c35\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/safeMode.js\":\"8ff15f9d42b3ee09\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/scheduleIdle.js\":\"25e7b80a54065429\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/screenWakeLock.js\":\"711b7c3820282bfe\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/selection.js\":\"9978637836c6bd68\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/softKeyboardGrab.js\":\"004fb173ad00510b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/startupTimeline.js\":\"6874b289a004de7b\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/state.js\":\"3c2328e4986779eb\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/string.js\":\"df172fa9d70e1564\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/surfaceZoom.js\":\"46d56bff3f0b1da3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/time.js\":\"1affa24a82f76ec3\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toast.js\":\"1c303c78ed9a3010\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/toggleStore.js\":\"2578b4a6ffd6264e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/untilStopped.js\":\"a087135c25184d9d\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/userActivity.js\":\"2d6b78b57dc10166\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewTransition.js\":\"0f1539b4a52967e8\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/viewport.js\":\"11a438593cb01ffb\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/webLock.js\":\"bf4cc1e371adc71e\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceRecovery.js\":\"3fc9cb89e9dc871c\",\"/knowledge-medium/pr-preview/pr-1912/src/utils/workspaceSnapshotStore.js\":\"c5f4a1feaec423c9\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-compiler-runtime.js\":\"e740964cdd28d2ba\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-client.js\":\"fe09d0e45c506b4f\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server-edge.js\":\"ee5883476f804232\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-server.js\":\"bac1c630f883fb80\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static-edge.js\":\"7873c0162a16a9e0\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-static.js\":\"55efd6ea079a9e6a\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom-test-utils.js\":\"91a432e3bb3ae845\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-dom.js\":\"b07913533f9d5877\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react-jsx-runtime.js\":\"4dd0fd01f7df1639\",\"/knowledge-medium/pr-preview/pr-1912/src/vendor/react.js\":\"2387480687d971c3\",\"/knowledge-medium/pr-preview/pr-1912/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1912/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
