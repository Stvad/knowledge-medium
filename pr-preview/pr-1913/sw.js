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
		buildId: "01aa0eeb53be-716fcae5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1913/\":\"bec34aae25067edb\",\"/knowledge-medium/pr-preview/pr-1913/index.html\":\"bec34aae25067edb\",\"/knowledge-medium/pr-preview/pr-1913/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1913/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1913/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1913/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1913/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1913/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1913/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1913/assets/FacadeVFS-Dq-uz9fK.js\":\"7df341564208245a\",\"/knowledge-medium/pr-preview/pr-1913/assets/OPFSCoopSyncVFS-zbQ6AX15.js\":\"d63ee71fa83be524\",\"/knowledge-medium/pr-preview/pr-1913/assets/OPFSWriteAheadVFS-DOEQMkYK.js\":\"0c835c0111fce6f2\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-CM2i-o0v.js\":\"d89495481ad60b3a\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1913/assets/wa-sqlite-async-G5Y8KuP5.js\":\"ad1c9e692c325ca1\",\"/knowledge-medium/pr-preview/pr-1913/assets/worker-DTLUgHff.js\":\"d4a632d77255de17\",\"/knowledge-medium/pr-preview/pr-1913/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1913/chunks/app-DLRoII3y.js\":\"7a2c396514348f08\",\"/knowledge-medium/pr-preview/pr-1913/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1913/index.js\":\"c117bf4da36acbca\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1913/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1913/assets/AccessHandlePoolVFS-CmHraNVh.js\":\"5d4b597bda3290ba\",\"/knowledge-medium/pr-preview/pr-1913/assets/IDBBatchAtomicVFS-DMLyxE9a.js\":\"f39dc455f8b009ce\",\"/knowledge-medium/pr-preview/pr-1913/assets/MemoryVFS-Bdytf1mF.js\":\"5f90ada5a1550366\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-DeUM8KdP.js\":\"15b3ae6565954c4e\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-async-DdyNPuJg.js\":\"865b1df783a12fea\",\"/knowledge-medium/pr-preview/pr-1913/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1913/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1913/chunks/AccessHandlePoolVFS-Cb0pttYD.js\":\"1f8cca5ce35c3da8\",\"/knowledge-medium/pr-preview/pr-1913/chunks/FacadeVFS-B0l3PDpz.js\":\"e3954e9fe09a3f69\",\"/knowledge-medium/pr-preview/pr-1913/chunks/IDBBatchAtomicVFS-D3PdiFYz.js\":\"8dd42631bbe9d79b\",\"/knowledge-medium/pr-preview/pr-1913/chunks/MemoryVFS-D1o_Mkov.js\":\"80c2344e294de6a8\",\"/knowledge-medium/pr-preview/pr-1913/chunks/OPFSCoopSyncVFS-BOtbc6V2.js\":\"2ba42f69b1ba5f78\",\"/knowledge-medium/pr-preview/pr-1913/chunks/OPFSWriteAheadVFS-RuL7Ys_N.js\":\"a6d7fc054503aaf4\",\"/knowledge-medium/pr-preview/pr-1913/chunks/Preview-Bat6Gx4o.js\":\"270ba7b6be25e81b\",\"/knowledge-medium/pr-preview/pr-1913/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1913/chunks/card-B47EqVmU.js\":\"7437c91ea63ea978\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1913/chunks/dist-DHNm5Pxz.js\":\"5df301a32668255f\",\"/knowledge-medium/pr-preview/pr-1913/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1913/chunks/mc-wa-sqlite-DhWyFnQv.js\":\"2963240dbeca53fb\",\"/knowledge-medium/pr-preview/pr-1913/chunks/mc-wa-sqlite-async-CEP3j4g2.js\":\"e73fb7260a789361\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-CLRF1wqB.js\":\"7453217d03423936\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-CuKm-WwU.js\":\"98b8986b796f4c66\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-D1S0GIz_.js\":\"1e6d960236bebe38\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-DGljFVKx.js\":\"68a5c7c128e7ffd2\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-DLOaKkXa.js\":\"6dc9518c674cfbbb\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-DWPrtB2c.js\":\"106157e5626e1e4b\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-DY6-F0Kx.js\":\"68e671392bd7bf00\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-dom-server-legacy.browser.production-DZwVjgDB.js\":\"a74a1ac041623529\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-dom-server.browser.production-B5gd-i-b.js\":\"0fd381ca7e2a76a7\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-dom-server.edge.production-CQjWj5B4.js\":\"61f633dd8fafed63\",\"/knowledge-medium/pr-preview/pr-1913/chunks/react-wESI_w_6.js\":\"c2ba5f849b962875\",\"/knowledge-medium/pr-preview/pr-1913/chunks/server.browser-B6g3X-In.js\":\"109063e1da26dbc6\",\"/knowledge-medium/pr-preview/pr-1913/chunks/textarea-BaZ4NtEf.js\":\"e3e11a805a075b1d\",\"/knowledge-medium/pr-preview/pr-1913/chunks/ui-BBYZz0X1.js\":\"f252e285f0669ade\",\"/knowledge-medium/pr-preview/pr-1913/chunks/wa-sqlite-DYfUVSVd.js\":\"a06802cde770a808\",\"/knowledge-medium/pr-preview/pr-1913/chunks/wa-sqlite-async-DJtfdoBK.js\":\"b51c8886f3bfb9ef\",\"/knowledge-medium/pr-preview/pr-1913/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1913/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1913/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1913/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1913/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1913/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1913/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1913/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1913/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1913/src/App.js\":\"f93f57e505e97c3d\",\"/knowledge-medium/pr-preview/pr-1913/src/appUpdate.js\":\"6aa8285e1c807680\",\"/knowledge-medium/pr-preview/pr-1913/src/appVersion.js\":\"20a49e4bc14465a1\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/initialLayout.js\":\"92149602133fd26f\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/openWorkspaceData.js\":\"15936082617be1d6\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/resolveWorkspace.js\":\"26e19164489846a0\",\"/knowledge-medium/pr-preview/pr-1913/src/bootstrap/workspaceBootstrap.js\":\"0f53db80a53bbf34\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockComponent.js\":\"c0e922c8ee87100e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockCrumbs.js\":\"8a2ff964c45fe345\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockEditor.js\":\"50b64c9f54d2ce00\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockLoadingPlaceholder.js\":\"472568eaa67f703a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockProperties.js\":\"da43750bd4a4c29a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/BlockSearchPicker.js\":\"74e9d18b55877d79\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ConfirmBulkDeleteDialog.js\":\"89a7b83bc3682a9c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/DividerHandle.js\":\"8276b8bbec8224c3\",\"/knowledge-medium/pr-preview/pr-1913/src/components/DraftEditor.js\":\"7677e14bd2562717\",\"/knowledge-medium/pr-preview/pr-1913/src/components/GutterPill.js\":\"877461569beaf50c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/Header.js\":\"445d6bdc84d07d2a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/LazyBlockComponent.js\":\"b207df29bfeb13c7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/Login.js\":\"46f48e9b3fac5857\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ZoomableSurface.js\":\"64459ebbe7ca92e5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/editModeKeepalive.js\":\"573b619cfcda7ae1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a9cfda063c5c63f0\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"f8258855f3d92679\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/RefPropertyEditor.js\":\"6b5eca4e8ef51a4c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/RefTargetTypePicker.js\":\"9a490be5d9706dde\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/SelectPropertyEditor.js\":\"b2a9546261d0eff5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/TypesPropertyEditor.js\":\"412e16313af4f40b\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/defaults.js\":\"8c48bbdf7a1a0454\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/kernelValuePresets.js\":\"3c070a598e351104\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/selectablePresets.js\":\"2da9769c97e7e1a9\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyEditors/typesPropertyUi.js\":\"067b70e53e43388c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/AddPropertyForm.js\":\"053168da743c0b3a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/PropertyPicker.js\":\"617939c56b80e7e5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/PropertyRow.js\":\"7e1bd1c37eaf74d7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/Rows.js\":\"77fa017c1ce0cbde\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/actions.js\":\"333295eb3b38f0e9\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/declarationOnly.js\":\"2918095399605333\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/layout.js\":\"8b772e021358a362\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/model.js\":\"422452efd6c22867\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/shapeUi.js\":\"aa08ba767e7358b5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/shapes.js\":\"c6292591a0de4767\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9586c6ff07a00195\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanel/visibility.js\":\"237e09e8519822bd\",\"/knowledge-medium/pr-preview/pr-1913/src/components/propertyPanelSections.js\":\"db7fd0bf5158f396\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/BlockEmbed.js\":\"772b81e693d55151\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/BlockLink.js\":\"b444256aa1bff0c0\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/BlockRef.js\":\"0cb5461b08d11ce5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/CompactReferenceLink.js\":\"d8b27b41a4a77501\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/ReferenceLink.js\":\"b4e0ba68b6da167f\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/cycleGuard.js\":\"98127c3597cdc870\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/cycleGuardContext.js\":\"9d1cc12fb6541402\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/linkInteraction.js\":\"521825494094cf21\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/referenceLayout.js\":\"6124049d3208d65a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/references/useBlockRefAncestors.js\":\"8c5e297698bbdee7\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockGutter.js\":\"418f52b837a0afd0\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockInfoDialog.js\":\"c0065266399f8de2\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockReadText.js\":\"6da9941a5fa28f3d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BlockTypeBlockRenderer.js\":\"c72ab771aa82fb50\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/BulletHoverCard.js\":\"156e910899dcec7b\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/CodeMirrorContentRenderer.js\":\"c4a612b9b0e4b962\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"916c74bf1e82f484\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/ColumnResizeHandles.js\":\"5dc84c7755fcf406\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"ef322ad4cad6c200\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/DefaultBlockRenderer.js\":\"5f90f733ca3e1271\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/LayoutRenderer.js\":\"106fa1516c358474\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/MarkdownContentRenderer.js\":\"5eeaee150ff6e15b\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/MissingDataRenderer.js\":\"ccab3b685c12d282\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/PanelRenderer.js\":\"59620306ddac98f9\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/PropertySchemaBlockRenderer.js\":\"4c635ae7338d3c1e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/TopLevelRenderer.js\":\"6d47a2218a9fb0d1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/blockGutterMode.js\":\"e484c4ab4788a9b5\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/blockTitleText.js\":\"b6e533ddbe62dc53\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/fieldCreationKeydown.js\":\"f339a0215b28cd7e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/renderer/layoutRootContext.js\":\"7f1f6ca6ccc4cecd\",\"/knowledge-medium/pr-preview/pr-1913/src/components/typeChip/TypeChip.js\":\"3f96c2588d78b312\",\"/knowledge-medium/pr-preview/pr-1913/src/components/typeChip/chipStyle.js\":\"36dfa0ba23738083\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/anchored-floating.js\":\"d1bbf88e3e18ab61\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/button.js\":\"5adf5b8813b7b69d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/card.js\":\"5065c239c9c900fd\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/checkbox.js\":\"6ce17d6d39e3c0ad\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/collapsible.js\":\"9a6633be66d51f8c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/command.js\":\"8636364939a77de8\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/context-menu.js\":\"7788212a29b45501\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/dialog.js\":\"ae58062f94fc0285\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/dropdown-menu.js\":\"83f9bee7d1dbd89c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/floating-listbox.js\":\"7755bcfc3ddcd6ae\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/index.js\":\"2d45f8b5987d5c7a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/input.js\":\"a2b405bb915c367d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/kbd.js\":\"0a48dca26067dff6\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/label.js\":\"35bed14da27014c1\",\"/knowledge-medium/pr-preview/pr-1913/src/components/ui/textarea.js\":\"f1229b9e52d78318\",\"/knowledge-medium/pr-preview/pr-1913/src/components/useEditModeYieldKeepalive.js\":\"99e547a713b5b98e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/BootFallback.js\":\"c675a94090e3bce6\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/FocusedRowLazyMount.js\":\"aa3639a0b5d08312\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/LazyViewportMount.js\":\"70966c872f3f5029\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/LocalDbCorruptionFallback.js\":\"ba070cc3e20a6edd\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/error.js\":\"5538757fa4d654e6\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/lazyMountRegistry.js\":\"161bbf3c2f56eb26\",\"/knowledge-medium/pr-preview/pr-1913/src/components/util/suspense.js\":\"4df257e3fe55196d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/CreateWorkspaceDialog.js\":\"70c03cc3f83adba4\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/PendingInvitations.js\":\"22b9c264daa1b0a3\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/SyncProgress.js\":\"25860f2c63263708\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/UnlockProgress.js\":\"9cb7619262f53d63\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceKeyGate.js\":\"24994c51236fb1ef\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceSettingsDialog.js\":\"00678cff00cb387d\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceSwitcher.js\":\"1d15d046f72449ea\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/WorkspaceSyncGate.js\":\"4ed790582221f184\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/ConversionFlow.js\":\"a532ecb63abade40\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/ConversionFlowHost.js\":\"7b1e5047dd5346eb\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/EncryptionSection.js\":\"4238b2af7b934359\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/attachmentPrompts.js\":\"70443b1cf88ffe48\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f5a5de198b822ab9\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/conversionFlowDeps.js\":\"acc708aa8db6404e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/conversionFlowStore.js\":\"ec2adb15fc1a3f4c\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/flowUi.js\":\"c9a89a811384e139\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/conversion/useConversionRun.js\":\"90f10759ad2d731e\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/keyUi.js\":\"06a3883985547f94\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/useCloseOnKeyLoss.js\":\"ea8031a16289eb32\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/useCloseOnServerE2ee.js\":\"6ce5972e601d2d5a\",\"/knowledge-medium/pr-preview/pr-1913/src/components/workspace/workspaceUnlocked.js\":\"42af9179a044e4d1\",\"/knowledge-medium/pr-preview/pr-1913/src/context/backgroundSubtree.js\":\"2e91d1e6e4da2535\",\"/knowledge-medium/pr-preview/pr-1913/src/context/block.js\":\"749752f1bbe36485\",\"/knowledge-medium/pr-preview/pr-1913/src/context/layoutWsContext.js\":\"487cd11f6583422e\",\"/knowledge-medium/pr-preview/pr-1913/src/context/propertyDisplay.js\":\"23fe76350b40f2f4\",\"/knowledge-medium/pr-preview/pr-1913/src/context/repo.js\":\"4a23141b1c1bbda6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/aliasClaim.js\":\"69695ebda2814b8a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/aliasSeatNamespace.js\":\"6fa9952cbbb3551a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/blockData.js\":\"8f30918c10cc32b5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/blockType.js\":\"ff1421afa5a6a137\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/changeScope.js\":\"e67226d8eceff5fd\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/codecs.js\":\"f86e9a9f4817d29e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/derivedData.js\":\"fbf24d7c95b87621\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/errors.js\":\"32fb43fdea77f9a2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/events.js\":\"c58cf35be6e5befc\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/handle.js\":\"d7f49e4fe2c95cf3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/index.js\":\"1dace5d686f97787\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/mutator.js\":\"60c2fe1010e361af\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/processor.js\":\"a18dd14e0f832373\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/propertySchema.js\":\"a55ea6b78afee372\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/query.js\":\"8b10cb93ba546915\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/sameTxProcessor.js\":\"aabb23a507a4c44d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/schema.js\":\"d7f49e4fe2c95cf3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/tx.js\":\"d7f49e4fe2c95cf3\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/typedBlockQuery.js\":\"c37de23fb34dd1cc\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/user.js\":\"d445b085f24c7d0e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/valuePresetCore.js\":\"d96b3b9d8d77357d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/api/valuePresets.js\":\"595957f0736add85\",\"/knowledge-medium/pr-preview/pr-1913/src/data/attachmentCleanerIOVerb.js\":\"cede0207e08ac923\",\"/knowledge-medium/pr-preview/pr-1913/src/data/block.js\":\"e71fb657753800f1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockCache.js\":\"e2642f42651653bb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockId.js\":\"c836e09383aa4d95\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockLiveness.js\":\"efde4b820690b4e4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockMerge.js\":\"16ae5df6ebfcd736\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockSchema.js\":\"bea2a777ec2752f9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockTypeLookup.js\":\"55fdaf9b88bb9c1b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/blockTypes.js\":\"13b7893d7bcb705b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/childrenView.js\":\"286219c6553670eb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/clientContext.js\":\"509ac6ed42f7f3c4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/dbFileSiblings.js\":\"fa369b7bb4385e44\",\"/knowledge-medium/pr-preview/pr-1913/src/data/definitionSeeds.js\":\"381a6b4670bba9f6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/derivedIds.js\":\"842d82915cead308\",\"/knowledge-medium/pr-preview/pr-1913/src/data/drawnSubtree.js\":\"c9b96339db967a83\",\"/knowledge-medium/pr-preview/pr-1913/src/data/facetBridge.js\":\"e69c1577524cd461\",\"/knowledge-medium/pr-preview/pr-1913/src/data/facets.js\":\"c2177c58b16ac85e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/globalState.js\":\"25792eced5020d77\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/aliasClaimRederiveProcessor.js\":\"bb6f8a9d304d262d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/ancestorBatch.js\":\"263d841c3ab6a6ca\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/blockTypeTypeifyProcessor.js\":\"e700768214a37649\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/clientSchema.js\":\"4fa883c6ca6cedd8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/commitPipeline.js\":\"c670f425a45c5a5f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/devAssertions.js\":\"d6187553f5917b76\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/firstSync.js\":\"dd3bb555753d6760\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/freshInitialLoad.js\":\"84f5b55749c4cc7b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/graphBackfillClaim.js\":\"425517d704b1b992\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/handleStore.js\":\"757100641276578f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/idleMarkerJobs.js\":\"1ae575eccbf156fb\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/initialDownload.js\":\"9e6796fa8e02d4c6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/initializeClientDatabase.js\":\"35f0506c7385e494\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/jsonCanonical.js\":\"13e5e43e54f89b81\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/kernelInvalidation.js\":\"faa162ea17598bf2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/kernelProcessors.js\":\"61270ddb64e2764a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/kernelQueries.js\":\"9a39fce510ea29ce\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/mergeTypeMembershipProcessor.js\":\"58f5f75aa738067b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/normalizeReferencesProcessor.js\":\"28904f7043bf8f3e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/poolInstrumentation.js\":\"c77abe930a1f5e02\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/processorRunner.js\":\"fd04e09cf3210c03\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyCellBackfill.js\":\"88081e99ce2b85dc\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyChildMint.js\":\"6c978d2de3d56627\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyChildrenProcessor.js\":\"9a85d06b51559660\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyDefinitionChangeProcessor.js\":\"32ab5c49c9353abe\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyDefinitionSynthesis.js\":\"7eae1339bad4737b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyKeyScan.js\":\"bcf602e872f8e887\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertySchemaResolution.js\":\"83a9a0f199a5b8b0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/propertyValueEdits.js\":\"776586ff5ea3dee2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/raiseProtocol.js\":\"a99cb585e80a023e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/readBatch.js\":\"1eab2b5ad9f91aa0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/refProjection.js\":\"90b114c93ea60bc4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/referenceTargetLookups.js\":\"03a39af8e50aea1b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/referenceTargetProcessor.js\":\"4effc53943b8566c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/replayMerge.js\":\"f7cf4648409372f0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/sqlBinds.js\":\"ac8aaf0c3be7dde1\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4ee0f582d16599be\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/arrivalProcessors.js\":\"b6bcb6e9701c5918\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/invalidate.js\":\"9a817c72f427d4f7\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/materialize.js\":\"e248f9582f89ec55\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/observer.js\":\"2926f10bbf03ab78\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/syncObserver/reconcile.js\":\"b3ce065fb60e4bc6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/timingMetrics.js\":\"e4cc08f3f0995b99\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/treeQueries.js\":\"261d3b6ee7881b4c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/txEngine.js\":\"279605d67d6a3eab\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/txSnapshots.js\":\"d38aee11c5dd5d1f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/typedBlockQuery.js\":\"50b3b5036bdfac74\",\"/knowledge-medium/pr-preview/pr-1913/src/data/internals/undoManager.js\":\"13d59bd48370e8dd\",\"/knowledge-medium/pr-preview/pr-1913/src/data/invalidation.js\":\"c8fd7b7048ae8f5d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/kernelDataExtension.js\":\"4f9d6eaaeabac4d9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/kernelPage.js\":\"5e1bf876510d57db\",\"/knowledge-medium/pr-preview/pr-1913/src/data/kernelValuePresetCores.js\":\"ab306d8a207a6a9e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localDbCorruptionSignal.js\":\"d84241de24954950\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localDbStorage.js\":\"ac03fa22325d076e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localDbVfs.js\":\"de0538874e0f3cc5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/localSchema.js\":\"d214bedaecfca8ee\",\"/knowledge-medium/pr-preview/pr-1913/src/data/maintenance.js\":\"6f3102bd6ee31577\",\"/knowledge-medium/pr-preview/pr-1913/src/data/mergeProperties.js\":\"e736cf66418f78e5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/metricsConsoleHook.js\":\"6331926e44cefb9a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/migrationsPage.js\":\"d2b2350a0ac5d160\",\"/knowledge-medium/pr-preview/pr-1913/src/data/mutators.js\":\"a07b0382e5f3f29e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/orderKey.js\":\"5aa924681edd31a2\",\"/knowledge-medium/pr-preview/pr-1913/src/data/orderKeyPlacement.js\":\"3261cdf66ce83ed4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/outlineSurface.js\":\"293f310b5be79896\",\"/knowledge-medium/pr-preview/pr-1913/src/data/pendingEditorContent.js\":\"b8de69944e68ce5e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/pendingUploadsSql.js\":\"de18de9a6c4a3928\",\"/knowledge-medium/pr-preview/pr-1913/src/data/pluginStateExtensions.js\":\"90c4e16d41793185\",\"/knowledge-medium/pr-preview/pr-1913/src/data/powerSyncLogger.js\":\"865b6e60a89bbb07\",\"/knowledge-medium/pr-preview/pr-1913/src/data/projectorRuntime.js\":\"6002f3ee9a1fcaed\",\"/knowledge-medium/pr-preview/pr-1913/src/data/properties.js\":\"01f6c30c555b82ee\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertiesPage.js\":\"9b131b5d2af7121c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyChildren.js\":\"ff4ee57a6c7e131f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDefinitionFanout.js\":\"b851211ed50c3128\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDefinitionMetadata.js\":\"1a628930002c5b42\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDefinitionRegistry.js\":\"59231a86f3e94524\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyDisplayMode.js\":\"660966b927eafa39\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertyRowCreation.js\":\"e997a5bb1a60b23f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertySchemaCreation.js\":\"8e68eacca906e5ba\",\"/knowledge-medium/pr-preview/pr-1913/src/data/propertySeeds.js\":\"0321b5812d10bd61\",\"/knowledge-medium/pr-preview/pr-1913/src/data/recentsPage.js\":\"770c55aff24dbf17\",\"/knowledge-medium/pr-preview/pr-1913/src/data/refTargetComparableProperty.js\":\"d29f548e94e954d6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/referenceBlock.js\":\"2204a277c2dd8f1a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/rejectedUploads.js\":\"03aada114b8b9256\",\"/knowledge-medium/pr-preview/pr-1913/src/data/releasePowerSyncConnection.js\":\"da4af305bfa65072\",\"/knowledge-medium/pr-preview/pr-1913/src/data/repo.js\":\"e2e841348c9e58a6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/repoProvider.js\":\"85f19e38435c4fea\",\"/knowledge-medium/pr-preview/pr-1913/src/data/rowProperty.js\":\"74e25042d317cfd0\",\"/knowledge-medium/pr-preview/pr-1913/src/data/searchFilter.js\":\"aed256966cd424ea\",\"/knowledge-medium/pr-preview/pr-1913/src/data/seedIdentityLedger.js\":\"17f9c5ab61dce004\",\"/knowledge-medium/pr-preview/pr-1913/src/data/stateBlocks.js\":\"07d0071a4e675611\",\"/knowledge-medium/pr-preview/pr-1913/src/data/structuralEditPolicy.js\":\"46b27b3a19a18375\",\"/knowledge-medium/pr-preview/pr-1913/src/data/structuralInsert.js\":\"5c81e35e6ed9d35c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/subtreeDelete.js\":\"cfa092264bd5b6d4\",\"/knowledge-medium/pr-preview/pr-1913/src/data/syncStreamLock.js\":\"d9f3716763d40016\",\"/knowledge-medium/pr-preview/pr-1913/src/data/syncedTableSqlRecognizer.js\":\"dc1ece9dca40e3af\",\"/knowledge-medium/pr-preview/pr-1913/src/data/syncedTableWriteGuard.js\":\"28c45cdbc8c1fc4d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/targets.js\":\"31aef48fa3e49085\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeColors.js\":\"306371753014d572\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeDefinitionMetadata.js\":\"7515ef34b0e2b20e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeDefinitionRegistry.js\":\"72ff3eabab461134\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeExtraction.js\":\"d20eb0f8a6340cc8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeInitialValues.js\":\"8f0151ed50d539d9\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typePropertyGroups.js\":\"c10d5c9e20d8966d\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeSeeds.js\":\"9202df0c77e98dc5\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typeTagger.js\":\"98d4c50c9e35bf80\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typedRecords.js\":\"6f2900bd8fecc834\",\"/knowledge-medium/pr-preview/pr-1913/src/data/typesPage.js\":\"dcd8549aa700549b\",\"/knowledge-medium/pr-preview/pr-1913/src/data/userPrefs.js\":\"89af9202204c6b56\",\"/knowledge-medium/pr-preview/pr-1913/src/data/userSchemasService.js\":\"f3861c7d8205b37a\",\"/knowledge-medium/pr-preview/pr-1913/src/data/userTypesService.js\":\"0ac762bd0c735628\",\"/knowledge-medium/pr-preview/pr-1913/src/data/valuePresetRegistry.js\":\"aee15d146bbb552f\",\"/knowledge-medium/pr-preview/pr-1913/src/data/visibleChildren.js\":\"a6a34a21e7e0a5c8\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceConversion.js\":\"30ebc0531e1513f7\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceFirstSync.js\":\"a00b174fdba2c6c6\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceIdNamespace.js\":\"5a0d246ab90ead0e\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaceSchema.js\":\"706bef55510a0422\",\"/knowledge-medium/pr-preview/pr-1913/src/data/workspaces.js\":\"6655f31f81a86c6c\",\"/knowledge-medium/pr-preview/pr-1913/src/data/writeAheadLog.js\":\"31a6c7c0bf1732a7\",\"/knowledge-medium/pr-preview/pr-1913/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/BlockPasteShellDecorator.js\":\"201903084887e10a\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/atTrigger.js\":\"a7bb8adf7283af23\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/autocomplete.js\":\"aeda59e8fb7ba38f\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/codeMirrorExtensions.js\":\"0e30e905a5001a4a\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/contentFlush.js\":\"89a92cab5d545a61\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/defaultInteractions.js\":\"80287b4cca54ae1f\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/editSettleSignal.js\":\"2d1e52282309f9b1\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/insertImage.js\":\"308caaf23b74cc63\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/referenceCompletionRange.js\":\"36fd70b72af2f3fa\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/referenceTargetTypes.js\":\"657e34a07e61a5ed\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/syntaxContext.js\":\"2311efd2519044b7\",\"/knowledge-medium/pr-preview/pr-1913/src/editor/triggerMatch.js\":\"23825a4214c9200b\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/AppRuntimeProvider.js\":\"bbf70c58bbdf67d7\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/BlockFocusShellDecorator.js\":\"65cf593c6f0e97fb\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/ExtensionRenderBoundary.js\":\"5e7b9e92ad90ab72\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/PanelContentRecovery.js\":\"dc45a398ea8c490a\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/apiCatalog.js\":\"535575a0e5c66968\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/approveExtensionHere.js\":\"86fa51a98da271b4\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/armedCutAppMount.js\":\"1f37e1531b170fff\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/batchableKeyedStore.js\":\"2b99c404a67fe1df\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/blockInteraction.js\":\"fec554c49099d371\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/blockSelectionAction.js\":\"5c71dfd9e14ea44f\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/compileExtensionModule.js\":\"58fc3e0ba96f472d\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/compiledModuleCache.js\":\"84e533763bb50bd9\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/continuousGestures.js\":\"6c083d2e2b80923f\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/core.js\":\"883cde71a6c052a1\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/defaultRenderers.js\":\"e460776cb11dbee8\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/definitionFanoutAppMount.js\":\"2d9bb30a9f5473f6\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/dialogAppMount.js\":\"4fc6a533a7d2e6b9\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/dynamicExtensionSeeds.js\":\"44cbf085dc4343c5\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/dynamicExtensions.js\":\"10f486f6a4e5cda4\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/exampleExtensions.js\":\"1cee9eb1e8e48f16\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionApprovalStatus.js\":\"301d4f85d8dbc2b2\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionLoadErrorToast.js\":\"62b219fef5f6edf8\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionLoadErrors.js\":\"d54f431be1b107db\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionLookup.js\":\"947b5044e293ebb9\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionToggles.js\":\"949ba97fc794b0c4\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/extensionUtilitiesCss.js\":\"04f2d64630969667\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/kernelPageDeletionGuard.js\":\"81792d4327d26501\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/liveRuntime.js\":\"14edd8aea0dca9ca\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/openExtensionsSettings.js\":\"74a9a6653d09e123\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/overridesCache.js\":\"3fa356551269ad2f\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/pluginIds.js\":\"8e682e748b687290\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/processorRejectionToast.js\":\"302126fc92e2e628\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/runtimeActions.js\":\"e747b2bb875050a2\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/runtimeContext.js\":\"b0982c775f7b050d\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/staticAppExtensions.js\":\"f8e8097757f11782\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/staticDataExtensions.js\":\"5376a1c36f81c3b4\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/toastAppMount.js\":\"724710b5646caaa3\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/useOverrides.js\":\"a6ad5d4b66b4e917\",\"/knowledge-medium/pr-preview/pr-1913/src/extensions/useShortcutSurfaceActivations.js\":\"7b77762f77332443\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/discoverToggleTree.js\":\"ca9b84d243cf9e17\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/facet.js\":\"cb705a459b33c524\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/resolveAppRuntime.js\":\"8d5202ae957dfd42\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/runtimeEvents.js\":\"3195ec6d25a8113e\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/togglable.js\":\"e3226adc2ef435c2\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/variantFacet.js\":\"66430b41027b47a3\",\"/knowledge-medium/pr-preview/pr-1913/src/facets/verbFacet.js\":\"b081bc2e4b0480ec\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/block.js\":\"fe1139b84c103dd0\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/focusedChild.js\":\"60ec478627e00e90\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/propertySchemas.js\":\"e3a1867cb71e8026\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/typeRegistry.js\":\"249364db54cb2520\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useAncestorCrumbs.js\":\"49e1d8fb8b3e727a\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useAutocompleteListbox.js\":\"e7083b5ff219e12a\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useDebouncedSearch.js\":\"a0c5eaf1231d5dbd\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useDebouncedValue.js\":\"6e8f5bc69e4ef2ea\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useFacetValue.js\":\"a9d9b3ad850734dd\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useIsFocalRender.js\":\"104c0a7bfe690e14\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useIsReadOnly.js\":\"94eb45d757fdfd52\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useMaterializeBacklog.js\":\"f449c671d6d4114d\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useMinuteClock.js\":\"693e7a757cdc441a\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/usePanelLayoutProjection.js\":\"67098a14bb66fe72\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/usePendingInvitations.js\":\"1d5c5e1044b387b8\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useRendererRegistry.js\":\"15037b7770027c12\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useRetainedFieldRows.js\":\"98fca52f4157be64\",\"/knowledge-medium/pr-preview/pr-1913/src/hooks/useWorkspaces.js\":\"fe3ca64e58dde96f\",\"/knowledge-medium/pr-preview/pr-1913/src/lib/utils.js\":\"3e1650d06e14ba5d\",\"/knowledge-medium/pr-preview/pr-1913/src/main.js\":\"cd2f7f50dc9eb8fb\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/MarkdownImage.js\":\"8f9e1a5cfaf56568\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/blockSeparators.js\":\"de6f3d9858905dfd\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/context.js\":\"99979b8b567d2abe\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/defaultMarkdownExtension.js\":\"6e5946979d5a5e73\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/extensions.js\":\"89faf48fb120f9c4\",\"/knowledge-medium/pr-preview/pr-1913/src/markdown/renderMarkdownHtml.js\":\"ac65cf19445c83ba\",\"/knowledge-medium/pr-preview/pr-1913/src/minimal-editor.js\":\"9bda9e9945a51081\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/armedCut.js\":\"7729c2cef32fa2df\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/captureMediaVerb.js\":\"a16e03ae83a422ee\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/clipboard.js\":\"c5967c40d4315177\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/decision.js\":\"e67246a550a0d710\",\"/knowledge-medium/pr-preview/pr-1913/src/paste/operations.js\":\"f0b53fc9c37ce371\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/account-header/AccountHeaderItem.js\":\"fa99c4be977bd3b5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/account-header/index.js\":\"9aa4c3c07a706975\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ef22e1c0ec347d9b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/askAgent.js\":\"21178b28f0c7521a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/askedStore.js\":\"b3704ddda7230480\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"85cec29fe062790c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/chipState.js\":\"34a60f8d0c90c216\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/dataExtension.js\":\"6627cea98adba65f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/index.js\":\"b37925759a4b3984\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"da74782a5983fba9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-dispatch-companion/schema.js\":\"7998a44b94720923\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b10ca4179d6117c2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/BridgePairingDialog.js\":\"c8fa3f1b25a8abdb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/addMedia.js\":\"1614765b301e4168\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a19cf7ffee6bab15\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/block.js\":\"0d194b300b0208ab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/context.js\":\"f41ef1876e3e8225\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b4b85866c696f9bb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/index.js\":\"e9afa6b46b448e61\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/outline.js\":\"66ccecf050645b00\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/properties.js\":\"1b3e13ef2eb8b6df\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/refs.js\":\"dbb8f1d3e2742836\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"37e095de5615a08f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/search.js\":\"5cf0c9494ea0103b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/shared.js\":\"a627fc05b78644f9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0bb879187b25ec0f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentViews/text.js\":\"d1b19af0e8c075b8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/agentWrites.js\":\"6a69fc16961633a2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/authoringCatalog.js\":\"c48ddf426919403b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/blockRefTargets.js\":\"5f72c0b0644d0e28\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/bridge.js\":\"10661f4d6bc7e6ea\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/bridgeLoop.js\":\"05993c835cf2883e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/changeHistory.js\":\"02787584b855275f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/commands.js\":\"07f87da6412eba20\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/commentsCommands.js\":\"a7f9073fa80df97c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/dataExtension.js\":\"5d878bf0b76355aa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/dataModelGuide.js\":\"2f42382225fa727d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/dayPropertyInputs.js\":\"12d9f5246946437f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/describeRuntime.js\":\"ded0c7bda3d3dc28\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/extensionLint.js\":\"5276a092f67c7bb4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/grainAudit.js\":\"ee4227600b725b84\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/healthCommand.js\":\"3dd368731a6f0d1e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/index.js\":\"247d61f9369f41d3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/presetIdentity.js\":\"578783b4bd341e51\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d3313f06ce702030\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/readMedia.js\":\"077e56cf3c9b5213\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/schema.js\":\"a8a6004a78c19403\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/serialization.js\":\"8e489afa8e5530aa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/targets.js\":\"949ee568c631042f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/tokens.js\":\"d219554577f86699\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/watchEvents.js\":\"c33656fc58a41a6a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/workspaceGuard.js\":\"b26d465edd245a2b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/agent-runtime/writeCommands.js\":\"3acb4538bbca436b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/AliasCollisionToast.js\":\"dc5d6839e815a400\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/DuplicateNameBanner.js\":\"b5bffaf8cbaae227\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/collisionMerge.js\":\"cdcbbdeeb8bfe568\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/dataExtension.js\":\"13883919994bb2c2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/index.js\":\"afcdbe40ecd9cde4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/mergeCollisionAction.js\":\"4781e6afd5066e12\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/pageStyling.js\":\"ed0c6e5c9d1a3877\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/rejectionToast.js\":\"fa0251e81d9dce09\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/alias/syncProcessor.js\":\"1c30243e5ef9d034\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/actions.js\":\"2f4740deeb2d15c1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/addComment.js\":\"2c7dd295d7d93a53\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/anchor.js\":\"5d0154e09628cf9a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/anchorState.js\":\"d0b386888a2f17f7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/commentLinks.js\":\"58487cc7d4d7240c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/confirmThreadDeletion.js\":\"a94e66dd8e8f8168\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/container.js\":\"3103b890ee13b47f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/dataExtension.js\":\"7126a5704bdfe29b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/deleteComment.js\":\"635882aaa9cdf46e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/highlights.js\":\"47de4f6f5edf734a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/index.js\":\"442e99288005e458\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/linkedCommentsPill.js\":\"82faa91872d37ca0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/margin.js\":\"c779fba66fd83227\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/marginAnchorLinks.js\":\"7a9efd9f72544ba1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/marginSchema.js\":\"587d0fe5aa395278\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/newComment.js\":\"1c4fd9458d0a58ff\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/ownThreadPicker.js\":\"cb1fa4b2707260d6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/placement.js\":\"ff24f4d993204c67\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/queries.js\":\"ba2f3faa78b82b17\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/quotePosition.js\":\"384ea93e9e7c971c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/quotedIn.js\":\"a88feb9d7f8cb554\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/quotedRange.js\":\"3a21dc8ad4416eae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/rangeRefs.js\":\"f4a6d10bb4e0a694\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/readHighlights.js\":\"4f573288c6efbad1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/readSelection.js\":\"8a6b44c7c1f2500d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/readSelectionUi.js\":\"3d9e0fb550ae46c9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/reanchor.js\":\"fccbf6a1de9946d1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/schema.js\":\"1ec9789fb2e6e102\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/scope.js\":\"3285d0f7c0615ab4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/scopeThreads.js\":\"8fefc5835394d780\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/splitRetarget.js\":\"fd46e479cdedd12e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/suggestionCard.js\":\"ca288e7cfb1d59b6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/suggestions.js\":\"157c1d01256ba3cf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/summaries.js\":\"1c11c9a9fe03b2d0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/summaryBatch.js\":\"af85dbef375f47c9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/surface.js\":\"4fa1078a60a20737\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/threadNavigation.js\":\"7d17591640b3094e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/threads.js\":\"10df7d0835007ade\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/ui.js\":\"f3a3afefe8f090fa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/annotations/uiStore.js\":\"03e79de11f7ee515\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-intents/appIntents.js\":\"1d04454b2ab6eda8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-intents/index.js\":\"61262a84431abaa1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-update-prompt/index.js\":\"19487768227f2bc9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/app-update-prompt/status.js\":\"513d04406699f4a6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"01f2e30f1418af13\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/MediaBlockRenderer.js\":\"741b585e45713e8b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bbacf9b4f9f90796\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/MediaUploadReconciler.js\":\"46799793c74f1a5c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/assetDownLane.js\":\"f9a0c889af1262f1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/assetResolver.js\":\"5a2e45b8473734a0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/assetUpload.js\":\"f2b155fbdd92df76\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/attachmentCleanerIO.js\":\"669780aa1ac4de76\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/supabaseAuditIO.js\":\"8a18a699fc2234ca\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/blobStore.js\":\"5f17b00186074a66\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/browserMedia.js\":\"ca5c7732a81aae45\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/byteStore.js\":\"9265a280d71dcde4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/cleanerIO.js\":\"bb44798afff3c6d5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/cleanupAttachments.js\":\"2e8ca00c0c7bc063\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/dataExtension.js\":\"c37d0319ce2d216e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/downLane.js\":\"0624c1c7391ac25d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/index.js\":\"62685f663cdaef89\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/insertImageContribution.js\":\"c57025b2a0dfb0f2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/laneArming.js\":\"6fce952bba367eb3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/laneLock.js\":\"c6e4576a662ff390\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaBlock.js\":\"d0b9675c0fb076cd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaCapture.js\":\"82c07b8eedc29156\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaLanes.js\":\"0ff26111a1e0be43\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaViewers.js\":\"6bad59146ac1048a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/mediaViewersFacet.js\":\"82ec86f968096069\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/pasteCapture.js\":\"0358b41d6bc05dee\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/resolver.js\":\"5f5e9ec6e23c4cb2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/retryUploadsAction.js\":\"79d3311163e85da1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/storagePaths.js\":\"071c1819f062c29c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadDrain.js\":\"1170b9da2ff34b33\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadLaneStatus.js\":\"8cdc87e238b3b1e2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadReconcile.js\":\"4a848109c17fea95\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadRecovery.js\":\"3cfd082a3512779b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/uploadStore.js\":\"276631f65f625577\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/attachments/useAssetObjectUrl.js\":\"6d8c0df27a980893\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"76acdad3361a25d1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/BacklinksViewSection.js\":\"dfe5cf22fee4b73f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/facet.js\":\"58a28710f94efa56\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/index.js\":\"ba4f11a9d2e2a00a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks-view/prop.js\":\"7d31551882b602db\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/BacklinkFilters.js\":\"751e4710cad89f10\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"3dd5ed86925f10e2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/BlockEntry.js\":\"f8579842b2ceba1c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/LinkedReferences.js\":\"217be0b55915a109\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"328aa9acd470cb7e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/dailyNoteDefaults.js\":\"f2aeb48fdaca51d8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/dataExtension.js\":\"2c43571700854416\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/edgeExclusions.js\":\"a9fe15a5a5250a09\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/filterProperty.js\":\"e6dc11a1a02a53cf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/index.js\":\"5f29ac13ea359c02\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c8cf7f3f83aeeb4b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/applies.js\":\"df0151a7d3d412c1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/countQuery.js\":\"b01983446cb52735\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/expansionStore.js\":\"550376713fb9791e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/index.js\":\"7e0469bda1c5f7c3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"94f0dd92ca601ce5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/presentationInvalidation.js\":\"596b013bb8ceca1a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/propertyEditorOverride.js\":\"b50cd215569ba9cd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/propertyFilter.js\":\"82b3b48df3ceda63\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/query.js\":\"f3e6538f362f16b4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/resolveFilter.js\":\"5e6409cf1c8c14a4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/sourceBatch.js\":\"16a1f8cb897f2e66\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/sources.js\":\"fe40bbf98410f0e8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/useBacklinks.js\":\"2b8c5b7bd5c87a11\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"dc31b48f433c95f0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/BirthdayCelebration.js\":\"30887d476491f402\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/BirthdayOverlay.js\":\"af182740868e84df\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/gate.js\":\"63fa918060cef8f9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/index.js\":\"007b17b4641e7b8d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/birthday/wolfTheme.js\":\"566add3dad1edd62\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/BlockDragLayer.js\":\"49803e4b58ac1a67\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/dragController.js\":\"01f833368ac48818\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/dropTarget.js\":\"dd7e73df5a8c5583\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/index.js\":\"18f70a00265604ba\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-drag/projection.js\":\"33d9b3a1333014f1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-info/BlockMetaCard.js\":\"9239e68932a26fc5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-info/index.js\":\"88bf2231368eaa9c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/AddTagDialog.js\":\"43cc6f4970f19c7d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0257a1a21910de32\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/TagNameIssueHint.js\":\"153746315e12c221\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/addTagAction.js\":\"8f1b90e37e2042d5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/appendTag.js\":\"ae9c08a41c8e67a1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/config.js\":\"aac108b97aeb12b9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/dataExtension.js\":\"f9432489f782b3c3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/index.js\":\"8505c485db2fc9b7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/block-tagging/propertyEditorOverride.js\":\"467322bd44bf4a15\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/BreadcrumbList.js\":\"52b35a9c9522a6ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"fd527139d297f765\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f97b362e9bc130b6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"413b4e510b3097de\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7c0ef2082d88ca3c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/index.js\":\"dddd70829d15e306\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6ef188651e6b643b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/CharacterCountItem.js\":\"024c89d07d273a65\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c47e3cc954aec8b6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/actions.js\":\"c73b52582b020af4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/blockType.js\":\"c3c50a1deca77294\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/charCount.js\":\"4d81a3e235e8efe9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/dataExtension.js\":\"29000148645d7f75\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/index.js\":\"66250e5152342ea8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/profiles.js\":\"45fffa9b378bb98f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/properties.js\":\"a6dbba3f8566bea0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/subtree.js\":\"55c2c9abe8849740\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/character-counter/textCounts.js\":\"30cdb5007dcb8db6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/colemak-keybindings/index.js\":\"5e4af4a50b586c5f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/CommandPalette.js\":\"effa0e13405eb675\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/HeaderItem.js\":\"57b19e089c5b292e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/context.js\":\"5f90c872e8bbb1f2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/index.js\":\"7f576a261386b486\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/selection.js\":\"6d9b366a09d42dd3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/toggleStore.js\":\"e7060309810e3d1b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/command-palette/useCommandPaletteActions.js\":\"3515c3dcc019ec8e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/ContributorBadges.js\":\"e45cd53e398e6ceb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/ProfilePicture.js\":\"5c99e5899fbe0b4d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/author.js\":\"33445572df6010aa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/codeMirrorExtensions.js\":\"ef6ce11becfa8eaa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/dataExtension.js\":\"e558ff215bb44e81\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/index.js\":\"c0c46ec13fe12478\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/mentionAutocomplete.js\":\"52a126f935b80cdf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/processor.js\":\"e1639b9a94d32e42\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/profiles.js\":\"d5989903efc28fb5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/queries.js\":\"3148b560c6819233\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/schema.js\":\"c90b84bdf764a0e7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/contributors/useCommentAuthor.js\":\"2910dffc8ae31ae4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"3dff3c43084c5609\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b0c9136598f3b219\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/index.js\":\"9d154db88114d1d7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"09ed7ee1b5ca801b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"91e5ac43f4619faf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/CalendarGrid.js\":\"5291cd61ae175ce8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DailyNotePicker.js\":\"0a8e19412398e5a3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e53638e42b411d40\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DateNavDecorator.js\":\"f9581cf14fe76b0e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DateScrubOverlay.js\":\"cf15d0839b156a81\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DayPropertyControl.js\":\"f04df125d7046738\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/DayValueReferenceControl.js\":\"156cbf06cc52391f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/HeaderItem.js\":\"0e2c663446d8834d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/ReschedulePicker.js\":\"ea6a95e2367596f7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/SpreadDatesDialog.js\":\"7d2bbab7eff8fb1a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/actions.js\":\"c49c10526f77acd0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/blockDateAdapter.js\":\"d6f1aa0cf3e87405\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/calendar.js\":\"201f93585d832590\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dailyNotes.js\":\"c100a293d152a23f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dataExtension.js\":\"889c40e987e2fd71\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubActions.js\":\"806d89a8bc3b3b16\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubGesture.js\":\"de8393653afc7071\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e9b71e40e7ac3955\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dateScrubRecognizer.js\":\"4ccb00739cd8caab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dayProperty.js\":\"a4e76fc7473bf5ba\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"d7044071f6a0d423\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/deletionGuard.js\":\"64232fb4ea66b2ef\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/dueQuery.js\":\"0271ec378be1bc39\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/index.js\":\"b06b4e5e1526e907\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/landing.js\":\"886892bffe8572ac\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/localSchema.js\":\"ef8ec03bfa868149\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/referenceDateAdapter.js\":\"5e7a30e8c5c012af\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/rescheduleAction.js\":\"1b24b0f5e117219b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/schema.js\":\"7f191584dc554523\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/spreadBlockDates.js\":\"9cf60ea9ec8a7500\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/spreadDatesAction.js\":\"fd0d6e3f6c7dbe4b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/today.js\":\"9f111936fe45a06d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"9f1327689bcca512\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3ec05e372938151e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/audit.js\":\"9778328f2be730fe\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/auditAction.js\":\"2a348f712e418f60\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/auditRanges.js\":\"8badee13570f4fcf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/diagnosticsSource.js\":\"0e580c4fad3b26cf\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/divergenceScan.js\":\"1ada810fa636e0ea\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/index.js\":\"55e0e049a671100d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/propertyChildrenChecks.js\":\"842ae9a1bcc3fb04\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/referencesMirror.js\":\"b58cc317d8ce9983\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/rowJson.js\":\"9330d5a472e89065\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/schedule.js\":\"0a8cbaecf3381594\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/data-integrity/store.js\":\"162a425ede4d2b72\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-maintenance/action.js\":\"5adb9094eda844a8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-maintenance/index.js\":\"776a159da36c7f50\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-maintenance/plugin.js\":\"28b2fc5e513c4214\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"e2609172938d14ab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/actions.js\":\"d36b493fc10de59b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/changeMarker.js\":\"90fccf9ef8adb762\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/diagnostics.js\":\"7f959c4bed55a547\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/fileSystemAccess.js\":\"26a29fd31bf678df\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/filenames.js\":\"7e53788c425c57b5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/index.js\":\"09133687a49c9502\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/mirror.js\":\"b3e6b9325d552370\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/runLock.js\":\"343fa00f962d2480\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/runtimeHealth.js\":\"d1184f777a146bad\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/schedule.js\":\"162b54c0d97f345d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/db-mirror/store.js\":\"1d77587bda2e1f1a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/default-themes/index.js\":\"2c49879732550d82\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/default-themes/themes.js\":\"cff17a5c84f35064\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/diagnostics/facet.js\":\"7db095c5fba6fea5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/diagnostics/useDiagnostics.js\":\"c5d150e7c76b148b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/dismissals.js\":\"27b37ea729a217b2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/index.js\":\"83f459934314ebfa\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/status.js\":\"203913acac29dee9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extension-prompts/store.js\":\"d4cc2db50fc3d39d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7661ecd008fca3fd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a15cc1ff26b53f67\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/actions.js\":\"34ab3bb599614265\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/config.js\":\"4d15aef58f5d2c5d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/dataExtension.js\":\"de4666c07b2e9914\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/effect.js\":\"9b765e8dda179775\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/index.js\":\"dff07abc7369f04b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/propertyEditorOverride.js\":\"668dadf4b1f29ba5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extensions-settings/useToggleTree.js\":\"338bd84dcd0925be\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/ExtractTypeDialog.js\":\"206c04a169e2116b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"3023e0ccf5f3466f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/PropertyShapePicker.js\":\"f36b9e0d9fd47e47\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/action.js\":\"23815077f9fae57f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/extract-type/index.js\":\"ecbe15093d1ed90e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/FindReplaceDialog.js\":\"4fc3d82371c62b76\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/HeaderItem.js\":\"9f70881074e3dc25\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/dataExtension.js\":\"2150b870bf887733\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/index.js\":\"d8a696285856850b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/search.js\":\"cd0233d0828ab786\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/toggleStore.js\":\"48d7ea08cf95b738\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/LocationPropertyEditor.js\":\"041a0f9fcecf530c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/MapView.js\":\"900ae47d375a11ed\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/blockTypes.js\":\"94f67f109037c694\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/codeMirrorExtensions.js\":\"29105167e59ec20a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/createOrFindPlace.js\":\"acf2a2de36eef2a8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/currentLocation.js\":\"f725b3a308fd734a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/dataExtension.js\":\"ce2b96b3d50c5b84\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/geoContentDecorator.js\":\"8197cca64676ead4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/googlePlacesClient.js\":\"f05bfe2f22a545af\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/index.js\":\"791d379abadee423\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/locationsPage.js\":\"b87caa36fa7eee28\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/mapViewport.js\":\"05307c5a8d2d226c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/pickCurrentLocation.js\":\"914ad0c12cad002c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/placeAutocomplete.js\":\"da719962e094609b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/placeNameCollision.js\":\"cdd8d4175e057cab\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/properties.js\":\"67ece39d4ad037b0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/propertyEditorOverrides.js\":\"3288c80362c631be\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/query.js\":\"11abed4e89d141ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/geo/usePlaceSearch.js\":\"434e592b0d4abd44\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"3823126322be6438\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ce025c21d7ae4302\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"52c2d9f574b9e7af\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/config.js\":\"c46b4f23f690d1bb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/dataExtension.js\":\"7a6e2c92d736d0c7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/facet.js\":\"f8bef157c11d1080\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/grouping.js\":\"1727a08c2bb645de\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/index.js\":\"fa3905d6237d55b4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b39646e7b83fc46d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/query.js\":\"f20aff945c41212f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/resolveConfig.js\":\"d427e9c4972015e8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d52c9e0305db4737\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"365c36d5c951b616\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/HtmlDocumentContent.js\":\"6be5cc8f89aa67db\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/HtmlFrame.js\":\"f607c18df471b669\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/actions.js\":\"855432521fa2d399\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/blockType.js\":\"8efd8c00d3836404\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/confirmRunScripts.js\":\"32d33716ce419054\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/dataExtension.js\":\"556822984a19d9fd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/frameAnnotations.js\":\"64b228e50fddec8b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/frameDocument.js\":\"894da38ba21369d1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/frameTheme.js\":\"593901deb885dab9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/index.js\":\"e3005e35ddeb9ffb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/scriptConsent.js\":\"2dee62ce9e153e35\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/sourceMap.js\":\"995634b4cd01e11c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/html-document/useDocumentScripts.js\":\"d09dd1202f6d5392\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/index.js\":\"637bfdf241bc3f16\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/record.js\":\"50ad6f601e99c373\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/recordStore.js\":\"1560f44c50c25944\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/responsiveness.js\":\"45bec1867cdfa243\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/schedule.js\":\"be586d0dff921763\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/interaction-metrics/sessionContext.js\":\"b111fc6a3c3baf07\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"787cd46feb19dae7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"50155a187d432997\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/actions.js\":\"fd9a67ff6bad24e4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/config.js\":\"5a1af8985769a6e3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/dataExtension.js\":\"305589c357243d77\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/effect.js\":\"67ec3a96cd71c944\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/index.js\":\"20615db3c5a088ae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/keyCapture.js\":\"c5b14a473d1635a6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/overrideStore.js\":\"6e59cf32f60c1b33\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5c23f13c3abece52\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/HeaderItem.js\":\"05c820259b4256b5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/LeftSidebar.js\":\"5f260a302fd7225a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/actions.js\":\"fc15bf8738d6dce6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/facet.js\":\"14692f509c822c5e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/index.js\":\"3509bfb2fb5b1176\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/shortcuts.js\":\"cd89e876c776f0cc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/left-sidebar/toggleStore.js\":\"014872c19ad06520\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/MergePicker.js\":\"bda80158dc61fb76\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/index.js\":\"2cc4949306e4e6e7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/mergeAction.js\":\"268119543552a1b9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/merge-blocks/strategy.js\":\"93089726ef71f7bd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/Button.js\":\"08753a42b66b667a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"0275ab2122005c5a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d330b7a7e5a0d996\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/facet.js\":\"e97d2bcabb4b300b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-bottom-nav/index.js\":\"aa892cb070c1a4fb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8f4db643481fe6e1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/actions.js\":\"30d83e712bc1257b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"59d0d714a3092ea6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/facet.js\":\"62c939dd537d1334\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/mobile-keyboard-toolbar/index.js\":\"6b9684e9deca3ec6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2df53eed951ed7e2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/blockSubtreeMembership.js\":\"501d982d1147f236\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/contextMenuItem.js\":\"9717ac4d279bddb4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/index.js\":\"4592236be97898e8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/moveAction.js\":\"5c4289ffc64bdb3e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/moveBlocks.js\":\"b83d98129c632f60\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/move-blocks/selectionAfterMove.js\":\"2fa67c919c27e381\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/TutorialBanner.js\":\"07316688c265cc42\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/action.js\":\"f8e3b8099a69eeda\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/bannerDismissal.js\":\"9065ed5d25810c0f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/documents/cheatSheet.js\":\"100d3d94e8c5e690\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/index.js\":\"e54ab08b43e3e1c6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/keys.js\":\"6a03355582e13475\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/landing.js\":\"e69f0460287214d9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/outline.js\":\"026cc2cc71907848\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/onboarding/seed.js\":\"f29980f19d967f8e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6fa51fcc17912621\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/analyze.js\":\"3da06107df865aa6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/diagnosticsSource.js\":\"f35056ed47642659\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/index.js\":\"ad3a538cfc80be36\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/load.js\":\"6ad608c544b35631\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/monitorRun.js\":\"ca4e0bd155f59a72\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/schedule.js\":\"0f2e33f5d1dad5ad\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/series.js\":\"8ff365884df7d935\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/store.js\":\"cd8eedb3a6540839\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/trendAction.js\":\"d9cd40c6a953a813\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/perf-monitor/verdict.js\":\"8e1555d45cf32024\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/plain-outliner/clickToEditAction.js\":\"fa81475fa16995b2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/plain-outliner/index.js\":\"3a24a0b4c7e18426\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/plain-outliner/interactions.js\":\"1230c948eef1fe1f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4444688df5a9a435\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/MigrationGate.js\":\"cc6225640368ddec\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/MigrationGateDialog.js\":\"a2de6caddf1ed398\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/action.js\":\"7afee364c57c84f0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/index.js\":\"97bb031ea62b706b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/localRunMessage.js\":\"15416896d3bedf05\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/plugin.js\":\"9c88fb20705b2136\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/progressReport.js\":\"aa4bb4daed11a70e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/properties-migration/sweepProgress.js\":\"e29e7b73f0fce752\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/FieldRowRenderer.js\":\"92d424667aec826d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/ValueRowRenderer.js\":\"447b13a6662ec02a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/actions.js\":\"40b00c4b21d1e82d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/autocomplete.js\":\"7762dd1c4b6022ff\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/fieldRow.js\":\"79da68976fefc206\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/index.js\":\"f42cb13b95826d93\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/referenceWarning.js\":\"c67a0f333d423a2b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/valueAutocomplete.js\":\"91434621c806bd73\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/property-rows/valueSchema.js\":\"67a91c73e87a4189\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/HeaderItem.js\":\"a3574080d10d3d4d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/QuickFind.js\":\"a92ce019fa87d1f6\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/index.js\":\"3d8cf3875230f569\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/recents.js\":\"7b3f381c5fd045ef\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/resultItems.js\":\"b482675424b70680\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/selection.js\":\"f21f0e5eae06b870\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/quick-find/toggleStore.js\":\"919d0c311fbf216d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/HeaderItem.js\":\"4d9e1acf41921e81\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4bcc170d3a4a870e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/grouping.js\":\"7950c6f1463486be\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/index.js\":\"d0b17a4868062dc7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/recents/target.js\":\"c76c8f7fe01d7bef\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/codeMirrorExtensions.js\":\"f62fe6c9219bcb1c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/contentPrefill.js\":\"7bee88430adad054\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/dataExtension.js\":\"cabb6dc37fac831f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/index.js\":\"2aa9c4d33b16fbcc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"18212952c55d926c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/invalidation.js\":\"2497832fc4507b49\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/localSchema.js\":\"6d29bcaaa862af95\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/blockrefs/index.js\":\"d0d84dce783e7101\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"02b7793390681a1d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/index.js\":\"38679f2151b1f4c5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/referenceNode.js\":\"9c5ec2ff27c55f0a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0a2536c257f5a446\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9449514d2afaccd9\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/index.js\":\"843df686903de41e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8cb1ac3ba96b84e4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"797eeb5cc048d3f4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/mergeRetargetProcessor.js\":\"6607a9a6495e7b40\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/parseFence.js\":\"bd4197e0b44dcfc1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/referenceParser.js\":\"f176a597a6e6d6f7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/referenceProjection.js\":\"5a51bf37a8c2b21c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/referencesProcessor.js\":\"16d21f119355982c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/renameProcessor.js\":\"f8c9b3e90845c73d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/references/spanReplacement.js\":\"a26cc2d0087e27dd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/htmlToOutline.js\":\"6d018b3c8215aef5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/index.js\":\"ca6eb94b3295990e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/normalizeClipboardDom.js\":\"245683b2f7c7cf71\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/rich-paste/pasteDecision.js\":\"3e6ea65efc28c676\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/action.js\":\"b8d394c0c5df0c99\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/blockIds.js\":\"640e4ccd0804b333\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/content.js\":\"248c87ad3d1cd70d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/effect.js\":\"62fd7891c0189410\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/ids.js\":\"a1241b29ccaddca3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/import.js\":\"3d7592cad59954e0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/index.js\":\"218e68cbef85af27\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/plan.js\":\"56e1f7813a565f05\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/plugin.js\":\"fcbff743ea41c847\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/promotion.js\":\"bd379fd624330676\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/properties.js\":\"605ac94d954efb0a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/references.js\":\"6b2d9d9075d0ff32\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/report.js\":\"d47af9c1780d66e7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/roamMemo.js\":\"855cf28f5f27b689\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/runtime.js\":\"43dec268cb239db2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/schemaReconciliation.js\":\"9ea6db4fa680e60d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/srsMarkers.js\":\"492849df06a171d4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/todo.js\":\"d616fe0a1b488269\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/typeCandidates.js\":\"1c9a4dcf11e41423\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/roam-import/types.js\":\"993f86f09a480d91\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/search-health/index.js\":\"3fab911dabad9e1d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/search-health/store.js\":\"30912250777f870b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/HeaderItem.js\":\"68723a1d65a903b4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"d75a8d49b0708b78\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/index.js\":\"7131e704f32d71ad\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/model.js\":\"07d3476e14eeccd2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/toggleStore.js\":\"4ed8b4453cfba37a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/shortcut-help/useKeyInspector.js\":\"a7a0f4858ed7b038\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"e483eac9e2ecc927\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/ShellDecorator.js\":\"c55ea419a5ae18d7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/actions.js\":\"cf754b6a8110b7cd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/exclusionsFacet.js\":\"212f1571094e90cb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/index.js\":\"6472abd5ed7130ed\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/shell.js\":\"b9d9d54d5f2b9ac7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/surface.js\":\"888c796d911d532e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/spatial-navigation/walker.js\":\"78496080299717a7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/RescheduleToast.js\":\"789a0aab4c440628\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/dataExtension.js\":\"c2eb5a6e2d053d5b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/index.js\":\"24e852d6b63f677a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/indicator.js\":\"2528970f14b46c9a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/moveSrsState.js\":\"f314f8ee1b49c1b5\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"488a1bf6fa997bae\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/scheduler.js\":\"d96dcdc9ff3a2fd0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/schema.js\":\"8b5d4371e06bacf4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2ec0511c981bdb26\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/srsClipboard.js\":\"d4a34493fa1b3b47\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"681cae2ac2569654\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/DailyNoteReviewHint.js\":\"bc76f02c745b1766\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/DeckPicker.js\":\"d29a7fe9e4441e8d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/ReviewControls.js\":\"97eed44bb694acfc\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/ReviewDeckRenderer.js\":\"da4c2c5316e1c48e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/ReviewSession.js\":\"7ea995273369ea61\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/actions.js\":\"d647b37554294b09\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/archive.js\":\"6189fc4d4e1d0f2e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/dataExtension.js\":\"844f7b54d367746e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/deck.js\":\"4d35de8d3d8f94c3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/dueQuery.js\":\"028018c0e89f9ff3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/gradeDecision.js\":\"ac28f6e5c9963ca4\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/index.js\":\"2108f67292251aa8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/keyHints.js\":\"0121a9afb4056e98\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/reviewCardLayout.js\":\"625e9e9c78e75003\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/reviewProgress.js\":\"156d105a5be23a59\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/schema.js\":\"25cb72e394348765\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/srs-review/useDueCards.js\":\"93a33a1d8badbbe3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/startup-metrics/index.js\":\"98c300adfcf42fed\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/startup-metrics/record.js\":\"ac0a4b4ed5153d4d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/storage-persistence/index.js\":\"4077c2058647a6bb\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/storage-persistence/persistenceStatus.js\":\"60488367cabd8c4d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/storage-persistence/requestAction.js\":\"73ac9717a8f49489\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/TypeChipsDecorator.js\":\"650cd6d6deb7e2d0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/codeMirrorExtensions.js\":\"ea44f0a415f2f30e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/index.js\":\"32adad9fc6b97ebe\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/supertags/typeAutocomplete.js\":\"d9370bceb5da4ec2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"7732db5d868d4b58\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/actions.js\":\"a813b5a2741dfa1c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/anchor.js\":\"ac6de46d477aa435\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/events.js\":\"70e3d42fc792003d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/gestureActions.js\":\"13400c8efaa9bd7b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/index.js\":\"8f6b4ef86dee9ad2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"07e7fce23dabbda0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/sync-metrics/collect.js\":\"6ad892901960c120\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/sync-metrics/index.js\":\"cc26b177ab46a546\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/sync-metrics/record.js\":\"33a9a27a8aa351b3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/RejectionDialog.js\":\"aa9a59147ef76957\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b7754e85c1cc204b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/index.js\":\"c16e4406a9133736\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/model.js\":\"2d95f44bf9598a99\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/queueCounts.js\":\"110f800a86177a74\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/rejectedHelpers.js\":\"a4419a219a1472e2\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/rematerializeAction.js\":\"be1f8d00408548b1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/system-status/useHysteresis.js\":\"ed2690e2a00279be\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/ColumnHeaders.js\":\"5f33dea378c11790\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/QueryUi.js\":\"f2d66e9c6d937c69\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/TableLayout.js\":\"bcb0672f90046df7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/actions.js\":\"82831eaa5de6050f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/cellEdits.js\":\"72cbe689a0657787\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/childrenViews.js\":\"477534ae8e01a004\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/columns.js\":\"5110faa0040d8214\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/controller.js\":\"9f15f2bad83a40be\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/convert.js\":\"bd2e8952fe5ce664\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/dataExtension.js\":\"3c9c99efa43cee08\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/index.js\":\"1e7136c5da558867\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/keys.js\":\"fb699c5475dd040b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/model.js\":\"e34dbd37dfafd6dd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/QueryText.js\":\"962138358b24290b\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/backfill.js\":\"3c240858e0d755c7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/completion.js\":\"6377347701acafd1\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/format.js\":\"721c87cac9219548\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/parse.js\":\"17a9e97e0848da51\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/queryValue.js\":\"adae89c4eb793d35\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/registrations.js\":\"f38e15683b237d04\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/query/source.js\":\"3e5b7570a6682f88\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/registry.js\":\"a7023778de5b32d8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/rowGutter.js\":\"755500ba0e8c6547\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/rowVerbs.js\":\"58c59fe3916ffa9c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/schema.js\":\"2e1cef50f3005f4d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/tables/sort.js\":\"3092e27edec31e24\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/theme-toggle/effect.js\":\"996e6829b4087086\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/theme-toggle/index.js\":\"03a5ea8209c04813\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/theme-toggle/theme.js\":\"cde84c3ecbb6119f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/actions.js\":\"032eecb065fb7f88\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/dataExtension.js\":\"0ab334eb76078966\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/index.js\":\"5755dca7fcac5fbd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/todo/schema.js\":\"228ca9ca3bfee2fd\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/TouchSelectionLayer.js\":\"263b0cf7ea65479c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/actions.js\":\"44b4273472630201\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/defaultItems.js\":\"76986783ec2d052e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/facet.js\":\"f5372d03f123ede8\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/holdRecognizer.js\":\"8e8e87ff1681532d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/touch-selection/index.js\":\"9523c5b9e9eafb9a\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/update-indicator/UpdateIndicator.js\":\"1934f5c3aa5bcdf7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/update-indicator/index.js\":\"440ad869e6fbee40\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/update-indicator/loadTimes.js\":\"b8ddc249cc59f435\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/VideoNotesRenderer.js\":\"f9e0df523ea2a274\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/VideoPlayerRenderer.js\":\"c1e40bbddc1a3d97\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/VideoTimeStamp.js\":\"cf2d56bd947013e3\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/actions.js\":\"9e6561c3b9b825b7\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/index.js\":\"b04405692362fb2e\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/markdown.js\":\"c5ba9731741068fe\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/notes.js\":\"a6784379ca897932\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/registry.js\":\"8ea5b3a6f2dc111d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/remark-timestamps.js\":\"053ae3ab998efe2c\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/video-player/view.js\":\"521f441ff954a028\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/LinkHints.js\":\"d15a9b3ef8cfb86f\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/index.js\":\"fc33eead500cd8c0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/model.js\":\"67904d3cf30e3a29\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-link-hints/settings.js\":\"f93b15fdfdff7927\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-normal-mode/actions.js\":\"3aa91d6fd7847066\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-normal-mode/index.js\":\"350c652d59e936a0\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/vim-normal-mode/interactions.js\":\"6f23f6e2499c676d\",\"/knowledge-medium/pr-preview/pr-1913/src/plugins/workspace-header/index.js\":\"93582ea9f32f0ca1\",\"/knowledge-medium/pr-preview/pr-1913/src/registerServiceWorker.js\":\"6c0d7cf630e4bf43\",\"/knowledge-medium/pr-preview/pr-1913/src/requestPersistentStorage.js\":\"d58e6b913cb525b6\",\"/knowledge-medium/pr-preview/pr-1913/src/services/authRequestDeadline.js\":\"428c0e8b76f06065\",\"/knowledge-medium/pr-preview/pr-1913/src/services/authStorage.js\":\"21ed3ecf05a5bc2a\",\"/knowledge-medium/pr-preview/pr-1913/src/services/powersync.js\":\"f1dcf3eca3b70ce0\",\"/knowledge-medium/pr-preview/pr-1913/src/services/supabase.js\":\"40c5aa2ddb87c851\",\"/knowledge-medium/pr-preview/pr-1913/src/services/uploadErrorClassifier.js\":\"5925862d26a30440\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/ActiveContexts.js\":\"e5febaad64f07570\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/HotkeyReconciler.js\":\"ff71a30dc3535c91\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/WipeLocalDataDialog.js\":\"6943ce491398a17d\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/actionDispatch.js\":\"279f9c568d4abcb5\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/actionRefItems.js\":\"dbde45aad764d7a0\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/applyKeybindingOverrides.js\":\"51a482915c4a5f60\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/blockActions.js\":\"6e0289c3ceb8485d\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/blockMergeGesture.js\":\"7a37235840e0e4ec\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/canonicalizeChord.js\":\"acb06141738700dc\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/defaultContexts.js\":\"0be66dd129273fd7\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/defaultShortcuts.js\":\"c44e46b4e5c0f6cf\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/effectiveActions.js\":\"3d3facb824f552d2\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/gestureAction.js\":\"da930afa909af9ab\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/gestureBinding.js\":\"5a9d4e954cfd792d\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/holdRegistry.js\":\"09d4f088d0a2f03f\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/keybindingConflicts.js\":\"b07f8a0075b47ccd\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/keybindingOverrides.js\":\"2a829617ae85d902\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/pointerAction.js\":\"c185349aa97365c6\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/resolve.js\":\"9f9f4f086dfb515b\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/runAction.js\":\"ad83dafb906adff8\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/sequenceMatcher.js\":\"c271f4238160d4f6\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/types.js\":\"7dff8af1ae85e159\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/useActionContext.js\":\"4b4bc38975943ca2\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/useActionDiscovery.js\":\"3dd7d753c595250e\",\"/knowledge-medium/pr-preview/pr-1913/src/shortcuts/utils.js\":\"421b750426a331d2\",\"/knowledge-medium/pr-preview/pr-1913/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1913/src/sw/bootStore.js\":\"a4a056a8ce33791e\",\"/knowledge-medium/pr-preview/pr-1913/src/sw/previewDatabases.js\":\"0c8dd435c8b21616\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/byteTransform.js\":\"dc8ffc6bf2c3ed6d\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/attachmentCleaner.js\":\"415d39250686f2d3\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/attachmentParts.js\":\"a2766148bf0fb403\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/bundleParts.js\":\"fb0b58d35b8faf54\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/bundleRecord.js\":\"a84e3e08190d0a37\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/manifest.js\":\"c6635315214eaa1f\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/takeBundle.js\":\"95815f83aa014465\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/bundle/verifyBundle.js\":\"f7814a8e5582bea0\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/cleaningStage.js\":\"42c3ee6565ddef61\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/conversionKey.js\":\"2255ccb23c738d91\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/conversionServer.js\":\"bb77d2bd6fa25755\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/flip.js\":\"d120c6abfcb670fc\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/flipAttempts.js\":\"6441c6aacc596df0\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/pages.js\":\"143d8ec30cb3f8c9\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/preflight.js\":\"466bc018356b3cca\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/reseal.js\":\"ff29eebcaf2aeb35\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/runConversion.js\":\"80e57a2257460d71\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/runLock.js\":\"aa345c6a2d7c98ed\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/sealing.js\":\"f2ddbe3bf869822f\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/sealingStage.js\":\"ac42bca46c2f7617\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/stage.js\":\"c4411cfb9485a55e\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/conversion/verifyReseal.js\":\"832e4091fbbd0c0e\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/aad.js\":\"f2db6d5e81c006f5\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/aead.js\":\"f83c1861f689fb66\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/base32.js\":\"8d5520938ccbda13\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/base64url.js\":\"f55dacba76e1f583\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/binaryEnvelope.js\":\"692b0e0c960a63da\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/byteAead.js\":\"8725c7f0f39caab3\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/canary.js\":\"3c9fe9d3983f0439\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/contentHash.js\":\"9b6fd67bafa9ec86\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/contentKey.js\":\"1b5c614c598eb342\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/derivedIdNamespace.js\":\"5dd49cc4e43c2d8c\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/envelope.js\":\"83b13aed4f1720be\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/hex.js\":\"49d6ef38c4aa9030\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/sha256Hex.js\":\"c468d71287b217df\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/crypto/workspaceKey.js\":\"1a45bc225bdd69da\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/conversionState.js\":\"20d5f7e6e91fbff2\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3699fe58ab773f3e\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/pastedKey.js\":\"7927f2fed9b79235\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4d8c2db97b8d771a\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/flows/upgradeWorkspacePin.js\":\"e3db0a9afc9c652d\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/keyStore.js\":\"e586fab1099cb723\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/mintWorkspaceKey.js\":\"bc8407ed6825da9f\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/modePin.js\":\"cf9575a8398d4aff\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/openWorkspaceKeys.js\":\"679f35df1dd3b5da\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/resolveWorkspaceEntry.js\":\"5dcd4f1cd7acd448\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/resolver.js\":\"8c9cc3b754e80488\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/keys/workspaceAccess.js\":\"7fea481aa618ba03\",\"/knowledge-medium/pr-preview/pr-1913/src/sync/transform.js\":\"2a96a5e02a95f806\",\"/knowledge-medium/pr-preview/pr-1913/src/themeBootDefaults.js\":\"a5d7622e28ddf449\",\"/knowledge-medium/pr-preview/pr-1913/src/types.js\":\"ca151bef0ef1c968\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/ClientLocalSettings.js\":\"065153c7c8f52770\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/abortableSleep.js\":\"c2daa4906db23ba5\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/array.js\":\"ed1f0c35663aadbe\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/backlinkAutocomplete.js\":\"33a021f84b781c4a\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/blockCrumbs.js\":\"7cf1c3fef1de54c1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/blockrefAutocomplete.js\":\"128b712095927cf3\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/cadencedIdleJob.js\":\"be6e559974906ae2\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/callbackSet.js\":\"2f56463b98ed3d66\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/clientId.js\":\"aa373a588e5faf32\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/codemirror.js\":\"89c7c441aa4440e7\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/codemirrorCompletion.js\":\"04c81070c87424f4\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/copy.js\":\"8b64aaa7016dd0f0\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dailyPage.js\":\"057620deff33a903\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dbForensics.js\":\"0b076ed54371c60f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dbForensicsHooks.js\":\"b5c73f44c6e8eb8c\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/deleteBlockThroughUi.js\":\"3eca1f151e24a1b1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dialogs.js\":\"e79efaed8b11f0c1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/dom.js\":\"4115afbaad37648c\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/downloadBlob.js\":\"56c581f9cc8c36c5\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/drawnWalk.js\":\"684848ca59b5b7d6\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/exportSqliteDb.js\":\"be5309444b054d62\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/fileSystemAccess.js\":\"350bc7d1b26ff2a3\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/flipSlide.js\":\"f0684417f31d0a0a\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/fnv1a.js\":\"431252e2e6e2a9f8\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/formatBytes.js\":\"f513abb3b32d0043\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/fuzzyRank.js\":\"8c96507e40e2115e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/idbKeyedStore.js\":\"01c98b0aca20f00e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/idleCallbackPolyfill.js\":\"52cc306bd9caed06\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/keyboardAwareScroll.js\":\"1f6e80aa2897d85f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/keyboardViewport.js\":\"49070c814a743419\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/lastWorkspace.js\":\"dda8ff162d87d1f5\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/layoutColumns.js\":\"5cbfccc2971f48b7\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/layoutSessionDom.js\":\"8b63a5f7b881e138\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/layoutSessionId.js\":\"a344eee208947183\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/linkClickGestures.js\":\"fc46cde3233d1d8d\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/linkTargetAutocomplete.js\":\"527ae3aa0160fb26\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/localDbCorruption.js\":\"d07e95ad3797c1d3\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/localDbRecovery.js\":\"649a3da2b03d7bee\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/markdownParser.js\":\"b24547f8eceef1b1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/memoize.js\":\"64ebd4dcfd2cf9fd\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/nameFieldCommit.js\":\"8da7d8f2096bb702\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/nameList.js\":\"7af91d7146d152d0\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/navigation.js\":\"45832767dc289490\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/omnilinerNamespace.js\":\"602540ce6d0c59ad\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/opfsPageScan.js\":\"38f1b439f2c94ede\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelClearance.js\":\"309b5cbfce105f02\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelHistory.js\":\"87bafb52564efd56\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelLanes.js\":\"548e4f126c2ad5c7\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelLayoutProjection.js\":\"81d2cd6ade9f1c77\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelScrollAnchor.js\":\"9ce4a55b9b108eff\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/panelUrlFlags.js\":\"960812f097ec94f9\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/platform.js\":\"c7c163b82b655136\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/pluralize.js\":\"3f16ea5e38b45df8\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/propertyCreation.js\":\"1f6e30764ab9cb46\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/propertyNavigation.js\":\"1e11e09bf0951ce3\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/propertyValueContext.js\":\"410645e060254b14\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/react.js\":\"04c6e6fbef0501d8\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/relativeDate.js\":\"157f6fccb8b521a1\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/relativeTime.js\":\"cad653639c280a49\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/renderScope.js\":\"b8e8cb0dd4417e3e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/resolvedThenable.js\":\"d1202e42a604289d\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/routing.js\":\"8e4915e0eeabf44f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/safeMode.js\":\"7e0745459cd4d9ce\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/scheduleIdle.js\":\"973a0e44d12b1c56\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/screenWakeLock.js\":\"7fe1b794eaf5d71e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/selection.js\":\"f0df2bf822a54d2f\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/softKeyboardGrab.js\":\"8be31a152d56cd0a\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/startupTimeline.js\":\"9a80d1603977539b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/state.js\":\"d2e8a4f2cefb3390\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/string.js\":\"4f63f04695f98283\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/surfaceZoom.js\":\"3e5c365e23e50c2e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/time.js\":\"a2b15b0567b06e32\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/toast.js\":\"d0e7a66b3ca9936b\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/toggleStore.js\":\"cfcce61c39043627\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/untilStopped.js\":\"b00943f2f3cebd2c\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/userActivity.js\":\"4ecf29d779f7971e\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/viewTransition.js\":\"5f61c4d623ee7f92\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/viewport.js\":\"3ee03aebe0c810b4\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/webLock.js\":\"cf88da91861354dc\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/workspaceRecovery.js\":\"3bb76b302b6741f7\",\"/knowledge-medium/pr-preview/pr-1913/src/utils/workspaceSnapshotStore.js\":\"0503868ba6d21259\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-compiler-runtime.js\":\"ed36c2d600c2f0c7\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-client.js\":\"f597050add0f2433\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-server-edge.js\":\"ad2ba546f2ae1d75\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-server.js\":\"59cd6e0741500ad7\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-static-edge.js\":\"d89d9b97bfe53ed8\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-static.js\":\"8dc40c2f82b27811\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom-test-utils.js\":\"c687e925fc2d79af\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-dom.js\":\"28cfe0116b692b4c\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react-jsx-runtime.js\":\"307a5ab01eb291a7\",\"/knowledge-medium/pr-preview/pr-1913/src/vendor/react.js\":\"52aa52342446d7a2\",\"/knowledge-medium/pr-preview/pr-1913/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1913/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1913/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
