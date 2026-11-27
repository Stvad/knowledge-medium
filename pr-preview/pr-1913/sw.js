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
		buildId: "4d969a39e14a-986b01c2",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1913/\":\"a17d08391dec87c8\",\"/knowledge-medium/pr-preview/pr-1913/index.html\":\"a17d08391dec87c8\",\"/knowledge-medium/pr-preview/pr-1913/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1913/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1913/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1913/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1913/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1913/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1913/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1913/assets/FacadeVFS-Dq-uz9fK.js\":\"7df341564208245a\",\"/knowledge-medium/pr-preview/pr-1913/assets/OPFSCoopSyncVFS-zbQ6AX15.js\":\"d63ee71fa83be524\",\"/knowledge-medium/pr-preview/pr-1913/assets/OPFSWriteAheadVFS-DOEQMkYK.js\":\"0c835c0111fce6f2\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-CM2i-o0v.js\":\"d89495481ad60b3a\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-async-G5Y8KuP5.js\":\"ad1c9e692c325ca1\",\"/knowledge-medium/pr-preview/pr-1913/assets/worker-DTLUgHff.js\":\"d4a632d77255de17\",\"/knowledge-medium/pr-preview/pr-1913/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1913/chunks/app-T-CMrhtE.js\":\"be290be7f31ff541\",\"/knowledge-medium/pr-preview/pr-1913/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1913/index.js\":\"5ecbd591a3df4a40\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1913/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1913/assets/AccessHandlePoolVFS-CmHraNVh.js\":\"5d4b597bda3290ba\",\"/knowledge-medium/pr-preview/pr-1913/assets/IDBBatchAtomicVFS-DMLyxE9a.js\":\"f39dc455f8b009ce\",\"/knowledge-medium/pr-preview/pr-1913/assets/MemoryVFS-Bdytf1mF.js\":\"5f90ada5a1550366\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-DeUM8KdP.js\":\"15b3ae6565954c4e\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-async-DdyNPuJg.js\":\"865b1df783a12fea\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1913/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1913/chunks/AccessHandlePoolVFS-Dz4fM9WF.js\":\"ee52954d77c2c94f\",\"/knowledge-medium/pr-preview/pr-1913/chunks/FacadeVFS-BQuwt__h.js\":\"7a4d0c6f631a5a09\",\"/knowledge-medium/pr-preview/pr-1913/chunks/IDBBatchAtomicVFS-ylUlNok9.js\":\"97b48f14229d30be\",\"/knowledge-medium/pr-preview/pr-1913/chunks/MemoryVFS-BuB4DKzj.js\":\"30cce14ee38f005b\",\"/knowledge-medium/pr-preview/pr-1913/chunks/OPFSCoopSyncVFS-BKLzewgK.js\":\"5d1b0eeee8f19942\",\"/knowledge-medium/pr-preview/pr-1913/chunks/OPFSWriteAheadVFS-BOg8T2vA.js\":\"03466b09e6aa7b3f\",\"/knowledge-medium/pr-preview/pr-1913/chunks/Preview-COnheDY1.js\":\"ea6cb28a9ef9e57b\",\"/knowledge-medium/pr-preview/pr-1913/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1913/chunks/card-BIzVLjjv.js\":\"b682102328bfae58\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dist-Yk0toV9G.js\":\"38a10b4c56179b96\",\"/knowledge-medium/pr-preview/pr-1913/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1913/chunks/mc-wa-sqlite-DhWyFnQv.js\":\"2963240dbeca53fb\",\"/knowledge-medium/pr-preview/pr-1913/chunks/mc-wa-sqlite-async-CEP3j4g2.js\":\"e73fb7260a789361\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-6SYikGvR.js\":\"11584ce0d7495312\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-B-PyRe8C.js\":\"530116ffdda3e523\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-Bdp9j0J1.js\":\"67b726f79d670499\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-CM7f9QHa.js\":\"223c7e3c227872ab\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-Cmx1-9V0.js\":\"4132413293ba1e2d\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-DcZOH35i.js\":\"9fdf8aa6ed54b315\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-GWhCDR2T.js\":\"7c6925b63f4a1680\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-YBTfSLN5.js\":\"1163d6b2c005d2fa\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-dom-server-legacy.browser.production-CZkRFOB6.js\":\"fdcaaaebbce35180\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-dom-server.browser.production-BhlQq-7t.js\":\"392ce9c4ca5a3531\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-dom-server.edge.production-D6yRxzk8.js\":\"7735bc2d9a77ac37\",\"/knowledge-medium/pr-preview/pr-1913/chunks/server.browser-DFNXVdiE.js\":\"66e19a68e45f86c4\",\"/knowledge-medium/pr-preview/pr-1913/chunks/textarea-ajH5XqYm.js\":\"0314a21d111dc9a2\",\"/knowledge-medium/pr-preview/pr-1913/chunks/ui-Bc16DUPz.js\":\"e9f7054d4c986149\",\"/knowledge-medium/pr-preview/pr-1913/chunks/wa-sqlite-DYfUVSVd.js\":\"a06802cde770a808\",\"/knowledge-medium/pr-preview/pr-1913/chunks/wa-sqlite-async-DJtfdoBK.js\":\"b51c8886f3bfb9ef\",\"/knowledge-medium/pr-preview/pr-1913/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1913/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1913/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1913/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1913/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1913/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1913/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1913/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1913/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1913/src/App.js\":\"7265059c7b571abe\",\"/knowledge-medium/pr-preview/pr-1913/src/appUpdate.js\":\"e40120497192dee4\",\"/knowledge-medium/pr-preview/pr-1913/src/appVersion.js\":\"e7069fc70072ef81\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/initialLayout.js\":\"b334cca253817cc7\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/openWorkspaceData.js\":\"c832e2e011fa2088\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/resolveWorkspace.js\":\"b1d2c3a1c5facf55\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/workspaceBootstrap.js\":\"a13daeffc39183a1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockComponent.js\":\"9daca03cba1638c3\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockCrumbs.js\":\"77afc27dd7212994\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockEditor.js\":\"131aeac19fd7557c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockLoadingPlaceholder.js\":\"2374363e9ea1b197\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockProperties.js\":\"21573e86cf89df1e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockSearchPicker.js\":\"0641d7b7cb3196a7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ConfirmBulkDeleteDialog.js\":\"d591d6a2f734688f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/DividerHandle.js\":\"b335e3d916bfcc22\",\"/knowledge-medium/pr-preview/pr-1913/src/components/DraftEditor.js\":\"caa2f3af640abf2e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/GutterPill.js\":\"3aa11430efd6b165\",\"/knowledge-medium/pr-preview/pr-1913/src/components/Header.js\":\"9aec5d31b0254186\",\"/knowledge-medium/pr-preview/pr-1913/src/components/LazyBlockComponent.js\":\"0d36655f0f1ee589\",\"/knowledge-medium/pr-preview/pr-1913/src/components/Login.js\":\"4f02fd2cacb9d2f4\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ZoomableSurface.js\":\"9c6e405bd29f3754\",\"/knowledge-medium/pr-preview/pr-1913/src/components/editModeKeepalive.js\":\"f030007c9d481d22\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyDisplay/PropertyDisplayScope.js\":\"213c838873ae844a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0f5c6279399cf252\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/RefPropertyEditor.js\":\"d77813215d59fa4e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/RefTargetTypePicker.js\":\"c50a616bdd66013a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/SelectPropertyEditor.js\":\"94627d6cfeef173e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/TypesPropertyEditor.js\":\"a8c1768b88ce15a2\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/defaults.js\":\"3f65b7ee93aa1507\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/kernelValuePresets.js\":\"f50ea60443e388b2\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/selectablePresets.js\":\"60bfcc3b9b57cd46\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/typesPropertyUi.js\":\"c8b2e4fb770464b7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/AddPropertyForm.js\":\"19c92f46ec0bee47\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/PropertyPicker.js\":\"acad7e16a1a99613\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/PropertyRow.js\":\"a29d15b5c4b883d5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/Rows.js\":\"bff504e8a2b7cea5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/actions.js\":\"ed51839bb7386a28\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/declarationOnly.js\":\"298841c0044cb4f0\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/layout.js\":\"2704a618aa183857\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/model.js\":\"5ff028b2e201ade2\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/shapeUi.js\":\"4d7c7ff8cfa0fa63\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/shapes.js\":\"469e17bc6f2f777d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/usePropertyEditingActivation.js\":\"6d240f3653a742d5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/visibility.js\":\"b67d6eeb388bd2f8\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanelSections.js\":\"05f3cf9855a9fe87\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/BlockEmbed.js\":\"3df6c747c06d6e60\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/BlockLink.js\":\"aeb1e915442c9d74\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/BlockRef.js\":\"94ffb0a4754dc95d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/CompactReferenceLink.js\":\"2156834daa59d8e6\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/ReferenceLink.js\":\"1f027b2057848d06\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/cycleGuard.js\":\"57644d839709c8fb\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/cycleGuardContext.js\":\"c1bc7e499fdbb68d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/linkInteraction.js\":\"085838d93470740c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/referenceLayout.js\":\"7996671acc943425\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/useBlockRefAncestors.js\":\"d69ed4062f3dd02c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockGutter.js\":\"d85ac2e54dc3e7f5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockInfoDialog.js\":\"301280d0e7757d4e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockReadText.js\":\"58256998d4baacaa\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockTypeBlockRenderer.js\":\"0bc8aa1b548c116f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BulletHoverCard.js\":\"f6d5fe6034871175\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/CodeMirrorContentRenderer.js\":\"0003e7435a400ec8\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"baf273ea6a5b1a73\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/ColumnResizeHandles.js\":\"fee4baca4e0b1484\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a72b873236164906\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/DefaultBlockRenderer.js\":\"a4e3e50a2904c2ff\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/LayoutRenderer.js\":\"96a860401776473e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/MarkdownContentRenderer.js\":\"d1c7dc990a1cca06\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/MissingDataRenderer.js\":\"c56e8963f34231f6\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/PanelRenderer.js\":\"d28eaf31869b76b5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c122a37f5091263f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/TopLevelRenderer.js\":\"d5dd1c931867b28d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/blockGutterMode.js\":\"c73ab907014df4a8\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/blockTitleText.js\":\"10b6aa6e94c6ac91\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/fieldCreationKeydown.js\":\"065553901c6d781f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/layoutRootContext.js\":\"e2b1870dd547c77a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/typeChip/TypeChip.js\":\"496d6821e56a607c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/typeChip/chipStyle.js\":\"5c1cd79865c197f1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/anchored-floating.js\":\"973fc2248c2253ed\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/button.js\":\"b7eac424031e6bd5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/card.js\":\"c607c23561d5c48f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/checkbox.js\":\"bc81b193923fb2de\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/collapsible.js\":\"35ffe18f2306bc37\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/command.js\":\"2e19566240916d15\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/context-menu.js\":\"6eceacd25c621abc\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/dialog.js\":\"c4e609aba54ae713\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/dropdown-menu.js\":\"daba4d73a1d73c9a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/floating-listbox.js\":\"955fd89dbfdf37a2\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/index.js\":\"40d46bd6f28b67f8\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/input.js\":\"9dc1f1faa0acf9fb\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/kbd.js\":\"790224f5f7dd3cb9\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/label.js\":\"0e6f11471c8d6322\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/textarea.js\":\"cff5177d1205131f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/useEditModeYieldKeepalive.js\":\"802a032a77dfc9ac\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/BootFallback.js\":\"853e5dacc3a30f48\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/FocusedRowLazyMount.js\":\"cff94500b7b2b9b6\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/LazyViewportMount.js\":\"e81e0d7a92e6f72c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/LocalDbCorruptionFallback.js\":\"8437e30016c1efb9\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/error.js\":\"03b8f15a0b78c2e3\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/lazyMountRegistry.js\":\"e36c65aff0065ae0\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/suspense.js\":\"7eedc8b549869d10\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/CreateWorkspaceDialog.js\":\"15a0e3d9c1d80202\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/PendingInvitations.js\":\"a64cb509dde64e56\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/SyncProgress.js\":\"27a997db4c097d4f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/UnlockProgress.js\":\"7e0b45f570a32f45\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceKeyGate.js\":\"6e37518de214bd65\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceSettingsDialog.js\":\"fb3d4822d90da1b7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceSwitcher.js\":\"148f751a711aba7a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceSyncGate.js\":\"341cf9944c5b318a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/ConversionFlow.js\":\"ef0e6704f2603079\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/ConversionFlowHost.js\":\"9b7cac2a7948b8d2\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/EncryptionSection.js\":\"0e031ab083051e4a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/attachmentPrompts.js\":\"c788aea33f954529\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/bundleFolderPrompts.js\":\"58be2c45fdec4ec1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/conversionFlowDeps.js\":\"4d47b08c4309b8c7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/conversionFlowStore.js\":\"fc3abffc14d19540\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/flowUi.js\":\"680d31ddca072032\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/useConversionRun.js\":\"038858fca9c480f1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/keyUi.js\":\"754e86350e47bc7c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/useCloseOnKeyLoss.js\":\"3bb966fb7bb9de45\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/useCloseOnServerE2ee.js\":\"86184760f57ee9db\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/workspaceUnlocked.js\":\"5006e170355351b1\",\"/knowledge-medium/pr-preview/pr-1913/src/context/backgroundSubtree.js\":\"0736e48f7eb91b02\",\"/knowledge-medium/pr-preview/pr-1913/src/context/block.js\":\"ea33b9b514fc7065\",\"/knowledge-medium/pr-preview/pr-1913/src/context/layoutWsContext.js\":\"7719400adc6bc845\",\"/knowledge-medium/pr-preview/pr-1913/src/context/propertyDisplay.js\":\"0eb6eb744cc3eece\",\"/knowledge-medium/pr-preview/pr-1913/src/context/repo.js\":\"aeea7ee31de72f63\",\"/knowledge-medium/pr-preview/pr-1913/src/data/aliasClaim.js\":\"7090da193b547ea9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/aliasSeatNamespace.js\":\"535102770cde68db\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/blockData.js\":\"346b919ac944ae05\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/blockType.js\":\"cf144ba022e26056\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/changeScope.js\":\"fc114d9cb31b9cc1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/codecs.js\":\"4f05fde9cec632be\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/derivedData.js\":\"f79bccc71cac946f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/errors.js\":\"2aca9422e85bac11\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/events.js\":\"0d49b85faf32e2a4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/handle.js\":\"f1f29b4ac585ff77\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/index.js\":\"d436f57838dd433f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/mutator.js\":\"4e97b12c8536bc46\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/processor.js\":\"d459b239823bdaa8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/propertySchema.js\":\"5db9efed8f905964\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/query.js\":\"35114bb468c70105\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/sameTxProcessor.js\":\"901abda3352e4730\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/schema.js\":\"f1f29b4ac585ff77\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/tx.js\":\"f1f29b4ac585ff77\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/typedBlockQuery.js\":\"4106de063212322a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/user.js\":\"748ae3582bc6f688\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/valuePresetCore.js\":\"9e7e9981ca532bb3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/valuePresets.js\":\"b91f48bfd2c1bdd1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/attachmentCleanerIOVerb.js\":\"52eb3c059135fa15\",\"/knowledge-medium/pr-preview/pr-1913/src/data/block.js\":\"cb9758f26a333478\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockCache.js\":\"462f5b10b3d97613\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockId.js\":\"42726f591005febf\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockLiveness.js\":\"ea993e4d40c047d2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockMerge.js\":\"c858e78a292197ad\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockSchema.js\":\"6103812da7206f9d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockTypeLookup.js\":\"03852e3dd95be3d6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockTypes.js\":\"a9c0e7e6dab9a0e9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/childrenView.js\":\"be4c09935ed6cb3a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/clientContext.js\":\"f7ec8e4bde618347\",\"/knowledge-medium/pr-preview/pr-1913/src/data/dbFileSiblings.js\":\"8718ac60d74cdbb5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/definitionSeeds.js\":\"f9040026e51e1115\",\"/knowledge-medium/pr-preview/pr-1913/src/data/derivedIds.js\":\"8501eac444c319d8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/drawnSubtree.js\":\"9e12a58aa091f403\",\"/knowledge-medium/pr-preview/pr-1913/src/data/facetBridge.js\":\"fcb8256b944016a0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/facets.js\":\"efd0982052b2ffb0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/globalState.js\":\"0a58560ff46cdeaa\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/aliasClaimRederiveProcessor.js\":\"ddbabeda1fa1a991\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/ancestorBatch.js\":\"e6db935951fbf59a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/blockTypeTypeifyProcessor.js\":\"6f4084c0805a9428\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/clientSchema.js\":\"fcd8fa2932a591ed\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/commitPipeline.js\":\"c490c95ef9c6f4c5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/devAssertions.js\":\"3e21843d42b56437\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/firstSync.js\":\"5b1156c395759eb8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/freshInitialLoad.js\":\"71caf40260d7f5f4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/graphBackfillClaim.js\":\"278ac23af9019880\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/handleStore.js\":\"f9695e3e46b173f1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/idleMarkerJobs.js\":\"67a4a7e524c5f530\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/initialDownload.js\":\"49c1675f136a168c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/initializeClientDatabase.js\":\"64fe6f548c8e642c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/jsonCanonical.js\":\"b8a706c07838e6e5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/kernelInvalidation.js\":\"69a7edb4e5230900\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/kernelProcessors.js\":\"7158e94d1aafb9c2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/kernelQueries.js\":\"e52fddf9c3cd60c4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/mergeTypeMembershipProcessor.js\":\"19e402bcd1e38240\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/normalizeReferencesProcessor.js\":\"ff3c6b7787fddae8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/poolInstrumentation.js\":\"9726d81768e13048\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/processorRunner.js\":\"7ba493d15c7f80b8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyCellBackfill.js\":\"1b6bd2c8d2073e40\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyChildMint.js\":\"79734f3119fde87e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyChildrenProcessor.js\":\"d124e757129aeb5a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4f8e151bbc45e139\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyDefinitionSynthesis.js\":\"20e0f810d213c8a5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyKeyScan.js\":\"5c25876a2892f6af\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertySchemaResolution.js\":\"92fb32667a65b6eb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyValueEdits.js\":\"5dc08d8d0750d6a3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/raiseProtocol.js\":\"01013e23638ac1a8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/readBatch.js\":\"10461e5d809a101d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/refProjection.js\":\"3a4471ad824ce9fb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/referenceTargetLookups.js\":\"c074ef5604c63cc9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/referenceTargetProcessor.js\":\"130d21205a01572c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/replayMerge.js\":\"276782750c817944\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/sqlBinds.js\":\"9c1bf9588069b590\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8e42b7ea38839dbb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/arrivalProcessors.js\":\"5c28746a36233621\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/invalidate.js\":\"353b378957708051\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/materialize.js\":\"a557b247fe3b8fb9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/observer.js\":\"65363808de4caec0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/reconcile.js\":\"024185f0aee6c999\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/timingMetrics.js\":\"8d63086874380d98\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/treeQueries.js\":\"a4c3b476ac8d7bf7\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/txEngine.js\":\"735012d24ab144c2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/txSnapshots.js\":\"bee342fd73153a5b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/typedBlockQuery.js\":\"02bd8548877b4eda\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/undoManager.js\":\"b4a9f794d2efc8ec\",\"/knowledge-medium/pr-preview/pr-1913/src/data/invalidation.js\":\"bd80a6a3237d9be2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/kernelDataExtension.js\":\"b68f16a23dacdc2e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/kernelPage.js\":\"8867b3946d660a99\",\"/knowledge-medium/pr-preview/pr-1913/src/data/kernelValuePresetCores.js\":\"baf0cdaa9ddeea0c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localDbCorruptionSignal.js\":\"f395e9e0fffce7ec\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localDbStorage.js\":\"43bc31ea74c712a9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localDbVfs.js\":\"9a23e78e66e5fd17\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localSchema.js\":\"54705ebde6c0c691\",\"/knowledge-medium/pr-preview/pr-1913/src/data/maintenance.js\":\"7251290f6041fe2d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/mergeProperties.js\":\"dfea77f5cecf5b04\",\"/knowledge-medium/pr-preview/pr-1913/src/data/metricsConsoleHook.js\":\"926ea89934e0168a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/migrationsPage.js\":\"dc3269e883cbd9db\",\"/knowledge-medium/pr-preview/pr-1913/src/data/mutators.js\":\"df6958fad1f08e2e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/orderKey.js\":\"28269fa4a357b74a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/orderKeyPlacement.js\":\"296236e2947b7127\",\"/knowledge-medium/pr-preview/pr-1913/src/data/outlineSurface.js\":\"9612f517d56c0897\",\"/knowledge-medium/pr-preview/pr-1913/src/data/pendingEditorContent.js\":\"d3ae0042baac56f0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/pendingUploadsSql.js\":\"578f09c2337328b8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/pluginStateExtensions.js\":\"72d174f41724dcbb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/powerSyncLogger.js\":\"fc8e41dbaeb82471\",\"/knowledge-medium/pr-preview/pr-1913/src/data/projectorRuntime.js\":\"1ac43ed23b3bfea4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/properties.js\":\"2c32e59623691941\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertiesPage.js\":\"5b75b34331c0e406\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyChildren.js\":\"6894d3da2373aea7\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDefinitionFanout.js\":\"bfb7a7af0df25b80\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDefinitionMetadata.js\":\"d3cf81e5e3e1fff4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDefinitionRegistry.js\":\"f289b447a8078991\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDisplayMode.js\":\"95c889169f58e66a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyRowCreation.js\":\"e3d700d331f37e8d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertySchemaCreation.js\":\"6b91751041c24ad9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertySeeds.js\":\"2bab56053d84a167\",\"/knowledge-medium/pr-preview/pr-1913/src/data/recentsPage.js\":\"07ed8b3c25f18eb5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/refTargetComparableProperty.js\":\"7a690c3d29351bf9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/referenceBlock.js\":\"27d9e3f0b6be22a9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/rejectedUploads.js\":\"526f247d3ba87c56\",\"/knowledge-medium/pr-preview/pr-1913/src/data/releasePowerSyncConnection.js\":\"f04581417699237c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/repo.js\":\"5472b76c1b1fd308\",\"/knowledge-medium/pr-preview/pr-1913/src/data/repoProvider.js\":\"4673075f2f03e390\",\"/knowledge-medium/pr-preview/pr-1913/src/data/rowProperty.js\":\"75aadd61e2f9dff3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/searchFilter.js\":\"3367806b8254a2ac\",\"/knowledge-medium/pr-preview/pr-1913/src/data/seedIdentityLedger.js\":\"394ab3498df2d342\",\"/knowledge-medium/pr-preview/pr-1913/src/data/stateBlocks.js\":\"256250917c0a0ff4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/structuralEditPolicy.js\":\"e198e13ba5bee287\",\"/knowledge-medium/pr-preview/pr-1913/src/data/structuralInsert.js\":\"25be1892550947e3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/subtreeDelete.js\":\"3b755ca697de6e34\",\"/knowledge-medium/pr-preview/pr-1913/src/data/syncStreamLock.js\":\"d860d2b1aab5e34f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/syncedTableSqlRecognizer.js\":\"d88294db2a546d9c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/syncedTableWriteGuard.js\":\"5ef9e52340128e26\",\"/knowledge-medium/pr-preview/pr-1913/src/data/targets.js\":\"d0556c7da4eda0fa\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeColors.js\":\"9d98757c6fbd17ee\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeDefinitionMetadata.js\":\"8b0e3c6eb11c3075\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeDefinitionRegistry.js\":\"a20c889a4c9d97eb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeExtraction.js\":\"2a0c7a3221a3a1bd\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeInitialValues.js\":\"ba3e60e8bd85bc72\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typePropertyGroups.js\":\"cb2e0fbd16164d02\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeSeeds.js\":\"4bd1a63020760136\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeTagger.js\":\"2a6f704dd90b8772\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typedRecords.js\":\"ad152e74c0e68967\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typesPage.js\":\"2ffc2aff81ea2d28\",\"/knowledge-medium/pr-preview/pr-1913/src/data/userPrefs.js\":\"fe515666e5e39226\",\"/knowledge-medium/pr-preview/pr-1913/src/data/userSchemasService.js\":\"4e8d465563c71372\",\"/knowledge-medium/pr-preview/pr-1913/src/data/userTypesService.js\":\"a00891afa525fcca\",\"/knowledge-medium/pr-preview/pr-1913/src/data/valuePresetRegistry.js\":\"2f8396d5bd93fb6f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/visibleChildren.js\":\"0804be548e9a3f14\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceConversion.js\":\"d2d96eb909a72ce0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceFirstSync.js\":\"146e200326223771\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceIdNamespace.js\":\"485c3ae2b9dee3aa\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceSchema.js\":\"c4dd33330abec66f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaces.js\":\"042bb0105f3fe6f5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/writeAheadLog.js\":\"d86414362e3939db\",\"/knowledge-medium/pr-preview/pr-1913/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/BlockPasteShellDecorator.js\":\"476a7b1cab6f934f\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/atTrigger.js\":\"513cdc4ebbe6cc89\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/autocomplete.js\":\"a05388f10e47d111\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/codeMirrorExtensions.js\":\"6074230c9e77b72e\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/contentFlush.js\":\"0311388e38ce12bd\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/defaultInteractions.js\":\"1b9a8b32d21142b4\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/editSettleSignal.js\":\"76ff6f9afe0cfb61\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/insertImage.js\":\"bd5ffa746b2649c9\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/referenceCompletionRange.js\":\"d15bb2063e34e147\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/referenceTargetTypes.js\":\"f2b4746bbc416c6a\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/syntaxContext.js\":\"00fbcba32b44d3d7\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/triggerMatch.js\":\"e18c30db356a25db\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/AppRuntimeProvider.js\":\"74840264f00096a1\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/BlockFocusShellDecorator.js\":\"e9e9af6f8041a40e\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/ExtensionRenderBoundary.js\":\"5ff6fb6ceff79b55\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/PanelContentRecovery.js\":\"58ef7a1a47c741ba\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/apiCatalog.js\":\"5d55e9e3b1aae9ce\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/approveExtensionHere.js\":\"a7507cc94056da78\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/armedCutAppMount.js\":\"3b745b9f6b71edf1\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/batchableKeyedStore.js\":\"82c7103ea2d52957\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/blockInteraction.js\":\"d69cb838c469221d\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/blockSelectionAction.js\":\"875e532c499293ad\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/compileExtensionModule.js\":\"8fa6bf54851093d0\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/compiledModuleCache.js\":\"96d1db0bb77f9ad4\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/continuousGestures.js\":\"8eeb5b2a46cf7892\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/core.js\":\"3365aa22773af1dc\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/defaultRenderers.js\":\"c09f2d8d20c5c8cd\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/definitionFanoutAppMount.js\":\"76b29e4286a8cfcf\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/dialogAppMount.js\":\"ee5b205b13af95c6\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/dynamicExtensionSeeds.js\":\"1d1158d7e7eaf695\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/dynamicExtensions.js\":\"4419183d6565808e\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/exampleExtensions.js\":\"04eb91e2c874f8d4\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionApprovalStatus.js\":\"983de4f31e67f046\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionLoadErrorToast.js\":\"8a03f0c8d4309346\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionLoadErrors.js\":\"dd1be7bcecd9517d\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionLookup.js\":\"6065022e939e00f6\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionToggles.js\":\"6fc37f0fb24261bc\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionUtilitiesCss.js\":\"dddca2ad905527a6\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/kernelPageDeletionGuard.js\":\"3bac10893c7a601b\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/liveRuntime.js\":\"6ccc9826695a334c\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/openExtensionsSettings.js\":\"efd4e4649519ad0d\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/overridesCache.js\":\"51fecc95a361f774\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/pluginIds.js\":\"b888ff42469e9cad\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/processorRejectionToast.js\":\"84ab40ad0b0a2330\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/runtimeActions.js\":\"813908e1d0ead148\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/runtimeContext.js\":\"f0eef41e56bb05ca\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/staticAppExtensions.js\":\"b7bffa5abfeecadb\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/staticDataExtensions.js\":\"6564d0868f1c6bfd\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/toastAppMount.js\":\"2305000a46f550f3\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/useOverrides.js\":\"24535b051b73b844\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/useShortcutSurfaceActivations.js\":\"588064735641778a\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/discoverToggleTree.js\":\"ff181a899723b762\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/facet.js\":\"8b009ce0d0c717bd\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/resolveAppRuntime.js\":\"595e908d6d5130af\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/runtimeEvents.js\":\"b7f863a91231a469\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/togglable.js\":\"672c82a741b19515\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/variantFacet.js\":\"4edca98dadf157ae\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/verbFacet.js\":\"d88685b4798b1677\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/block.js\":\"32d220dabe8d39b9\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/focusedChild.js\":\"93d3cdc3b5ea54db\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/propertySchemas.js\":\"63fb7f45fef7dc13\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/typeRegistry.js\":\"0b5490587c68de66\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useAncestorCrumbs.js\":\"29165fdbd39de9a4\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useAutocompleteListbox.js\":\"dc9f6bbf7ee4b9d2\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useDebouncedSearch.js\":\"f198a41eed63473c\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useDebouncedValue.js\":\"6cdc472c66535da7\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useFacetValue.js\":\"3c35feed414513a2\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useIsFocalRender.js\":\"310a1179061da6ac\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useIsReadOnly.js\":\"c73f548d11676488\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useMaterializeBacklog.js\":\"fdb0d7c971a75d00\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useMinuteClock.js\":\"9156625bb22ab4c8\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/usePanelLayoutProjection.js\":\"d3769eb6d6213faf\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/usePendingInvitations.js\":\"da77b0891d76cd94\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useRendererRegistry.js\":\"3b83d9d0677aa800\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useRetainedFieldRows.js\":\"6bc4f16f98a297f9\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useWorkspaces.js\":\"c8e38dccdc81852b\",\"/knowledge-medium/pr-preview/pr-1913/src/lib/utils.js\":\"8d73a889a66c66f8\",\"/knowledge-medium/pr-preview/pr-1913/src/main.js\":\"666899ccec1d48a5\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/MarkdownImage.js\":\"ab048fa23a1267fc\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/blockSeparators.js\":\"ec7d41a00ab70635\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/context.js\":\"50773088c006d575\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/defaultMarkdownExtension.js\":\"48aa313afdb52c7b\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/extensions.js\":\"6651f28f2063508f\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/renderMarkdownHtml.js\":\"c546c2c8ec09d09e\",\"/knowledge-medium/pr-preview/pr-1913/src/minimal-editor.js\":\"dae1e3ef65124900\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/armedCut.js\":\"186df961bbaf10dc\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/captureMediaVerb.js\":\"c855f7827ce5e7b8\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/clipboard.js\":\"2fd96e979cb47f0b\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/decision.js\":\"bf2c63deaf7fcbb0\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/operations.js\":\"db647ea31da1aa24\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/account-header/AccountHeaderItem.js\":\"f24b07fd88d6d0ca\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/account-header/index.js\":\"0d791db1e9110346\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"dfe5ec8750191abf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/askAgent.js\":\"ad44aff2eaa0a64f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/askedStore.js\":\"608d4896819608f5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3297c3ccda6ddc7e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/chipState.js\":\"226582c57b41092e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b5ae63d7e35d8fa2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/index.js\":\"e84dd42103e62fba\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5776ce5963866867\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/schema.js\":\"2f9c481c4ce0f17f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9a58a5cd4dc54415\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4438941a9bfd30ff\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/addMedia.js\":\"0614ba5ad8b6e32e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/backlinks.js\":\"88000177f60db3ce\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/block.js\":\"ef07e4dbf7fba1c9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/context.js\":\"ca4c5b359a80a57b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9f2f9412aa0222d4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/index.js\":\"5431fc32be2835d0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/outline.js\":\"856646b5f30849cc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/properties.js\":\"732571091a206602\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/refs.js\":\"9c66decc59c267a0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"1c47e43f3ece521d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/search.js\":\"4c547ab3c8a158d0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/shared.js\":\"e93fe23a09a51275\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6448a6d56f5a1633\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/text.js\":\"7ee781a29af90f33\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentWrites.js\":\"b5b6139af9f1da10\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/authoringCatalog.js\":\"879f368cbd266dbf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/blockRefTargets.js\":\"04fe59a63127b22b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/bridge.js\":\"f99a37b099958c3a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/bridgeLoop.js\":\"489009fbe2d8d4f6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/changeHistory.js\":\"a45a107be641e38e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/commands.js\":\"019449649478b23a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/commentsCommands.js\":\"f6c4ab0da1a6db4b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/dataExtension.js\":\"be9a08e2ed5aa1ab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/dataModelGuide.js\":\"556e082718ff0f39\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/dayPropertyInputs.js\":\"4cb22196e46e1e3f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/describeRuntime.js\":\"cf9cd06559a952cb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/extensionLint.js\":\"085c196178c1b87d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/grainAudit.js\":\"c92212262a5d11f7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/healthCommand.js\":\"480248c2c0a99724\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/index.js\":\"a29a716a7a59cdb8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/presetIdentity.js\":\"e35b1c759cf6a226\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0d38810f5cbe0484\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/readMedia.js\":\"e57aa56fbb6e6bcd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/schema.js\":\"51163cfdf03b91ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/serialization.js\":\"aae4d77dd30322e8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/targets.js\":\"c14d03604b04daeb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/tokens.js\":\"5050c44739abc6f1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/watchEvents.js\":\"4d117c0f812e57f6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/workspaceGuard.js\":\"8176192d72a1ce83\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/writeCommands.js\":\"5a4b5e5e76e54f73\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/AliasCollisionToast.js\":\"22890195d7990fb8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/DuplicateNameBanner.js\":\"4ab9a37d0e6740a3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/collisionMerge.js\":\"2e51eee181e38118\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/dataExtension.js\":\"23be5a5569f8261b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/index.js\":\"60fa7e3929152fd6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/mergeCollisionAction.js\":\"292cab0b7eab2665\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/pageStyling.js\":\"eb5d63c0006f9d64\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/rejectionToast.js\":\"85f0e63a7a71b936\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/syncProcessor.js\":\"f768ce9de19656bd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/actions.js\":\"e92ec66993f1986a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/addComment.js\":\"a44a09d7a9a4c94a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/anchor.js\":\"4500ff5bc387bff1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/anchorState.js\":\"c452f3d144772877\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/commentLinks.js\":\"be41297eb9d9748e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/confirmThreadDeletion.js\":\"caa423414e2751c8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/container.js\":\"394b90e246b0176b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/dataExtension.js\":\"f11afaab4dab9648\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/deleteComment.js\":\"d649fc49730c2eed\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/highlights.js\":\"be28957bc81baf19\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/index.js\":\"290c6fbb103b4c50\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/linkedCommentsPill.js\":\"4f89c179c0e6cadc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/margin.js\":\"be22fe82489f833a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/marginAnchorLinks.js\":\"051a8ee2b7a0bba2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/marginSchema.js\":\"b3b0c6a9c0201f72\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/newComment.js\":\"1709e650641cc192\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/ownThreadPicker.js\":\"9907be03b3abb614\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/placement.js\":\"a8343f936d7b797b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/queries.js\":\"8e49ad5ba45a470c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/quotePosition.js\":\"95160bd9380627fd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/quotedIn.js\":\"891372b36e2d84a0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/quotedRange.js\":\"3d66bb028cb170cb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/rangeRefs.js\":\"cf445844d4c3f795\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/readHighlights.js\":\"571bc35eed0e9c30\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/readSelection.js\":\"f13df1d9766ffc35\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/readSelectionUi.js\":\"001b93bdbf16830f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/reanchor.js\":\"8c9cef61311158f3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/schema.js\":\"78241b07d4ae48b9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/scope.js\":\"de841d28f0945992\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/scopeThreads.js\":\"b217abf0960fff53\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/splitRetarget.js\":\"1d714f2f0a917d4b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/suggestionCard.js\":\"44cf5e84540a9e71\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/suggestions.js\":\"69deb759b4ee37ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/summaries.js\":\"92a9b6c621891285\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/summaryBatch.js\":\"753f52b79a5a42a4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/surface.js\":\"194f8c77fcdd80ee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/threadNavigation.js\":\"d01f09c8ae347ab4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/threads.js\":\"507acb4e43c8ff54\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/ui.js\":\"411a307e3db17d8d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/uiStore.js\":\"fd917f30e555677d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-intents/appIntents.js\":\"1011f77f94c00dd9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-intents/index.js\":\"eb50f056f520130b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-update-prompt/index.js\":\"28e0fab48365ad48\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-update-prompt/status.js\":\"6e319da51c2affe7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e3b9651542897b52\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/MediaBlockRenderer.js\":\"33c30239406a0baa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/MediaDownLaneReplicator.js\":\"59ad7e323ac2fe58\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/MediaUploadReconciler.js\":\"e8507affb40ff95c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/assetDownLane.js\":\"b2e9027724dfa6a5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/assetResolver.js\":\"f799d20db1550072\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/assetUpload.js\":\"90ffd309fd1add4e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/attachmentCleanerIO.js\":\"b4254b74595314af\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/supabaseAuditIO.js\":\"54a04529701b98e3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/blobStore.js\":\"836d8a81c4eab9c4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/browserMedia.js\":\"e640b201523d86ab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/byteStore.js\":\"a00b8f06e05ae150\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/cleanerIO.js\":\"25c9abb64ebbf229\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/cleanupAttachments.js\":\"1828be0a84eb905c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/dataExtension.js\":\"e537fc8ed03f3595\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/downLane.js\":\"18cdfd8e7a574081\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/index.js\":\"e31cfea85c1a9871\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/insertImageContribution.js\":\"d77db799f3b6174e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/laneArming.js\":\"cae0d4357b6ca887\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/laneLock.js\":\"0204eef484815a9b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaBlock.js\":\"70e74f3a017d5456\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaCapture.js\":\"dc606e1b67c2198d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaLanes.js\":\"1716e56299adb387\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaViewers.js\":\"6b440556fef7a9b7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaViewersFacet.js\":\"aef18e47df9a3ace\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/pasteCapture.js\":\"75a5bfb11154a8e1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/resolver.js\":\"1badcfaf51622bae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/retryUploadsAction.js\":\"70f8bf00c514353f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/storagePaths.js\":\"d278473cad1bd227\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadDrain.js\":\"ea49297d57a44634\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadLaneStatus.js\":\"3d8cce54018393e6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadReconcile.js\":\"f5e16e10072c334c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadRecovery.js\":\"a5e2afc6302b9e73\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadStore.js\":\"f683a97c85b0ae6a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/useAssetObjectUrl.js\":\"4c194054c238d006\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d3dad9d316788b4d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ff79855b515d20df\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/facet.js\":\"60e7fd8b78749933\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/index.js\":\"d53a143392573b74\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/prop.js\":\"ef7b008a04c19e79\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/BacklinkFilters.js\":\"4a60fb0e9772fc8a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"68cd65947137482d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/BlockEntry.js\":\"a69afafdcd242bca\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/LinkedReferences.js\":\"abd078774142f815\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"501aca557bf8b416\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/dailyNoteDefaults.js\":\"5ba3de9b0c6d88e6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/dataExtension.js\":\"ddd5412f75a6c600\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/edgeExclusions.js\":\"efa16408321eebfc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/filterProperty.js\":\"19f6acb6c6696202\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/index.js\":\"f6dde78722108edb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"7879d5a61cf2b9dd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/applies.js\":\"c962432e7c66a1b7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/countQuery.js\":\"d2dc3af95e21b5fb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/expansionStore.js\":\"90bad3f03c3050bd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/index.js\":\"50a2721423e1cc5d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a1d6652bbc2dacef\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/presentationInvalidation.js\":\"190da3cc0ac62b84\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/propertyEditorOverride.js\":\"074132dbb8680734\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/propertyFilter.js\":\"9970e7a66136cdae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/query.js\":\"bc0a984baa101e63\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/resolveFilter.js\":\"38f7535219055b08\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/sourceBatch.js\":\"e9a1d3bd69bd3253\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/sources.js\":\"55035cdc0ff68347\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/useBacklinks.js\":\"bb60e79f27480be9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"60ea83e77392e6c9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/BirthdayCelebration.js\":\"48e678825a75b422\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/BirthdayOverlay.js\":\"c2aded421924a32c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/gate.js\":\"d8e6e0eb25c7a476\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/index.js\":\"c08a191b38190b25\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/wolfTheme.js\":\"43c822aedb532a7f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/BlockDragLayer.js\":\"9a95a9370f0eaca8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/dragController.js\":\"31d9db5c0b15116f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/dropTarget.js\":\"2b3ed18f73a13234\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/index.js\":\"0c516c3d08354370\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/projection.js\":\"759815e192e62871\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-info/BlockMetaCard.js\":\"e705dae1fd78e541\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-info/index.js\":\"18abc515665dc837\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/AddTagDialog.js\":\"d6475c087921ed66\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"1ac473524e013e8c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/TagNameIssueHint.js\":\"0932785f3e0193d1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/addTagAction.js\":\"c28e898075d55eec\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/appendTag.js\":\"309f0c3fd6c1683a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/config.js\":\"87bbfa06202190b1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/dataExtension.js\":\"5859b32644d2ec46\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/index.js\":\"493662c04e18d35d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/propertyEditorOverride.js\":\"3f0685a491628db0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/BreadcrumbList.js\":\"d5ac7d02d18356b9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4fc21693be990a5b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5880c4c647234897\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"8c6d83db75a29793\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7755127562069090\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/index.js\":\"fdf96eb63f735a26\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"0ddb1ebdd0b8db93\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/CharacterCountItem.js\":\"b8ae88d2ef00c7b7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/ProfilePropertyEditor.js\":\"ae39d4d28a33d30f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/actions.js\":\"398fb3848b1945ab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/blockType.js\":\"c390b513316b6a82\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/charCount.js\":\"d44d58f3c5375a4e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/dataExtension.js\":\"045bebd9908bcd60\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/index.js\":\"d3afb17b20c065a4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/profiles.js\":\"99339f2a477c27e7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/properties.js\":\"3885d69e927b79c3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/subtree.js\":\"e366a06edc60b057\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/textCounts.js\":\"190560dc441c6582\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/colemak-keybindings/index.js\":\"829082952e518ec4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/CommandPalette.js\":\"31f1eabf50646e92\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/HeaderItem.js\":\"55a76c2f55e070ea\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/context.js\":\"dcc0bb1e87646e65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/index.js\":\"424f92066c2fb1f8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/selection.js\":\"7ff161537ecc3edb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/toggleStore.js\":\"bf6a4097c9074e47\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/useCommandPaletteActions.js\":\"49f6cb45cff8d010\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/ContributorBadges.js\":\"b434e3cc0a57b96f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/ProfilePicture.js\":\"110088ee3adb5d74\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/author.js\":\"89fe3c19aa39096d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/codeMirrorExtensions.js\":\"6abb07991841e82a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/dataExtension.js\":\"8406b30235625c64\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/index.js\":\"47688a866e458bad\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/mentionAutocomplete.js\":\"e32038b60e6e4d6e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/processor.js\":\"ec6574ce32d41191\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/profiles.js\":\"14dd52a6fed72227\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/queries.js\":\"95c1e5575ddb44e5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/schema.js\":\"75e80fefb24b7ead\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/useCommentAuthor.js\":\"2a3c8ff354b36bcb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"fcbe991bb3c83fc9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e73676e1210eb626\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/index.js\":\"57193a4960d9d157\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e81f8fba90eb1e6d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c800c713f37f1728\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/CalendarGrid.js\":\"4ef36f513280b545\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DailyNotePicker.js\":\"218a153dd1c1ade5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"b55c5600144cb99e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DateNavDecorator.js\":\"8e30607037ce86e4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DateScrubOverlay.js\":\"0fc1accc6f029940\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DayPropertyControl.js\":\"976b7e7f19379262\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DayValueReferenceControl.js\":\"7a9380dd6ad63ad9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/HeaderItem.js\":\"fffd6d551cc71868\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/ReschedulePicker.js\":\"2efcc6621441002c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/SpreadDatesDialog.js\":\"2dc2de2fc1620c18\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/actions.js\":\"ef420fafc81bb584\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/blockDateAdapter.js\":\"93fdd289ad3cb949\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/calendar.js\":\"9c101a00f8ef6080\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dailyNotes.js\":\"db8869d6680080c0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dataExtension.js\":\"238487c4ad86a653\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubActions.js\":\"74e9adb3daa67019\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubGesture.js\":\"280554a145666165\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3a850840f02dcc6c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ecf1522033393f35\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dayProperty.js\":\"7b256b7af8ca41c2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"30af47f6ca4169cb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/deletionGuard.js\":\"3629c6886db65ec2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dueQuery.js\":\"f6e19d4bc9cfd091\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/index.js\":\"363e7cdadeb61e89\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/landing.js\":\"03266e0fd0b042a5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/localSchema.js\":\"f9b34f7e1a880bdf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/referenceDateAdapter.js\":\"61499518aafd52d0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/rescheduleAction.js\":\"756f8bac526d63f1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/schema.js\":\"0cea048e894b8c82\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/spreadBlockDates.js\":\"20b14ab3d11a42b8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/spreadDatesAction.js\":\"b623fa774e07a348\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/today.js\":\"84bf40893e08a843\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e9272e653e4ab0eb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f128f63312cd8614\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/audit.js\":\"b81beda11783425b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/auditAction.js\":\"02c59a1ce8c168a6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/auditRanges.js\":\"bcfa8c394c6a79a3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/diagnosticsSource.js\":\"adc8a5b2895ec42b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/divergenceScan.js\":\"9c0a2cd4d4d3737b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/index.js\":\"706e56b8da9d269a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/propertyChildrenChecks.js\":\"085b180987cbd572\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/referencesMirror.js\":\"0c453205e83929f0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/rowJson.js\":\"9f204210c28e7ab4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/schedule.js\":\"0ef67b02db2e2b49\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/store.js\":\"fee3a93d800d9ff0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-maintenance/action.js\":\"cde12496db1fdf11\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-maintenance/index.js\":\"c746f14f82d4419d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-maintenance/plugin.js\":\"467b70d8b4b27a4a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"85bff9ee3a67c0c2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/actions.js\":\"7566ebc86a24400b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/changeMarker.js\":\"6788783a0748bf07\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/diagnostics.js\":\"3a775f4ca49c0e4e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/fileSystemAccess.js\":\"1f3af1bc91bd3fd8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/filenames.js\":\"ed540fe12ccd95b8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/index.js\":\"1792714cfd27ad31\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/mirror.js\":\"a28ebd2757d5bf63\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/runLock.js\":\"ed0e4df67fb85c32\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/runtimeHealth.js\":\"cfc95dfc7a9e8257\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/schedule.js\":\"276251ea5fc7bbdb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/store.js\":\"e8b94b18bc6a12d5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/default-themes/index.js\":\"360417d997cf7522\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/default-themes/themes.js\":\"88868ed26f720b2f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/diagnostics/facet.js\":\"06324e325da9bd0c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/diagnostics/useDiagnostics.js\":\"c64015ae8ae265b0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/dismissals.js\":\"ca209060ed471654\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/index.js\":\"89adc0955b70be7e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/status.js\":\"e1a7daa376bc5f89\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/store.js\":\"c5f9c633bc5ee0f6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"15debf1df5df1de3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a7b72b48dd48ed64\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/actions.js\":\"74aa3c6668633276\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/config.js\":\"8a4a90eda253371a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/dataExtension.js\":\"023bdfbca67eb7b7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/effect.js\":\"c426ef98dd50c62e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/index.js\":\"0f530157a326c067\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/propertyEditorOverride.js\":\"75e90ac1093c33b7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/useToggleTree.js\":\"baf4119559279ac8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/ExtractTypeDialog.js\":\"f2c0994cf42fd497\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"0f983e07cd98ba99\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/PropertyShapePicker.js\":\"cc80f71320d6768c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/action.js\":\"6132e9a7f7e58f83\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/index.js\":\"8b31b41552ae15b0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/FindReplaceDialog.js\":\"c2b6a366fad2a251\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/HeaderItem.js\":\"c9746b290c387c4a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/dataExtension.js\":\"04933d9dbc7e70bd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/index.js\":\"dc7c09d81c0f6988\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/search.js\":\"8eb553bedd0c6256\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/toggleStore.js\":\"924b3c1132904856\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/LocationPropertyEditor.js\":\"351dad22a02089a1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/MapView.js\":\"b11e656379be1f71\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/blockTypes.js\":\"045a71314865e99b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/codeMirrorExtensions.js\":\"50db0842f42feaa9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/createOrFindPlace.js\":\"db6ff714c763e47e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/currentLocation.js\":\"e0fd915b286b7fa6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/dataExtension.js\":\"c769389a768eb7d7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/geoContentDecorator.js\":\"130721babc4ab777\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/googlePlacesClient.js\":\"48099035992a6792\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/index.js\":\"dd671b4ffac870ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/locationsPage.js\":\"2b1f436ecd5ef099\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/mapViewport.js\":\"4139b947a024c211\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/pickCurrentLocation.js\":\"3e87cc7dacd1d102\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/placeAutocomplete.js\":\"3c151b3ed98b5c99\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/placeNameCollision.js\":\"18e5099b755aaf1e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/properties.js\":\"2466e7aff209978f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/propertyEditorOverrides.js\":\"057f07dd4041d1cf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/query.js\":\"2e410061874d6b7e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/usePlaceSearch.js\":\"f0454c97fbdd29c5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"6df2548dba5c96ad\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"dc3c035780702692\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"750b64b205a9312f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/config.js\":\"ee2fe7c36b821ef4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/dataExtension.js\":\"5ecef7aa8ab07c8a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/facet.js\":\"3db52f5efeb1026e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/grouping.js\":\"d08a6b894f380cce\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/index.js\":\"73149d6f557eddbb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7a75c8d327a525ac\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/query.js\":\"8e3d8309fe8877bf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/resolveConfig.js\":\"3ccfdad1f2e81cb1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2bf5c9f9324659a8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"854654de4756fa46\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/HtmlDocumentContent.js\":\"f65c7c77b83c00c8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/HtmlFrame.js\":\"89ddb2263a65188d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/actions.js\":\"35ae904a14cd227f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/blockType.js\":\"f01509b8acf3c893\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/confirmRunScripts.js\":\"abb2e363a509df61\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/dataExtension.js\":\"142d4e77568468d9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/frameAnnotations.js\":\"af5217415e53502e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/frameDocument.js\":\"d01217fc72a191de\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/frameTheme.js\":\"74110783dd866193\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/index.js\":\"bbdf80d4e394d134\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/scriptConsent.js\":\"fc8bef19a06950fb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/sourceMap.js\":\"389c5b99a1a019d1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/useDocumentScripts.js\":\"c8b7ee62ef00b3a6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/index.js\":\"2a1ed57775e44499\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/record.js\":\"da1762730c26ac24\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/recordStore.js\":\"a596a675fdbd027a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/responsiveness.js\":\"f94315a4dc3a24da\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/schedule.js\":\"a2bfc7e68ced2c9b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/sessionContext.js\":\"f124dbbef0fc47f6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"92fe3982a319c726\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"b662c75d5b2f3bf8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/actions.js\":\"a76d017277d9439e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/config.js\":\"2d4a7c12ac7d8c6b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/dataExtension.js\":\"1f63cffac1c7239e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/effect.js\":\"348224475fbac16c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/index.js\":\"fbde490b002ebf8a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/keyCapture.js\":\"0a90188f0a34cbae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/overrideStore.js\":\"d1c28cd195af86c8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"24af7de818d168fc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/HeaderItem.js\":\"757e1e74f005ec2c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/LeftSidebar.js\":\"f55abf39d50b5608\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/actions.js\":\"ef6eb7140de4cea5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/facet.js\":\"7c51c50250709c3c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/index.js\":\"294863b41364c379\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/shortcuts.js\":\"738eca3743f33e25\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/toggleStore.js\":\"2c3c71c4df8b4aa3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/MergePicker.js\":\"9d16561e3a384353\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/index.js\":\"27ae1718dfd6d0e7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/mergeAction.js\":\"feca5cda68285733\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/strategy.js\":\"217fc7fccf9bf6ec\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/Button.js\":\"975f0892e288f417\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b618fb44cf01b73c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/defaultItems.js\":\"507f63764fab6743\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/facet.js\":\"66177ab8c6a4c663\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/index.js\":\"31dfd24d179892b8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"2afceac1ee5220ee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e35d6d7c9ea9dcea\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"f9d12d6daf57d9fc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6460e608006a4a3a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/index.js\":\"dd2e3885817b1e1e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/MoveDestinationPicker.js\":\"1137825117609ce7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/blockSubtreeMembership.js\":\"da2972e2e7cb60e6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/contextMenuItem.js\":\"3da1727319e9251c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/index.js\":\"9cfa93818bf56e31\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/moveAction.js\":\"e2d72dab453a71c9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/moveBlocks.js\":\"d8f85f6133fd858c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/selectionAfterMove.js\":\"4359cc15bf490f24\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/TutorialBanner.js\":\"cc634c2efd63baf5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/action.js\":\"67bca79243f8c757\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/bannerDismissal.js\":\"c802037ab8468f69\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/documents/cheatSheet.js\":\"8b093e534ffc968a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/index.js\":\"a4652b2eacf37ec0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/keys.js\":\"fd5f16566cab386a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/landing.js\":\"dd791edc92fa7eb0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/outline.js\":\"b3bf524e134bacd7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/seed.js\":\"13b81760c252c4a2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/PerfTrendDialog.js\":\"1c887f2b4cc10053\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/analyze.js\":\"4660428a71f1896f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/diagnosticsSource.js\":\"a45974ef29c845b3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/index.js\":\"4e511e0a47c20383\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/load.js\":\"ec17cb30696d9bc2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/monitorRun.js\":\"3f6db7d2c7159eed\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/schedule.js\":\"8457fb2c46627820\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/series.js\":\"c29c1536357c0018\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/store.js\":\"bd7d8e14b33d7bd7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/trendAction.js\":\"b724437ed72b9fc6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/verdict.js\":\"de843fd0da23a346\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/plain-outliner/clickToEditAction.js\":\"7a84c0d0c0cf2f41\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/plain-outliner/index.js\":\"e97991bec9e0c6d0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/plain-outliner/interactions.js\":\"3abc80dd20aaf910\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7d5445f5bb89ba55\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/MigrationGate.js\":\"ccc37cc52f73861a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/MigrationGateDialog.js\":\"2f5d2646a99a3091\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/action.js\":\"6b16d65b0822552b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/index.js\":\"e5a62dfe2641acb6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/localRunMessage.js\":\"8951109b7684cb90\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/plugin.js\":\"ded9f173ce23cdb4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/progressReport.js\":\"e7aea60812cae13b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/sweepProgress.js\":\"2cb6011c6d22cddd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/FieldRowRenderer.js\":\"7ee6df92f7cfd1bf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/ValueRowRenderer.js\":\"9ec625d1bf9feee6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/actions.js\":\"3ab7f3d06283e05e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/autocomplete.js\":\"a0fb12372a2ebcc5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/fieldRow.js\":\"4050d4c70c2cf81a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/index.js\":\"af08792740885af1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/referenceWarning.js\":\"3618c6e279267188\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/valueAutocomplete.js\":\"9350c43836a7ebb7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/valueSchema.js\":\"b92409e1e4714c47\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/HeaderItem.js\":\"8058a091b46d4c70\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/QuickFind.js\":\"a8df4689104615ee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/index.js\":\"4eabb92de639db82\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/recents.js\":\"99b7ab61abfc6b50\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/resultItems.js\":\"715aabea972e4524\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/selection.js\":\"71665e17c0739d64\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/toggleStore.js\":\"e5a68c4e38086a2a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/HeaderItem.js\":\"c807f15b3e55a576\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/RecentsPageBlockRenderer.js\":\"6de4aee835c18fe8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/grouping.js\":\"9fd50e92e563a494\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/index.js\":\"2c2fece480b78b48\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/target.js\":\"a75e25557761537e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/codeMirrorExtensions.js\":\"16dabfd4ae466b74\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/contentPrefill.js\":\"f1cb543372a80d96\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/dataExtension.js\":\"77329807b5a2fd48\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/index.js\":\"475a8f565992a599\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"7987aa6c184c50ec\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/invalidation.js\":\"4b3656a1d01f8f7e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/localSchema.js\":\"16658c5e0b6dad81\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/blockrefs/index.js\":\"c95231bb164aafd1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"feeb5bc2458e1119\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/index.js\":\"3afbcf8a17dd4ec8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/referenceNode.js\":\"3583446e3caa1161\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/remark-reference-occurrences.js\":\"eea878bc07d81430\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"5f22d8d0edbd2892\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/index.js\":\"ed56932eade69ec4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a798ed6b73f499a0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"1488218cba2dad7a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/mergeRetargetProcessor.js\":\"3d5a46bd7549b048\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/parseFence.js\":\"5ff419a1544b250f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/referenceParser.js\":\"08ebb77fae79f1d7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/referenceProjection.js\":\"ac7af80017052c2b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/referencesProcessor.js\":\"0812583bdc066e4b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/renameProcessor.js\":\"e7812abedb9ede28\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/spanReplacement.js\":\"fa5b656d75cb1f13\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/htmlToOutline.js\":\"d69a59e6fc040076\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/index.js\":\"0b4a7d43c38b8666\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a10296871f61d534\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/pasteDecision.js\":\"893da1323fb9c8a7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/action.js\":\"b027e1bd6a92a4d9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/blockIds.js\":\"2625cc6b7910d1bc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/content.js\":\"7af09e5a7e335491\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/effect.js\":\"1cab734cea179de4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/ids.js\":\"f9118e19b0b3dd08\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/import.js\":\"d1dcb3c5e5b232c3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/index.js\":\"750bc2c73468ca42\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/plan.js\":\"49954fe0cd8f7d0c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/plugin.js\":\"178d7092f437bcee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/promotion.js\":\"f564b03356135a39\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/properties.js\":\"d29107ff872c9ab4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/references.js\":\"d98efc06696269f0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/report.js\":\"07341d20e977bf97\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/roamMemo.js\":\"588f57a4e3adadcb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/runtime.js\":\"96cacd84bc55efb7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/schemaReconciliation.js\":\"3337a52affaf0b21\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/srsMarkers.js\":\"37176c23468a6a51\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/todo.js\":\"2d8751868b81a5e4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/typeCandidates.js\":\"a33133912e5bf9db\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/types.js\":\"2e725ad89f35a209\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/search-health/index.js\":\"382a27114b6be6db\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/search-health/store.js\":\"7c6a2ef184343f93\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/HeaderItem.js\":\"c7d7a3d8d8da4f7b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6fbd3b071f796d0c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/index.js\":\"d748bcea7db4f3a4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/model.js\":\"62f43a558bd7c7ac\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/toggleStore.js\":\"61356de110df20e3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/useKeyInspector.js\":\"504c8665d68fde89\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"abdb41fbdce548b5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/ShellDecorator.js\":\"89b35377a0cc5978\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/actions.js\":\"0f1ac0d3c6cbebf6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/exclusionsFacet.js\":\"fbcd8e25049304a2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/index.js\":\"9f50236b78fe51ab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/shell.js\":\"155682540e828f91\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/surface.js\":\"4e5a8ed4e081cf9c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/walker.js\":\"d670bd8652034d62\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/RescheduleToast.js\":\"671423dded6dc473\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/dataExtension.js\":\"f5124bd138e7849a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/index.js\":\"f05470c3f7a7906b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/indicator.js\":\"e51be95232447f5a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/moveSrsState.js\":\"71a6417437a58e6b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"db3ef64216b6de0b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/scheduler.js\":\"f0f9a204781ab1ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/schema.js\":\"5d74b1cdd1205a50\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2b862d720fbcdfb5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/srsClipboard.js\":\"f02b0a0bf3c8c979\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e1c6547b3b334f8b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ba067fb6845847b5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/DeckPicker.js\":\"1aa5b3f2eacb0758\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/ReviewControls.js\":\"51d44844226872dc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/ReviewDeckRenderer.js\":\"32d6c8b35e0e1cee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/ReviewSession.js\":\"16afcae467044e2d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/actions.js\":\"be5ed7b0ce3bf7bc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/archive.js\":\"0d66acce305ead1f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/dataExtension.js\":\"ecac5813820a8d42\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/deck.js\":\"e2fa94e8cf7367ce\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/dueQuery.js\":\"6465d480b217417d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/gradeDecision.js\":\"3df743a37f02548d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/index.js\":\"138e3fc4c1a91dd2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/keyHints.js\":\"cd4c5c588eab4f60\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/reviewCardLayout.js\":\"25c6a7ec4759ed03\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/reviewProgress.js\":\"6f06e87cd6d8109d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/schema.js\":\"c5f889860e238eac\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/useDueCards.js\":\"2d865330a0b33d05\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/startup-metrics/index.js\":\"fa399d4e1906a7be\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/startup-metrics/record.js\":\"81a36d34fa5dd6a5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/storage-persistence/index.js\":\"144c4d7518b31bf1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/storage-persistence/persistenceStatus.js\":\"daef7e6c9600fed3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/storage-persistence/requestAction.js\":\"49253a9f0ee13e65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/TypeChipsDecorator.js\":\"a44f0fb2fec12a40\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/codeMirrorExtensions.js\":\"7c6724180964efee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/index.js\":\"70ac19a137fa2b7e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/typeAutocomplete.js\":\"7a942342e29c64b9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4e690a5d02378fcb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/actions.js\":\"ee6968fb4985aa3d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/anchor.js\":\"f3131f926f33afc6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/events.js\":\"7763da9218249bd5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/gestureActions.js\":\"e6c9de730c256395\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/index.js\":\"9783b581944a69db\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e378ff9538af128b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/sync-metrics/collect.js\":\"89598d6f9b05ae91\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/sync-metrics/index.js\":\"2b7b50b72e92a2b5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/sync-metrics/record.js\":\"0d3df4d51768b77d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/RejectionDialog.js\":\"d5b3a7d01326e591\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a310924d77a055e7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/index.js\":\"82fbdda1e1014032\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/model.js\":\"a5c0b68fd0b4451b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/queueCounts.js\":\"f23ee588f4f31d1d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/rejectedHelpers.js\":\"3f7c08a10492d730\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/rematerializeAction.js\":\"517426eeb5ff7d12\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/useHysteresis.js\":\"b35f27b384c281b9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/ColumnHeaders.js\":\"f017d2a783702c21\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/QueryUi.js\":\"635d657132c1a3c8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/TableLayout.js\":\"457ee11688189de9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/actions.js\":\"4f6c3f0462293791\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/cellEdits.js\":\"1ab46fb101940937\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/childrenViews.js\":\"848c94d6017e6977\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/columns.js\":\"c456063fa80f7d7d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/controller.js\":\"013c4cfc4114eae5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/convert.js\":\"23e3b9d038d68803\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/dataExtension.js\":\"d4735f3a8a9eb726\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/index.js\":\"164ac2b4c2c8e6b6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/keys.js\":\"1de33e856361eb06\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/model.js\":\"703383f069f0ea43\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/QueryText.js\":\"a2660176f5fdac9e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/backfill.js\":\"d915f4994ffc4ff4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/completion.js\":\"78e3e6e2b3b0e5d7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/format.js\":\"04f092b426d0235b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/parse.js\":\"b12b338084a38dd2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/queryValue.js\":\"bee800070a9ab84d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/registrations.js\":\"621397cae2bc27f8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/source.js\":\"a0d642a3c0958bd9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/registry.js\":\"475529f4b2253137\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/rowGutter.js\":\"9ee448d15bebebe9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/rowVerbs.js\":\"ea96e00fd50ac483\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/schema.js\":\"bef56dd8d3cbdd06\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/sort.js\":\"0fc15a3771964534\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/theme-toggle/effect.js\":\"192fe261d55a6c39\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/theme-toggle/index.js\":\"2b8f589a5900985a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/theme-toggle/theme.js\":\"838f6b5d800880ee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/actions.js\":\"1b2090adaac84548\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/dataExtension.js\":\"bfdb650bebf92408\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/index.js\":\"6761d0c2788f762d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/schema.js\":\"7244cbf0ce87f0b7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1c26267234363d3f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/actions.js\":\"ddf5eb738ee3b6dc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/defaultItems.js\":\"8677ceb6ebbedf3d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/facet.js\":\"72728fab77039a72\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/holdRecognizer.js\":\"5db2ef3933943ca8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/index.js\":\"ebd4f4b364da8336\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/update-indicator/UpdateIndicator.js\":\"ab6e65c9f83a6cc5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/update-indicator/index.js\":\"784cfecf28835098\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/update-indicator/loadTimes.js\":\"6c81f2aa42c796b8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/VideoNotesRenderer.js\":\"0b598f00242d304c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/VideoPlayerRenderer.js\":\"503b683ea69866be\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/VideoTimeStamp.js\":\"a653c26181f65134\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/actions.js\":\"1029d8c0e28d4f05\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/index.js\":\"18daca4f88c06995\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/markdown.js\":\"8b21cc5686128f98\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/notes.js\":\"3632f7f1e26d1d33\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/registry.js\":\"c7cf7d7eb37e5472\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/remark-timestamps.js\":\"5dfca3f000d01195\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/view.js\":\"bebc45ab6b1f7891\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/LinkHints.js\":\"15df1d121b25e60d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/index.js\":\"bbb5a74d94730409\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/model.js\":\"08f3e44734564cfa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/settings.js\":\"2af18cb080e633a5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-normal-mode/actions.js\":\"dfc09142e9bc0511\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-normal-mode/index.js\":\"84a5b173559e58a1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-normal-mode/interactions.js\":\"3dd7c0c263d96a3b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/workspace-header/index.js\":\"b0790d22005781c3\",\"/knowledge-medium/pr-preview/pr-1913/src/registerServiceWorker.js\":\"9ce7bcadd3cc1e22\",\"/knowledge-medium/pr-preview/pr-1913/src/requestPersistentStorage.js\":\"1c4738f2038d7912\",\"/knowledge-medium/pr-preview/pr-1913/src/services/authRequestDeadline.js\":\"75af6498ff631296\",\"/knowledge-medium/pr-preview/pr-1913/src/services/authStorage.js\":\"02f3244150d7eba7\",\"/knowledge-medium/pr-preview/pr-1913/src/services/powersync.js\":\"52cb36fd04531207\",\"/knowledge-medium/pr-preview/pr-1913/src/services/supabase.js\":\"6065da5bc4abe6ee\",\"/knowledge-medium/pr-preview/pr-1913/src/services/uploadErrorClassifier.js\":\"6213f70ceebcee90\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/ActiveContexts.js\":\"9a93f0ca60dfd096\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/HotkeyReconciler.js\":\"8a631eb5b19d0eaf\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/WipeLocalDataDialog.js\":\"5911a13c6b801503\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/actionDispatch.js\":\"8387952da6122b2e\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/actionRefItems.js\":\"25f8d760563f421b\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/applyKeybindingOverrides.js\":\"460b3f1c47b6e3e6\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/blockActions.js\":\"5e5b98a530f57a89\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/blockMergeGesture.js\":\"c2391f9ee8522582\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/canonicalizeChord.js\":\"61d2e822f5c62c3b\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/defaultContexts.js\":\"39903a0e8efdee7a\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/defaultShortcuts.js\":\"58d97d1f761cbbf6\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/effectiveActions.js\":\"428c0c81fcb96bc4\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/gestureAction.js\":\"44c54f97d8adedd0\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/gestureBinding.js\":\"12eb1160818c11ec\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/holdRegistry.js\":\"854f2944e4dbbe3d\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/keybindingConflicts.js\":\"6fc239c580272803\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/keybindingOverrides.js\":\"b0b891c009d94232\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/pointerAction.js\":\"86dd91eafa06af71\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/resolve.js\":\"8be6eb012c631558\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/runAction.js\":\"b9a8faaaf25cf803\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/sequenceMatcher.js\":\"8d2c9b9b28feee17\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/types.js\":\"1bf8a75adc04970b\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/useActionContext.js\":\"af2184a3db96e305\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/useActionDiscovery.js\":\"0e25342539939497\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/utils.js\":\"64af7dac65606e78\",\"/knowledge-medium/pr-preview/pr-1913/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1913/src/sw/bootStore.js\":\"255d3241059ccb0f\",\"/knowledge-medium/pr-preview/pr-1913/src/sw/previewDatabases.js\":\"e6908c52712cd072\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/byteTransform.js\":\"d45fc11f5feefda9\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/attachmentCleaner.js\":\"eb2d82e53cecd4f1\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/attachmentParts.js\":\"58da57015b88042f\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/bundleParts.js\":\"47016bb7f8942d9f\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/bundleRecord.js\":\"99fa2a365dd3ff44\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/manifest.js\":\"0f621528c7339de5\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/takeBundle.js\":\"12fec1f539a6f13d\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/verifyBundle.js\":\"f929765150a199df\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/cleaningStage.js\":\"d1e8157953146c00\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/conversionKey.js\":\"2f0aee398468c7e8\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/conversionServer.js\":\"fe1f0d7e9c184de4\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/flip.js\":\"5868e6d3bc75e7f4\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/flipAttempts.js\":\"22d34f93c4518be7\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/pages.js\":\"4616126aee22a164\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/preflight.js\":\"534ccdc7336219d6\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/reseal.js\":\"43640962fb914cb1\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/runConversion.js\":\"236b362f69ff30f1\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/runLock.js\":\"28821bb878b4a046\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/sealing.js\":\"9ab6873b55cdb1a2\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/sealingStage.js\":\"1b6c76868edc54fb\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/stage.js\":\"c8cdb7a06c369b9f\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/verifyReseal.js\":\"d1b98240d239e1e6\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/aad.js\":\"3e91776fbeb15369\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/aead.js\":\"9a5c33b709b2a972\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/base32.js\":\"341d6b3f66813451\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/base64url.js\":\"dab445b1689ba073\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/binaryEnvelope.js\":\"e2e594cc18313259\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/byteAead.js\":\"8b30efeeef11e81b\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/canary.js\":\"d726e80ec6e7f7a3\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/contentHash.js\":\"7e72aea35ffa228f\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/contentKey.js\":\"cdaee3b7ebf476bb\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/derivedIdNamespace.js\":\"f88a127730057ead\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/envelope.js\":\"c3157c6348911b2d\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/hex.js\":\"1eee5325be6a5b56\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/sha256Hex.js\":\"4f6937de179664b2\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/workspaceKey.js\":\"abaa5cb7d7af6826\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/conversionState.js\":\"87bd40b9381546ff\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9f71fbe67ac3767f\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/pastedKey.js\":\"5081b418723d55ab\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"7552f967029d007c\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/upgradeWorkspacePin.js\":\"7b4cf6cc9af4afb6\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/keyStore.js\":\"459d682493ef681b\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/mintWorkspaceKey.js\":\"b67e66d1b5f758e1\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/modePin.js\":\"b0cc4a31dd42151d\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/openWorkspaceKeys.js\":\"4c95771578bfae89\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/resolveWorkspaceEntry.js\":\"5215bd78d345df41\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/resolver.js\":\"87866c44dea9f46c\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/workspaceAccess.js\":\"d2255efeb3d555a3\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/transform.js\":\"8b0223aa5435b75b\",\"/knowledge-medium/pr-preview/pr-1913/src/themeBootDefaults.js\":\"1cc7d6e041a13cdd\",\"/knowledge-medium/pr-preview/pr-1913/src/types.js\":\"60635160c5f9f397\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/ClientLocalSettings.js\":\"3b96fac2636bf311\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/abortableSleep.js\":\"1f97a9f9d3ab3f59\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/array.js\":\"652c2620a99c59e6\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/backlinkAutocomplete.js\":\"78f06e6aca3a3e2a\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/blockCrumbs.js\":\"3405d771784e8b81\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/blockrefAutocomplete.js\":\"c5b4676dc2b4385b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/cadencedIdleJob.js\":\"65f1178f566146fb\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/callbackSet.js\":\"aea7432b8b5492d4\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/clientId.js\":\"4027cf6360f6d90e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/codemirror.js\":\"5eecd990386f1d96\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/codemirrorCompletion.js\":\"b248537813bb6224\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/copy.js\":\"7c5d08bdbd415500\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dailyPage.js\":\"116e5c8033c65728\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dbForensics.js\":\"71f3404d3dc36eb5\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dbForensicsHooks.js\":\"b7fe0d1f2783927f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/deleteBlockThroughUi.js\":\"b813847c99aa0566\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dialogs.js\":\"c9e731b5dcefe35b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dom.js\":\"7013f6a2bb6c24f7\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/downloadBlob.js\":\"d484a3d39dec663e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/drawnWalk.js\":\"8f73e20eff373669\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/exportSqliteDb.js\":\"3ed7137e1dee6dd6\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/fileSystemAccess.js\":\"e9206a5eae33d290\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/flipSlide.js\":\"85dd5c7786461ef7\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/fnv1a.js\":\"f14d2faf1d14ba6b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/formatBytes.js\":\"9de6c541b0e96185\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/fuzzyRank.js\":\"cc8dc0da37ad393c\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/idbKeyedStore.js\":\"b358b899d30b4f10\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/idleCallbackPolyfill.js\":\"aec0666c6ddd2524\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/keyboardAwareScroll.js\":\"4a0ee40213ba3eba\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/keyboardViewport.js\":\"502ff57df3f0e76a\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/lastWorkspace.js\":\"c473f3f72a2fa710\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/layoutColumns.js\":\"f0fd533ad9b7e148\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/layoutSessionDom.js\":\"c9603ccd05ea47fe\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/layoutSessionId.js\":\"46b732016fc96859\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/linkClickGestures.js\":\"f8e37ad247154f1a\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/linkTargetAutocomplete.js\":\"6b5111e9d8918bea\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/localDbCorruption.js\":\"8d7cde237aadbc49\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/localDbRecovery.js\":\"678fd138483d606f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/markdownParser.js\":\"e603f486f94ae5c2\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/memoize.js\":\"f81b021a0aa593a5\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/nameFieldCommit.js\":\"a744edca09d87056\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/nameList.js\":\"ed4688eebbcae8de\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/navigation.js\":\"12b5ab9fdf7e38c1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/omnilinerNamespace.js\":\"7e731dc7c218b217\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/opfsPageScan.js\":\"db15600c4efa10f1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelClearance.js\":\"04b07eafecafb840\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelHistory.js\":\"b26401215d6e2d97\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelLanes.js\":\"52c74cff7d5daff3\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelLayoutProjection.js\":\"315d0a59ad5bf5a6\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelScrollAnchor.js\":\"ea07f5cd53d489e7\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelUrlFlags.js\":\"99dc1cf01f6e24a1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/platform.js\":\"a41f840bdd883d99\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/pluralize.js\":\"025690f97d50a7ae\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/propertyCreation.js\":\"4f880bd75ab0fd6f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/propertyNavigation.js\":\"0ea2fefadf3b6cb0\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/propertyValueContext.js\":\"ffbc7f859968c350\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/react.js\":\"3c6b31b99c8f4d44\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/relativeDate.js\":\"46e81a50955d0bf9\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/relativeTime.js\":\"e0b21523e3e9efeb\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/renderScope.js\":\"b7edfea3915cab8f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/resolvedThenable.js\":\"703ebc0ac33409cd\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/routing.js\":\"01904e0167686f8e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/safeMode.js\":\"3911236223bf04a6\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/scheduleIdle.js\":\"27b86634782bab77\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/screenWakeLock.js\":\"8b57077090ba37a1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/selection.js\":\"ed13dcacbe3f5598\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/softKeyboardGrab.js\":\"9f3636cad52627fd\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/startupTimeline.js\":\"90c4531a1052a6ee\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/state.js\":\"2afc0247964f185f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/string.js\":\"2dcf65d9a2e2c8dc\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/surfaceZoom.js\":\"d3fea7eb7029233f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/time.js\":\"c4b1e055705fa6f7\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/toast.js\":\"e1087079be103b37\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/toggleStore.js\":\"a709eabfaf6e4046\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/untilStopped.js\":\"baacca148d51e76b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/userActivity.js\":\"292c4ed7481a2571\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/viewTransition.js\":\"eb1f3f23996885c2\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/viewport.js\":\"7eb94fe471e08183\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/webLock.js\":\"a5366795adc9cfda\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/workspaceRecovery.js\":\"16c94c9bd4390ebf\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/workspaceSnapshotStore.js\":\"a3a75d81b1c29a28\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-compiler-runtime.js\":\"3b27b84a3ecaaa89\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-client.js\":\"502b6b7c964797a4\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-server-edge.js\":\"00c54a20305f4d51\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-server.js\":\"9ef12037ee9223ca\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-static-edge.js\":\"8c9a2731a7cdaefe\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-static.js\":\"bc5c00506bcd3e0c\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-test-utils.js\":\"bc78df0fbe0e2d56\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom.js\":\"8fbc73403207a864\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-jsx-runtime.js\":\"d85fecef3ba3098e\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react.js\":\"223f7638304e2b96\",\"/knowledge-medium/pr-preview/pr-1913/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1913/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1913/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
