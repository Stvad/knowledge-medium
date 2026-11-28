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
		buildId: "e7cfb798d56c-5a53b8df",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/\":\"0f41892f16686942\",\"/knowledge-medium/pr-preview/pr-1914/index.html\":\"0f41892f16686942\",\"/knowledge-medium/pr-preview/pr-1914/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1914/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1914/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1914/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1914/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1914/assets/FacadeVFS-DhTj-ED6.js\":\"4df7aa3bc35edc90\",\"/knowledge-medium/pr-preview/pr-1914/assets/OPFSCoopSyncVFS-Cd3XGD6g.js\":\"3b23c213acd82b2d\",\"/knowledge-medium/pr-preview/pr-1914/assets/OPFSWriteAheadVFS-DvWalbDy.js\":\"96caa91eb48d7a3e\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-CjyKgg_a.js\":\"56f6f832d9de1d37\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-async-3zaSseyk.js\":\"3d643d8a7b0f4cf9\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1914/assets/worker-NVD9C0Bs.js\":\"abea3b1c560b81a2\",\"/knowledge-medium/pr-preview/pr-1914/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1914/chunks/app-CtFBRNO9.js\":\"db1346f71f25ef68\",\"/knowledge-medium/pr-preview/pr-1914/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1914/index.js\":\"da251dd9ae7171b7\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1914/assets/AccessHandlePoolVFS-DxGzDC4K.js\":\"c8bfce4f50bfa012\",\"/knowledge-medium/pr-preview/pr-1914/assets/IDBBatchAtomicVFS-D0M47mwA.js\":\"4bcbe1a588588b0b\",\"/knowledge-medium/pr-preview/pr-1914/assets/MemoryVFS-Jebj8RPl.js\":\"52f390901ba9932d\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-DHk5QXgk.js\":\"dd071bf4ad932abf\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-async-BPG0drxK.js\":\"8e98161b29931b6f\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1914/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1914/chunks/AccessHandlePoolVFS-Ddm1uk2-.js\":\"5e31356cdf5cd5a8\",\"/knowledge-medium/pr-preview/pr-1914/chunks/FacadeVFS-ZnvD5W1t.js\":\"36c39e45de7ec92b\",\"/knowledge-medium/pr-preview/pr-1914/chunks/IDBBatchAtomicVFS-BeLApUgP.js\":\"0c1e3b024d755228\",\"/knowledge-medium/pr-preview/pr-1914/chunks/MemoryVFS-CJyVvLnN.js\":\"3c33d4c5337569ab\",\"/knowledge-medium/pr-preview/pr-1914/chunks/OPFSCoopSyncVFS-fzLlfJcz.js\":\"fdd43614d3f7b294\",\"/knowledge-medium/pr-preview/pr-1914/chunks/OPFSWriteAheadVFS-DT1yRcsg.js\":\"2305cf150ec5be32\",\"/knowledge-medium/pr-preview/pr-1914/chunks/Preview-DyMyISD3.js\":\"7c66026b758855e9\",\"/knowledge-medium/pr-preview/pr-1914/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1914/chunks/card-ctXE8oYh.js\":\"a55f58a8ce904390\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-Cx9zJ6SM.js\":\"e682751cda6b6900\",\"/knowledge-medium/pr-preview/pr-1914/chunks/freezeExtensionImports-D39Whb2B.js\":\"7ee194c73ab89cec\",\"/knowledge-medium/pr-preview/pr-1914/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1914/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1914/chunks/mc-wa-sqlite-DZSYCUdb.js\":\"38c336fd2aacefea\",\"/knowledge-medium/pr-preview/pr-1914/chunks/mc-wa-sqlite-async-CkerVRR-.js\":\"bef5b2bebef23cfc\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-BAkLFueO.js\":\"3ae768cf4a7e28e8\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-BSywkzIn.js\":\"94d243f8da4385bf\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-CbaZiW_q.js\":\"4644edf6def37e59\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-DNEM85mE.js\":\"c5c610fe75020c6a\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-DNbK47S8.js\":\"8a83ca67a217185d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-OmXfXvDS.js\":\"b2c38a8999d2990d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server-legacy.browser.production-LhzKDMAA.js\":\"e7132a2677dd6654\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server.browser.production-BGwwRHGI.js\":\"d9dc656d3cadbf0a\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server.edge.production-Cm9X8aQN.js\":\"c941ecd79ab78b06\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-wJZ6RJsc.js\":\"14fb5314b3541825\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-wJhCyFz-.js\":\"ca91b79d16fab898\",\"/knowledge-medium/pr-preview/pr-1914/chunks/server.browser-S1yc2WRy.js\":\"5ffdd26760daa3c0\",\"/knowledge-medium/pr-preview/pr-1914/chunks/textarea-Ci9ZKSHt.js\":\"7112bfc855bf269f\",\"/knowledge-medium/pr-preview/pr-1914/chunks/ui-dpoC2Afh.js\":\"d7bc606f71889ef8\",\"/knowledge-medium/pr-preview/pr-1914/chunks/wa-sqlite-4u-7N4da.js\":\"ab6082f24cba190f\",\"/knowledge-medium/pr-preview/pr-1914/chunks/wa-sqlite-async-SP4Qp5Qh.js\":\"f1beff2159621739\",\"/knowledge-medium/pr-preview/pr-1914/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1914/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1914/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1914/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1914/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1914/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1914/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1914/src/App.js\":\"e037d7c3e41f34ec\",\"/knowledge-medium/pr-preview/pr-1914/src/appUpdate.js\":\"07be9b1db4bc61a3\",\"/knowledge-medium/pr-preview/pr-1914/src/appVersion.js\":\"8865f9d55e75205c\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/initialLayout.js\":\"231f37164cb6c02b\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/openWorkspaceData.js\":\"8ecc111549e58b84\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/resolveWorkspace.js\":\"64f3ec15790791a3\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/workspaceBootstrap.js\":\"86950c0875ec1af1\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockComponent.js\":\"b9322e08d1a71407\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockCrumbs.js\":\"561fb81a8811f767\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockEditor.js\":\"07ebbf6bbc893c97\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockLoadingPlaceholder.js\":\"a6f9000c56988eae\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockProperties.js\":\"756e736e692030d4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockSearchPicker.js\":\"af3542a1576fd29b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ConfirmBulkDeleteDialog.js\":\"8ce00191ff4dcea7\",\"/knowledge-medium/pr-preview/pr-1914/src/components/DividerHandle.js\":\"bb3b761f8493a82a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/DraftEditor.js\":\"3c9733bb593e76d7\",\"/knowledge-medium/pr-preview/pr-1914/src/components/GutterPill.js\":\"e3a159f68b4eb5ef\",\"/knowledge-medium/pr-preview/pr-1914/src/components/Header.js\":\"364ab1dbb92ae6d7\",\"/knowledge-medium/pr-preview/pr-1914/src/components/LazyBlockComponent.js\":\"213b68ea24d0b3ca\",\"/knowledge-medium/pr-preview/pr-1914/src/components/Login.js\":\"fecd65f0f1740975\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ZoomableSurface.js\":\"7fa4c47448032a20\",\"/knowledge-medium/pr-preview/pr-1914/src/components/editModeKeepalive.js\":\"57c118a709fe7093\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyDisplay/PropertyDisplayScope.js\":\"670c382d35f3bdbe\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ffc0da449881d42b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/RefPropertyEditor.js\":\"071df31430ef5285\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/RefTargetTypePicker.js\":\"bfc80744867f9014\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/SelectPropertyEditor.js\":\"3c2dc078b281feb3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/TypesPropertyEditor.js\":\"2538bae6c8eccef6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/defaults.js\":\"f445249e409a8ac9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/kernelValuePresets.js\":\"db83ee4d90489093\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/selectablePresets.js\":\"966bc7b9f262443f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/typesPropertyUi.js\":\"b2463419d18061ed\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/AddPropertyForm.js\":\"911ae4fee220443b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/PropertyPicker.js\":\"77a95ef281df2c2d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/PropertyRow.js\":\"960c2a0a6243f1bb\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/Rows.js\":\"7da3e5e2fb5ca40c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/actions.js\":\"8546f1d43015a249\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/declarationOnly.js\":\"cdb352061b7729af\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/layout.js\":\"a1c3627bb9a796c5\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/model.js\":\"a50be322bd3607b0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/shapeUi.js\":\"b0088a0588924834\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/shapes.js\":\"cf6c51716db3f2f1\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/usePropertyEditingActivation.js\":\"3a19c8ab47b7bf60\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/visibility.js\":\"71e5380c363ba2a8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanelSections.js\":\"12f5bf6bfe20f325\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockEmbed.js\":\"086bf80fa07db6da\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockLink.js\":\"29a8902974404628\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockRef.js\":\"ce5b3e388071431b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/CompactReferenceLink.js\":\"86e337e941356371\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/ReferenceLink.js\":\"d98e6398bbef08d4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/cycleGuard.js\":\"2db221c9c867807f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/cycleGuardContext.js\":\"58cdfb5fd66640b4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/linkInteraction.js\":\"faac4908ff8b1572\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/referenceLayout.js\":\"a65b02b339dbfde1\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/useBlockRefAncestors.js\":\"1b7af4cd462d1788\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockGutter.js\":\"e6ff783c4cd5b7eb\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockInfoDialog.js\":\"5b58945af3d3b7fc\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockReadText.js\":\"5c168d45433d00c6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockTypeBlockRenderer.js\":\"8c2581aabe92f828\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BulletHoverCard.js\":\"75432f73f9ad9198\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/CodeMirrorContentRenderer.js\":\"bdb20e7715ca9fed\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1202541d3a50e870\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/ColumnResizeHandles.js\":\"65bca0c12f9c8293\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"878e5e1f927aa1e0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/DefaultBlockRenderer.js\":\"0910d8259e5c0ce8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/LayoutRenderer.js\":\"ee412d23e5cab511\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/MarkdownContentRenderer.js\":\"e8dcbc1cf96b6404\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/MissingDataRenderer.js\":\"10ea6c7176ef7fee\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/PanelRenderer.js\":\"11baa2ad240c1811\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ad0295b180a7fe6e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/TopLevelRenderer.js\":\"ccbcb56bde0a7d48\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/blockGutterMode.js\":\"744d64d38e9e1508\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/blockTitleText.js\":\"89a0beccc5aa82c1\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/fieldCreationKeydown.js\":\"a6fff4704635ec16\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/layoutRootContext.js\":\"193d4ab5754bdf70\",\"/knowledge-medium/pr-preview/pr-1914/src/components/typeChip/TypeChip.js\":\"88b08aba453e5120\",\"/knowledge-medium/pr-preview/pr-1914/src/components/typeChip/chipStyle.js\":\"09eb3ad2aa64c3fc\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/anchored-floating.js\":\"4cb44db43f27701b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/button.js\":\"bcce528ecee2da57\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/card.js\":\"e068915e57263431\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/checkbox.js\":\"13090a97f5734e4b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/collapsible.js\":\"8f0260f6f50b4430\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/command.js\":\"87f482f0214f4887\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/context-menu.js\":\"ac23092c645bb48a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/dialog.js\":\"d06dfef6a3d00a39\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/dropdown-menu.js\":\"80c49aff7af0786c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/floating-listbox.js\":\"7789135863db1a1e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/index.js\":\"4c7c4303b86a0d9b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/input.js\":\"1ad62f6417d305f0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/kbd.js\":\"d1fac9ec26ec825e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/label.js\":\"de47db5d42c70cf1\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/textarea.js\":\"edd056dd4cbe098e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/useEditModeYieldKeepalive.js\":\"af9ace8777666bf0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/BootFallback.js\":\"5dd048986210ed53\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/FocusedRowLazyMount.js\":\"cad3b1d1588e6ddc\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/LazyViewportMount.js\":\"438abbf79aacde93\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/LocalDbCorruptionFallback.js\":\"01c93f9fc0d6733c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/error.js\":\"36762555ea2ce11c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/lazyMountRegistry.js\":\"8970ad01e49e9cba\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/suspense.js\":\"d4e6f0bc2278754d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/CreateWorkspaceDialog.js\":\"4eb34fbecd5d2133\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/PendingInvitations.js\":\"6587cf64199bbb70\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/SyncProgress.js\":\"a7b2d7f2ee68f41c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/UnlockProgress.js\":\"4cabb535ff210f50\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceKeyGate.js\":\"39f7c968be9f858a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSettingsDialog.js\":\"0b133525e316a283\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSwitcher.js\":\"20dcb92cf9e0d174\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSyncGate.js\":\"32f35afa6e7220af\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/ConversionFlow.js\":\"6f6d2871b429176a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/ConversionFlowHost.js\":\"56883384d3a735eb\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/EncryptionSection.js\":\"53a9b3009fd956ac\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/attachmentPrompts.js\":\"482445568101b3c3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ec806651476981e6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/conversionFlowDeps.js\":\"d868f8d3b3e7479e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/conversionFlowStore.js\":\"895538dc78a0add6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/flowUi.js\":\"1b5aab051f468d27\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/useConversionRun.js\":\"877314a16a3c86fb\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/keyUi.js\":\"e142e2045882dbc0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/useCloseOnKeyLoss.js\":\"fc56c23bc9c756c9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/useCloseOnServerE2ee.js\":\"6061ad9193104b6c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/workspaceUnlocked.js\":\"b4b7395598c4eab9\",\"/knowledge-medium/pr-preview/pr-1914/src/context/backgroundSubtree.js\":\"3ca3b454f38885de\",\"/knowledge-medium/pr-preview/pr-1914/src/context/block.js\":\"8f01bf8c23f1d6b5\",\"/knowledge-medium/pr-preview/pr-1914/src/context/layoutWsContext.js\":\"c4197ab7f49525e1\",\"/knowledge-medium/pr-preview/pr-1914/src/context/propertyDisplay.js\":\"fef6b14da5dbf9d6\",\"/knowledge-medium/pr-preview/pr-1914/src/context/repo.js\":\"7693721b30e41da7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/aliasClaim.js\":\"5b2cc4b8518e2278\",\"/knowledge-medium/pr-preview/pr-1914/src/data/aliasSeatNamespace.js\":\"0dd0ebbd3124a1cc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/blockData.js\":\"5036c1f6d19678ae\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/blockType.js\":\"ac4e7ccd8a18f977\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/changeScope.js\":\"a62f7950bd92f3d3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/codecs.js\":\"a4f1165b47b21dd8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/derivedData.js\":\"d69c933eca0d5fb5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/errors.js\":\"3b4012abe593e86e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/events.js\":\"8c4eaf6f9910fa7b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/handle.js\":\"43f555fbcced405f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/index.js\":\"276867d479f63959\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/mutator.js\":\"e2c46096e3ce0e9b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/processor.js\":\"30e01842dc036c5e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/propertySchema.js\":\"55b98edc466079bc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/query.js\":\"3fb12565eb166772\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/sameTxProcessor.js\":\"ef47d9b64e77fc0c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/schema.js\":\"43f555fbcced405f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/tx.js\":\"43f555fbcced405f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/typedBlockQuery.js\":\"d3b4f94fb01cfa1d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/user.js\":\"e98f8626cd33d843\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/valuePresetCore.js\":\"17303f3123285e2e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/valuePresets.js\":\"f9be9d564ef3b732\",\"/knowledge-medium/pr-preview/pr-1914/src/data/attachmentCleanerIOVerb.js\":\"d72152385585d247\",\"/knowledge-medium/pr-preview/pr-1914/src/data/block.js\":\"ef9da9395fb403c8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockCache.js\":\"b917ded0fb9f048b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockId.js\":\"4aae2dc2a707770c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockLiveness.js\":\"71eaf2d09037f6e3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockMerge.js\":\"cd95beae27816a62\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockSchema.js\":\"042ca8df6ce3e2db\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockTypeLookup.js\":\"9e43d4d0556ac87e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockTypes.js\":\"9c7349a6508a11b7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/childrenView.js\":\"e379e0de01d2b8aa\",\"/knowledge-medium/pr-preview/pr-1914/src/data/clientContext.js\":\"624e6502a5e08998\",\"/knowledge-medium/pr-preview/pr-1914/src/data/dbFileSiblings.js\":\"0b65f8c145837bed\",\"/knowledge-medium/pr-preview/pr-1914/src/data/definitionSeeds.js\":\"65b7013cbf12b2c6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/derivedIds.js\":\"f8ed3694073b106b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/drawnSubtree.js\":\"a00c3e776932a1aa\",\"/knowledge-medium/pr-preview/pr-1914/src/data/facetBridge.js\":\"b5e2df491a4cea59\",\"/knowledge-medium/pr-preview/pr-1914/src/data/facets.js\":\"c5f93f6538ca82d3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/globalState.js\":\"8d36d8b56c0e80e9\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/aliasClaimRederiveProcessor.js\":\"0e5e9f394893ccac\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/ancestorBatch.js\":\"64ae988bfc4a8235\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/blockTypeTypeifyProcessor.js\":\"79c8fec3dd20bffb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/clientSchema.js\":\"8cf76f496520b15f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/commitPipeline.js\":\"15d44d7dd3cbce56\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/devAssertions.js\":\"4362601e93dbc1bc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/firstSync.js\":\"6019535395d06586\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/freshInitialLoad.js\":\"fa81a10f6d23ca3e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/graphBackfillClaim.js\":\"723ff9f54e521202\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/handleStore.js\":\"4b7b435cf77b178b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/idleMarkerJobs.js\":\"62003017456160c7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/initialDownload.js\":\"b1c1cf36a635e60f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/initializeClientDatabase.js\":\"06d2802eff0ff3ea\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/jsonCanonical.js\":\"7130b272cd20e959\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelInvalidation.js\":\"43d37585c516cb78\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelProcessors.js\":\"0ab55c7d05843ac2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelQueries.js\":\"0ba678620d3f1b79\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/mergeTypeMembershipProcessor.js\":\"fc8ca0af78853935\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/normalizeReferencesProcessor.js\":\"94fa9df700dc1c0a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/poolInstrumentation.js\":\"19708b1144c9fb6a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/processorRunner.js\":\"6b5726d28d57d7cf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyCellBackfill.js\":\"6c08938203fc1874\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyChildMint.js\":\"279e16beb09b6520\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyChildrenProcessor.js\":\"a9ab0e6623c8e18c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a350d6402914afeb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyDefinitionSynthesis.js\":\"293ac9cad826f670\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyKeyScan.js\":\"7744450596d11cf2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertySchemaResolution.js\":\"aef5f7cb2a6eb958\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyValueEdits.js\":\"e0a5d6f632969a69\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/raiseProtocol.js\":\"e786fccddd741a69\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/readBatch.js\":\"ed9869689c2982c3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/refProjection.js\":\"cced6dea69e93214\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/referenceTargetLookups.js\":\"2a4cf0c6dbd2a1fb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/referenceTargetProcessor.js\":\"849d4e6e2af0b763\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/replayMerge.js\":\"7e1b842ebe44f88a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/sqlBinds.js\":\"b557782229ace394\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"8256a8529e1a1632\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/arrivalProcessors.js\":\"c7f6f18961f162df\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/invalidate.js\":\"385adae7ce3b23f7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/materialize.js\":\"2fabbf88c13d4302\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/observer.js\":\"8063eb65653497f5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/reconcile.js\":\"9a8568eedfd0befa\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/timingMetrics.js\":\"a28c63a6b6f21285\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/treeQueries.js\":\"664c56f5b075c30b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/txEngine.js\":\"01b9cb091184d38e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/txSnapshots.js\":\"111f90f790a9a123\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/typedBlockQuery.js\":\"0ca46177907f2802\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/undoManager.js\":\"8a952a31a97e92d6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/invalidation.js\":\"31d1b63f97fe93bb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelDataExtension.js\":\"267cbb4a7a45034a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelPage.js\":\"bbe83be8ea19c133\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelValuePresetCores.js\":\"7e39f89eaaad46c7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbCorruptionSignal.js\":\"61c1cc72e3483050\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbStorage.js\":\"dbbf2376cbabfbb0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbVfs.js\":\"56cd36b17ec52617\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localSchema.js\":\"14ef2c9893e451f5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/maintenance.js\":\"0d42de0c0ecea2ab\",\"/knowledge-medium/pr-preview/pr-1914/src/data/mergeProperties.js\":\"27ed360bff743dee\",\"/knowledge-medium/pr-preview/pr-1914/src/data/metricsConsoleHook.js\":\"6759a5cabe8bd18a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/migrationsPage.js\":\"71f8ae05521d4bc0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/mutators.js\":\"527c8ccf7259b31b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/orderKey.js\":\"d3e4d7ec81a30a64\",\"/knowledge-medium/pr-preview/pr-1914/src/data/orderKeyPlacement.js\":\"2b686884c6f01ea8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/outlineSurface.js\":\"7088dc58426fb970\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pendingEditorContent.js\":\"5b63f75f3987931e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pendingUploadsSql.js\":\"e28d8c14e2eae557\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pluginStateExtensions.js\":\"4fd61955c7f7da54\",\"/knowledge-medium/pr-preview/pr-1914/src/data/powerSyncLogger.js\":\"c1b84b0525d7cce0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/projectorRuntime.js\":\"b7353f0fcf76decf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/properties.js\":\"52a55fdbbf76c113\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertiesPage.js\":\"c1edf626b44a271c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyChildren.js\":\"6c86af246615fe87\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionFanout.js\":\"33cb5efe4a4882d4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionMetadata.js\":\"61ba7b24ddcec489\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionRegistry.js\":\"ec90ec39aeb787f8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDisplayMode.js\":\"0555dd768cbc3512\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyRowCreation.js\":\"1f746ab5155a8743\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertySchemaCreation.js\":\"d2ba18ec121c0abb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertySeeds.js\":\"229039b53aecc758\",\"/knowledge-medium/pr-preview/pr-1914/src/data/recentsPage.js\":\"f6bdef58b19575f0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/refTargetComparableProperty.js\":\"08634feb6ed594b0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/referenceBlock.js\":\"0825a156b4da9da4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/rejectedUploads.js\":\"fc33b24fabfc832a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/releasePowerSyncConnection.js\":\"51c456fb70852041\",\"/knowledge-medium/pr-preview/pr-1914/src/data/repo.js\":\"32041b758e89d12c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/repoProvider.js\":\"ec807d179c7dcc0a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/rowProperty.js\":\"cc4c023945efedaa\",\"/knowledge-medium/pr-preview/pr-1914/src/data/searchFilter.js\":\"58297727a10ee665\",\"/knowledge-medium/pr-preview/pr-1914/src/data/seedIdentityLedger.js\":\"ed701a4a47fbd211\",\"/knowledge-medium/pr-preview/pr-1914/src/data/stateBlocks.js\":\"0c6e532addb100e7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/structuralEditPolicy.js\":\"05d96a3f1043e3b1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/structuralInsert.js\":\"5a1408563aa30f23\",\"/knowledge-medium/pr-preview/pr-1914/src/data/subtreeDelete.js\":\"6b3d44ff8e31fa50\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncStreamLock.js\":\"ed2d35205587af02\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncedTableSqlRecognizer.js\":\"fa0e2bc7069b1cc4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncedTableWriteGuard.js\":\"430d0f734ca593d9\",\"/knowledge-medium/pr-preview/pr-1914/src/data/targets.js\":\"7790becd4ce48093\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeColors.js\":\"87ec71e21df428fd\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeDefinitionMetadata.js\":\"800ab67d44b169ae\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeDefinitionRegistry.js\":\"7c6a4088963dc953\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeExtraction.js\":\"67690ecf196f5d13\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeInitialValues.js\":\"dd516d3e24b57a75\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typePropertyGroups.js\":\"fa1952e27ef25c0c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeSeeds.js\":\"86554ac7810f4310\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeTagger.js\":\"a073ec7daaefb6fe\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typedRecords.js\":\"3efc41bc862673e6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typesPage.js\":\"09ce7310569ae11e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userPrefs.js\":\"ed5dbc5554398232\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userSchemasService.js\":\"80b22beec7cc336e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userTypesService.js\":\"b6cc7c0040bf42e9\",\"/knowledge-medium/pr-preview/pr-1914/src/data/valuePresetRegistry.js\":\"6a828f9bbd8b2622\",\"/knowledge-medium/pr-preview/pr-1914/src/data/visibleChildren.js\":\"78b763c6677891bf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceConversion.js\":\"f704e2147f108a88\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceFirstSync.js\":\"9e9db682138dab55\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceIdNamespace.js\":\"983b7e652be09657\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceSchema.js\":\"b29ce9bfa54e865e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaces.js\":\"964a4dc712b912a9\",\"/knowledge-medium/pr-preview/pr-1914/src/data/writeAheadLog.js\":\"ac58835d240db522\",\"/knowledge-medium/pr-preview/pr-1914/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/BlockPasteShellDecorator.js\":\"0947dd1200cb341c\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/atTrigger.js\":\"f08cdb46e23e23fd\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/autocomplete.js\":\"ac60b031211faea6\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/codeMirrorExtensions.js\":\"8066a337078be032\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/contentFlush.js\":\"5356fcb2784ef44d\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/defaultInteractions.js\":\"8dcaf339472510a1\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/editSettleSignal.js\":\"301c10c06fe29e85\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/insertImage.js\":\"e6646c21a20ddb61\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/referenceCompletionRange.js\":\"4b0bc373fdf5caf9\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/referenceTargetTypes.js\":\"62a7ecf8dbbf3e1c\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/syntaxContext.js\":\"6c89ce46f3614b7a\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/triggerMatch.js\":\"1e95ebcf8f990bdb\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/AppRuntimeProvider.js\":\"fe51c8631530c7b5\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/BlockFocusShellDecorator.js\":\"f6373e5e87d80f54\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/ExtensionRenderBoundary.js\":\"1b378d3d2350467e\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/PanelContentRecovery.js\":\"5cbed7df7921c512\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/apiCatalog.js\":\"ad6f47b86a36c771\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/appRuntimeController.js\":\"1ce199b878463d9e\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/approveExtensionHere.js\":\"563d28dbb62b2690\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/armedCutAppMount.js\":\"07720d1c1a69ef96\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/batchableKeyedStore.js\":\"d89e0b987ffa3071\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/blockInteraction.js\":\"c1327f661a795408\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/blockSelectionAction.js\":\"196d1caa52190c06\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/compileExtensionModule.js\":\"7b419b5139e99c63\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/compiledModuleCache.js\":\"c13c48d3be7c4fc9\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/continuousGestures.js\":\"ae955684b5906186\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/core.js\":\"aec1e037ac114e6f\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/defaultRenderers.js\":\"be769caa57fde20b\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/definitionFanoutAppMount.js\":\"2ea44120aaebf9d7\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dialogAppMount.js\":\"f09d1aca45161879\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dynamicExtensionSeeds.js\":\"cb6103678cf02cb7\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dynamicExtensions.js\":\"f6d760409f4ce431\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/exampleExtensions.js\":\"a414812299e1bfad\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionApprovalStatus.js\":\"ffb672c5b10bb0dd\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionImportPolicy.js\":\"be672706341c7f60\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLoadErrorToast.js\":\"6742584fd4731944\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLoadErrors.js\":\"1d9daf084599e42c\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLookup.js\":\"27cb333b9dcf7c47\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionToggles.js\":\"9b49073936ea35dc\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionUtilitiesCss.js\":\"0ecf49fbc5806bee\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/kernelPageDeletionGuard.js\":\"446af1835a17875e\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/liveRuntime.js\":\"578bd6588fd9e9d7\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/normalizeExtensionSource.js\":\"ff1dc78ced59a2d3\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/openExtensionsSettings.js\":\"fde187692e2a8c3b\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/overridesCache.js\":\"4447112877d7a690\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/pluginIds.js\":\"cb08454077cdcb08\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/processorRejectionToast.js\":\"70a81f653290ee20\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/runtimeActions.js\":\"0e802c8e6bdc55ce\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/runtimeContext.js\":\"c9e35114cd864df8\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/staticAppExtensions.js\":\"b2eb3cdff48abe7a\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/staticDataExtensions.js\":\"9b9465e8dfb695d4\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/toastAppMount.js\":\"254d2bd8f89d74b2\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/transpileExtension.js\":\"e129953b7d23e5be\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/useOverrides.js\":\"e12f08a79aae9598\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/useShortcutSurfaceActivations.js\":\"daf03981893c5215\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/discoverToggleTree.js\":\"9000557819ec3665\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/facet.js\":\"9ce10e0ce7e18ada\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/resolveAppRuntime.js\":\"ed5c6db708badfd4\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/runtimeEvents.js\":\"749f10998edf3382\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/togglable.js\":\"0f85740ed0e01554\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/variantFacet.js\":\"cbe55ed874f20152\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/verbFacet.js\":\"b4304ba75ebfd0d4\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/block.js\":\"e50d6e41fa5d788c\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/focusedChild.js\":\"05faf803314cd55c\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/propertySchemas.js\":\"44ae2bb2cf28dbd0\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/typeRegistry.js\":\"72d2cde6613ef56f\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useAncestorCrumbs.js\":\"a6d140cafc090ca2\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useAutocompleteListbox.js\":\"f110ac4a20485d67\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useDebouncedSearch.js\":\"84b33b0b6cb117fc\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useDebouncedValue.js\":\"c15d25cd048069a8\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useFacetValue.js\":\"f87f5f083bad374b\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useIsFocalRender.js\":\"783b38bc9b1993a5\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useIsReadOnly.js\":\"912204d237df1ead\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useMaterializeBacklog.js\":\"42e20f7f121a2ece\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useMinuteClock.js\":\"32c92ffab8b51335\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/usePanelLayoutProjection.js\":\"3cde2f4e544cfc03\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/usePendingInvitations.js\":\"07f76b2fd758508d\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useRendererRegistry.js\":\"9d28288949766ff1\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useRetainedFieldRows.js\":\"3e609d0acaeaedce\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useWorkspaces.js\":\"d1139bd900203a08\",\"/knowledge-medium/pr-preview/pr-1914/src/lib/utils.js\":\"b45893a64acca0ba\",\"/knowledge-medium/pr-preview/pr-1914/src/main.js\":\"40616d7f4a443e4d\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/MarkdownImage.js\":\"37f8a13cb0063ddd\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/blockSeparators.js\":\"e923c41566094c45\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/context.js\":\"48e8c0e9d2bd7e4f\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/defaultMarkdownExtension.js\":\"2900e356b55f7184\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/extensions.js\":\"65f7d578d6dd69ae\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/renderMarkdownHtml.js\":\"1d96aa6deb43e921\",\"/knowledge-medium/pr-preview/pr-1914/src/minimal-editor.js\":\"680635bdb6c43e75\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/armedCut.js\":\"02b792fad64e18b4\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/captureMediaVerb.js\":\"1581e5cd6637cb41\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/clipboard.js\":\"5f26fe0d14ec563f\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/decision.js\":\"354ca08179d320f6\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/operations.js\":\"7a73a1e0ead7e4da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/account-header/AccountHeaderItem.js\":\"9f001dc74ecfd528\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/account-header/index.js\":\"3584784fbcadb27b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"981457bf53989eea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/askAgent.js\":\"bc484400634bd45d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/askedStore.js\":\"90798a87fafe3091\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3ea2530ff2d32048\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/chipState.js\":\"0a1f62cb92f0368c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/dataExtension.js\":\"2058334353153dff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/index.js\":\"66827790550813c0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"e13e68d965c0ff6f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/schema.js\":\"5e33647f727954d5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9d0de2fc3c4e202e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4ce70cfe2ed46925\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/addMedia.js\":\"c2ff6e0e1ad8dbd7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b1b0dab1c76de48e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/block.js\":\"60665c267bc5dc55\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/context.js\":\"c10e11eea4f0b8c6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/displayIds.js\":\"032b42e3df5635c8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/index.js\":\"c8e184e16aabcc74\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/outline.js\":\"ee6eefa6678c9dbb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/properties.js\":\"b6c51c946028398a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/refs.js\":\"1d2f1069a7303ef0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"79fb3c77adee5c13\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/search.js\":\"1e25f8eda0ce8d48\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/shared.js\":\"70485fccb934085d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3c967aad34042fba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/text.js\":\"2fe8976b9104f075\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentWrites.js\":\"2610fe6208800c8e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/authoringCatalog.js\":\"fb67bafdeb16b5c5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/blockRefTargets.js\":\"c1b75e2319d2f4ce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/bridge.js\":\"c4e47b85bb05e64e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/bridgeLoop.js\":\"653a1a6e6f33d93b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/changeHistory.js\":\"d559b706cf7561d5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/commands.js\":\"2e121dca4123191c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/commentsCommands.js\":\"0ec26de39af36f16\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dataExtension.js\":\"44554ee08f31d5bb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dataModelGuide.js\":\"a9718d5d73f353a4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dayPropertyInputs.js\":\"54bfc4318fb6ff17\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/describeRuntime.js\":\"29ea023dc6f84726\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/extensionLint.js\":\"f5aa0d6bcd06b71e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/grainAudit.js\":\"e9367ea179287dfb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/healthCommand.js\":\"dad2b1f91cd94ea8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/index.js\":\"dc488c3d4c29c8f8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/presetIdentity.js\":\"33d607bca4ceb6fb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"8370014780210249\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/readMedia.js\":\"4a2739448c5b7689\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/schema.js\":\"a9a35ac2d4ba2925\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/serialization.js\":\"6a8efb232ab44b67\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/targets.js\":\"726e270152c96515\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/tokens.js\":\"4c293967a2863460\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/watchEvents.js\":\"2b4c048df042c31b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/workspaceGuard.js\":\"722fafadb0c5cdc9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/writeCommands.js\":\"f6cb9939cc88d0be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/AliasCollisionToast.js\":\"6aac94d06c88bfa4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/DuplicateNameBanner.js\":\"ea3ab5401820d37f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/collisionMerge.js\":\"0644376aa8702735\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/dataExtension.js\":\"325348cdd59768e6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/index.js\":\"c383c11eb1dc6712\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/mergeCollisionAction.js\":\"2911c9d214d6aa17\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/pageStyling.js\":\"131854bca05b4d0d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/rejectionToast.js\":\"0040998146f64581\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/syncProcessor.js\":\"6242fc4caeef74e5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/actions.js\":\"7426130d418056f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/addComment.js\":\"e4e79926fd7d089d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/anchor.js\":\"d17dde239eca9a8a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/anchorState.js\":\"72e60173163d0646\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/commentLinks.js\":\"cbd03b8ab8e5612b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/confirmThreadDeletion.js\":\"aac2bc1819118255\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/container.js\":\"60cee9226d3deb1e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/dataExtension.js\":\"59cbd792ba5cde81\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/deleteComment.js\":\"e228973be7d93b71\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/highlights.js\":\"2bd826238ef67f7c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/index.js\":\"415420b261f7206f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/linkedCommentsPill.js\":\"0a834d572d948282\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/margin.js\":\"8b4a59bcff63c789\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/marginAnchorLinks.js\":\"3a4f4ac7865d5b29\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/marginSchema.js\":\"10681f6a8946ef2c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/newComment.js\":\"99aabd112b4c083e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/ownThreadPicker.js\":\"03ab483e958bbc61\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/placement.js\":\"583cccb91571eedd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/queries.js\":\"dcb20df1765598eb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotePosition.js\":\"c9c4374f5ea64618\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotedIn.js\":\"d919701b0de42261\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotedRange.js\":\"1748c9c69d2aa206\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/rangeRefs.js\":\"bb3043f37b7e3265\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readHighlights.js\":\"ae91feccb706b15e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readSelection.js\":\"8fd5fdec79c654f6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readSelectionUi.js\":\"ec69e0e72ad1a640\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/reanchor.js\":\"4f1a81a21dc87aad\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/schema.js\":\"b58e0ea49f6e971c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/scope.js\":\"4caf5be3339f7bc4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/scopeThreads.js\":\"520b93e71faddca3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/splitRetarget.js\":\"7c68b61ed4eb0c82\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/suggestionCard.js\":\"1d471c9b6b43c010\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/suggestions.js\":\"09a97ce036261e8c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/summaries.js\":\"500fa785bbcd3258\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/summaryBatch.js\":\"3b2ebe9a8e7dec21\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/surface.js\":\"41888bc33a8c889a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/threadNavigation.js\":\"d13ab0b97630e09a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/threads.js\":\"0455e57c13567155\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/ui.js\":\"95c7a6ec44e403d6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/uiStore.js\":\"eace5651f6d02853\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-intents/appIntents.js\":\"e587affec9d39481\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-intents/index.js\":\"d9e5abdb9a138571\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-update-prompt/index.js\":\"a8121b75dd4ac9f0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-update-prompt/status.js\":\"d37edbd15e100d65\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fa49552cd2b8fb9f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaBlockRenderer.js\":\"9cb197bfddc1ff44\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaDownLaneReplicator.js\":\"b31abc60a86cac61\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaUploadReconciler.js\":\"d08d953eb168fdde\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetDownLane.js\":\"c3a501bcf249f56a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetResolver.js\":\"077c0b3faeb7535d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetUpload.js\":\"5ec536d100743b79\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/attachmentCleanerIO.js\":\"4aa8018bca3de60e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/supabaseAuditIO.js\":\"640a6fed12401621\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/blobStore.js\":\"c11323d1d63e6814\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/browserMedia.js\":\"b8d1e62414f90ce9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/byteStore.js\":\"0b77649d101369ab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/cleanerIO.js\":\"4e3610529dec2e18\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/cleanupAttachments.js\":\"3acf2a8a98884f10\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/dataExtension.js\":\"28e6d331b156d613\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/downLane.js\":\"06d9a36f7dc128a1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/index.js\":\"62f7ed21618c94c0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/insertImageContribution.js\":\"c545d4c3467c013d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/laneArming.js\":\"a0158fb2a933fec8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/laneLock.js\":\"5cb9838d4c5f6657\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaBlock.js\":\"848956434fd08468\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaCapture.js\":\"273a9d5cf188495b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaLanes.js\":\"423d86afbf984bd5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaViewers.js\":\"6c9c9497316d064a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaViewersFacet.js\":\"dcd89e30cf2dc8f9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/pasteCapture.js\":\"cd4a4d18e11be5ce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/resolver.js\":\"93bdc3d0f0120b98\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/retryUploadsAction.js\":\"6b09f832fe1b2f6e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/storagePaths.js\":\"d390dba7a5deff62\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadDrain.js\":\"bfcb45ade43df263\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadLaneStatus.js\":\"6cda1d370d3f9140\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadReconcile.js\":\"a6a9dc476b67955d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadRecovery.js\":\"50eba0f42247b08a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadStore.js\":\"51a87874c94ee1a5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/useAssetObjectUrl.js\":\"a43f5d2be8569e50\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"29ccda49ae0aadf2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f8b196ce065d4f9f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/facet.js\":\"c7d63def65b61536\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/index.js\":\"dfa945a03c9404ff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/prop.js\":\"c63b4427f000329c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BacklinkFilters.js\":\"85c0e7a6c69f9e9e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ac6c06da466ea12c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BlockEntry.js\":\"5c56c2f364203dbf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/LinkedReferences.js\":\"53fc3917e4348c6b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e30067ae53894759\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/dailyNoteDefaults.js\":\"8244413d0a761793\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/dataExtension.js\":\"bc83b57b45f98b06\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/edgeExclusions.js\":\"3a027949e2c9b321\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/filterProperty.js\":\"709c00c2c7cb4352\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/index.js\":\"dbf34e66b514ac9b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"38778d6b7342e83c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/applies.js\":\"865a3f314231d3c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/countQuery.js\":\"1a26d3554a5ac469\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/expansionStore.js\":\"4d8f02237c862ee5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/index.js\":\"2ec6fa87b4e89eee\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1d2dcafc1ddc7789\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/presentationInvalidation.js\":\"159998fb524c5d88\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/propertyEditorOverride.js\":\"ebf52653a443742b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/propertyFilter.js\":\"4781b80792bbb966\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/query.js\":\"469f9fd7c70c1279\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/resolveFilter.js\":\"3ceb91e41e65a005\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/sourceBatch.js\":\"82a59531487500cf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/sources.js\":\"44f0c26ec2d122d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/useBacklinks.js\":\"3b395dbd8fc92dcc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5b3480c22c5f4054\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/BirthdayCelebration.js\":\"c2eb8a528a320a7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/BirthdayOverlay.js\":\"f539715924b1acc1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/gate.js\":\"fd3c9fe51dc7ebbb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/index.js\":\"24f1219bf83102eb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/wolfTheme.js\":\"6284a059b944b78b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/BlockDragLayer.js\":\"460bd107efcaabec\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/dragController.js\":\"7209e3b5ee378da7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/dropTarget.js\":\"2bdd974c7e45b6fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/index.js\":\"1d9454d51aac8a3c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/projection.js\":\"f361f9be9d9da756\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-info/BlockMetaCard.js\":\"0255dd23e695c01d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-info/index.js\":\"4ddbb4107e41aff6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/AddTagDialog.js\":\"46c9cd758d1c1abc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2fcfa284adda3fc2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/TagNameIssueHint.js\":\"54ce85282b6c1ffd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/addTagAction.js\":\"1828b8f9d93421e9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/appendTag.js\":\"4c48895b47578689\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/config.js\":\"f77aa7a6fd387847\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/dataExtension.js\":\"5908ce5bef152cbb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/index.js\":\"cbb680b01aa0273b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/propertyEditorOverride.js\":\"063224812a8f2a22\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/BreadcrumbList.js\":\"43e8a906b41946de\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"54bce6d0991036e0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/Breadcrumbs.js\":\"03912e8be77548f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"06fb0d6d60738027\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e3a8f62b20051070\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/index.js\":\"6f0d87cb442eb94c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"fcd47d01ba3d28a7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/CharacterCountItem.js\":\"9475e34f7c1c1568\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/ProfilePropertyEditor.js\":\"29827bd00b61b1d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/actions.js\":\"aca3d4846c4812b7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/blockType.js\":\"0926b78c33395464\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/charCount.js\":\"d083b12ec492d92b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/dataExtension.js\":\"6874d9ae2e9a4761\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/index.js\":\"a3135bac1e723dfe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/profiles.js\":\"beaf0c1bd66440f8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/properties.js\":\"661550ddffe3b81a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/subtree.js\":\"b5634f859d27f0e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/textCounts.js\":\"c711bdd6a9058913\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/colemak-keybindings/index.js\":\"58344a2ff087bff4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/CommandPalette.js\":\"056955977bdd8205\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/HeaderItem.js\":\"7555beab4ddc75b2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/context.js\":\"abe2ca1c84ca3503\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/index.js\":\"a6747acd17c3fe4f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/selection.js\":\"49762741c3254746\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/toggleStore.js\":\"4854fd919b1ecb21\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/useCommandPaletteActions.js\":\"2411deed8cebf52e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/ContributorBadges.js\":\"745a2b933def1e23\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/ProfilePicture.js\":\"4d0f3387bd2b41cc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/author.js\":\"b92a97f62a45b3b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/codeMirrorExtensions.js\":\"f52d443c67bc78c8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/dataExtension.js\":\"68114e224d3134ee\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/index.js\":\"318b97c2470cf2c5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/mentionAutocomplete.js\":\"50517d85c9dcad8a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/processor.js\":\"715985d5a6060870\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/profiles.js\":\"3fad9de252ec59d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/queries.js\":\"80b1268380a6f14c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/schema.js\":\"1c35a14a596f3790\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/useCommentAuthor.js\":\"cc13adebcf764d25\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"45bf57949778ac98\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/followOrigin.js\":\"496254c20672e311\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/index.js\":\"96c9e09fc07a45c1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"56083a6b6f76ef4e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5d0d159dff5b34db\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/CalendarGrid.js\":\"3ec6c0ba21b7d7e2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DailyNotePicker.js\":\"28ab1691b548a33e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"34deba2c10a6bfe5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateNavDecorator.js\":\"2958e729490b4e74\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateScrubOverlay.js\":\"e274dde5050c5281\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DayPropertyControl.js\":\"360237c884470d4c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DayValueReferenceControl.js\":\"2114233cfaccf220\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/HeaderItem.js\":\"9e22a5bc3fe45f0b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/ReschedulePicker.js\":\"ad883ac17926b256\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5c078f7f5e32d634\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/actions.js\":\"986323f281d509ab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/blockDateAdapter.js\":\"a875090e80e17e21\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/calendar.js\":\"7ac3c2e6a49e1e5d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dailyNotes.js\":\"7df400c17ba11869\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dataExtension.js\":\"5a26d7b3e57f078d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubActions.js\":\"88eafbfff73fb385\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubGesture.js\":\"4e946957a10a0ae8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubGestureActions.js\":\"de363015e6007a83\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubRecognizer.js\":\"5f8bb1941626037f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dayProperty.js\":\"afa94c0d49bfd437\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"f720436f9f0b6d8f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/deletionGuard.js\":\"f912a2e09d3ab26f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dueQuery.js\":\"8771ec8d1f69f46a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/index.js\":\"8cbf8694adf8e5b1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/landing.js\":\"35a0569c83c736d4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/localSchema.js\":\"a75bf06b12559e7c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/referenceDateAdapter.js\":\"5e5df823c68842d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/rescheduleAction.js\":\"5e16fa208cbc9ead\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/schema.js\":\"82b577d0526fa2fb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/spreadBlockDates.js\":\"0c5204cd9b1750b6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/spreadDatesAction.js\":\"d2f54e256fc5b493\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/today.js\":\"558e541f7771cc67\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a5a545d7845d8172\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"dc52a470a19dc33d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/audit.js\":\"20e413cb0968a23e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/auditAction.js\":\"14ce595d85b40396\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/auditRanges.js\":\"15c71b59c082f68c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/diagnosticsSource.js\":\"efe70dd8a2245a87\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/divergenceScan.js\":\"7bf208f1da22ab34\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/index.js\":\"1f66834567258fc2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e9851a88ff75626c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/referencesMirror.js\":\"bb793ec7c717c2aa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/rowJson.js\":\"e955538b3fb504c9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/schedule.js\":\"14d14285461ac0f6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/store.js\":\"bd1f72e459ebddc6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/action.js\":\"e4a2e6e29ef7fc02\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/index.js\":\"5c04d104006cb964\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/plugin.js\":\"d70807b1c2239d31\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"0f5f0c0d46767098\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/actions.js\":\"85d6047bf6fcfb8c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/changeMarker.js\":\"e1629d10c55071ef\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/diagnostics.js\":\"fa2d90ef6481980e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/fileSystemAccess.js\":\"3031a3000ab1cbb8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/filenames.js\":\"52ff821c0c3aa58b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/index.js\":\"17b6d53c4ded779b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/mirror.js\":\"ed6049a0bd12f06f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/runLock.js\":\"06e56a8bf67488fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/runtimeHealth.js\":\"667da0e6a69bcffe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/schedule.js\":\"f54a3f29f194eed1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/store.js\":\"3928a94af81a70c1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/default-themes/index.js\":\"781bd3679a376e6b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/default-themes/themes.js\":\"60ec77d1349511eb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/diagnostics/facet.js\":\"8aa20b0d29749729\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/diagnostics/useDiagnostics.js\":\"976aaef055feb8d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/dismissals.js\":\"e3a9e6ccf9dcce05\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/index.js\":\"313d8536cb68ebe7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/status.js\":\"f2748b90ae66e8c1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/store.js\":\"a66c691918891805\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"78ed210933bca5fc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/ExtensionsSettings.js\":\"538f4fa6465c8235\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/actions.js\":\"0b7c6d859cec3cf0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/config.js\":\"3c88deae75602be0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/dataExtension.js\":\"e6461e47b86eb80f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/effect.js\":\"36f32d6bb1d6554f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/index.js\":\"1e2295b09b461243\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0544611b46dcedfa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/useToggleTree.js\":\"b6c4160f18bd31cc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/ExtractTypeDialog.js\":\"03367fab1056cf72\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4520c5993f07f06d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/PropertyShapePicker.js\":\"0e6114d704e21bb2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/action.js\":\"c51ff64886d329b9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/index.js\":\"4c6cf1925499b06a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/FindReplaceDialog.js\":\"b4db2624221974d5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/HeaderItem.js\":\"7651a75d0c57321d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/dataExtension.js\":\"81df3c463ab45fc9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/index.js\":\"950238cf85485c90\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/search.js\":\"bcf098a4f1f5e28e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/toggleStore.js\":\"5f531fd99f2eb418\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/LocationPropertyEditor.js\":\"9a7c068e74efbd1d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/MapView.js\":\"c9a017ba87fbfcd8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/blockTypes.js\":\"ed1126cc015eef1a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/codeMirrorExtensions.js\":\"d2c192de43431040\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/createOrFindPlace.js\":\"984f62de48233f35\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/currentLocation.js\":\"46dbab31916e0a1e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/dataExtension.js\":\"80adae0a68b983e3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/geoContentDecorator.js\":\"c803818ce82429d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/googlePlacesClient.js\":\"12b562549f5e2af0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/index.js\":\"2d9d881707e8462a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/locationsPage.js\":\"3298a8be8ecf456b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/mapViewport.js\":\"f6e17aa3518d41e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/pickCurrentLocation.js\":\"702ecff1e4b9bb43\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/placeAutocomplete.js\":\"20c8387568edbf59\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/placeNameCollision.js\":\"ea1691e5ea592b86\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/properties.js\":\"1cf189925d5b304f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/propertyEditorOverrides.js\":\"562f8177999dad49\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/query.js\":\"b45c83c50775432c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/usePlaceSearch.js\":\"767e53b7239dce98\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d3e671207df4ab4d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"20199c8be2dce619\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ffa2a33a4e4bba94\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/config.js\":\"a2ac9434a7d59f89\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/dataExtension.js\":\"1322ab9b68b07fa9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/facet.js\":\"92abc152f1a4a61d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/grouping.js\":\"e5cf3ebd67433bc3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/index.js\":\"ca99624b36c0c53e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"948c22bcad27ef1f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/query.js\":\"4f16192c6feddeab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/resolveConfig.js\":\"06d05d09a714a23c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"29b207ee2b0460b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"daa77f1b742a56d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/HtmlDocumentContent.js\":\"5ec40768c903491c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/HtmlFrame.js\":\"99d9f3a633d28772\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/actions.js\":\"d5890898ae6a7aa9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/blockType.js\":\"d057cac572b5e60d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/confirmRunScripts.js\":\"c28d51e996f7e447\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/dataExtension.js\":\"c3baad9756d07f98\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameAnnotations.js\":\"63405214c5768d73\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameDocument.js\":\"d76e9bd8a526733e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameTheme.js\":\"e8ba302d9144561c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/index.js\":\"673f8c42e0ea6f98\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/scriptConsent.js\":\"8b62b4fa1cb64e3b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/sourceMap.js\":\"6b14b1375caf4244\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/useDocumentScripts.js\":\"fc1805e2e1a8296f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/index.js\":\"66080226bb6ffe38\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/record.js\":\"83eaf252f7d2b5f3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/recordStore.js\":\"3f67aa715970b925\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/responsiveness.js\":\"000fdc56c4f39885\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/schedule.js\":\"89edc030d01eac0b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/sessionContext.js\":\"c5d99e63d7e60554\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"beda3476308fe7fc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"5863d0fcb8f772a0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/actions.js\":\"2770cbe4bba178df\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/config.js\":\"943bbf78c2515b08\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/dataExtension.js\":\"00409c27dc33e5c6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/effect.js\":\"1a653686a626f89f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/index.js\":\"90d6fdcf0ad72fbb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/keyCapture.js\":\"e51e2c6e78de0bf3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/overrideStore.js\":\"6441167130fc5b81\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"296f1e07ea8397cb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/HeaderItem.js\":\"63392ee9fea0b2ea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/LeftSidebar.js\":\"f95c06cd9ed7c42f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/actions.js\":\"e9a344e86de9ec2d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/facet.js\":\"f3a6e073665d10e0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/index.js\":\"d2deb2f00da023f6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/shortcuts.js\":\"62581a09f417b15d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/toggleStore.js\":\"d78ab6ce52d0777c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/MergePicker.js\":\"763488e6b282ead8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/index.js\":\"d91dbbfb2cc8d2d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/mergeAction.js\":\"6a6bf722dbf201ab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/strategy.js\":\"c10ca0d2e1e59dbb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/Button.js\":\"c2efe58de7f14de0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e58dc3908f70f3b8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/defaultItems.js\":\"31a59899c22de4e8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/facet.js\":\"70ba7bad014e13e8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/index.js\":\"fc90a4c44c96c13f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fe33f10bf2e2fcea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a963bec241b780fc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"af5cceff40278c97\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/facet.js\":\"fb94fffc918d129c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/index.js\":\"3db718687d755635\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/MoveDestinationPicker.js\":\"c1b9816ce6ebea1d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e3a72102ae9a5d8d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/contextMenuItem.js\":\"a3bb177cbdba32a6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/index.js\":\"05d693cfce539f56\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/moveAction.js\":\"236e002a5f4556ef\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/moveBlocks.js\":\"6bb2aab89070f87d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/selectionAfterMove.js\":\"6228e87ad77308f5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/TutorialBanner.js\":\"29e5fa008f41aba1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/action.js\":\"6b6e2f80ac800a3b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/bannerDismissal.js\":\"ed7969e2d757f210\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/documents/cheatSheet.js\":\"4570326a24ab748e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/index.js\":\"7ec52ea9b9758128\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/keys.js\":\"807718c32c799562\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/landing.js\":\"f82fdf867f2f8c7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/outline.js\":\"3c69e053750c0910\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/seed.js\":\"dff424b568f09fba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e1eaa82091540818\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/analyze.js\":\"b96905636e808565\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/diagnosticsSource.js\":\"85fa63cff6d7cb50\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/index.js\":\"52b468fc48e05439\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/load.js\":\"451cec282e5fef4e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/monitorRun.js\":\"7d0b845fb113bb01\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/schedule.js\":\"36b6dcad0d4aed9a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/series.js\":\"ca2d430db358b523\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/store.js\":\"6e736d40d911b160\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/trendAction.js\":\"d2d3097c19052cfe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/verdict.js\":\"44a22006c9af78c5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/clickToEditAction.js\":\"1a2e0c7a2c3bb814\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/index.js\":\"ad8838b2e0889c4c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/interactions.js\":\"86fc3c16891d858f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"7409311c9520ab1c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/MigrationGate.js\":\"63211773ef73224f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/MigrationGateDialog.js\":\"64a86cc9714679a9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/action.js\":\"10376137c2ea5270\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/index.js\":\"625d73fc7180c008\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/localRunMessage.js\":\"6407e1da567f3e55\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/plugin.js\":\"e910b29a94e45d7c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/progressReport.js\":\"da5a42332fb2298f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/sweepProgress.js\":\"44dc2aa055941700\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/FieldRowRenderer.js\":\"4736544847a5bb80\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/ValueRowRenderer.js\":\"24d27461631de191\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/actions.js\":\"c579d03cbaf760a9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/autocomplete.js\":\"a55a46ad62aabe8a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/fieldRow.js\":\"875601bbf4224ad8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/index.js\":\"7cf0ec7c21c3ced2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/referenceWarning.js\":\"d0d09ed1f47566b2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/valueAutocomplete.js\":\"1569a63c6b4eb983\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/valueSchema.js\":\"1ff000cf0953d06e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/HeaderItem.js\":\"269c596531d35f9c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/QuickFind.js\":\"6684bd31ed38b4ac\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/index.js\":\"50a9a8d918e4d510\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/recents.js\":\"62e373e0a82fd24d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/resultItems.js\":\"b0d69bce9d73673f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/selection.js\":\"34c9384e260701ec\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/toggleStore.js\":\"2dc0526e97c5f472\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/HeaderItem.js\":\"9d310ac3e586b504\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/RecentsPageBlockRenderer.js\":\"785c4b37988898a3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/grouping.js\":\"a50fa381c74b9e22\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/index.js\":\"766eee3e2fe97ef7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/target.js\":\"5fa823aae7dd48a2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/codeMirrorExtensions.js\":\"e7eb48c53e8c28e9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/contentPrefill.js\":\"9100489634837138\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/dataExtension.js\":\"5706ca968613f13e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/index.js\":\"1f4eee8c8401711f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"18c6551324d22adc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/invalidation.js\":\"73480dc64f8f9801\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/localSchema.js\":\"e693d3dc32aa5dfa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/blockrefs/index.js\":\"df3cdfdae2326cc3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"22d9dd63fc6cc76c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/index.js\":\"d4ef4d88d0b99986\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/referenceNode.js\":\"51061c0a75779fad\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/remark-reference-occurrences.js\":\"00c6978264ceecb1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"614475f282896898\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/index.js\":\"f63934e26d7cc45c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"78d77401a3e689b7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"0f18f79c7c8cbcb8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/mergeRetargetProcessor.js\":\"28d6ddc43a16e081\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/parseFence.js\":\"c6dd1778fe197f2c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referenceParser.js\":\"168d845177d85aa7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referenceProjection.js\":\"9056439592a60f5b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referencesProcessor.js\":\"048932702a7efade\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/renameProcessor.js\":\"c71619c62548b0cd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/spanReplacement.js\":\"333cee98e8fa9151\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/htmlToOutline.js\":\"2da8d37b4af3d7b9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/index.js\":\"a1930b8a01180b9b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/normalizeClipboardDom.js\":\"d1a7626be602c30c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/pasteDecision.js\":\"33f307006cd532c1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/action.js\":\"c7e46ca170d3ae9c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/blockIds.js\":\"3f43d63340741d29\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/content.js\":\"10ce95d5046a0a11\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/effect.js\":\"e4f245cfa9875b1c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/ids.js\":\"d43658683982d9e4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/import.js\":\"f2beb4a7ead71ffc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/index.js\":\"12954addcf614d86\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/plan.js\":\"153d9fb26da46d91\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/plugin.js\":\"5a7220a01b8e721e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/promotion.js\":\"1fd19b559efcbd49\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/properties.js\":\"6140174894dd48c9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/references.js\":\"86bbc7a651956536\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/report.js\":\"6c5e64fe46feeed3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/roamMemo.js\":\"119d4b8bc4d214cb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/runtime.js\":\"958a43d86c8846d7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/schemaReconciliation.js\":\"5a3fba1ce06362bd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/srsMarkers.js\":\"905556c4aac80a7a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/todo.js\":\"b48ddab34dccd2dd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/typeCandidates.js\":\"796a60999f3d09f1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/types.js\":\"0c863974c1d409bf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/search-health/index.js\":\"30bb19f611a7f3a6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/search-health/store.js\":\"9b01b20169738b3d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/HeaderItem.js\":\"0a0f62cce1f74d89\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"0525961a2a24cf0f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/index.js\":\"c2ce30500afcee53\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/model.js\":\"ce0496ef9c7de7de\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/toggleStore.js\":\"25ab5b441ac635fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/useKeyInspector.js\":\"47e485bb1217314c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3ce3a9d89f3e34e0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/ShellDecorator.js\":\"fe7357975e0e3648\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/actions.js\":\"2bd03330a705a4cb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/exclusionsFacet.js\":\"70d3393472c94625\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/index.js\":\"461bdb65265ca0d2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/shell.js\":\"35ea32deaa8e3824\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/surface.js\":\"f456d2eb60376c1c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/walker.js\":\"f5f4021cea26bd3a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a850ff036c838949\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/dataExtension.js\":\"86c5d5239ab014d2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/index.js\":\"2cc2516ee4f4acfa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/indicator.js\":\"9d17b827e2299234\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/moveSrsState.js\":\"6b47c677be699d58\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"487676bc79b8b9b7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/scheduler.js\":\"5b2a7666a822932b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/schema.js\":\"2d1507c0b1c9aba0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f58914dfc4dfa84c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/srsClipboard.js\":\"791ed897a5d24fa7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"e5f110c017fa6ef5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9a76679dd6be18b6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/DeckPicker.js\":\"0d0fcf0bd7834230\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewControls.js\":\"c78edfe03c175eca\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewDeckRenderer.js\":\"448c0e4844a7b96a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewSession.js\":\"5a0709d3500fa3ce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/actions.js\":\"594b52b84997e01f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/archive.js\":\"ac227bd2f6ac102b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/dataExtension.js\":\"ab3c397721a57090\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/deck.js\":\"5c5a708ab81525d6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/dueQuery.js\":\"bcccf1d835d68c2a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/gradeDecision.js\":\"7f19fbabea13d648\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/index.js\":\"2c112aabb7de8d6f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/keyHints.js\":\"a24c73550d91f135\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/reviewCardLayout.js\":\"c873debc9da0a7a3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/reviewProgress.js\":\"4d315cd237d0765f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/schema.js\":\"3a84c2e2589113ae\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/useDueCards.js\":\"59c6da8f19db8c5b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/startup-metrics/index.js\":\"bdefad53c302bd04\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/startup-metrics/record.js\":\"9eb45c71129702bc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/index.js\":\"a90a963f2e62d3af\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/persistenceStatus.js\":\"016692d4af28000d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/requestAction.js\":\"2a9f8545dcf96ed0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/TypeChipsDecorator.js\":\"59559bcb427f6c16\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/codeMirrorExtensions.js\":\"db34a4bbe32c3e00\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/index.js\":\"1485f49889f539be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/typeAutocomplete.js\":\"cf2f8f06666c28df\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"12bfbf58ddf0d6c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/actions.js\":\"c8bac51a43696412\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/anchor.js\":\"2493453bce393929\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/events.js\":\"9bab48ae1ed2e6d1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/gestureActions.js\":\"292bd3674588218f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/index.js\":\"33ad52908adb2cb1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"30a1516417d2dd8d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/collect.js\":\"4d700206b9a927cb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/index.js\":\"881654df9884fa69\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/record.js\":\"a3d7ed4c98abec10\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/RejectionDialog.js\":\"08cc3976a2b29540\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/SystemStatusHeaderItem.js\":\"375009e6a86845ab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/index.js\":\"1975e1ef58ac2573\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/model.js\":\"9c488eb8483f78ee\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/queueCounts.js\":\"5c6acd282bf89107\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/rejectedHelpers.js\":\"e4c87fa42aa6c624\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/rematerializeAction.js\":\"2d3a3156e21b90a9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/useHysteresis.js\":\"19e4842ff18616c1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/ColumnHeaders.js\":\"4bac2b7334631486\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/QueryUi.js\":\"770386a5c906b303\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/TableLayout.js\":\"6d295f929d9d4b13\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/actions.js\":\"d01260540eb2d26a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/cellEdits.js\":\"e848844a5aa0ccaa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/childrenViews.js\":\"90993a209500ced2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/columns.js\":\"d431ad55707b3af7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/controller.js\":\"0815f759fe206cd4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/convert.js\":\"3f4f4ccb7b3f570b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/dataExtension.js\":\"a4bed3256530a3ec\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/index.js\":\"f73ffd2cdeab1f87\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/keys.js\":\"69602cb436a0e6b8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/model.js\":\"893355ab4c7e1304\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/QueryText.js\":\"a060dbd1de5e2fcd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/backfill.js\":\"4c141a3719fe2ace\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/completion.js\":\"f90904d4e3658064\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/format.js\":\"1510bf75002c314d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/parse.js\":\"f3e3c6cf08071dd0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/queryValue.js\":\"27027bb2cd182650\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/registrations.js\":\"623a632a5d4be564\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/source.js\":\"a91b33e2a080d15c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/registry.js\":\"358b1f6b1f012e4c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/rowGutter.js\":\"c8a17a04ba6917e9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/rowVerbs.js\":\"5a0cde7801896020\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/schema.js\":\"a7b269f3970551b9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/sort.js\":\"cf180e9bd5d23764\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/effect.js\":\"37ac79c42588b906\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/index.js\":\"701f221643fcec8d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/theme.js\":\"19a69c6c2a1ed0ba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/actions.js\":\"fd8af7ffbd7e994b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/dataExtension.js\":\"91b0103f562ec7f0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/index.js\":\"64851e3c67dfc92a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/schema.js\":\"d2639e00d6874c43\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1b10e83410a346a6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/actions.js\":\"4dc5db69eff4442c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/defaultItems.js\":\"a6674e64e42b1e9b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/facet.js\":\"59d9aa4a9b25aa21\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/holdRecognizer.js\":\"ffaa469b4938d7f2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/index.js\":\"cc9bd555c9b91671\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/UpdateIndicator.js\":\"bc611daa1206dee3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/index.js\":\"c88aca680ba34b6d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/loadTimes.js\":\"ba4580137db84042\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoNotesRenderer.js\":\"a9f610d3e1140562\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoPlayerRenderer.js\":\"42503269d4918c76\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoTimeStamp.js\":\"ea79f822cce8d0c2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/actions.js\":\"3194ac0abbf2611a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/index.js\":\"4e693278701b9b63\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/markdown.js\":\"6c1f5c3ad9a7bd3e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/notes.js\":\"5b44709b3e362dea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/registry.js\":\"8886795dc648507d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/remark-timestamps.js\":\"8289054edfef2299\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/view.js\":\"3059527e07d78916\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/LinkHints.js\":\"2fa83bb051fad49f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/index.js\":\"7ba26c1af5417be1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/model.js\":\"7fa432c4e518e3a3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/settings.js\":\"62c88e856ad44a87\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/actions.js\":\"bc6a7057eb748831\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/index.js\":\"afa2b462b8f26083\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/interactions.js\":\"d7a2190473fe5a1b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/workspace-header/index.js\":\"1f72a96689e1304e\",\"/knowledge-medium/pr-preview/pr-1914/src/registerServiceWorker.js\":\"1c42cb2117b9f7b7\",\"/knowledge-medium/pr-preview/pr-1914/src/requestPersistentStorage.js\":\"346bfe39ce1a6e92\",\"/knowledge-medium/pr-preview/pr-1914/src/services/authRequestDeadline.js\":\"ff6ff44350b3deb3\",\"/knowledge-medium/pr-preview/pr-1914/src/services/authStorage.js\":\"2874d143e0e89c60\",\"/knowledge-medium/pr-preview/pr-1914/src/services/powersync.js\":\"390bdc28fe29fe3a\",\"/knowledge-medium/pr-preview/pr-1914/src/services/supabase.js\":\"ba996cc8e0544012\",\"/knowledge-medium/pr-preview/pr-1914/src/services/uploadErrorClassifier.js\":\"986113a2d6bcd215\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/ActiveContexts.js\":\"75920dd96e6f3ab0\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/HotkeyReconciler.js\":\"c81f1d6c58e2c59d\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/WipeLocalDataDialog.js\":\"3674b75199bbbeab\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/actionDispatch.js\":\"8845f3ba6efdae64\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/actionRefItems.js\":\"b36889d644c894b8\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/applyKeybindingOverrides.js\":\"2819d8aa60b89955\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/blockActions.js\":\"73d060c5352e04d0\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/blockMergeGesture.js\":\"38e54b4ce5668492\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/canonicalizeChord.js\":\"5649666c764a794c\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/defaultContexts.js\":\"18ff532a45ac31aa\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/defaultShortcuts.js\":\"64bb83d6c068f401\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/effectiveActions.js\":\"0a7642c03b862469\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/gestureAction.js\":\"5d7a6b6480bfa617\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/gestureBinding.js\":\"3dd0ce4beba620be\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/holdRegistry.js\":\"68b4249340ae7811\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/keybindingConflicts.js\":\"55e275cc78ab1e98\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/keybindingOverrides.js\":\"156cd274339fde2e\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/pointerAction.js\":\"f57c96f4cc9c97f2\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/resolve.js\":\"bf733c285597a1f6\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/runAction.js\":\"a20522b227a124a8\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/sequenceMatcher.js\":\"bd10b5f9b657a536\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/types.js\":\"ee34630df88124cd\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/useActionContext.js\":\"bf36d8b3f864696a\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/useActionDiscovery.js\":\"763b55f286e57b02\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/utils.js\":\"a7b629c3f51f349e\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/bootStore.js\":\"d29e4f5f6fff4a10\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/previewDatabases.js\":\"e42fa81aafcc6e2a\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/byteTransform.js\":\"8b157ae7a66f2748\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/attachmentCleaner.js\":\"0585a569a58209ff\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/attachmentParts.js\":\"6311159642f390e8\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/bundleParts.js\":\"59d760bf760cfa2b\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/bundleRecord.js\":\"6ba4e2f5fd49bfb8\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/manifest.js\":\"2014b37edde26888\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/takeBundle.js\":\"4c38a26838e37b00\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/verifyBundle.js\":\"7108f280dd70eb75\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/cleaningStage.js\":\"124b58368c10512e\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionKey.js\":\"44d9bb987f500452\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionServer.js\":\"b067bf4b5520fe8c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/flip.js\":\"a007d70bcce76fc9\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/flipAttempts.js\":\"382618c5537af1c6\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/pages.js\":\"6c8cafd4bf8b7f66\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/preflight.js\":\"764a772a87d0bd62\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/reseal.js\":\"1b086146a1eb13a4\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/runConversion.js\":\"1245637845bfc7ec\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/runLock.js\":\"038701794d58a302\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/sealing.js\":\"493d4d7c066dd9c3\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/sealingStage.js\":\"9bf25c0f7a26ca59\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/stage.js\":\"06be6519f5131111\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/verifyReseal.js\":\"38a7acafbf548aeb\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/aad.js\":\"07cf4112df0a3a5b\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/aead.js\":\"36afb7b4e9628602\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/base32.js\":\"d75261c225a1505f\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/base64url.js\":\"3f1be9862d1e45c7\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/binaryEnvelope.js\":\"206d950144521f68\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/byteAead.js\":\"2c45097b00ef3711\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/canary.js\":\"fdfe76ad2909dd3c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/contentHash.js\":\"05155b18844e5ad1\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/contentKey.js\":\"8e4f094a062faaf2\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/derivedIdNamespace.js\":\"fa971a7b15bb9f86\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/envelope.js\":\"03894754a825c5b7\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/hex.js\":\"68d375472d9f2e6f\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/sha256Hex.js\":\"75a79d8d53a5802c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/workspaceKey.js\":\"cac3e62c067e35d7\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/conversionState.js\":\"0fbba1285f0946ee\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/createEncryptedWorkspace.js\":\"5a30638ed2f91a20\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/pastedKey.js\":\"66a73f0d789ff575\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"71c476f618a29222\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/upgradeWorkspacePin.js\":\"41ceeab1fbc73100\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/keyStore.js\":\"7f20f62d4f014d9d\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/mintWorkspaceKey.js\":\"8c8daaedd5b0e2d8\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/modePin.js\":\"b02d0c9b92c05127\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/openWorkspaceKeys.js\":\"fd2d66cb6be81497\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/resolveWorkspaceEntry.js\":\"1e9b66b20093a0b3\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/resolver.js\":\"d59da2301edd182c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/workspaceAccess.js\":\"1e9a178d564585bb\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/transform.js\":\"7d50300374aa4610\",\"/knowledge-medium/pr-preview/pr-1914/src/themeBootDefaults.js\":\"43c2b55bea0e29b0\",\"/knowledge-medium/pr-preview/pr-1914/src/types.js\":\"84ac253eb758291f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/ClientLocalSettings.js\":\"834562a104c04283\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/abortableSleep.js\":\"79e2e0024aa18ed9\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/array.js\":\"fe2d06b97df4ed41\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/backlinkAutocomplete.js\":\"6a0713a23634f2fd\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/blockCrumbs.js\":\"796d959c83f65e23\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/blockrefAutocomplete.js\":\"d50b36b21018c406\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/cadencedIdleJob.js\":\"1db90034b7db7b69\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/callbackSet.js\":\"a943011063babe20\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/clientId.js\":\"4bd67a2cc7523757\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/codemirror.js\":\"0696947ea165f996\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/codemirrorCompletion.js\":\"67398e216cb50e7d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/copy.js\":\"95e6491c683e43de\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dailyPage.js\":\"6d36d563dd4d6e93\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dbForensics.js\":\"3b5eafb5ccdbec85\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dbForensicsHooks.js\":\"7d4cecdd93ede590\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/deleteBlockThroughUi.js\":\"b0fd3144a66cddd4\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dialogs.js\":\"162ac0a4602e4a5f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dom.js\":\"c7586559e63b048c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/downloadBlob.js\":\"9d80c1027808b1eb\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/drawnWalk.js\":\"a6d87875a025f430\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/exportSqliteDb.js\":\"f32b36d3d3df4c88\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fileSystemAccess.js\":\"f774c11c3488f220\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/flipSlide.js\":\"db5a09f81402bddc\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fnv1a.js\":\"649397b1785aa240\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/formatBytes.js\":\"31a2f4a19158fcfc\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fuzzyRank.js\":\"3f170b1f0c47735a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/idbKeyedStore.js\":\"471e0021a04d0482\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/idleCallbackPolyfill.js\":\"b509078d7aa50d37\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/keyboardAwareScroll.js\":\"4f435518df2adb6a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/keyboardViewport.js\":\"7d642c12d3ec7e21\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/lastWorkspace.js\":\"e0ec43d7f10e63eb\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutColumns.js\":\"71a2f4a177f257ee\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutSessionDom.js\":\"4ca42768300ac7cf\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutSessionId.js\":\"56723268b55caa0c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/linkClickGestures.js\":\"fafd7913c8d496e0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/linkTargetAutocomplete.js\":\"f48d64ae3fcaab22\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/localDbCorruption.js\":\"cf16e5e0f56ef4eb\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/localDbRecovery.js\":\"a72af0249051d844\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/markdownParser.js\":\"ad253e14e4781b63\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/memoize.js\":\"886a36eeef62dc5f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/nameFieldCommit.js\":\"144cf49a5f1883a6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/nameList.js\":\"bddfc94404b05f8a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/navigation.js\":\"8ec444b943790f67\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/omnilinerNamespace.js\":\"73f46df1ba53cb23\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/opfsPageScan.js\":\"e9fac63aae55be85\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelClearance.js\":\"545b9b4a93d83735\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelHistory.js\":\"7df16e1710205255\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelLanes.js\":\"0629207e7fecd417\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelLayoutProjection.js\":\"aa9ee0a7e78d87ad\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelScrollAnchor.js\":\"37ea3b0ef583175b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelUrlFlags.js\":\"0eeb51f9b9c940b6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/platform.js\":\"f8401f8eb0ba07a0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/pluralize.js\":\"34999aacf913b995\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyCreation.js\":\"1d7bef69c8bbe900\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyNavigation.js\":\"d8baabc53877c282\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyValueContext.js\":\"e8adf7174937b72d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/react.js\":\"f21569303383c9fa\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/relativeDate.js\":\"366d04e26cca2c56\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/relativeTime.js\":\"96fba25df449d72a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/renderScope.js\":\"df2b7310a13e8d08\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/resolvedThenable.js\":\"bad628139728be33\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/routing.js\":\"5146e01ff9548bb0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/safeMode.js\":\"78c51ba0eaebcbe5\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/scheduleIdle.js\":\"b67d55f0646d6165\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/screenWakeLock.js\":\"5ddb8255e0a5f0e8\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/selection.js\":\"f70daa3ba15b0602\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/softKeyboardGrab.js\":\"47b3bd47ea6ffee8\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/startupTimeline.js\":\"6215ec23190c82ca\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/state.js\":\"4413cb5ced0d9fdb\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/string.js\":\"54882120e46cf32e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/surfaceZoom.js\":\"af423b5efbb42b61\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/time.js\":\"bcbff3ebbf1cc45c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/toast.js\":\"e6e7b26a9dfb16e6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/toggleStore.js\":\"cfbb48bd60d031e6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/untilStopped.js\":\"c86a38168d1593b0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/userActivity.js\":\"526a37bd4278efe2\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/viewTransition.js\":\"3832074f235f4970\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/viewport.js\":\"af9c631e0b9fef0c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/webLock.js\":\"1e9127f126c3e23d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/workspaceRecovery.js\":\"7006efc04167a7c3\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/workspaceSnapshotStore.js\":\"7d95faecd0346fb1\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-compiler-runtime.js\":\"58827b91be4761e3\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-client.js\":\"711ac8bf721bcf6e\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-server-edge.js\":\"9ad3e682111f3979\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-server.js\":\"e1efa7a4b5052daf\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-static-edge.js\":\"b54ff049f88b6030\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-static.js\":\"ddf5d92c6874abd4\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-test-utils.js\":\"f0b510e181a6748b\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom.js\":\"638d2d7c042c7942\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-jsx-runtime.js\":\"e3870edeeeb7d381\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react.js\":\"052e3a274879500d\",\"/knowledge-medium/pr-preview/pr-1914/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1914/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1914/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
