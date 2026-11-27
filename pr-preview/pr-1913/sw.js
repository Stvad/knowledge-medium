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
		buildId: "7cfd096963a9-7d83d542",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1913/\":\"175642f833ffa9b3\",\"/knowledge-medium/pr-preview/pr-1913/index.html\":\"175642f833ffa9b3\",\"/knowledge-medium/pr-preview/pr-1913/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1913/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1913/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1913/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1913/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1913/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1913/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1913/assets/FacadeVFS-Dq-uz9fK.js\":\"7df341564208245a\",\"/knowledge-medium/pr-preview/pr-1913/assets/OPFSCoopSyncVFS-zbQ6AX15.js\":\"d63ee71fa83be524\",\"/knowledge-medium/pr-preview/pr-1913/assets/OPFSWriteAheadVFS-DOEQMkYK.js\":\"0c835c0111fce6f2\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-CM2i-o0v.js\":\"d89495481ad60b3a\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-async-G5Y8KuP5.js\":\"ad1c9e692c325ca1\",\"/knowledge-medium/pr-preview/pr-1913/assets/worker-DTLUgHff.js\":\"d4a632d77255de17\",\"/knowledge-medium/pr-preview/pr-1913/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1913/chunks/app-Ck_K1Mof.js\":\"94c4820bf9659a61\",\"/knowledge-medium/pr-preview/pr-1913/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1913/index.js\":\"9dd78d607ff66fbb\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1913/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1913/assets/AccessHandlePoolVFS-CmHraNVh.js\":\"5d4b597bda3290ba\",\"/knowledge-medium/pr-preview/pr-1913/assets/IDBBatchAtomicVFS-DMLyxE9a.js\":\"f39dc455f8b009ce\",\"/knowledge-medium/pr-preview/pr-1913/assets/MemoryVFS-Bdytf1mF.js\":\"5f90ada5a1550366\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-DeUM8KdP.js\":\"15b3ae6565954c4e\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-async-DdyNPuJg.js\":\"865b1df783a12fea\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1913/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1913/chunks/AccessHandlePoolVFS-BmlwTFNF.js\":\"f8d0a0bc0d09874a\",\"/knowledge-medium/pr-preview/pr-1913/chunks/FacadeVFS-BYcJPcgB.js\":\"bf8ffce90ea213fe\",\"/knowledge-medium/pr-preview/pr-1913/chunks/IDBBatchAtomicVFS-DSrZukQv.js\":\"fcd1b96aff7f5217\",\"/knowledge-medium/pr-preview/pr-1913/chunks/MemoryVFS-f9AqD0cd.js\":\"7addd293620e26d4\",\"/knowledge-medium/pr-preview/pr-1913/chunks/OPFSCoopSyncVFS-DC0Y-z5t.js\":\"b565e96a067edc93\",\"/knowledge-medium/pr-preview/pr-1913/chunks/OPFSWriteAheadVFS-BLUMztGM.js\":\"e66ccfa068d81a15\",\"/knowledge-medium/pr-preview/pr-1913/chunks/Preview-DNqm1f3K.js\":\"ebea6c0cc4ee913c\",\"/knowledge-medium/pr-preview/pr-1913/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1913/chunks/card-HaLrlgzh.js\":\"f6294d1857eac070\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dist-CTZss61T.js\":\"6ec0f14287929dca\",\"/knowledge-medium/pr-preview/pr-1913/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1913/chunks/mc-wa-sqlite-DhWyFnQv.js\":\"2963240dbeca53fb\",\"/knowledge-medium/pr-preview/pr-1913/chunks/mc-wa-sqlite-async-CEP3j4g2.js\":\"e73fb7260a789361\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react--dJIs_o6.js\":\"299e9cf0152aedd8\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-8-o6Wf8H.js\":\"a69f547f6c5ec019\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-C2NbC59j.js\":\"d3e4d4682cb47d46\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-DEYABNI9.js\":\"dd3f3fe97cae7643\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-DwC1Z024.js\":\"468647b7817faed7\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-M_e7EVvh.js\":\"d42318275db98ec4\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-RTezOAdm.js\":\"583594e0e794f575\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-dom-server-legacy.browser.production-BoJlrC7Q.js\":\"0dde7b7cbc9ea31e\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-dom-server.browser.production-CBCqH279.js\":\"a6dc0e99d39be34f\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-dom-server.edge.production-BuiNmad5.js\":\"ea27eee5afb44544\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-osBPwPME.js\":\"b43700b8cc5901e6\",\"/knowledge-medium/pr-preview/pr-1913/chunks/server.browser-BbVwDFex.js\":\"e8e7ff846be5db8f\",\"/knowledge-medium/pr-preview/pr-1913/chunks/textarea-cuaKtqSd.js\":\"28f5be55621bc547\",\"/knowledge-medium/pr-preview/pr-1913/chunks/ui-DqXVJbz8.js\":\"38b5c0966809b537\",\"/knowledge-medium/pr-preview/pr-1913/chunks/wa-sqlite-DYfUVSVd.js\":\"a06802cde770a808\",\"/knowledge-medium/pr-preview/pr-1913/chunks/wa-sqlite-async-DJtfdoBK.js\":\"b51c8886f3bfb9ef\",\"/knowledge-medium/pr-preview/pr-1913/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1913/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1913/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1913/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1913/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1913/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1913/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1913/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1913/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1913/src/App.js\":\"412ec0c44a50036f\",\"/knowledge-medium/pr-preview/pr-1913/src/appUpdate.js\":\"e9b88efce4e4b6fa\",\"/knowledge-medium/pr-preview/pr-1913/src/appVersion.js\":\"22fdd74b945c3f07\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/initialLayout.js\":\"9e113fab31ddf285\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/openWorkspaceData.js\":\"493a46cbf50bea27\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/resolveWorkspace.js\":\"d6ac85830e4c9e5b\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/workspaceBootstrap.js\":\"aaf5daf08d2c3a5f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockComponent.js\":\"a7db0a9e951dbc1b\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockCrumbs.js\":\"3cd026ae5d89c0f5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockEditor.js\":\"714b976656aa05e1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockLoadingPlaceholder.js\":\"94250b5e5ee98998\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockProperties.js\":\"90377a57a56f936d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockSearchPicker.js\":\"e613dca45bad879a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ConfirmBulkDeleteDialog.js\":\"2dabfff4d9f245e3\",\"/knowledge-medium/pr-preview/pr-1913/src/components/DividerHandle.js\":\"1ef0e430ba228bd0\",\"/knowledge-medium/pr-preview/pr-1913/src/components/DraftEditor.js\":\"4919a1913d85bce3\",\"/knowledge-medium/pr-preview/pr-1913/src/components/GutterPill.js\":\"5a4a92dbbe5e8811\",\"/knowledge-medium/pr-preview/pr-1913/src/components/Header.js\":\"88b17125d16ba216\",\"/knowledge-medium/pr-preview/pr-1913/src/components/LazyBlockComponent.js\":\"beabb3b4f550e0db\",\"/knowledge-medium/pr-preview/pr-1913/src/components/Login.js\":\"3f46df5d8c12abd6\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ZoomableSurface.js\":\"4f56b3aff0d31058\",\"/knowledge-medium/pr-preview/pr-1913/src/components/editModeKeepalive.js\":\"82103ab7d578c03c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyDisplay/PropertyDisplayScope.js\":\"ca02221fdf9c6af9\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"86e2cdc467db6251\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/RefPropertyEditor.js\":\"bf02be4e99f2dd54\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/RefTargetTypePicker.js\":\"0424fccb67800b5c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/SelectPropertyEditor.js\":\"ae111af633ee9565\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/TypesPropertyEditor.js\":\"08a49ac8b7661c14\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/defaults.js\":\"9d76df578caaf28c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/kernelValuePresets.js\":\"62ecdee8ee550c02\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/selectablePresets.js\":\"dca9de3e0c3284d2\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/typesPropertyUi.js\":\"1bc8c15de4a3291a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/AddPropertyForm.js\":\"e6b93b80e96bf4a9\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/PropertyPicker.js\":\"c0775e416ae3e82b\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/PropertyRow.js\":\"548c993e22835fa4\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/Rows.js\":\"80ce02a88c6390b1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/actions.js\":\"1085d8af55e79e5b\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/declarationOnly.js\":\"0547fc70f979d0af\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/layout.js\":\"2955e21d08851ec4\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/model.js\":\"14412a2dbf6ef2f8\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/shapeUi.js\":\"452082e436f339b3\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/shapes.js\":\"03767d34dbf61dd2\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/usePropertyEditingActivation.js\":\"a3e86046bb9bbe97\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/visibility.js\":\"f1b44201d560bb62\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanelSections.js\":\"133076c8e754340e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/BlockEmbed.js\":\"757edf41ac6c8eb0\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/BlockLink.js\":\"75f6613d721ff29a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/BlockRef.js\":\"a07f433ada134bb4\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/CompactReferenceLink.js\":\"0ec50e9804b0ae5f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/ReferenceLink.js\":\"e66afee18c7c5b47\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/cycleGuard.js\":\"a2bd354f173462e8\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/cycleGuardContext.js\":\"1e68e7e49932114d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/linkInteraction.js\":\"ff5f855ebea8a66e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/referenceLayout.js\":\"e0be2b9d1a6d4978\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/useBlockRefAncestors.js\":\"31e8b9414ab36b93\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockGutter.js\":\"3a3f545e1b3197fd\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockInfoDialog.js\":\"22046d8d136b2b26\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockReadText.js\":\"b3e852ed8f14997b\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockTypeBlockRenderer.js\":\"699c1eb4cfe1ded1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BulletHoverCard.js\":\"e3df0c91e4a07fb7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/CodeMirrorContentRenderer.js\":\"f776bad332504407\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b9a31d702c330e16\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/ColumnResizeHandles.js\":\"cfecab698aa6ce67\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"557be9eb74e74c2f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/DefaultBlockRenderer.js\":\"f9498c33395a7fdc\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/LayoutRenderer.js\":\"728bf83d6f9935fc\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/MarkdownContentRenderer.js\":\"7915f34cc12798f1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/MissingDataRenderer.js\":\"864780cc4fdc7efd\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/PanelRenderer.js\":\"e891dee5e576a9b3\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/PropertySchemaBlockRenderer.js\":\"cc94e04ec45112f7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/TopLevelRenderer.js\":\"edae997c8c3e2216\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/blockGutterMode.js\":\"b0b599304f56f5ea\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/blockTitleText.js\":\"f6ef4d9be220afd1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/fieldCreationKeydown.js\":\"2589578de9a0ccba\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/layoutRootContext.js\":\"8147a0119b2c72a1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/typeChip/TypeChip.js\":\"cf061760c39cf3b8\",\"/knowledge-medium/pr-preview/pr-1913/src/components/typeChip/chipStyle.js\":\"1c9d4d72d0a22910\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/anchored-floating.js\":\"5a6cb6278849edde\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/button.js\":\"e4707b6b45d4d432\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/card.js\":\"a8392982438677b6\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/checkbox.js\":\"aba5e501ca2dc8d1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/collapsible.js\":\"1c6f9a46243005ef\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/command.js\":\"4f1e94925b4b0704\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/context-menu.js\":\"11e28b31cd35762b\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/dialog.js\":\"a6fd2fd27bf5f5c1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/dropdown-menu.js\":\"5afa0db33e876f20\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/floating-listbox.js\":\"3224a0a4635a1bcd\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/index.js\":\"a94993dd59d3c5cb\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/input.js\":\"836eb7b716bdd59a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/kbd.js\":\"33eee9cf101fc783\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/label.js\":\"577926be5987ccee\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/textarea.js\":\"8856fbaa4f52b460\",\"/knowledge-medium/pr-preview/pr-1913/src/components/useEditModeYieldKeepalive.js\":\"afec45ce1ec38019\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/BootFallback.js\":\"2b1f74f1498a6cba\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/FocusedRowLazyMount.js\":\"46c57eb302fb07c7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/LazyViewportMount.js\":\"fcb47270a324dad9\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/LocalDbCorruptionFallback.js\":\"0eef6e81f368fb8d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/error.js\":\"6c8677ae24e27051\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/lazyMountRegistry.js\":\"52f8d5e6427c4043\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/suspense.js\":\"3fe747f604866f02\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/CreateWorkspaceDialog.js\":\"378f748a66ac83af\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/PendingInvitations.js\":\"64c7bd9ff0d71b86\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/SyncProgress.js\":\"f537d25f14c70bd8\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/UnlockProgress.js\":\"1b2dbf8470259a5b\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceKeyGate.js\":\"e4c886ece389a6d0\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceSettingsDialog.js\":\"e7f384db51042760\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceSwitcher.js\":\"10a37300ad47f54d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceSyncGate.js\":\"27e7d53d2f321917\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/ConversionFlow.js\":\"4747b5769a4e1629\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/ConversionFlowHost.js\":\"01bae9cb916fbf68\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/EncryptionSection.js\":\"3805fcc1b6d7e278\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/attachmentPrompts.js\":\"546b8b09f1841b7c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f2c0d978a451c162\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/conversionFlowDeps.js\":\"ab51c556d1164777\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/conversionFlowStore.js\":\"4838434649aedfb0\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/flowUi.js\":\"cd474a03492ada50\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/useConversionRun.js\":\"b80c7b3edfbabc53\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/keyUi.js\":\"42ff04be8d10eb8e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/useCloseOnKeyLoss.js\":\"a9a3147ab908cbe6\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/useCloseOnServerE2ee.js\":\"7fe0d4355d0b95ca\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/workspaceUnlocked.js\":\"9a8267926b725437\",\"/knowledge-medium/pr-preview/pr-1913/src/context/backgroundSubtree.js\":\"1f3d91d5ab679998\",\"/knowledge-medium/pr-preview/pr-1913/src/context/block.js\":\"47799ea21c4260c7\",\"/knowledge-medium/pr-preview/pr-1913/src/context/layoutWsContext.js\":\"a6bdf2eb3111e8f4\",\"/knowledge-medium/pr-preview/pr-1913/src/context/propertyDisplay.js\":\"ea64d8785a6fad82\",\"/knowledge-medium/pr-preview/pr-1913/src/context/repo.js\":\"a985352c53814d3f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/aliasClaim.js\":\"bad1d6efdd7a7ad8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/aliasSeatNamespace.js\":\"ae3648e556bb7c9e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/blockData.js\":\"99c5746094b284c8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/blockType.js\":\"b84792b27fc5fc27\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/changeScope.js\":\"c7e89020f2cbc1c5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/codecs.js\":\"5f47e3467a93859f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/derivedData.js\":\"f2af36c879eade1e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/errors.js\":\"f48c6d0aab279590\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/events.js\":\"a60f389e3471039d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/handle.js\":\"e0137f4f970b39f1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/index.js\":\"7e01207aaf47c556\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/mutator.js\":\"1abc74efd6ff896c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/processor.js\":\"948472b0b2eabb44\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/propertySchema.js\":\"6e0a3e06f8818674\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/query.js\":\"5ef2cfe7e168a978\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/sameTxProcessor.js\":\"1c54139184ebca54\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/schema.js\":\"e0137f4f970b39f1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/tx.js\":\"e0137f4f970b39f1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/typedBlockQuery.js\":\"49f00806e9796046\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/user.js\":\"92c28a752fbca9b3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/valuePresetCore.js\":\"3d1fc1f20df51dd0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/valuePresets.js\":\"c383d169b60cd75a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/attachmentCleanerIOVerb.js\":\"085f3c2cce3215a0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/block.js\":\"a9b8b0468dcd30fb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockCache.js\":\"cab0a31ed1fedfa7\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockId.js\":\"43b06a20d553db9a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockLiveness.js\":\"d402f333c9016a51\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockMerge.js\":\"8e9327e4414a984e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockSchema.js\":\"c4b99ad4b516f582\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockTypeLookup.js\":\"765d5eceb8048f14\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockTypes.js\":\"4ce3a2950b202337\",\"/knowledge-medium/pr-preview/pr-1913/src/data/childrenView.js\":\"04d4bc849651795b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/clientContext.js\":\"62138e4da8cbfe80\",\"/knowledge-medium/pr-preview/pr-1913/src/data/dbFileSiblings.js\":\"66d3328fc6bd909f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/definitionSeeds.js\":\"895c588f54a88802\",\"/knowledge-medium/pr-preview/pr-1913/src/data/derivedIds.js\":\"af11aced942722c7\",\"/knowledge-medium/pr-preview/pr-1913/src/data/drawnSubtree.js\":\"c6f5c466677fa6b0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/facetBridge.js\":\"654b61f3245b3e45\",\"/knowledge-medium/pr-preview/pr-1913/src/data/facets.js\":\"1630777226ef8d25\",\"/knowledge-medium/pr-preview/pr-1913/src/data/globalState.js\":\"02f66c152e5ebe2e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/aliasClaimRederiveProcessor.js\":\"39c5ce5f418bab37\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/ancestorBatch.js\":\"d144f6e711eaec7d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/blockTypeTypeifyProcessor.js\":\"4d51e310d52c292c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/clientSchema.js\":\"297c438a58cbc806\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/commitPipeline.js\":\"8b837fe11acdaa12\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/devAssertions.js\":\"c2d00cac46a77453\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/firstSync.js\":\"134bf2b8d04ad302\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/freshInitialLoad.js\":\"765b58e4eed7f50d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/graphBackfillClaim.js\":\"ac00e18736fbafeb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/handleStore.js\":\"7e5d810313a8f2f0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/idleMarkerJobs.js\":\"c9ba010618c66c85\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/initialDownload.js\":\"dbf4c3cae7d02e91\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/initializeClientDatabase.js\":\"c8fbd1f2e668854e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/jsonCanonical.js\":\"b5da702aafb9c8dc\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/kernelInvalidation.js\":\"59cc7db0b203b074\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/kernelProcessors.js\":\"67212ce6c5e09226\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/kernelQueries.js\":\"c8f6ed56861de610\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/mergeTypeMembershipProcessor.js\":\"bce5a4f1375092de\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/normalizeReferencesProcessor.js\":\"ea65732751d27c08\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/poolInstrumentation.js\":\"e401d233ee3dceb4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/processorRunner.js\":\"5535ab89aaccfcc3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyCellBackfill.js\":\"216cb6e7284975c9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyChildMint.js\":\"4bb08488354d702b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyChildrenProcessor.js\":\"f940e2e2648ae7ef\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyDefinitionChangeProcessor.js\":\"bbf80e484832f535\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyDefinitionSynthesis.js\":\"f56d1507be61429a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyKeyScan.js\":\"faf925c1f5cad503\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertySchemaResolution.js\":\"4fdfb03a5536dc89\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyValueEdits.js\":\"cf5c320ffa5963b3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/raiseProtocol.js\":\"a8b0626c984acf7e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/readBatch.js\":\"3b716209ea5ce5c1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/refProjection.js\":\"0f148545aef62d25\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/referenceTargetLookups.js\":\"bfe65b2c9f8fdfba\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/referenceTargetProcessor.js\":\"4b5f070b085caea1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/replayMerge.js\":\"58073531cda08f30\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/sqlBinds.js\":\"ce9a080487b68c99\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4f67bad2b0405cc9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/arrivalProcessors.js\":\"4b2a016e038123d0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/invalidate.js\":\"4605869a3ee45efd\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/materialize.js\":\"e697015d9521c08f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/observer.js\":\"04faa0ccb69bf59c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/reconcile.js\":\"8f2d69c97e027bef\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/timingMetrics.js\":\"56e3f76761a02cd8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/treeQueries.js\":\"ef911a24a610c3a8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/txEngine.js\":\"62588a69986f954c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/txSnapshots.js\":\"f309b83c74ffcfad\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/typedBlockQuery.js\":\"8998d0586df58b16\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/undoManager.js\":\"ff21f73609c0b638\",\"/knowledge-medium/pr-preview/pr-1913/src/data/invalidation.js\":\"ae80e524fc279674\",\"/knowledge-medium/pr-preview/pr-1913/src/data/kernelDataExtension.js\":\"2dbd4051edb05d75\",\"/knowledge-medium/pr-preview/pr-1913/src/data/kernelPage.js\":\"c8fb671a3750bae5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/kernelValuePresetCores.js\":\"5d645ee6ce2e999e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localDbCorruptionSignal.js\":\"d14d1c3a09d7e9b1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localDbStorage.js\":\"39d178bcc6569c91\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localDbVfs.js\":\"342d8181495fd1f1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localSchema.js\":\"9418dd83c1e59e2b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/maintenance.js\":\"2b929ae6f0c60198\",\"/knowledge-medium/pr-preview/pr-1913/src/data/mergeProperties.js\":\"7794c37b4e39dac7\",\"/knowledge-medium/pr-preview/pr-1913/src/data/metricsConsoleHook.js\":\"efa761f4e04edc61\",\"/knowledge-medium/pr-preview/pr-1913/src/data/migrationsPage.js\":\"91bed6a6f8ecdbd4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/mutators.js\":\"4509319bbb7c6a76\",\"/knowledge-medium/pr-preview/pr-1913/src/data/orderKey.js\":\"00c5e8e593714d64\",\"/knowledge-medium/pr-preview/pr-1913/src/data/orderKeyPlacement.js\":\"5362be49a938b680\",\"/knowledge-medium/pr-preview/pr-1913/src/data/outlineSurface.js\":\"8b371ba4ef28bb17\",\"/knowledge-medium/pr-preview/pr-1913/src/data/pendingEditorContent.js\":\"50cdf9c0fa9efa19\",\"/knowledge-medium/pr-preview/pr-1913/src/data/pendingUploadsSql.js\":\"d96a28ba3e1ad5f2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/pluginStateExtensions.js\":\"bfd13e57862957e2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/powerSyncLogger.js\":\"1d43742151ca7bb2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/projectorRuntime.js\":\"00eca54fc669abda\",\"/knowledge-medium/pr-preview/pr-1913/src/data/properties.js\":\"0fd5ed8b5534cb86\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertiesPage.js\":\"48f42a970deba058\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyChildren.js\":\"f5d73a0244feb358\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDefinitionFanout.js\":\"e13b2d414848091b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDefinitionMetadata.js\":\"0e0e00c7a989af9f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDefinitionRegistry.js\":\"55e320ec1f3c38be\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDisplayMode.js\":\"573d3d085a57ee15\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyRowCreation.js\":\"9408073ccffb40a3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertySchemaCreation.js\":\"cc6e3e1b06b8dd95\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertySeeds.js\":\"52092e1a2d6c31d9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/recentsPage.js\":\"dcc4044d5bee7922\",\"/knowledge-medium/pr-preview/pr-1913/src/data/refTargetComparableProperty.js\":\"1d3f10fd68db5a5f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/referenceBlock.js\":\"046db64b8c856db6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/rejectedUploads.js\":\"935d34c1d9c39f5a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/releasePowerSyncConnection.js\":\"788fa13116b17ce1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/repo.js\":\"75a8bdec1e47ccd9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/repoProvider.js\":\"3c0aaf49c33d5a37\",\"/knowledge-medium/pr-preview/pr-1913/src/data/rowProperty.js\":\"f0f6dae67fd3de32\",\"/knowledge-medium/pr-preview/pr-1913/src/data/searchFilter.js\":\"6953930a19ac9bdb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/seedIdentityLedger.js\":\"d241975dbe651785\",\"/knowledge-medium/pr-preview/pr-1913/src/data/stateBlocks.js\":\"eb3bcfc8f3695e4d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/structuralEditPolicy.js\":\"ada5d88bb403a9ff\",\"/knowledge-medium/pr-preview/pr-1913/src/data/structuralInsert.js\":\"4c5f19941c2c2484\",\"/knowledge-medium/pr-preview/pr-1913/src/data/subtreeDelete.js\":\"b4c58d67ea92bf66\",\"/knowledge-medium/pr-preview/pr-1913/src/data/syncStreamLock.js\":\"7c49e75076776a5e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/syncedTableSqlRecognizer.js\":\"0b26d947b53e2867\",\"/knowledge-medium/pr-preview/pr-1913/src/data/syncedTableWriteGuard.js\":\"a366dac9863a66f8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/targets.js\":\"cda2a6094b76eb82\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeColors.js\":\"8d356e2bd3439ac9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeDefinitionMetadata.js\":\"2b25b3e1669b1b26\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeDefinitionRegistry.js\":\"9139515d0c3beb41\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeExtraction.js\":\"da7ad55c210c749b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeInitialValues.js\":\"108f7e3bd5e58d4e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typePropertyGroups.js\":\"f12078c2d545a248\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeSeeds.js\":\"0db68c0b7c910e11\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeTagger.js\":\"cc90f069d8c0b6c9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typedRecords.js\":\"29c98827cfa2abe6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typesPage.js\":\"9c42da820e0c2c56\",\"/knowledge-medium/pr-preview/pr-1913/src/data/userPrefs.js\":\"8793edfb07542060\",\"/knowledge-medium/pr-preview/pr-1913/src/data/userSchemasService.js\":\"66233f3bc2d6048f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/userTypesService.js\":\"8a32c726ca7515ef\",\"/knowledge-medium/pr-preview/pr-1913/src/data/valuePresetRegistry.js\":\"2e815d6010a46cbd\",\"/knowledge-medium/pr-preview/pr-1913/src/data/visibleChildren.js\":\"0eaa0481d49f0081\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceConversion.js\":\"b0e59f346ff53954\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceFirstSync.js\":\"036d5e37ff932e5a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceIdNamespace.js\":\"735028a62673221e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceSchema.js\":\"2a4e4a14eb557dba\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaces.js\":\"ee997146e1ccf056\",\"/knowledge-medium/pr-preview/pr-1913/src/data/writeAheadLog.js\":\"e4d590fb91b73472\",\"/knowledge-medium/pr-preview/pr-1913/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/BlockPasteShellDecorator.js\":\"08473119d3f97bd2\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/atTrigger.js\":\"3813830098c669ae\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/autocomplete.js\":\"59c31319805e91da\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/codeMirrorExtensions.js\":\"f80b0c3c3085e8e0\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/contentFlush.js\":\"9e6c0667748f0d9c\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/defaultInteractions.js\":\"3b44af33d4f76de0\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/editSettleSignal.js\":\"6ae257e15e96fd48\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/insertImage.js\":\"b794503bf04ddcba\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/referenceCompletionRange.js\":\"41eb1122ee71e881\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/referenceTargetTypes.js\":\"a1fea05b3e007cae\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/syntaxContext.js\":\"2d0903483dee582e\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/triggerMatch.js\":\"3f0c2c4eda51c8de\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/AppRuntimeProvider.js\":\"5e3e83e8d46b007f\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/BlockFocusShellDecorator.js\":\"9da3f78020931d86\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/ExtensionRenderBoundary.js\":\"2be601dd9001dc24\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/PanelContentRecovery.js\":\"95135b073f43137d\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/apiCatalog.js\":\"9e125320a3e30605\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/approveExtensionHere.js\":\"19243a031a2efc91\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/armedCutAppMount.js\":\"36f9c5872245f178\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/batchableKeyedStore.js\":\"20c3d596111178e1\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/blockInteraction.js\":\"654cbca49e8580da\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/blockSelectionAction.js\":\"1f711c36d3b18956\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/compileExtensionModule.js\":\"7ed4b624a850cf45\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/compiledModuleCache.js\":\"290eab785d73915a\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/continuousGestures.js\":\"d62b334f62137e89\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/core.js\":\"d1f5a832f7f295bb\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/defaultRenderers.js\":\"aedb4b86b85f622a\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/definitionFanoutAppMount.js\":\"9304d2d11aaff99b\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/dialogAppMount.js\":\"261b2946f5be2f92\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/dynamicExtensionSeeds.js\":\"9c10d456b6080b08\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/dynamicExtensions.js\":\"f47c9009d187071e\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/exampleExtensions.js\":\"936e6ad63e756dbb\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionApprovalStatus.js\":\"eae3ce34c6f373e6\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionLoadErrorToast.js\":\"1d8b76959904a3d2\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionLoadErrors.js\":\"841fbad7195c3df9\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionLookup.js\":\"197525af8b409d7b\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionToggles.js\":\"483b89b80d7e18d1\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionUtilitiesCss.js\":\"2c1fc92942825f2a\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/kernelPageDeletionGuard.js\":\"80ef584d74f94af7\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/liveRuntime.js\":\"8dca9004afb280c8\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/openExtensionsSettings.js\":\"070635cd7bb6fca9\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/overridesCache.js\":\"144ac88c77412360\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/pluginIds.js\":\"59e5a3b0d5b53b5b\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/processorRejectionToast.js\":\"6134a583a955f094\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/runtimeActions.js\":\"6e72b471dd5b49ca\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/runtimeContext.js\":\"0bdbf762fba29e92\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/staticAppExtensions.js\":\"af40ba264dade04b\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/staticDataExtensions.js\":\"ae4781521596ad2d\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/toastAppMount.js\":\"40d11a4a6fd670bd\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/useOverrides.js\":\"b5661e47813bbde1\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/useShortcutSurfaceActivations.js\":\"ceb2c2fade6f80ab\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/discoverToggleTree.js\":\"dabcd4403dbfb9c2\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/facet.js\":\"d36df7b39bd8015c\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/resolveAppRuntime.js\":\"6f8fe91bdd81e71b\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/runtimeEvents.js\":\"0e29078ae6330814\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/togglable.js\":\"811907c77889013f\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/variantFacet.js\":\"ef2f869552f5b24a\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/verbFacet.js\":\"c1659a57f8cb44d7\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/block.js\":\"93cef33188df45bb\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/focusedChild.js\":\"fab8e94a54cf56c3\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/propertySchemas.js\":\"1627aa3b41b10a32\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/typeRegistry.js\":\"9d327035ae14e54a\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useAncestorCrumbs.js\":\"19364500eaea58f7\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useAutocompleteListbox.js\":\"fa6b83248bd47c2c\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useDebouncedSearch.js\":\"b6fe25840c674065\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useDebouncedValue.js\":\"7e839c89329c7485\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useFacetValue.js\":\"2ec380925b23f776\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useIsFocalRender.js\":\"a532fd73efa39fe7\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useIsReadOnly.js\":\"24251d7eb4db1df3\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useMaterializeBacklog.js\":\"b5c8bc122354d4d8\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useMinuteClock.js\":\"0818955ffb39a993\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/usePanelLayoutProjection.js\":\"6719b0dec04f0980\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/usePendingInvitations.js\":\"4e61f8f0a5fda98b\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useRendererRegistry.js\":\"72faa255f5a83475\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useRetainedFieldRows.js\":\"93837be28b3b4e39\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useWorkspaces.js\":\"7061cf06cc48c0f6\",\"/knowledge-medium/pr-preview/pr-1913/src/lib/utils.js\":\"d5af4ae289576eba\",\"/knowledge-medium/pr-preview/pr-1913/src/main.js\":\"845a56bd47d0dc76\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/MarkdownImage.js\":\"9a98f32b0e76f80f\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/blockSeparators.js\":\"bb641c7f5f0bbeb7\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/context.js\":\"4643c2053c776b4e\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/defaultMarkdownExtension.js\":\"954ced06487b1c89\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/extensions.js\":\"dae35a67e676dad0\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/renderMarkdownHtml.js\":\"7d54aaa5e7ecc62b\",\"/knowledge-medium/pr-preview/pr-1913/src/minimal-editor.js\":\"0cd7591ab84d9223\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/armedCut.js\":\"a4c46f511dfb1e6a\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/captureMediaVerb.js\":\"960584a6765bc577\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/clipboard.js\":\"1bf6efc63ec5f5b8\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/decision.js\":\"ba7ac16459a00f98\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/operations.js\":\"d4ec3d3479842977\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/account-header/AccountHeaderItem.js\":\"47ff40cce1ceeb2b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/account-header/index.js\":\"6bf99a7c605a90e8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ca38663464a9ce04\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/askAgent.js\":\"7312687fff917f9c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/askedStore.js\":\"d2b7af423532e049\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6848e4e719f9a49f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/chipState.js\":\"59d016ef3a9ee8db\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/dataExtension.js\":\"139569cf0c8134ce\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/index.js\":\"522be34e0bd5718c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"b94d155558839b2c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/schema.js\":\"7ad3ee2a1db3cfde\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/AgentTokensDialog.js\":\"668e5f0e354b7a13\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/BridgePairingDialog.js\":\"aaab7b43d955b413\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/addMedia.js\":\"7d07c9d9b342efba\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/backlinks.js\":\"2eb8238a6b8bbe2e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/block.js\":\"40dfd3d14de1e910\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/context.js\":\"e5d8872c2b54e6cf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/displayIds.js\":\"88b48775c4f084c3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/index.js\":\"9591c950623e2380\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/outline.js\":\"506b68d3a53320af\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/properties.js\":\"bc981e2e71797e99\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/refs.js\":\"6098ae0f7d17d08b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"c4a78d3388d7a923\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/search.js\":\"e09033e86c278312\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/shared.js\":\"a05f964034ed8096\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a4abcb6bc42fa13f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/text.js\":\"4e7d7ff99e03a778\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentWrites.js\":\"7b57d4007dfb242a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/authoringCatalog.js\":\"0bfd8dd84dc10447\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/blockRefTargets.js\":\"1ba804a255e54455\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/bridge.js\":\"01a1fb056f5e5ea5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/bridgeLoop.js\":\"cf1d10a5f44526ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/changeHistory.js\":\"766e5c416a305b76\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/commands.js\":\"67fd0d8131aaf978\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/commentsCommands.js\":\"8a71e96a06154b7b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/dataExtension.js\":\"4d541738c7ca4a7f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/dataModelGuide.js\":\"d6693bd14a7dd0d7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/dayPropertyInputs.js\":\"7db8039f04f57e41\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/describeRuntime.js\":\"1db9361a45657e00\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/extensionLint.js\":\"f3ccb0873d54d0d0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/grainAudit.js\":\"5f74ab6ec0dcbf2e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/healthCommand.js\":\"172a902dbb4d1558\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/index.js\":\"39c864ee7663349a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/presetIdentity.js\":\"d139e9c575677211\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"f26dd408488f5141\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/readMedia.js\":\"58e1093047372179\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/schema.js\":\"56ec2ac52d0803c1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/serialization.js\":\"a76c7d7e9af4140f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/targets.js\":\"85c648063c8b2639\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/tokens.js\":\"beef00d6b37e7fe3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/watchEvents.js\":\"ce28c0b09935d35a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/workspaceGuard.js\":\"2cf2740bd820e71c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/writeCommands.js\":\"0439f9b8a8e29cc2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/AliasCollisionToast.js\":\"6f00adf61714f294\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/DuplicateNameBanner.js\":\"6a22836c2e28439b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/collisionMerge.js\":\"f950b7a2c45d4102\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/dataExtension.js\":\"9191a783a5471284\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/index.js\":\"87cd10900e82742c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/mergeCollisionAction.js\":\"c2ce63c8ebe585d8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/pageStyling.js\":\"25971e2fb64954b9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/rejectionToast.js\":\"e18d8ed8053e4db2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/syncProcessor.js\":\"5bb93d48d86038f4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/actions.js\":\"b17f3fd06638bc81\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/addComment.js\":\"07e1deeb6e5266ee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/anchor.js\":\"1ce8f052b308113e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/anchorState.js\":\"5b4881e1df5bfc57\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/commentLinks.js\":\"5e6b354778d0ca41\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/confirmThreadDeletion.js\":\"32053e1f212991c7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/container.js\":\"046b5e6b63b66ff3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/dataExtension.js\":\"67f4b33d6e13df3d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/deleteComment.js\":\"1a6a4c7b4ae5d3cf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/highlights.js\":\"866cc6c4c0732fc9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/index.js\":\"df8cc6612cdff7b2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/linkedCommentsPill.js\":\"e904e14a8c73c109\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/margin.js\":\"fe905955762dbd50\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/marginAnchorLinks.js\":\"e203e2c94bbdecb9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/marginSchema.js\":\"1be0bd2ce346dc08\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/newComment.js\":\"a88f38a904db7bf3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/ownThreadPicker.js\":\"68a66c26e9e2bfa9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/placement.js\":\"958c8bf7a570cde7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/queries.js\":\"76edb528addd9176\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/quotePosition.js\":\"2ecebfa55467514b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/quotedIn.js\":\"a55e671a78d375c6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/quotedRange.js\":\"62ecc33b2aff402d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/rangeRefs.js\":\"087697e96ce47762\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/readHighlights.js\":\"ae4b964fd506d8e2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/readSelection.js\":\"96dfef5af8a2ec5e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/readSelectionUi.js\":\"664926fc453fad48\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/reanchor.js\":\"a70c699d2e5d0d80\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/schema.js\":\"debdebea4a373e01\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/scope.js\":\"e8511231b7e333da\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/scopeThreads.js\":\"c9e4910259f0a525\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/splitRetarget.js\":\"f5e59aff71e89cb8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/suggestionCard.js\":\"d997e7c6233a17a6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/suggestions.js\":\"63c66efc921da41d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/summaries.js\":\"d94520dc745dbebc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/summaryBatch.js\":\"b2abe1967d248a9d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/surface.js\":\"e62578601a455aef\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/threadNavigation.js\":\"d09d2f9803b614b6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/threads.js\":\"0e8a9b1613ddc936\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/ui.js\":\"de7317b9f1c964b4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/uiStore.js\":\"07d3f30064ee6e71\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-intents/appIntents.js\":\"3b95e708dd9dbfb5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-intents/index.js\":\"4b3ba6b2b27959d6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-update-prompt/index.js\":\"089c46e9c69d85f1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-update-prompt/status.js\":\"5b091f9e848c83cf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"40ca1cd636b33f38\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/MediaBlockRenderer.js\":\"c395bd19f8b7844d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1088e4b86b94d6a4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/MediaUploadReconciler.js\":\"3e56ddc167827e94\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/assetDownLane.js\":\"ed05aded6826f0a5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/assetResolver.js\":\"502debc8a24d02c1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/assetUpload.js\":\"baa94ba885219300\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/attachmentCleanerIO.js\":\"f21b10dc9df089b3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b2b7704ac82569f5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/blobStore.js\":\"dc511d9f70a42ba0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/browserMedia.js\":\"06c8cdf9e3ce26db\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/byteStore.js\":\"b56a0d7d79f7c6d3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/cleanerIO.js\":\"3af143261f196812\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/cleanupAttachments.js\":\"29d8c9cb4282be49\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/dataExtension.js\":\"ce769079c022c57b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/downLane.js\":\"3a75768adbee7e74\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/index.js\":\"5009bbd2d48e3e43\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/insertImageContribution.js\":\"600c03245acf04bf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/laneArming.js\":\"17daac6384f199b4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/laneLock.js\":\"a786933a6344ecf4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaBlock.js\":\"85f81d6cf98bfeff\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaCapture.js\":\"a67d0f06fd110eae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaLanes.js\":\"f229d5cc1a684889\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaViewers.js\":\"8880adcbed3853d1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaViewersFacet.js\":\"c0fb2e7b48d5f161\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/pasteCapture.js\":\"24bdfc71f819f895\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/resolver.js\":\"b389e737448be523\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/retryUploadsAction.js\":\"d80283fb7546cc7a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/storagePaths.js\":\"f9044bb7b644ee9a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadDrain.js\":\"8969471364024c6a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadLaneStatus.js\":\"57b6709747287e25\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadReconcile.js\":\"b46c3b70445700f9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadRecovery.js\":\"b27d8e000a2b3429\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadStore.js\":\"fbd01d4e53245996\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/useAssetObjectUrl.js\":\"268de86b8fc9895a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f6f2d79b76e503d2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/BacklinksViewSection.js\":\"7e9357ef038b53e6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/facet.js\":\"99f9f4a713140d65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/index.js\":\"a614840710fb2f6a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/prop.js\":\"dc18911a5ce1add1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/BacklinkFilters.js\":\"cf3f28d317ace9b4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"6b405704ee55ea86\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/BlockEntry.js\":\"01dc751386745e19\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/LinkedReferences.js\":\"1dc109bb3c8bdb47\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"f40544a9eaadcac2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/dailyNoteDefaults.js\":\"9535cd63246547df\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/dataExtension.js\":\"095304697d5a4201\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/edgeExclusions.js\":\"4a880671f32d8a6e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/filterProperty.js\":\"d1a2074bea2f5966\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/index.js\":\"7048056d10170d93\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"63bd53b0155724fc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/applies.js\":\"94f1866ce8d45691\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/countQuery.js\":\"1cf63b0db0264275\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/expansionStore.js\":\"10b7ed60a9aaa4f8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/index.js\":\"9d3243ae09282025\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"524c0dace6630e9f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/presentationInvalidation.js\":\"a2565c88281ef163\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/propertyEditorOverride.js\":\"aafad72995fc0de6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/propertyFilter.js\":\"451caeb2cb15de27\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/query.js\":\"6aba3e314cce3806\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/resolveFilter.js\":\"fb9cfdc286e581a2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/sourceBatch.js\":\"cacf4a2d5088ef08\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/sources.js\":\"64dcb6d09723fbc4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/useBacklinks.js\":\"abde1169e663151b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"11754ad53da38a02\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/BirthdayCelebration.js\":\"346092d6a68be10c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/BirthdayOverlay.js\":\"579f14ca27cade01\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/gate.js\":\"5d59bc9c82063a98\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/index.js\":\"36882aa522180164\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/wolfTheme.js\":\"d925412dc7462367\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/BlockDragLayer.js\":\"e199bc6a934efa20\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/dragController.js\":\"d8b906c74efaa513\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/dropTarget.js\":\"311ab9480a6b8859\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/index.js\":\"665323126a113fb9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/projection.js\":\"2da4f357a27b2a0f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-info/BlockMetaCard.js\":\"b1937cd8e876ebb2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-info/index.js\":\"6a1a081ff48632d4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/AddTagDialog.js\":\"a87ba234d54db6a6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"da1bd4703ea31065\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/TagNameIssueHint.js\":\"3e8bcd61ca026079\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/addTagAction.js\":\"2183a194a784cf43\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/appendTag.js\":\"40192ceca7513bb5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/config.js\":\"98a914be0f65f388\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/dataExtension.js\":\"eef5196b5fbecf58\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/index.js\":\"5ddb84ead31a175d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/propertyEditorOverride.js\":\"421096e7f39ea551\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/BreadcrumbList.js\":\"40fdc8b4585ad007\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3c73e532b04a615d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fee4407c8a899467\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7776557933f613bd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c128ef13ad9630aa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/index.js\":\"5a05f747f87d185f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ab02b328864851d0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/CharacterCountItem.js\":\"a143176ce999c660\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/ProfilePropertyEditor.js\":\"98ff94df30a5ba31\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/actions.js\":\"80dda2a24771eec8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/blockType.js\":\"292f0abca70cc0c0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/charCount.js\":\"addc4e0796ed1214\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/dataExtension.js\":\"7997504d1fd66b65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/index.js\":\"037ca8f6ed3c6a11\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/profiles.js\":\"5f5e75ea9b80ba2b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/properties.js\":\"bab7bc6508ecdde3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/subtree.js\":\"95fa9ab758a77447\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/textCounts.js\":\"d22e341c78552b6d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/colemak-keybindings/index.js\":\"5b3e3e35ea387282\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/CommandPalette.js\":\"dbf2d005d3ffbf64\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/HeaderItem.js\":\"97bb6b8857a19365\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/context.js\":\"af03396094b7a597\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/index.js\":\"08c27514dcec3ba4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/selection.js\":\"fbe960757d5ec02c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/toggleStore.js\":\"8137c747ed89a005\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/useCommandPaletteActions.js\":\"39f478763b734e98\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/ContributorBadges.js\":\"cec53dd7aa658d5f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/ProfilePicture.js\":\"4a1ef92d6aa8f3ab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/author.js\":\"6c7517807da19c0f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/codeMirrorExtensions.js\":\"034bf621e385de87\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/dataExtension.js\":\"4d3d495b0524ba1f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/index.js\":\"0ad8174339e043c7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/mentionAutocomplete.js\":\"0132c6c56857f173\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/processor.js\":\"c95d45c149b585c6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/profiles.js\":\"ec2e108491d813dd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/queries.js\":\"d18214939a970322\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/schema.js\":\"2698536d5cf32b13\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/useCommentAuthor.js\":\"030259edeecbcbc1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"bdcaa352d45e6098\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/followOrigin.js\":\"621896c66ee32c1d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/index.js\":\"7d9bce7b6b1c2beb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"f910ded4acbdc274\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"409f922ebb7fa775\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/CalendarGrid.js\":\"9de3063f97be2a65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DailyNotePicker.js\":\"82ef2ac6e97d2894\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"31290b448baef9d6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DateNavDecorator.js\":\"0d3dcf0e924fdc35\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DateScrubOverlay.js\":\"cff32aaddd2e2bc2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DayPropertyControl.js\":\"e72a9b706de08199\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DayValueReferenceControl.js\":\"0ad0fa051ce06165\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/HeaderItem.js\":\"64b6aac8108e69c6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/ReschedulePicker.js\":\"8b57cc5ba43ba0aa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/SpreadDatesDialog.js\":\"a91051c7eb59b678\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/actions.js\":\"53171d50c25192bd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/blockDateAdapter.js\":\"2458e35fa488c79d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/calendar.js\":\"24cf55ad51bd6baa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dailyNotes.js\":\"8f190898f78b9de4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dataExtension.js\":\"1797969a8c61c20f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubActions.js\":\"97a2cb78d3486ac0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubGesture.js\":\"6fbfbb95096e2bc3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6fa728b2d024400c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubRecognizer.js\":\"cebe06f919a50923\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dayProperty.js\":\"01f4cd8b98901082\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"4c58f9446c9ad3dc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/deletionGuard.js\":\"c5b8e70a754528ef\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dueQuery.js\":\"e1c7a8a325681709\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/index.js\":\"0fca9d4c41803078\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/landing.js\":\"373288a77d7f4cbb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/localSchema.js\":\"ad77bc394eaba090\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/referenceDateAdapter.js\":\"ff8c8c339110107e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/rescheduleAction.js\":\"6874d9ef8ae6c31f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/schema.js\":\"840ed6ad46dfde9f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/spreadBlockDates.js\":\"da035dc8d839e19e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/spreadDatesAction.js\":\"5731a4387cc79340\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/today.js\":\"14581219eba230a2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e467baaba22605e0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"48e6a36393414d25\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/audit.js\":\"8a2cf098edaa1443\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/auditAction.js\":\"f23977201b96fe2a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/auditRanges.js\":\"70262111611ad4f7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/diagnosticsSource.js\":\"3c2a1c4a2cc9eb34\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/divergenceScan.js\":\"ccacecc6ea097335\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/index.js\":\"6997c1c8a9a141a9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/propertyChildrenChecks.js\":\"27b5e7258eebf02b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/referencesMirror.js\":\"b374de3148842b17\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/rowJson.js\":\"4379409850ec5d59\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/schedule.js\":\"db39db6ebd8541c4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/store.js\":\"04e2018d69d1728f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-maintenance/action.js\":\"06c772ee05c8379f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-maintenance/index.js\":\"d9be2226bc268671\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-maintenance/plugin.js\":\"674c9daa06e9dbac\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9ed3816603f2059b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/actions.js\":\"15ea5de6852143e0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/changeMarker.js\":\"fb3e535e6de86a69\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/diagnostics.js\":\"0c4e0bcdf51d56db\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/fileSystemAccess.js\":\"72805b39516799f4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/filenames.js\":\"edd049c793f0c082\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/index.js\":\"7b5ae17fe90ebd67\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/mirror.js\":\"046a9ada417b4651\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/runLock.js\":\"811d0e87613ab472\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/runtimeHealth.js\":\"9e342909252e9147\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/schedule.js\":\"89f9ff03d53e928d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/store.js\":\"2d19b1d6b28b0ea6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/default-themes/index.js\":\"2c2da04f8cb55a8f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/default-themes/themes.js\":\"e72c6bbb84c4f61b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/diagnostics/facet.js\":\"8161562e7309027e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/diagnostics/useDiagnostics.js\":\"f3843c03c32a9159\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/dismissals.js\":\"899c38ebf8dd4244\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/index.js\":\"224a1df7ddbbe12a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/status.js\":\"210cf20eca6ec3dd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/store.js\":\"78afed3dc11382ea\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"e7c2e74446202474\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/ExtensionsSettings.js\":\"62b54b65826f159a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/actions.js\":\"df9dc0b7ee7afc4d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/config.js\":\"dc1bee041cbfdbca\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/dataExtension.js\":\"bc97b8edd50af04f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/effect.js\":\"381644576a84f7d1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/index.js\":\"feb0f9687d050c08\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9f62d7ef8c1f21d5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/useToggleTree.js\":\"49619e0b0678661b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/ExtractTypeDialog.js\":\"41265bce7487c1d5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"93a3e9526463b882\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/PropertyShapePicker.js\":\"ac6ffa5145b353c8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/action.js\":\"32e93976d55ea64f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/index.js\":\"bb8491a937acf7ed\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/FindReplaceDialog.js\":\"ba1d8ecc6888ac23\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/HeaderItem.js\":\"7fae2a559bef2483\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/dataExtension.js\":\"5002635ced893717\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/index.js\":\"7ae7271a1891c566\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/search.js\":\"aa4cc3b78be23766\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/toggleStore.js\":\"094775734b12ca3f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/LocationPropertyEditor.js\":\"c67fb8b1f29e0a56\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/MapView.js\":\"ac07e84347031a84\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/blockTypes.js\":\"075d6e4ce18bc088\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/codeMirrorExtensions.js\":\"dfaaaf043716d664\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/createOrFindPlace.js\":\"7aeff80449cca1fe\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/currentLocation.js\":\"163bca06cc537e5b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/dataExtension.js\":\"1d331e162b1f0537\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/geoContentDecorator.js\":\"75bd4dd89b0af3b2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/googlePlacesClient.js\":\"650fecc9354c16ce\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/index.js\":\"38484156249a8a41\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/locationsPage.js\":\"dbf8899a5f11229c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/mapViewport.js\":\"89d932a5a8b2c2ba\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/pickCurrentLocation.js\":\"7a143ae23c0429bd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/placeAutocomplete.js\":\"1a5bd5e3e7f44115\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/placeNameCollision.js\":\"719222429b5b96c5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/properties.js\":\"8926121e13137e9e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/propertyEditorOverrides.js\":\"2d5a80acfebb09c7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/query.js\":\"9c059927b6e8cf32\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/usePlaceSearch.js\":\"1953a258e4d8c01f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d96d77473eeb7e18\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"95751d8e60c4ccab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"02d404aa3c224862\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/config.js\":\"ed8f3bf1f4a975ca\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/dataExtension.js\":\"d9d5029b5a950c68\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/facet.js\":\"dc1dd4c1abdcd500\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/grouping.js\":\"b93340153fa73019\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/index.js\":\"261160b56811d420\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2a8a258f9f60ba65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/query.js\":\"411898a524b33760\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/resolveConfig.js\":\"4a5781539bbed775\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"85a1bc82c163ff53\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"7df207e2a48d0f77\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/HtmlDocumentContent.js\":\"85b8f836c580ddf7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/HtmlFrame.js\":\"53a11e8190d2d9a3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/actions.js\":\"4220ac5a5fc3f43d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/blockType.js\":\"90c3ec28db018641\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/confirmRunScripts.js\":\"987fc5b3d1d534cf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/dataExtension.js\":\"6a9ca91da3c5b618\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/frameAnnotations.js\":\"4b3b46856d0f4630\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/frameDocument.js\":\"74dd016821eba075\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/frameTheme.js\":\"c31e5bfcc4193caa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/index.js\":\"b88a6644bfbf6294\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/scriptConsent.js\":\"2c045170f1def893\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/sourceMap.js\":\"ef93ec996c9f608f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/useDocumentScripts.js\":\"c7fa7a9299154ad1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/index.js\":\"3daf6f93d04751df\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/record.js\":\"f86c97da311f78a0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/recordStore.js\":\"3e2228ca271b4150\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/responsiveness.js\":\"a49b7e5652ab5a1a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/schedule.js\":\"da0df8afeb577a05\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/sessionContext.js\":\"421a5b6f7458df29\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d537c4ee3762fdfb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"260cb75abaac33a2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/actions.js\":\"be00b3a614b0ff39\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/config.js\":\"ac35975577e4bd9b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/dataExtension.js\":\"b60533231a6bb79a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/effect.js\":\"03f4bf869e2edb69\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/index.js\":\"67431088ee178150\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/keyCapture.js\":\"88ff96b74d925f48\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/overrideStore.js\":\"a0b492d87f622d36\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"31c00eae57bc13e4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/HeaderItem.js\":\"29b37ffaaa8d42ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/LeftSidebar.js\":\"2ad6e0aa1e70e9c7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/actions.js\":\"bc406a9a112fdf75\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/facet.js\":\"d108a15314f66977\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/index.js\":\"4d0c141bbabf3b1a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/shortcuts.js\":\"ed5e76b5efaff3a3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/toggleStore.js\":\"a2a1faa15ca5769b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/MergePicker.js\":\"5365a87e4319be50\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/index.js\":\"91e5144f28f47d04\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/mergeAction.js\":\"55edcddb523d7d83\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/strategy.js\":\"e7bb3790388b8b4a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/Button.js\":\"7e94b9693f9a6973\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"79dbf6e2d93f0048\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/defaultItems.js\":\"18e60c15594b304f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/facet.js\":\"8f5eb72b70b1d7f1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/index.js\":\"41747bb6c586afbb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f9f615fbf8e959f2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/actions.js\":\"2c6a434511f0ac36\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"89176602fae3ac39\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/facet.js\":\"10764e141fa1e360\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/index.js\":\"a76431b74fc535a7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f8fb0b05745ea84a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/blockSubtreeMembership.js\":\"08a92d4c0560e448\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/contextMenuItem.js\":\"4f099780310dc71c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/index.js\":\"1a57ef0b34f31489\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/moveAction.js\":\"3504d7424ccb38c2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/moveBlocks.js\":\"fdfde25ca8f0f67f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/selectionAfterMove.js\":\"263fbb0e187067c6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/TutorialBanner.js\":\"dda2372398b2c686\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/action.js\":\"d11261d9311d5818\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/bannerDismissal.js\":\"1e0aa6481fe4e8d6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/documents/cheatSheet.js\":\"f1f279ea817233ca\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/index.js\":\"ad773a1883e0e92c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/keys.js\":\"8bbeda3210054db7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/landing.js\":\"5bbda29e1ca25e09\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/outline.js\":\"53524ccd6da47a45\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/seed.js\":\"62ad6f011beeac27\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/PerfTrendDialog.js\":\"cfc43de76790f251\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/analyze.js\":\"79acc4f8143c0714\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/diagnosticsSource.js\":\"4cd8a0b750105bb6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/index.js\":\"be15af74139746a7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/load.js\":\"6d1ed285dbcecf27\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/monitorRun.js\":\"8dcb8779195f6775\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/schedule.js\":\"a6976bcda3a82c92\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/series.js\":\"f6e5949a2545450f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/store.js\":\"7c3575c043ace5d7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/trendAction.js\":\"5cad7ab31e43ade0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/verdict.js\":\"0d27636af9e7074a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/plain-outliner/clickToEditAction.js\":\"c1dfe191e69c86b6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/plain-outliner/index.js\":\"1c3d2929f5cd1055\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/plain-outliner/interactions.js\":\"ee2d6fdda4c40aa4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c153d242fece5611\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/MigrationGate.js\":\"c7b694c648213668\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/MigrationGateDialog.js\":\"b225e381d5a0410b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/action.js\":\"441207437e225b18\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/index.js\":\"889ce3ea3fcab86c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/localRunMessage.js\":\"c17cb926dfd2c27d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/plugin.js\":\"1d969898ecc3e240\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/progressReport.js\":\"be24c420824b0602\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/sweepProgress.js\":\"917f5ea5872e2912\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/FieldRowRenderer.js\":\"66a9b6a93b87fee1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/ValueRowRenderer.js\":\"eddfd9f99f32ff6e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/actions.js\":\"6db5ff61cfab9c4e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/autocomplete.js\":\"fa9c3956ff7465b8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/fieldRow.js\":\"cc52be34b1cb3c47\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/index.js\":\"7d09cdbddcf9dbac\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/referenceWarning.js\":\"1be70b06fda2ad64\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/valueAutocomplete.js\":\"56757468bbf1a63f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/valueSchema.js\":\"2c73d9d179316805\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/HeaderItem.js\":\"158c841f70bf9a4c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/QuickFind.js\":\"a8a18fae1b7ddfcd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/index.js\":\"ea3e180f48453fb5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/recents.js\":\"110870a0983a174d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/resultItems.js\":\"f05a41f6614bcf29\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/selection.js\":\"a3839b18639c6e0f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/toggleStore.js\":\"f023d01b06a9939f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/HeaderItem.js\":\"ae71668eb8a1e042\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/RecentsPageBlockRenderer.js\":\"741f555faaef6c49\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/grouping.js\":\"e013623de77422d6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/index.js\":\"1c719c50f44f7331\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/target.js\":\"99fd714b6d1c7420\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/codeMirrorExtensions.js\":\"4a3189c49996e1ba\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/contentPrefill.js\":\"d00c5361612cf2de\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/dataExtension.js\":\"3886ceca7af41781\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/index.js\":\"82a917b15d6f3c9d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5f26f4df41fd605e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/invalidation.js\":\"ea2c5a5785885046\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/localSchema.js\":\"68b667df62efdd80\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/blockrefs/index.js\":\"272a0485152c98aa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"29ee4514d0d8dffb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/index.js\":\"4fcb051b048bd2ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/referenceNode.js\":\"d3da1d54b8c9516c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b1a93e1377cfae49\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"a6dbd9306360b0ce\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/index.js\":\"4d89a1ce9766161d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"05e36bf1a241d350\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"04bed939d8d34e9d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/mergeRetargetProcessor.js\":\"7e31f22f51e92d6d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/parseFence.js\":\"6152f7f1ff9888c6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/referenceParser.js\":\"af295a90005400b1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/referenceProjection.js\":\"3909322d7af2c533\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/referencesProcessor.js\":\"c64119f67f09abbf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/renameProcessor.js\":\"4589ed6feecb882b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/spanReplacement.js\":\"5009897e37f917f7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/htmlToOutline.js\":\"c1a635979f9158ec\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/index.js\":\"50cb6d84a09c7159\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6adb69936fb61dc8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/pasteDecision.js\":\"25661abfe4ae26ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/action.js\":\"de0f16aa831e733f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/blockIds.js\":\"4c63aa13bb8a660c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/content.js\":\"833cb64784a4329f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/effect.js\":\"921f87efff26eb12\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/ids.js\":\"c6b511d6a454152d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/import.js\":\"9ff6b1ed72a9b835\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/index.js\":\"4a48c2e3ae48150f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/plan.js\":\"46e1e8fe71b91fb0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/plugin.js\":\"68086af8b5a2018c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/promotion.js\":\"af044d7aabe7976b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/properties.js\":\"5897c74db9597d1d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/references.js\":\"26a094df305cd23a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/report.js\":\"af58d30fcbcbc305\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/roamMemo.js\":\"d26c7d39b0f3d3ed\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/runtime.js\":\"e39675d1541b648f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/schemaReconciliation.js\":\"10a36d1b83d3c388\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/srsMarkers.js\":\"e92c59b17d74f0e2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/todo.js\":\"f9f69af6492337b3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/typeCandidates.js\":\"4bbeef4c3b79de5f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/types.js\":\"72c4f8d81815eca2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/search-health/index.js\":\"0d857077d5fb9810\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/search-health/store.js\":\"261ae5c36425f11a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/HeaderItem.js\":\"fce65fe31284b132\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9bb9595538e6b955\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/index.js\":\"9b34ef13e82b989f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/model.js\":\"749307dbbb01cdcb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/toggleStore.js\":\"948fe4e83f0f545f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/useKeyInspector.js\":\"b014be9e8bbe09bb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"7189620c31cf6762\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/ShellDecorator.js\":\"88ab05f55ca9c77f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/actions.js\":\"c363abbda944920c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/exclusionsFacet.js\":\"29615705849ac173\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/index.js\":\"3af9493ca6f18f14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/shell.js\":\"9e754645a772b3f8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/surface.js\":\"a231bf2f963b3c10\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/walker.js\":\"645ec0aa4692a372\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/RescheduleToast.js\":\"256735523f1a9d2d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/dataExtension.js\":\"d15e9fee82be832a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/index.js\":\"3c153590b1b8f14e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/indicator.js\":\"f5f79c084c0d2147\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/moveSrsState.js\":\"b3444e2cf1ffa10d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"46c0045503f3d15f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/scheduler.js\":\"22a912f3c2904cdd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/schema.js\":\"00e834904e50d8ee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3270f916a583487e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/srsClipboard.js\":\"cc26d3f4f4414b3d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"c0903660a49a51b3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/DailyNoteReviewHint.js\":\"c1ed3187a5317326\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/DeckPicker.js\":\"1c53b5b55c9acb38\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/ReviewControls.js\":\"d5af35217d7d7456\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6981773e89d47541\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/ReviewSession.js\":\"cccf053299d095ec\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/actions.js\":\"343c54b6082464ec\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/archive.js\":\"0220fbca533895a7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/dataExtension.js\":\"f3a89f174e5db7e9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/deck.js\":\"8a0806b91d94b1af\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/dueQuery.js\":\"f454aa892aaa629c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/gradeDecision.js\":\"f4589bfad7caa44e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/index.js\":\"9a2d77e964c76f58\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/keyHints.js\":\"0af4f4586632b594\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/reviewCardLayout.js\":\"bb636795f6705bac\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/reviewProgress.js\":\"ae9bc140d6bcd464\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/schema.js\":\"797f17c13bb9d1d8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/useDueCards.js\":\"237127e4c7467511\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/startup-metrics/index.js\":\"f08a7a25f8fbc867\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/startup-metrics/record.js\":\"d573c72fa803bb52\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/storage-persistence/index.js\":\"87da256e9c431caa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/storage-persistence/persistenceStatus.js\":\"d20636de3c8053f6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/storage-persistence/requestAction.js\":\"d216d868a9d58583\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/TypeChipsDecorator.js\":\"6c5659b9fe2fb4ce\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/codeMirrorExtensions.js\":\"6b11f5970e8768d7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/index.js\":\"a3293f6731b8c1b8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/typeAutocomplete.js\":\"a9e843c752806c71\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"65e7f2bb6ab73272\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/actions.js\":\"d2f7cb796eab91b3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/anchor.js\":\"ca46f62dd8c73f3c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/events.js\":\"db2f4eed43ccf5b2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/gestureActions.js\":\"964d66b37e82ff6f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/index.js\":\"a7b79a34b2953961\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e90f1244b15958e3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/sync-metrics/collect.js\":\"647638d0850aed10\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/sync-metrics/index.js\":\"55ed3823318b9a94\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/sync-metrics/record.js\":\"37f9d034bcde31de\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/RejectionDialog.js\":\"22609cebfd348543\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/SystemStatusHeaderItem.js\":\"087dc9b95f98a361\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/index.js\":\"cae39ea2ce7b79c8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/model.js\":\"dd182f0163351d67\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/queueCounts.js\":\"6746cad7d42f5f08\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/rejectedHelpers.js\":\"bdb58de4140b4e3d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/rematerializeAction.js\":\"d327ee30d776aaaf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/useHysteresis.js\":\"a5e6899205707991\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/ColumnHeaders.js\":\"fb88a6f1bb975619\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/QueryUi.js\":\"e6d213cf31395bc8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/TableLayout.js\":\"d8ad4df22a48d692\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/actions.js\":\"6a22a5f630403068\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/cellEdits.js\":\"ec6c837b7914c3c9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/childrenViews.js\":\"baa47570de66877a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/columns.js\":\"48d44ee5bed20c16\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/controller.js\":\"fd9922ddabdac0a4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/convert.js\":\"9542eed7c35127e4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/dataExtension.js\":\"e6ad2ec1ea4c0018\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/index.js\":\"43f511f608628495\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/keys.js\":\"4480460f80a2c887\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/model.js\":\"67c09473e9fa46e9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/QueryText.js\":\"2fcae951057ff83f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/backfill.js\":\"59aec60946c87118\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/completion.js\":\"fb10923bd8f2002a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/format.js\":\"a537bdc34686522e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/parse.js\":\"18bbf1bf48a34b11\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/queryValue.js\":\"d5df5cd5cfd3f77f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/registrations.js\":\"ff8fd0d598b85969\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/source.js\":\"5d1469ef073cc923\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/registry.js\":\"ec63e32a291d26a8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/rowGutter.js\":\"6d51306f9f2dc324\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/rowVerbs.js\":\"951cee8327f90eb3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/schema.js\":\"6a802cbe19ade0af\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/sort.js\":\"1eec7f99198bf45b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/theme-toggle/effect.js\":\"23cdeef8eed2aa6f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/theme-toggle/index.js\":\"2d68654a45011009\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/theme-toggle/theme.js\":\"57804606d42dec57\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/actions.js\":\"8db52ae0072e7403\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/dataExtension.js\":\"ead161ad6e192643\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/index.js\":\"1f54ec6811b54aae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/schema.js\":\"d6a315850ec96969\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/TouchSelectionLayer.js\":\"0d8665ea0027d525\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/actions.js\":\"8d660fab89f34027\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/defaultItems.js\":\"e68276802acc697d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/facet.js\":\"2b7cc36d2abe22f6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/holdRecognizer.js\":\"1ebfaf4d20781133\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/index.js\":\"d16d0fe20a4d95ce\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/update-indicator/UpdateIndicator.js\":\"698f817fea55bd5e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/update-indicator/index.js\":\"c52f635be0105546\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/update-indicator/loadTimes.js\":\"07b5074772a07e88\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/VideoNotesRenderer.js\":\"cfb688540e04526b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/VideoPlayerRenderer.js\":\"918dc9cefaf4f40b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/VideoTimeStamp.js\":\"7179d76898c434b4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/actions.js\":\"a81e93dc9ca4a15d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/index.js\":\"dca3f1acd8efe0e8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/markdown.js\":\"87fac9b894c1ac16\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/notes.js\":\"52c233ae42fb39a7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/registry.js\":\"4050af78376656c3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/remark-timestamps.js\":\"b430769909ed553f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/view.js\":\"bb3dc22ec851c2eb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/LinkHints.js\":\"e9ec66889a6bcda0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/index.js\":\"cf25080d0092f64f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/model.js\":\"478e77a8c3c702cf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/settings.js\":\"55156a70656e3d09\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-normal-mode/actions.js\":\"4c2598fea7713bca\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-normal-mode/index.js\":\"f41f2da8b59e7bdd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-normal-mode/interactions.js\":\"cb31d0c6f00b868f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/workspace-header/index.js\":\"68eda08c731da718\",\"/knowledge-medium/pr-preview/pr-1913/src/registerServiceWorker.js\":\"f137a282e0967ec4\",\"/knowledge-medium/pr-preview/pr-1913/src/requestPersistentStorage.js\":\"82f72c8f485ac81f\",\"/knowledge-medium/pr-preview/pr-1913/src/services/authRequestDeadline.js\":\"20ac3b429ddba56f\",\"/knowledge-medium/pr-preview/pr-1913/src/services/authStorage.js\":\"b94fa0ff74ae0618\",\"/knowledge-medium/pr-preview/pr-1913/src/services/powersync.js\":\"5910d9c72666638a\",\"/knowledge-medium/pr-preview/pr-1913/src/services/supabase.js\":\"424f7e8049756ba3\",\"/knowledge-medium/pr-preview/pr-1913/src/services/uploadErrorClassifier.js\":\"d792770cfdae733f\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/ActiveContexts.js\":\"e0182138891fbbbb\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/HotkeyReconciler.js\":\"a7d29df5b5937d53\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/WipeLocalDataDialog.js\":\"466b143c37127a21\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/actionDispatch.js\":\"cb8829fe1a25f5b7\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/actionRefItems.js\":\"8f19d246c4e56564\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/applyKeybindingOverrides.js\":\"fb93b92a2566546c\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/blockActions.js\":\"0dbfa73697c9b5e3\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/blockMergeGesture.js\":\"89f652769ae52a3e\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/canonicalizeChord.js\":\"a20aa80acb55eb81\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/defaultContexts.js\":\"ffa8b33efb1e2294\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/defaultShortcuts.js\":\"caeb1b1367160235\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/effectiveActions.js\":\"9a7d187f8e087d47\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/gestureAction.js\":\"9247c50b1a2a6ee7\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/gestureBinding.js\":\"10be8a1dc840de6f\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/holdRegistry.js\":\"8bba243cc8905041\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/keybindingConflicts.js\":\"d4bc73bfaae2833f\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/keybindingOverrides.js\":\"2694d56894cd7270\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/pointerAction.js\":\"9bfd01ed1515f3fd\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/resolve.js\":\"060b1d0996f4ffb9\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/runAction.js\":\"88377861962adac6\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/sequenceMatcher.js\":\"35bf40a5b73356c8\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/types.js\":\"2d309a3ec41fcb55\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/useActionContext.js\":\"b540abbf6c2ae60b\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/useActionDiscovery.js\":\"658484d3cab8ee91\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/utils.js\":\"d784cb4ba488e5b6\",\"/knowledge-medium/pr-preview/pr-1913/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1913/src/sw/bootStore.js\":\"b17a2666842a71f7\",\"/knowledge-medium/pr-preview/pr-1913/src/sw/previewDatabases.js\":\"b0384aec17a62482\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/byteTransform.js\":\"50fe19e1e70c3ebb\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/attachmentCleaner.js\":\"26045eab095d958c\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/attachmentParts.js\":\"87d2920a1436899c\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/bundleParts.js\":\"158ead5bc4e44893\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/bundleRecord.js\":\"a0efec9a1187f61e\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/manifest.js\":\"7d64cc5d34c167a6\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/takeBundle.js\":\"5063474fe97a8df8\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/verifyBundle.js\":\"56c1286bdd7d3abf\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/cleaningStage.js\":\"59f6509fe1a4ec1b\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/conversionKey.js\":\"fbca05d08fcd686f\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/conversionServer.js\":\"48cf20e6c96a9c8b\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/flip.js\":\"b83dcf18529f2d9a\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/flipAttempts.js\":\"e0690d8cd5585448\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/pages.js\":\"e484ed9eb10e1ae3\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/preflight.js\":\"d6ee495957a708d4\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/reseal.js\":\"77c1993fc3f126e2\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/runConversion.js\":\"2fda3049e17a3269\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/runLock.js\":\"8191892321e32f29\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/sealing.js\":\"f7cdc097d2830b0b\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/sealingStage.js\":\"abe0cb5c36fbc44d\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/stage.js\":\"62b1a42f67ec90ad\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/verifyReseal.js\":\"7b50371bbdd57466\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/aad.js\":\"33de125a54b8eb29\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/aead.js\":\"56206047fdeb1e74\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/base32.js\":\"5802c08fddf03e45\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/base64url.js\":\"aff101918da9ace4\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/binaryEnvelope.js\":\"2b58316690a01c65\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/byteAead.js\":\"f76e640be6a743e2\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/canary.js\":\"48036dc5eda1024c\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/contentHash.js\":\"00a691ad7a40933e\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/contentKey.js\":\"398cf70d0aa24c8b\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/derivedIdNamespace.js\":\"d039a0433ab11b57\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/envelope.js\":\"6f4596266a25cf57\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/hex.js\":\"1073b545631f9120\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/sha256Hex.js\":\"67c19e9a8dc59cd2\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/workspaceKey.js\":\"b89fd8f86b6277e2\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/conversionState.js\":\"4b64c24ccac950e3\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/createEncryptedWorkspace.js\":\"67707861a86e723b\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/pastedKey.js\":\"5799eaf84cf4de7a\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"96b88188a7561ab2\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/upgradeWorkspacePin.js\":\"a8db6ed614185b10\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/keyStore.js\":\"cad8fe2f059dcd60\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/mintWorkspaceKey.js\":\"755ddb3bcac70a70\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/modePin.js\":\"4dc0b1224cc4b544\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/openWorkspaceKeys.js\":\"70e751068786af24\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/resolveWorkspaceEntry.js\":\"73a8385203cf99ff\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/resolver.js\":\"55e71dc19ab04273\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/workspaceAccess.js\":\"c9464ed4f08e845d\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/transform.js\":\"892c4bf8e52d0276\",\"/knowledge-medium/pr-preview/pr-1913/src/themeBootDefaults.js\":\"087a1127b7a5d84b\",\"/knowledge-medium/pr-preview/pr-1913/src/types.js\":\"63c975b29679e660\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/ClientLocalSettings.js\":\"c86f3a04550f3a9d\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/abortableSleep.js\":\"407c8ce83fd0ae88\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/array.js\":\"c72b3d7d88c31176\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/backlinkAutocomplete.js\":\"0a5ed76310659cbc\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/blockCrumbs.js\":\"e2b24ae666813c17\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/blockrefAutocomplete.js\":\"b79009223268ae52\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/cadencedIdleJob.js\":\"7c9fc21583f15b7f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/callbackSet.js\":\"3f8540938feced0d\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/clientId.js\":\"c743c0aae4403871\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/codemirror.js\":\"e8875f57fb4b65c3\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/codemirrorCompletion.js\":\"6dda627fa04a6ad8\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/copy.js\":\"8deac8431e2d1db1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dailyPage.js\":\"010c2a0e056c7392\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dbForensics.js\":\"17141bf1ba280add\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dbForensicsHooks.js\":\"1bd02a1e0464a845\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/deleteBlockThroughUi.js\":\"238b3b81d916a20e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dialogs.js\":\"1d6bab85fccb8ac3\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dom.js\":\"665553bd691ac1d4\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/downloadBlob.js\":\"50f95f117ea6bd09\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/drawnWalk.js\":\"76e2086e4fdb200f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/exportSqliteDb.js\":\"20003b36dbc61479\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/fileSystemAccess.js\":\"05c5407a6a70a669\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/flipSlide.js\":\"90fb72eaf39f1063\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/fnv1a.js\":\"d28ffb3c05b1e4bc\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/formatBytes.js\":\"833837ed6ea3a8c7\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/fuzzyRank.js\":\"400a7a13fe9e997f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/idbKeyedStore.js\":\"6e7feab9610c850a\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/idleCallbackPolyfill.js\":\"a4cb98f32a78a977\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/keyboardAwareScroll.js\":\"f2a654f5e07fc438\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/keyboardViewport.js\":\"894ee8e491ff233c\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/lastWorkspace.js\":\"972d7258160cfc4f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/layoutColumns.js\":\"6733e91788250bf0\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/layoutSessionDom.js\":\"6ef28f5be61dc48d\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/layoutSessionId.js\":\"ee3dc988b3fc5dfc\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/linkClickGestures.js\":\"c0ff2f1402d8664d\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/linkTargetAutocomplete.js\":\"3c4f2ce98e64ee25\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/localDbCorruption.js\":\"14f9eb4c1151e3a2\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/localDbRecovery.js\":\"ca0229801e0463b0\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/markdownParser.js\":\"4adae940f8edcafe\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/memoize.js\":\"bb8525dc6488a968\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/nameFieldCommit.js\":\"419bc2cc10761eb2\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/nameList.js\":\"2e3d8da77d013701\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/navigation.js\":\"5c1e2f6389ebaee1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/omnilinerNamespace.js\":\"3d35ebb114dd049b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/opfsPageScan.js\":\"edfd24cffbb43c41\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelClearance.js\":\"e9efbd5ba38dc615\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelHistory.js\":\"2e26cad27a9aabf9\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelLanes.js\":\"fb83a6d5c0a2565c\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelLayoutProjection.js\":\"9da858f0947c6a3b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelScrollAnchor.js\":\"b23f1f044e353f6a\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelUrlFlags.js\":\"7ecc546196ef6881\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/platform.js\":\"d3a739b4b94cf21b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/pluralize.js\":\"0199fe65863c4d83\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/propertyCreation.js\":\"87dcc2234e1808a6\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/propertyNavigation.js\":\"d37923d45d76acc1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/propertyValueContext.js\":\"83a3ff7392fa893f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/react.js\":\"387584395f02afd5\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/relativeDate.js\":\"b31d327a6cb50c1d\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/relativeTime.js\":\"f8ec97ec320d9f0b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/renderScope.js\":\"bacc527d450d0ae5\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/resolvedThenable.js\":\"b0e3bf6b00451fdc\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/routing.js\":\"f62412edabdb1fd1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/safeMode.js\":\"0357c1e278a7d4e3\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/scheduleIdle.js\":\"36fde2476eaf7956\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/screenWakeLock.js\":\"38449901322b5eaf\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/selection.js\":\"78b6e3e1601bdba5\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/softKeyboardGrab.js\":\"8b877b175af40b25\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/startupTimeline.js\":\"139e565bca4db7e1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/state.js\":\"4865539f5001d2fc\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/string.js\":\"2f44e1a64493057b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/surfaceZoom.js\":\"ff7389727bad3d72\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/time.js\":\"3652bddd518bf9ef\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/toast.js\":\"b351269cedcf7179\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/toggleStore.js\":\"f14b95f981dc12bc\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/untilStopped.js\":\"44a9e8fca458497f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/userActivity.js\":\"272fab6a3459a48d\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/viewTransition.js\":\"4948f92ac773bfda\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/viewport.js\":\"724fbe2841ecb7c0\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/webLock.js\":\"938b80d0b554dd10\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/workspaceRecovery.js\":\"f91d10eb67a3a765\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/workspaceSnapshotStore.js\":\"fb7875f9abad8070\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-compiler-runtime.js\":\"33537f005b86bba2\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-client.js\":\"11d33c3c68497d74\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-server-edge.js\":\"60021266c987a91e\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-server.js\":\"e9c426199ed8e46e\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-static-edge.js\":\"be0426ef02108a69\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-static.js\":\"5f27b5eb1a649720\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-test-utils.js\":\"a17de3de565aa5de\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom.js\":\"e3d5b340ad289e5a\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-jsx-runtime.js\":\"c068b54348a2f96b\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react.js\":\"0e20a2bbc9816e5f\",\"/knowledge-medium/pr-preview/pr-1913/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1913/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1913/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
