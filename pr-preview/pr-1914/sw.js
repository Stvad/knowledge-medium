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
		buildId: "49a31f42b3cd-d9a0da5b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/\":\"38976e5c9a5285fa\",\"/knowledge-medium/pr-preview/pr-1914/index.html\":\"38976e5c9a5285fa\",\"/knowledge-medium/pr-preview/pr-1914/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1914/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1914/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1914/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1914/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1914/assets/FacadeVFS-DhTj-ED6.js\":\"4df7aa3bc35edc90\",\"/knowledge-medium/pr-preview/pr-1914/assets/OPFSCoopSyncVFS-Cd3XGD6g.js\":\"3b23c213acd82b2d\",\"/knowledge-medium/pr-preview/pr-1914/assets/OPFSWriteAheadVFS-DvWalbDy.js\":\"96caa91eb48d7a3e\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-CjyKgg_a.js\":\"56f6f832d9de1d37\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-async-3zaSseyk.js\":\"3d643d8a7b0f4cf9\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1914/assets/worker-NVD9C0Bs.js\":\"abea3b1c560b81a2\",\"/knowledge-medium/pr-preview/pr-1914/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1914/chunks/app-CzemfkPg.js\":\"8e9ce6698bd2c85c\",\"/knowledge-medium/pr-preview/pr-1914/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1914/index.js\":\"9ff10881194d2bd4\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1914/assets/AccessHandlePoolVFS-DxGzDC4K.js\":\"c8bfce4f50bfa012\",\"/knowledge-medium/pr-preview/pr-1914/assets/IDBBatchAtomicVFS-D0M47mwA.js\":\"4bcbe1a588588b0b\",\"/knowledge-medium/pr-preview/pr-1914/assets/MemoryVFS-Jebj8RPl.js\":\"52f390901ba9932d\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-DHk5QXgk.js\":\"dd071bf4ad932abf\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-async-BPG0drxK.js\":\"8e98161b29931b6f\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1914/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1914/chunks/AccessHandlePoolVFS-Bm1cAqvi.js\":\"3243952902e4d206\",\"/knowledge-medium/pr-preview/pr-1914/chunks/FacadeVFS-CIBUptF2.js\":\"7963050847a6558d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/IDBBatchAtomicVFS-DiypnvUh.js\":\"0b677655b19e2624\",\"/knowledge-medium/pr-preview/pr-1914/chunks/MemoryVFS-CKXqSqI-.js\":\"5230268eab99a72d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/OPFSCoopSyncVFS-Ci0c152J.js\":\"c1763a92d491a0fa\",\"/knowledge-medium/pr-preview/pr-1914/chunks/OPFSWriteAheadVFS-BJ2VRghZ.js\":\"b8c1dac2eab75dc8\",\"/knowledge-medium/pr-preview/pr-1914/chunks/Preview-D9H9mac6.js\":\"e06655b14e8e54e9\",\"/knowledge-medium/pr-preview/pr-1914/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1914/chunks/card-BtcdxGtw.js\":\"09d8a06176f18c6d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-BiQmJ5aP.js\":\"467b9bd893372fa7\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1914/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1914/chunks/mc-wa-sqlite-DZSYCUdb.js\":\"38c336fd2aacefea\",\"/knowledge-medium/pr-preview/pr-1914/chunks/mc-wa-sqlite-async-CkerVRR-.js\":\"bef5b2bebef23cfc\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-BVxrOqJ0.js\":\"770dafb0a24bc387\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-CEIt-6HP.js\":\"31e9906964a19d9b\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-CIgOESmi.js\":\"ef9ab02e845c74f4\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-CMReOrTm.js\":\"58edad372c47e558\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-CaD7Q6Dr.js\":\"d8bf8ec9039adb85\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-KwKBLjOl.js\":\"3d2be26eef2f49bb\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-MgJ4kdmf.js\":\"08697eb583f720ad\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server-legacy.browser.production-Bn-Gbbqr.js\":\"a7785a533f29a39a\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server.browser.production-BclpLarg.js\":\"7ff528e9af18f340\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server.edge.production-B71LZEG7.js\":\"6e8ac934ceb03bd7\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-sOOelO8z.js\":\"cb484e3953987fc6\",\"/knowledge-medium/pr-preview/pr-1914/chunks/server.browser-ym-raleO.js\":\"d68a1deb9399594b\",\"/knowledge-medium/pr-preview/pr-1914/chunks/textarea-DwUo00qa.js\":\"fb64c7f2d1dc6b6d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/ui-CHOWtj5t.js\":\"610f21f21d84a8f3\",\"/knowledge-medium/pr-preview/pr-1914/chunks/wa-sqlite-4u-7N4da.js\":\"ab6082f24cba190f\",\"/knowledge-medium/pr-preview/pr-1914/chunks/wa-sqlite-async-SP4Qp5Qh.js\":\"f1beff2159621739\",\"/knowledge-medium/pr-preview/pr-1914/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1914/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1914/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1914/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1914/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1914/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1914/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1914/src/App.js\":\"6eb5b9c30bd1c19a\",\"/knowledge-medium/pr-preview/pr-1914/src/appUpdate.js\":\"de4d2ac3787b0f58\",\"/knowledge-medium/pr-preview/pr-1914/src/appVersion.js\":\"f291317b560a5eda\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/initialLayout.js\":\"81b7c32d9b260501\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/openWorkspaceData.js\":\"2b674ea651f48ab0\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/resolveWorkspace.js\":\"61461eec059039af\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/workspaceBootstrap.js\":\"186744c4fc837f53\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockComponent.js\":\"f4274fa3b07a2eb6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockCrumbs.js\":\"ff0b11c6c121cf09\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockEditor.js\":\"75ab54ce55e90610\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockLoadingPlaceholder.js\":\"6f68a657458cc221\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockProperties.js\":\"60d1d9fbe7e26885\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockSearchPicker.js\":\"9b9afae16fcbece8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ConfirmBulkDeleteDialog.js\":\"4f561630e0b47d34\",\"/knowledge-medium/pr-preview/pr-1914/src/components/DividerHandle.js\":\"0a6fe52595a1d074\",\"/knowledge-medium/pr-preview/pr-1914/src/components/DraftEditor.js\":\"9ade45ac19727667\",\"/knowledge-medium/pr-preview/pr-1914/src/components/GutterPill.js\":\"1ead3bfd4f8bc9b6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/Header.js\":\"acd1a8d1d9c19d69\",\"/knowledge-medium/pr-preview/pr-1914/src/components/LazyBlockComponent.js\":\"ee0c04f11ece245d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/Login.js\":\"8359c068f1de4605\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ZoomableSurface.js\":\"5d326fd3587b8401\",\"/knowledge-medium/pr-preview/pr-1914/src/components/editModeKeepalive.js\":\"45e038933a222e14\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyDisplay/PropertyDisplayScope.js\":\"eea5acff4234df8f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ac3a683a21e56f77\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/RefPropertyEditor.js\":\"fa831ed05a0e5022\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/RefTargetTypePicker.js\":\"3cf8ae04a6f7e876\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/SelectPropertyEditor.js\":\"a6c54d1aaae142ad\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/TypesPropertyEditor.js\":\"3d1dab0098f80ed9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/defaults.js\":\"94ccfdb1dff8e1e3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/kernelValuePresets.js\":\"409bd9dbf6b10477\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/selectablePresets.js\":\"b6d043946aee54e3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/typesPropertyUi.js\":\"65b9b956a4d310bf\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/AddPropertyForm.js\":\"dcf04179ab517961\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/PropertyPicker.js\":\"05a6c535cadea4a1\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/PropertyRow.js\":\"9757893249458a79\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/Rows.js\":\"aa28d776447cbd6e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/actions.js\":\"eb38b4e7b1b9f1e0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/declarationOnly.js\":\"18209b6ddeb04aac\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/layout.js\":\"ebb71967bc506476\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/model.js\":\"5aa89607c2a7084f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/shapeUi.js\":\"8a271e96decd9781\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/shapes.js\":\"3699b23e9b6ff5f0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/usePropertyEditingActivation.js\":\"75cb07b5227381de\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/visibility.js\":\"8b65f5d271715e9b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanelSections.js\":\"f09fb3131bb0d560\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockEmbed.js\":\"01f5098311656f69\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockLink.js\":\"b54d082465964c07\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockRef.js\":\"73900d9727a016cc\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/CompactReferenceLink.js\":\"6ac7f3ff5edf8c64\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/ReferenceLink.js\":\"072b4fd64d64eea0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/cycleGuard.js\":\"562062407afd7a6b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/cycleGuardContext.js\":\"878a7bf5b006f61f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/linkInteraction.js\":\"3d6d0e00dd33a6c4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/referenceLayout.js\":\"6518e42bd0983983\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/useBlockRefAncestors.js\":\"6bf214c6247d3c05\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockGutter.js\":\"c7156db65d3ba94d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockInfoDialog.js\":\"fd511c3a55065167\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockReadText.js\":\"5c5db332b2410871\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockTypeBlockRenderer.js\":\"5df7db58b9f38f34\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BulletHoverCard.js\":\"ce63361e53521f28\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/CodeMirrorContentRenderer.js\":\"57a3788047da79c4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"d48f64537c285062\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/ColumnResizeHandles.js\":\"867d6a66cc5e8041\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d089a86c7a8952fa\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/DefaultBlockRenderer.js\":\"a2adc1a3ccf1ae41\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/LayoutRenderer.js\":\"865485762b560cd8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/MarkdownContentRenderer.js\":\"da29253c7edc9df2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/MissingDataRenderer.js\":\"7e138ba0eacf435f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/PanelRenderer.js\":\"e810ccc124708a98\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/PropertySchemaBlockRenderer.js\":\"6de7de21fef0ec68\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/TopLevelRenderer.js\":\"c8ffb86798586693\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/blockGutterMode.js\":\"df3114bdc60e1204\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/blockTitleText.js\":\"7c09151df9c47e7a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/fieldCreationKeydown.js\":\"9ccadb7febb768d2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/layoutRootContext.js\":\"df022eae699fc539\",\"/knowledge-medium/pr-preview/pr-1914/src/components/typeChip/TypeChip.js\":\"14196dfa1aef533b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/typeChip/chipStyle.js\":\"049ebdee440372e8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/anchored-floating.js\":\"7223ab9f9ef47dac\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/button.js\":\"38e60912634a426f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/card.js\":\"82c7407e1accd1fd\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/checkbox.js\":\"4ca64e976a3d8054\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/collapsible.js\":\"6283f4216daf52c4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/command.js\":\"39632c31059bd10c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/context-menu.js\":\"22f0bbc519ea245c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/dialog.js\":\"662f9d28e74245b3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/dropdown-menu.js\":\"dfa7a11e13244ba7\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/floating-listbox.js\":\"1f75f6734eb7285b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/index.js\":\"c78182331a687b2f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/input.js\":\"56420971b7a40a09\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/kbd.js\":\"f6630e73fc074f45\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/label.js\":\"6f1d66a41337402f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/textarea.js\":\"d09b55a61fc8034b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/useEditModeYieldKeepalive.js\":\"f9049fe7f9f546bd\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/BootFallback.js\":\"f7dccc2016eb126b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/FocusedRowLazyMount.js\":\"32fe6f67c665bc8b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/LazyViewportMount.js\":\"17f9fbca29a5110f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/LocalDbCorruptionFallback.js\":\"1287b03df826e3a5\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/error.js\":\"91b0bcb23b2e1947\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/lazyMountRegistry.js\":\"0003c467e6407d61\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/suspense.js\":\"5b7959d74e04d3d4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/CreateWorkspaceDialog.js\":\"a7da97c1fe93679f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/PendingInvitations.js\":\"6c9bb605de6d2504\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/SyncProgress.js\":\"c95f1de08eaff804\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/UnlockProgress.js\":\"f41f1acda807f66e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceKeyGate.js\":\"38a0ab2bf4212ec0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSettingsDialog.js\":\"5a04634c09723fd0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSwitcher.js\":\"f835465cc02caddf\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSyncGate.js\":\"0ca60f6391243151\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/ConversionFlow.js\":\"54d5768d26a9e17a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/ConversionFlowHost.js\":\"554f47c49b5a19eb\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/EncryptionSection.js\":\"a54b3b899f8eafe2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/attachmentPrompts.js\":\"c7743e1ef4d78a29\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/bundleFolderPrompts.js\":\"ac2bec775ee6f6f0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/conversionFlowDeps.js\":\"50ba6edadfd559ef\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/conversionFlowStore.js\":\"3b0810adc5d88199\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/flowUi.js\":\"7789301e14d47993\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/useConversionRun.js\":\"773ccbf608c4b485\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/keyUi.js\":\"767195a3ec4a84d5\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/useCloseOnKeyLoss.js\":\"d363387152696bf9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/useCloseOnServerE2ee.js\":\"d2dba5a6cbcecae9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/workspaceUnlocked.js\":\"691deb4213955b71\",\"/knowledge-medium/pr-preview/pr-1914/src/context/backgroundSubtree.js\":\"416e7af2c4527b1e\",\"/knowledge-medium/pr-preview/pr-1914/src/context/block.js\":\"d086de98b4de1c1f\",\"/knowledge-medium/pr-preview/pr-1914/src/context/layoutWsContext.js\":\"9cf30cc8f252a856\",\"/knowledge-medium/pr-preview/pr-1914/src/context/propertyDisplay.js\":\"73264e0178b6b7a1\",\"/knowledge-medium/pr-preview/pr-1914/src/context/repo.js\":\"14d0e16ca99f54f1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/aliasClaim.js\":\"d531fe1a517d324b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/aliasSeatNamespace.js\":\"77d737e52933cc0f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/blockData.js\":\"5eda39c81f4dac25\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/blockType.js\":\"391058e90cd2545b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/changeScope.js\":\"8f1ab667b9834f3a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/codecs.js\":\"c34dcd2e619b0e43\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/derivedData.js\":\"546196920ec49135\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/errors.js\":\"4e32dfeb69250c41\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/events.js\":\"dd858bbb320c8a5f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/handle.js\":\"3dc94ad2b7983504\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/index.js\":\"0fc0bf0882b1eb35\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/mutator.js\":\"57415939be6d06b0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/processor.js\":\"cc995a16b9aef5ba\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/propertySchema.js\":\"e5c93d299dc58458\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/query.js\":\"d2a30f5b320cc456\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/sameTxProcessor.js\":\"31a26a8847129cdb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/schema.js\":\"3dc94ad2b7983504\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/tx.js\":\"3dc94ad2b7983504\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/typedBlockQuery.js\":\"36694b681a8a6994\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/user.js\":\"bde12005e6d4c8e4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/valuePresetCore.js\":\"09850a6225ecc12a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/valuePresets.js\":\"ef55d853f94488ce\",\"/knowledge-medium/pr-preview/pr-1914/src/data/attachmentCleanerIOVerb.js\":\"7ca3e8305339d1bd\",\"/knowledge-medium/pr-preview/pr-1914/src/data/block.js\":\"bb82f5e08fa949e6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockCache.js\":\"1f4496a329bb3092\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockId.js\":\"15caa1132c719cba\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockLiveness.js\":\"1cbcaf8a6fbc82ca\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockMerge.js\":\"04dfb65045c36e0a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockSchema.js\":\"9aec4a67232c04ff\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockTypeLookup.js\":\"b3369dc500cde11b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockTypes.js\":\"81747259ed8f547b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/childrenView.js\":\"32b39238d7d1a3eb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/clientContext.js\":\"88110da7abaa3138\",\"/knowledge-medium/pr-preview/pr-1914/src/data/dbFileSiblings.js\":\"06dce28435e52704\",\"/knowledge-medium/pr-preview/pr-1914/src/data/definitionSeeds.js\":\"4f8cbe70bdd1bcf8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/derivedIds.js\":\"d50c3b97484344b7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/drawnSubtree.js\":\"ecd448bbc982a7b4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/facetBridge.js\":\"3a7260da0d4799b8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/facets.js\":\"b0103a0825df9a30\",\"/knowledge-medium/pr-preview/pr-1914/src/data/globalState.js\":\"d80ce1b92240b81d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/aliasClaimRederiveProcessor.js\":\"dccbeeaeb8348318\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/ancestorBatch.js\":\"bfebcf79ee815950\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/blockTypeTypeifyProcessor.js\":\"414a03eb3c809e60\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/clientSchema.js\":\"2cb5df3c71b3f3d5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/commitPipeline.js\":\"40130292217f003d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/devAssertions.js\":\"4377a39213e66e3f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/firstSync.js\":\"c10c72570b53b57a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/freshInitialLoad.js\":\"44a287b0127b1f5a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/graphBackfillClaim.js\":\"716131eff91257d1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/handleStore.js\":\"51ef90bec824aef6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/idleMarkerJobs.js\":\"a99f2230dfeccac1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/initialDownload.js\":\"ac9b2d1cafaf2f55\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/initializeClientDatabase.js\":\"6734c498cd1b197b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/jsonCanonical.js\":\"89b84e3c0e5eb2f9\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelInvalidation.js\":\"4d6f9ff604f54634\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelProcessors.js\":\"7c6014ce775e6b97\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelQueries.js\":\"fd0ed5e786f9b841\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/mergeTypeMembershipProcessor.js\":\"fb5720bbfe42cd53\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/normalizeReferencesProcessor.js\":\"1ba1619bee444998\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/poolInstrumentation.js\":\"33fd8105582af45e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/processorRunner.js\":\"3bd196c8a6576815\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyCellBackfill.js\":\"7f36d3960291770c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyChildMint.js\":\"3a46ac4c09505a76\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyChildrenProcessor.js\":\"6c911502b740213b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c7ef210ea359172e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyDefinitionSynthesis.js\":\"e4d81011d2e9dd63\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyKeyScan.js\":\"04b0db9e25516efc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertySchemaResolution.js\":\"747b063543da44f5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyValueEdits.js\":\"207dc1173044be28\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/raiseProtocol.js\":\"8fe66d067ba10cb4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/readBatch.js\":\"5d151f8cf3757170\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/refProjection.js\":\"e0e3e08782beeb15\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/referenceTargetLookups.js\":\"38829494883a6fca\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/referenceTargetProcessor.js\":\"0ba8248f575b60dc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/replayMerge.js\":\"6f9592c348359166\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/sqlBinds.js\":\"652d1a12d61bc9bb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"1121eb2572dd8233\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/arrivalProcessors.js\":\"13bece387fde5e77\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/invalidate.js\":\"dfb653c2e23532eb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/materialize.js\":\"3100b317d1019b1d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/observer.js\":\"7b01e27e2f8e9b3a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/reconcile.js\":\"d2e84089f132c6c6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/timingMetrics.js\":\"dbf3102af893d8b6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/treeQueries.js\":\"e4937337b48e0f59\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/txEngine.js\":\"5f16133d0d97b0be\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/txSnapshots.js\":\"063db03ed65efaa4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/typedBlockQuery.js\":\"460acb21e584bde1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/undoManager.js\":\"01bf59d1b4c2d611\",\"/knowledge-medium/pr-preview/pr-1914/src/data/invalidation.js\":\"92f12b0ad8b3f44f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelDataExtension.js\":\"80ad7c7e5cb5385d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelPage.js\":\"2e6d56b90090186f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelValuePresetCores.js\":\"c3c75e57fe3b8a46\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbCorruptionSignal.js\":\"bacaa6d15e8b4638\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbStorage.js\":\"062778a746288110\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbVfs.js\":\"0568dacecb1dadd5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localSchema.js\":\"a09e2ad4d4e93d46\",\"/knowledge-medium/pr-preview/pr-1914/src/data/maintenance.js\":\"4b95f5b29e9f96e5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/mergeProperties.js\":\"bb3d5e1b35a7566c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/metricsConsoleHook.js\":\"3295c9d0a4fda92f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/migrationsPage.js\":\"9f61ff8680716f6f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/mutators.js\":\"1e742727b435566e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/orderKey.js\":\"6a2964a68434d075\",\"/knowledge-medium/pr-preview/pr-1914/src/data/orderKeyPlacement.js\":\"e39d79181ab32705\",\"/knowledge-medium/pr-preview/pr-1914/src/data/outlineSurface.js\":\"e1d940411f258870\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pendingEditorContent.js\":\"bb9cde70b0848b94\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pendingUploadsSql.js\":\"de8c2e6cd585a64e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pluginStateExtensions.js\":\"76f8f9eddce1071b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/powerSyncLogger.js\":\"d93a47bcc49c879b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/projectorRuntime.js\":\"1eb262f60dbb39b2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/properties.js\":\"c6d0a965f410dd2a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertiesPage.js\":\"54c7a478e67b057e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyChildren.js\":\"0d0d41e20f11a372\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionFanout.js\":\"3028b4d25f544ac4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionMetadata.js\":\"bedafa539ef7317a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionRegistry.js\":\"23212665ee1d5476\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDisplayMode.js\":\"2b3a38fb4c35866c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyRowCreation.js\":\"c9313c9f5c9ddc31\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertySchemaCreation.js\":\"78d209c36a05d8fc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertySeeds.js\":\"155a374379acb887\",\"/knowledge-medium/pr-preview/pr-1914/src/data/recentsPage.js\":\"5d755d263740cb60\",\"/knowledge-medium/pr-preview/pr-1914/src/data/refTargetComparableProperty.js\":\"aaecc3d9b96d7bfb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/referenceBlock.js\":\"9bcf126c22452321\",\"/knowledge-medium/pr-preview/pr-1914/src/data/rejectedUploads.js\":\"588393ea74151174\",\"/knowledge-medium/pr-preview/pr-1914/src/data/releasePowerSyncConnection.js\":\"4a74593930d7a6fe\",\"/knowledge-medium/pr-preview/pr-1914/src/data/repo.js\":\"e78895cd3f01dfb1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/repoProvider.js\":\"18af45a86e12f533\",\"/knowledge-medium/pr-preview/pr-1914/src/data/rowProperty.js\":\"dce03cc8a09e426d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/searchFilter.js\":\"206531f3afe66795\",\"/knowledge-medium/pr-preview/pr-1914/src/data/seedIdentityLedger.js\":\"be2b1a06b07e15d3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/stateBlocks.js\":\"3cb652d574f91977\",\"/knowledge-medium/pr-preview/pr-1914/src/data/structuralEditPolicy.js\":\"984d57725ffb7cb0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/structuralInsert.js\":\"971b22e2705afb47\",\"/knowledge-medium/pr-preview/pr-1914/src/data/subtreeDelete.js\":\"6dae773cf2f82dff\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncStreamLock.js\":\"df807f094f9b7491\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncedTableSqlRecognizer.js\":\"05055e6b2b1dcc9f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncedTableWriteGuard.js\":\"15f17687be8b4799\",\"/knowledge-medium/pr-preview/pr-1914/src/data/targets.js\":\"d05e6d5aed94a0fb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeColors.js\":\"3aeae003d4869f60\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeDefinitionMetadata.js\":\"648503a29de280a6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeDefinitionRegistry.js\":\"e5e9f67aa432b038\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeExtraction.js\":\"4d680696355d8541\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeInitialValues.js\":\"2a5f6b3a244bd524\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typePropertyGroups.js\":\"ecada178f26cb3ff\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeSeeds.js\":\"16678740db5c953b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeTagger.js\":\"0af8137977971070\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typedRecords.js\":\"e530a28ed4b1d9d2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typesPage.js\":\"cbed7b1ba6c9ebcb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userPrefs.js\":\"6e4d02c6c87ee649\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userSchemasService.js\":\"685466da77010ffc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userTypesService.js\":\"a463ff74f0307d21\",\"/knowledge-medium/pr-preview/pr-1914/src/data/valuePresetRegistry.js\":\"857520a3438a19ae\",\"/knowledge-medium/pr-preview/pr-1914/src/data/visibleChildren.js\":\"aeef96b343d4b76e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceConversion.js\":\"2ee463adb22a150c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceFirstSync.js\":\"fd98c2b9c4f1b80f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceIdNamespace.js\":\"0b1d16b5c37144f0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceSchema.js\":\"1a1d675ab0aaa527\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaces.js\":\"ddd764d14bfeb501\",\"/knowledge-medium/pr-preview/pr-1914/src/data/writeAheadLog.js\":\"b8a3294669008aed\",\"/knowledge-medium/pr-preview/pr-1914/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/BlockPasteShellDecorator.js\":\"08ec70673105ba2b\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/atTrigger.js\":\"c20cfffa78f94a30\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/autocomplete.js\":\"1b658ed1676e4d50\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/codeMirrorExtensions.js\":\"19ee015a775ad8ce\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/contentFlush.js\":\"8f0c3b7b16709f0a\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/defaultInteractions.js\":\"544d711d4f696a96\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/editSettleSignal.js\":\"64a8528c75fb938b\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/insertImage.js\":\"4dfa57ad59f4bc42\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/referenceCompletionRange.js\":\"41b60d1d6f4aa0f3\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/referenceTargetTypes.js\":\"9c0cfa318654d192\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/syntaxContext.js\":\"ae7bcff136372535\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/triggerMatch.js\":\"6ce48e6faf816ddb\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/AppRuntimeProvider.js\":\"397e9c7f561c300c\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/BlockFocusShellDecorator.js\":\"7748cc50292ae575\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/ExtensionRenderBoundary.js\":\"a4b246f4865ad0de\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/PanelContentRecovery.js\":\"4de219296841400d\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/apiCatalog.js\":\"6e8f0ac69ed72cc3\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/approveExtensionHere.js\":\"027786c6a4b49368\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/armedCutAppMount.js\":\"74921e0760fbe2d6\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/batchableKeyedStore.js\":\"c65d6aa79f78be69\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/blockInteraction.js\":\"305b50f46fe62e45\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/blockSelectionAction.js\":\"669a89a382189263\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/compileExtensionModule.js\":\"02bf0cf0d71cd4ef\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/compiledModuleCache.js\":\"cefc9fc0a60ccfb9\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/continuousGestures.js\":\"a311c082c4934c79\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/core.js\":\"36c8fe72a88886cb\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/defaultRenderers.js\":\"6363b84d5bc05c21\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/definitionFanoutAppMount.js\":\"7dc98237e4ca2603\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dialogAppMount.js\":\"9b3054b348a0a4e4\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dynamicExtensionSeeds.js\":\"fe891d0700f013c3\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dynamicExtensions.js\":\"74fe2ea2f1ad8b91\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/exampleExtensions.js\":\"ca8f49bc85466f02\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionApprovalStatus.js\":\"738cae6e3ab2aa3c\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLoadErrorToast.js\":\"9fc17183a02b3bab\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLoadErrors.js\":\"4f61806e6dff3dd6\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLookup.js\":\"27816965bcc01f29\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionToggles.js\":\"92d95cdbe96e08c6\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionUtilitiesCss.js\":\"4ac0e8187e4a2e04\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/kernelPageDeletionGuard.js\":\"2730abb02d347e00\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/liveRuntime.js\":\"90704b0bc7196947\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/openExtensionsSettings.js\":\"9881fefc3dd24b46\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/overridesCache.js\":\"0da6022ddbddb7e5\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/pluginIds.js\":\"34128810a93728cf\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/processorRejectionToast.js\":\"a9349d04006acd79\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/runtimeActions.js\":\"4130ee7ac2577f49\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/runtimeContext.js\":\"3b4895428c5b3d80\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/staticAppExtensions.js\":\"3a78d92a397c484a\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/staticDataExtensions.js\":\"392745630106efb3\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/toastAppMount.js\":\"bacc73e64d5f04fd\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/useOverrides.js\":\"1730d98437f9b76f\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/useShortcutSurfaceActivations.js\":\"55e7bed7f523f11c\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/discoverToggleTree.js\":\"b5e93cc2303098bc\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/facet.js\":\"35e3cda709b97e2b\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/resolveAppRuntime.js\":\"302e75078fe6aa73\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/runtimeEvents.js\":\"eb62da92a699e8e7\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/togglable.js\":\"f0c6370d302be587\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/variantFacet.js\":\"db1c3dd72121052a\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/verbFacet.js\":\"b383059adf2ab1c8\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/block.js\":\"27291aa8482f9dd7\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/focusedChild.js\":\"776ab4ed5beb759b\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/propertySchemas.js\":\"f28888ef6cbaccc5\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/typeRegistry.js\":\"d427a1c76a5161ca\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useAncestorCrumbs.js\":\"f6a827a41387923e\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useAutocompleteListbox.js\":\"94b301759c7d3184\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useDebouncedSearch.js\":\"227a555bf916ee29\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useDebouncedValue.js\":\"1f7387be4822f37a\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useFacetValue.js\":\"115f8f28a7421966\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useIsFocalRender.js\":\"459bf20f0c17e1d0\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useIsReadOnly.js\":\"6d91fdb138781216\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useMaterializeBacklog.js\":\"dd07dffee22ab911\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useMinuteClock.js\":\"ab3822ed9191dda7\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/usePanelLayoutProjection.js\":\"adc56461dac0ddbb\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/usePendingInvitations.js\":\"c297d0f9307c689f\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useRendererRegistry.js\":\"3d0d53926d6f7907\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useRetainedFieldRows.js\":\"f1f1ab14e7488f65\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useWorkspaces.js\":\"2a64a1f436989177\",\"/knowledge-medium/pr-preview/pr-1914/src/lib/utils.js\":\"33bc284ff4192a80\",\"/knowledge-medium/pr-preview/pr-1914/src/main.js\":\"a31a6732e8a9aa3a\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/MarkdownImage.js\":\"dddacd2d0aff3729\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/blockSeparators.js\":\"dbb54d85581530bb\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/context.js\":\"c66c09a186bc866f\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/defaultMarkdownExtension.js\":\"e6fe2fd7a4641515\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/extensions.js\":\"1be7516390a64975\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/renderMarkdownHtml.js\":\"66c208e716bb76c5\",\"/knowledge-medium/pr-preview/pr-1914/src/minimal-editor.js\":\"7e7c590caab14d20\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/armedCut.js\":\"b3f0a0639b426cc1\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/captureMediaVerb.js\":\"59b2f80a7a29f073\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/clipboard.js\":\"3cd0e24ec705c0dc\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/decision.js\":\"bada49ac7dfa09f4\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/operations.js\":\"f2e4d452e365e3cf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/account-header/AccountHeaderItem.js\":\"71ac3a9359b8871b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/account-header/index.js\":\"cd799598489adb8e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"42556d7264ec3a35\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/askAgent.js\":\"8aeb000adeac2d3a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/askedStore.js\":\"630048f2dc27630e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"35ce6295cf1a3807\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/chipState.js\":\"281319039bcdde9c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4cf1a4014eb57b49\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/index.js\":\"ace535c4ec76aa42\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"ed99aff441266154\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/schema.js\":\"4d9cc813c4d672a8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3a9e404ee5875f4e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a5d35f2c6cb3ff49\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/addMedia.js\":\"bf5058976ba4f476\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/backlinks.js\":\"ce5b9d9990fc6065\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/block.js\":\"96f0e077bcd63b30\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/context.js\":\"24de332d5761860e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b5f642df1ee5a6fd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/index.js\":\"2426ca17c7fb04f5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/outline.js\":\"42f192e002ff7be5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/properties.js\":\"c9a00f47490041ff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/refs.js\":\"8dd8595203409d16\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"cac8c7aac161e762\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/search.js\":\"836a970a21931866\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/shared.js\":\"00b67b030273939f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6478683673f4524f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/text.js\":\"4e13828fd136706f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentWrites.js\":\"08b8185851388caf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/authoringCatalog.js\":\"95c38f771cebca38\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/blockRefTargets.js\":\"03466613eb06d41c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/bridge.js\":\"a8d0bc359ecaf118\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/bridgeLoop.js\":\"9743526bc0722895\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/changeHistory.js\":\"4b321ac0cbdceb98\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/commands.js\":\"58b3f4167b0d9a80\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/commentsCommands.js\":\"080e0bad8f107611\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dataExtension.js\":\"8633477fa1f12b0d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dataModelGuide.js\":\"bd741716533eaf7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dayPropertyInputs.js\":\"3e800eec1cd76f91\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/describeRuntime.js\":\"57ca2f2ab34caca7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/extensionLint.js\":\"7ecac11fb97fefd6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/grainAudit.js\":\"8c82004b37beea43\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/healthCommand.js\":\"e4f975a2703625e5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/index.js\":\"017902602840292e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/presetIdentity.js\":\"e3604bb105e499b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e5ec7037faa82e25\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/readMedia.js\":\"e8f9be4d3d22e3e2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/schema.js\":\"1f79eb3717315640\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/serialization.js\":\"d4853649c6b15f7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/targets.js\":\"8c32a2804df71fe4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/tokens.js\":\"c70888c8255dba6d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/watchEvents.js\":\"9412ea7af40e9438\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/workspaceGuard.js\":\"f64d94cfa6261d8b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/writeCommands.js\":\"2bef672c788edd25\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/AliasCollisionToast.js\":\"5b0160acb3d2481f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/DuplicateNameBanner.js\":\"d509a8dfcd805d7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/collisionMerge.js\":\"1e02233767abd53e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/dataExtension.js\":\"eb56ff4546c863e2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/index.js\":\"ca24d8e40c67c203\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/mergeCollisionAction.js\":\"e0e1cda6b3fc1add\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/pageStyling.js\":\"6e7d5dcd9501e28b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/rejectionToast.js\":\"e870e71160ba273a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/syncProcessor.js\":\"12a78090ba9cef58\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/actions.js\":\"c1023155d6cd346e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/addComment.js\":\"8ba608baebe77dda\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/anchor.js\":\"5b94639091ba0772\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/anchorState.js\":\"9e7232a2ec7954a0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/commentLinks.js\":\"a3bbd2b5feb2b5ef\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/confirmThreadDeletion.js\":\"7fc1a5874488eca9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/container.js\":\"2457c0fffa6a2498\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/dataExtension.js\":\"cde9b04f9223cbdb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/deleteComment.js\":\"1eecc1db634f4aa0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/highlights.js\":\"d72b47a7dfd3efde\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/index.js\":\"74ec14a03645dff8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/linkedCommentsPill.js\":\"8f3d25eec4e062d3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/margin.js\":\"789374402525cb9c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/marginAnchorLinks.js\":\"c03a3e3b01008b10\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/marginSchema.js\":\"eb114f9b9d2a5ae3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/newComment.js\":\"4478212305979706\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/ownThreadPicker.js\":\"16f0856100a57ba6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/placement.js\":\"24cf858dbab89e76\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/queries.js\":\"45bfe764768825ff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotePosition.js\":\"91d7856980846ec7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotedIn.js\":\"e17f988c0007c78d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotedRange.js\":\"a1ff596c9c1e7cbc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/rangeRefs.js\":\"a2c562799c0edec0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readHighlights.js\":\"2042b956aaf3d927\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readSelection.js\":\"49ba04468fb22dfb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readSelectionUi.js\":\"0a1605010c410b85\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/reanchor.js\":\"6c10165d811a6729\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/schema.js\":\"8c1b63d3138aaaf1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/scope.js\":\"745827f617e12c76\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/scopeThreads.js\":\"cca030f11288d6d8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/splitRetarget.js\":\"150e687cca795505\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/suggestionCard.js\":\"f5b2b2f7d4f634b1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/suggestions.js\":\"594945727feea6ae\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/summaries.js\":\"a4d1e3835baaeaf0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/summaryBatch.js\":\"737a55bd19de5f1d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/surface.js\":\"1b2cddd05584332a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/threadNavigation.js\":\"907918af844d5969\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/threads.js\":\"b40298615e864760\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/ui.js\":\"4b8249d1e0a84174\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/uiStore.js\":\"db11d0c51564e877\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-intents/appIntents.js\":\"4cf1f0856aab41d5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-intents/index.js\":\"6bef5166e83fe402\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-update-prompt/index.js\":\"5fd201d8aac6e4a7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-update-prompt/status.js\":\"43ef5a0e8c09ab1b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e65d02f29df1e83b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaBlockRenderer.js\":\"17fa435c55f7eff9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaDownLaneReplicator.js\":\"1d5a79902422e399\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaUploadReconciler.js\":\"f03b1f74a97b42f0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetDownLane.js\":\"2773c7ac6e10ffdb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetResolver.js\":\"af8ed5ca6814a958\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetUpload.js\":\"cd649a69d32578ac\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/attachmentCleanerIO.js\":\"da2199949ec7e2a9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/supabaseAuditIO.js\":\"da14e299b518b96b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/blobStore.js\":\"d2e2f1978ae49e7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/browserMedia.js\":\"e760fc9567aa914e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/byteStore.js\":\"5d7a9758d3ce49d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/cleanerIO.js\":\"9e097a2353caa74a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/cleanupAttachments.js\":\"0345f15c07207419\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/dataExtension.js\":\"57b4effcc21afe3e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/downLane.js\":\"4b67257541c3e403\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/index.js\":\"8cd400505aa637a4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/insertImageContribution.js\":\"7e003988628ebe9e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/laneArming.js\":\"ca09f4878460bb1b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/laneLock.js\":\"e60ca8445a16e601\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaBlock.js\":\"cd519b7f8763a6ca\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaCapture.js\":\"cd7db83bef88bde9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaLanes.js\":\"376c9de700601774\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaViewers.js\":\"e654eda7760e4e86\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaViewersFacet.js\":\"1cc0089e2e3bc0c9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/pasteCapture.js\":\"1f917660e21c6478\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/resolver.js\":\"762925909055a59e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/retryUploadsAction.js\":\"ef4dda5331cfa254\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/storagePaths.js\":\"e94be258d84ebe25\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadDrain.js\":\"65c06e04fc58f767\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadLaneStatus.js\":\"350b51b61ba27970\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadReconcile.js\":\"5ad295225b662267\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadRecovery.js\":\"8aaaa177e32dad75\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadStore.js\":\"cfa9931c770600b8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/useAssetObjectUrl.js\":\"09223e5484fbff7b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e777e72e427d4182\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/BacklinksViewSection.js\":\"91b44bd58eecdac2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/facet.js\":\"8cdb08a2a7b2914e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/index.js\":\"7d1492dbc175f979\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/prop.js\":\"49c7ad8b63bf2a10\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BacklinkFilters.js\":\"05b68aa6c798482c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ba0bf50fbefe282f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BlockEntry.js\":\"cca1a2edc0fc0a73\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/LinkedReferences.js\":\"cb53e5e4bd7d4c25\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"669df4dc0264ed7b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/dailyNoteDefaults.js\":\"ea316a4161870aa7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/dataExtension.js\":\"67da8c8a0886268d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/edgeExclusions.js\":\"df7426b8da88a56c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/filterProperty.js\":\"d29ccfa628143279\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/index.js\":\"93ba0fa250cb75e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f4d731c5329a48ce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/applies.js\":\"14ecb8cac17ab3f6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/countQuery.js\":\"29ebbe4cf74e71a8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/expansionStore.js\":\"22573100cb7661ea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/index.js\":\"f392aeeeb23d047f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"445040c910397ddc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/presentationInvalidation.js\":\"6f2417edbeb65a02\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/propertyEditorOverride.js\":\"bfc971cb97b5dc12\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/propertyFilter.js\":\"49559139ab6c27c1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/query.js\":\"ac2156f187de53bb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/resolveFilter.js\":\"8e3195a78eac2668\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/sourceBatch.js\":\"d605deb482a0f25d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/sources.js\":\"ae6637c5de9c7c13\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/useBacklinks.js\":\"83e35a6656edc3d5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"d8aae60db4a3a6f9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/BirthdayCelebration.js\":\"dbdcdfb43fb282d7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/BirthdayOverlay.js\":\"48efd3a00d1ab484\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/gate.js\":\"99a973a91dab7cd2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/index.js\":\"87fdff35a2e68300\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/wolfTheme.js\":\"e6f6af3aea2e1af7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/BlockDragLayer.js\":\"fa3529f41a5c6d1f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/dragController.js\":\"e4333b11df43969d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/dropTarget.js\":\"6d2ef7765cc092c0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/index.js\":\"8afa407e212547ca\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/projection.js\":\"6c33d63ad7bea118\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-info/BlockMetaCard.js\":\"d2e5f09a744819a3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-info/index.js\":\"d586ee81f97898b6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/AddTagDialog.js\":\"fc048fac1192cd49\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"742d16995a2b2e0a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/TagNameIssueHint.js\":\"3088db28ede56c44\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/addTagAction.js\":\"03f380fd4b6e98be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/appendTag.js\":\"f98afff5045102c8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/config.js\":\"e78bc7088275fd2f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/dataExtension.js\":\"8b75fc89f9678794\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/index.js\":\"eb66cb2333e7ed14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/propertyEditorOverride.js\":\"2056f0eac73263f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/BreadcrumbList.js\":\"21b86048637e1da9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"14f25d6d1ddf9c9d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/Breadcrumbs.js\":\"634fe60d08fc97ea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a7792d761ef37d7e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c964fcc99c7dbbef\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/index.js\":\"4f18e48a617f4e95\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4427b5a4856570d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/CharacterCountItem.js\":\"5f85d3fbcae82981\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e79afc592327cf70\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/actions.js\":\"739313680c281edf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/blockType.js\":\"38c0e96c0df5bf6d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/charCount.js\":\"69af87801e6c4ab1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/dataExtension.js\":\"6d1504bd8cf2815c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/index.js\":\"04d4246d433e4ecb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/profiles.js\":\"17900df436540118\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/properties.js\":\"f8d00679b0d769c4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/subtree.js\":\"635f357b70811a60\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/textCounts.js\":\"ef30203753a3c9b7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/colemak-keybindings/index.js\":\"7de27a07bc12189b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/CommandPalette.js\":\"ed003be38b5fd784\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/HeaderItem.js\":\"84cb0f9a4c88b448\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/context.js\":\"4ebf07fd5d598426\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/index.js\":\"7d9190d4b0528788\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/selection.js\":\"4a5b0ee887448fa8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/toggleStore.js\":\"c23a7f1b4657f443\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/useCommandPaletteActions.js\":\"4c0392a663dcb77b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/ContributorBadges.js\":\"d1d100c56166bbce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/ProfilePicture.js\":\"8528b2986a61549f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/author.js\":\"e64ea3ff4a7f4a6c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/codeMirrorExtensions.js\":\"9d3433f2a3ed74d8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/dataExtension.js\":\"5555781cdeddb973\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/index.js\":\"df2131fe0d1800d8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/mentionAutocomplete.js\":\"2719d2c83acb10b9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/processor.js\":\"2f3a2b121a8ff2af\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/profiles.js\":\"80c7e6cb92226694\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/queries.js\":\"80d82848dd74133b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/schema.js\":\"fa7171a6ea3f9243\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/useCommentAuthor.js\":\"0533312902f8444d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"b682667488792d63\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b4ac8251bf277159\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/index.js\":\"60f6b209bb2beeba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"716d7b66e06f6841\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"30661540fd071813\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/CalendarGrid.js\":\"cc8c72716491bf32\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DailyNotePicker.js\":\"7c72033373e1a798\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"467f6a03a6b213a9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateNavDecorator.js\":\"1ed469c43a924cdc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateScrubOverlay.js\":\"66a00ae55ba50bd1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DayPropertyControl.js\":\"68a48859cf8886d3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DayValueReferenceControl.js\":\"d1b607ec3477df09\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/HeaderItem.js\":\"6dd361430be1a132\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/ReschedulePicker.js\":\"c93471dd27593b8b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b7942b5e1c7e2b47\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/actions.js\":\"bbe6e58f823c943e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/blockDateAdapter.js\":\"832f3ff709d6a5fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/calendar.js\":\"5fd6f460fb48e08e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dailyNotes.js\":\"f01b60e06f5f9a33\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dataExtension.js\":\"4a28bab493b91688\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubActions.js\":\"86d9be0589d39764\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubGesture.js\":\"823ac35d1ed3a578\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a64da18079bd5e9e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubRecognizer.js\":\"61e21c0ac7dc0c95\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dayProperty.js\":\"fe900009c706a6ec\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"0ef17282849f1432\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/deletionGuard.js\":\"b5d1e36643540516\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dueQuery.js\":\"c2277041584cc794\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/index.js\":\"e85a0cd349664b5b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/landing.js\":\"53d09a5f09153f4c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/localSchema.js\":\"82c501da3d76d4ad\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/referenceDateAdapter.js\":\"527f08d6cb0dbda1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/rescheduleAction.js\":\"6e4b923d086ce4ad\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/schema.js\":\"5bc4a9dc277863cd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/spreadBlockDates.js\":\"28f8a4a6b2a749e2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/spreadDatesAction.js\":\"9248542232b59af7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/today.js\":\"34a47ed593c81e94\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5171f9725e514e06\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"04ccc30214937f4f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/audit.js\":\"f3e55ab3b7d583ee\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/auditAction.js\":\"f3d711319081ae9d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/auditRanges.js\":\"0e0b3ac818fdde39\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/diagnosticsSource.js\":\"f68d884aaaa2f281\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/divergenceScan.js\":\"0e42a19f1397f26b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/index.js\":\"265a165372334b5f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/propertyChildrenChecks.js\":\"dccf9da830d9c37b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/referencesMirror.js\":\"4fb0701d72bea6ab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/rowJson.js\":\"290addb963ca38bc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/schedule.js\":\"916c3616c0a52c7c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/store.js\":\"c6b37b83e4a7a154\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/action.js\":\"fd4d24af0eaacdc3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/index.js\":\"cc5ac66213461554\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/plugin.js\":\"27597ca7addeb8a0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"685aa40406437458\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/actions.js\":\"a5e3d59c9fe6b8ae\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/changeMarker.js\":\"d2a5d03078fb567c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/diagnostics.js\":\"424e22170dcf49e0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/fileSystemAccess.js\":\"655ff7e4dd37ca66\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/filenames.js\":\"a720c387b2af8e18\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/index.js\":\"992c2745760db814\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/mirror.js\":\"5cdd1d421e6d4971\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/runLock.js\":\"23722282eae037c8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/runtimeHealth.js\":\"c21a57b3d7246783\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/schedule.js\":\"15bd3634ee2b4758\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/store.js\":\"becb0b42bc04c913\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/default-themes/index.js\":\"946a5319853b5d7c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/default-themes/themes.js\":\"3715f4d83c7fd17d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/diagnostics/facet.js\":\"4a6ff24cc6b75c97\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/diagnostics/useDiagnostics.js\":\"1afde03092d0d716\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/dismissals.js\":\"6cceae75d12d00cb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/index.js\":\"42141960efaa646c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/status.js\":\"d07e6a8b88af6f27\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/store.js\":\"6e82d8fa06349ae0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b6c08e8ebe0faae7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/ExtensionsSettings.js\":\"a8dab148a345339f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/actions.js\":\"0365fca0bf260d34\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/config.js\":\"6abf6623dc3d05ca\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/dataExtension.js\":\"4c6fb9a579e66b14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/effect.js\":\"8ff33ec0034d2276\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/index.js\":\"23dc2213c8ec966b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/propertyEditorOverride.js\":\"7086f825d383d9bd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/useToggleTree.js\":\"14d5625f42d3ae94\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/ExtractTypeDialog.js\":\"123bc5d7a46ba02b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"2cd579bd21a3faa7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/PropertyShapePicker.js\":\"1ff6d04d6d8c063f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/action.js\":\"181d94264478e086\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/index.js\":\"7149a9b9a30948fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/FindReplaceDialog.js\":\"74af54a018db2339\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/HeaderItem.js\":\"236050031d8d156f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/dataExtension.js\":\"1c5d62ae23d8c6a3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/index.js\":\"fa0240a1f66e840f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/search.js\":\"0a95c97cc4200500\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/toggleStore.js\":\"c38e42d42b701ac0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/LocationPropertyEditor.js\":\"e89fb817291dc506\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/MapView.js\":\"df483e02ec23c35b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/blockTypes.js\":\"63265f8af461acd3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/codeMirrorExtensions.js\":\"eaab7f6523fc1a9f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/createOrFindPlace.js\":\"71df51d2b2b00141\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/currentLocation.js\":\"0cb0bb8c01ac1206\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/dataExtension.js\":\"0c7109e9eefc5c43\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/geoContentDecorator.js\":\"8bb23c46ecba24b9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/googlePlacesClient.js\":\"3966177f593531dc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/index.js\":\"384dcb5278f96824\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/locationsPage.js\":\"590b4c48af39d8e3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/mapViewport.js\":\"2c73307e6cbf67a8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/pickCurrentLocation.js\":\"1c039d8b0ef91e58\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/placeAutocomplete.js\":\"f7179017f1ed2172\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/placeNameCollision.js\":\"2e32d88e87adbb6a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/properties.js\":\"93ead7e3f1ca694b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/propertyEditorOverrides.js\":\"8a2c6e6c07c7c8e5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/query.js\":\"f599a46096aaed80\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/usePlaceSearch.js\":\"f9a9d07568e5a2f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f40c67d06ece5cae\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"6319126248850e85\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"6d121f7d3b9aac4f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/config.js\":\"29238dd78e4177ba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/dataExtension.js\":\"85016d3c2d3b4ce5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/facet.js\":\"6f1fb05b2ff5a929\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/grouping.js\":\"3719ff0e1ba79aff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/index.js\":\"2a749dd2e3de6c33\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"306aebcb5fc0dda6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/query.js\":\"dadae023991a8515\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/resolveConfig.js\":\"13011294a332f965\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"3f8d72c863251fcf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"72db33a4ea4111b1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/HtmlDocumentContent.js\":\"92f1c8434b142bc6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/HtmlFrame.js\":\"8f4e906598428763\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/actions.js\":\"914ab4951dcd76f9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/blockType.js\":\"552f38af2b364793\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/confirmRunScripts.js\":\"2f88e2d22b532562\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/dataExtension.js\":\"3acfb3863ffb71aa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameAnnotations.js\":\"ca81fe98cae21c7c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameDocument.js\":\"1afaa3adefa98756\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameTheme.js\":\"4bcd1dab48851fc0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/index.js\":\"3516e0a9d25dd1c4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/scriptConsent.js\":\"9237673466f4fe1d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/sourceMap.js\":\"7ae640d7923e5adf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/useDocumentScripts.js\":\"f161cdd8d8f28f98\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/index.js\":\"fa1a8c22b84fa186\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/record.js\":\"e23334c970cf23e8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/recordStore.js\":\"d93c136d4422e41c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/responsiveness.js\":\"0ef38c14ae59680d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/schedule.js\":\"6b9d80d7b84dc649\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/sessionContext.js\":\"d7e53beab3b0736a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"58b633a2a68a91bf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"43c9082eb03f97b0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/actions.js\":\"8b09ed1fb2047795\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/config.js\":\"d7b23cb81ce55a2c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/dataExtension.js\":\"f1996805ac768dd0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/effect.js\":\"23efd9d3063eb039\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/index.js\":\"ce74d55992dd6950\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/keyCapture.js\":\"b675b7f8122b2b4b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/overrideStore.js\":\"b5d27beb29c09448\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"e3e00219d5665551\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/HeaderItem.js\":\"98664443f66d4396\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/LeftSidebar.js\":\"4badf344ed47a757\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/actions.js\":\"4a7a2ca73737b445\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/facet.js\":\"38096d74d998575a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/index.js\":\"c05c828669355dc5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/shortcuts.js\":\"f3ce3ee6e47095cb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/toggleStore.js\":\"5967313af4c2657f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/MergePicker.js\":\"8b3f02696dcbc438\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/index.js\":\"758f13268f4b884e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/mergeAction.js\":\"30305a1c65f396ab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/strategy.js\":\"27122d202566be86\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/Button.js\":\"00f3fdb5c9c0733a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"873a494a55a730fd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/defaultItems.js\":\"31118542e4d7dde2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/facet.js\":\"0aa38be6a51d9e11\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/index.js\":\"1e862131bab4ff7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"56139589b1c5e34c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e8771d716d432c46\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"9d11a26498a432ce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/facet.js\":\"316041116de1cf5c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/index.js\":\"1cb61d19df43d3c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/MoveDestinationPicker.js\":\"dc28005f696e5de2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1a002ae34e088b44\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/contextMenuItem.js\":\"d35b01216f503122\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/index.js\":\"90779e7a6ff4dc8d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/moveAction.js\":\"e74a1da47796e9be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/moveBlocks.js\":\"cf5fcb8f494489a4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/selectionAfterMove.js\":\"b475ff5e06748925\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/TutorialBanner.js\":\"2c88cbcfe3f0b415\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/action.js\":\"bfb2e3e9bf170cf1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/bannerDismissal.js\":\"dd8f71fd3be003f3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/documents/cheatSheet.js\":\"d6dfc6041d613428\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/index.js\":\"91338049804e3edd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/keys.js\":\"84870bc3cd2cc2af\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/landing.js\":\"63940919d9ff226a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/outline.js\":\"6dde37dfca6de74c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/seed.js\":\"ebbb4289ed1399e5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7f7f04d1675b43ea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/analyze.js\":\"b289ba75b70d448c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/diagnosticsSource.js\":\"35fba2d665af0541\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/index.js\":\"3584c74efc342530\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/load.js\":\"7d5503aca8bbd336\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/monitorRun.js\":\"1b7ef770cc44ad78\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/schedule.js\":\"41646c19318983b1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/series.js\":\"92b208e07c329969\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/store.js\":\"887a69ae9657e596\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/trendAction.js\":\"c5ddd9a39d744fff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/verdict.js\":\"bf01ac39f027d470\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/clickToEditAction.js\":\"1913d89299ac14c5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/index.js\":\"c90e48d11ee3bc95\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/interactions.js\":\"7ef1b61dd837afc1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"4514c0742d8912f0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/MigrationGate.js\":\"7280ddbf9d85c325\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/MigrationGateDialog.js\":\"d32033f2d599be73\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/action.js\":\"c30a86dd459eb978\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/index.js\":\"96485aff3ebe5dfa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/localRunMessage.js\":\"d5bd3fb9430c82fc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/plugin.js\":\"0c68c635e527a2f0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/progressReport.js\":\"30f37e0052bffffb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/sweepProgress.js\":\"9c064d33f95c8232\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/FieldRowRenderer.js\":\"1762d5561ab873f4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/ValueRowRenderer.js\":\"05948cc6d85ed0bb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/actions.js\":\"8a2eefc9d7a3caf8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/autocomplete.js\":\"1211edce23199a93\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/fieldRow.js\":\"45621b21c2ef9998\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/index.js\":\"84b684d570ae5d16\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/referenceWarning.js\":\"5f5b7160fc96b471\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/valueAutocomplete.js\":\"3ede4b30a0586ec5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/valueSchema.js\":\"b40ac5ac1c1eb330\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/HeaderItem.js\":\"21191d372ac1bff2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/QuickFind.js\":\"e47ad5dc6bd60e05\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/index.js\":\"b2b597364816f886\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/recents.js\":\"0d6e4cffccb329c3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/resultItems.js\":\"e15743394b671ba3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/selection.js\":\"3816fc474d5efa64\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/toggleStore.js\":\"52a0f824d7eb5f5b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/HeaderItem.js\":\"3a065176d81ee928\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/RecentsPageBlockRenderer.js\":\"24019722e3f3f040\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/grouping.js\":\"2dd97025a83ffe23\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/index.js\":\"41ac0efa8628f6e3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/target.js\":\"d460ef67cb80838d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/codeMirrorExtensions.js\":\"9a1d7e8bf90fea49\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/contentPrefill.js\":\"b1acd7f9f8e73070\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/dataExtension.js\":\"4b088475b8fce856\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/index.js\":\"24b95665ed647060\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ca5ee930f1763e55\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/invalidation.js\":\"9341fdec1b227e38\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/localSchema.js\":\"b1af635f4671a404\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/blockrefs/index.js\":\"82176edea5d50d04\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"cf0331ae3ebf6b89\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/index.js\":\"36e1de6f34584719\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/referenceNode.js\":\"d47ddd73942d7dd9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/remark-reference-occurrences.js\":\"6d4e0f6bffe79952\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"fc961a4c5d820f51\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/index.js\":\"cc16193530aade65\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"af66492ed11e6ec3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"36c73b7408112c50\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/mergeRetargetProcessor.js\":\"9bfda4886d3fcd5b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/parseFence.js\":\"1271e86cd208c76c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referenceParser.js\":\"cf447068d43ea22c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referenceProjection.js\":\"309399800d3d945b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referencesProcessor.js\":\"b2f5e7d259166548\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/renameProcessor.js\":\"a9bd4a1ef5f1477e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/spanReplacement.js\":\"ef6ea512da69df1d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/htmlToOutline.js\":\"23285cc74ccfab81\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/index.js\":\"4d172048b76206dd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/normalizeClipboardDom.js\":\"b069f40f65df1c28\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/pasteDecision.js\":\"f7376cb10387ea70\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/action.js\":\"284e2a339f56b91e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/blockIds.js\":\"c2cf09fbc866f101\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/content.js\":\"f18744f45b2356be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/effect.js\":\"4d734eb4e43d15d4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/ids.js\":\"2c0f48388eb07371\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/import.js\":\"459b1c245429beda\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/index.js\":\"6998d2a30e0b19b8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/plan.js\":\"da34299afb405844\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/plugin.js\":\"cebfae01d5cbebbd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/promotion.js\":\"30b2a48a0ccd94db\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/properties.js\":\"3d1cb82d73a9c99d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/references.js\":\"4a46a4087e7131cd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/report.js\":\"6d82dad2c77bb781\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/roamMemo.js\":\"5d39985a10195dd9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/runtime.js\":\"52f6bf59785e6183\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/schemaReconciliation.js\":\"ac2b7eca3505f22e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/srsMarkers.js\":\"d12ee257b4e1dfc3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/todo.js\":\"a88ec2f7ec5683e6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/typeCandidates.js\":\"fe24e2c1bffee9f9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/types.js\":\"20774aabad959ee2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/search-health/index.js\":\"68d0e2a659e1c8c8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/search-health/store.js\":\"7ea160bbc341862a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/HeaderItem.js\":\"23a9953de1777752\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7bcba828e88457c6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/index.js\":\"f972d5a1fbf0ccb2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/model.js\":\"3ae9663375589d59\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/toggleStore.js\":\"5880f79574ec1f24\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/useKeyInspector.js\":\"66980f9edfc73994\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5120b7da1adff4d8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/ShellDecorator.js\":\"191b3f831a52894a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/actions.js\":\"13a0883a2d226fda\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/exclusionsFacet.js\":\"2d73399c781e9c52\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/index.js\":\"027f69089a9bd17a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/shell.js\":\"b3ffb2da58e0b0bd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/surface.js\":\"4a9529f4fcdd3ccb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/walker.js\":\"d6a42387f4e4372a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6822e3ba524753ca\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/dataExtension.js\":\"b13c0bdd40d025b5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/index.js\":\"eb11c83cc2dffb93\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/indicator.js\":\"3b28f0d034b8142e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/moveSrsState.js\":\"3959a05c0e182b3a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"57518dd3f01361b3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/scheduler.js\":\"16429517f2b73fd9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/schema.js\":\"0b65313c90fa0ac8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"47ed7633eea58d7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/srsClipboard.js\":\"9a43e24701541542\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"4458d2283617fe14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/DailyNoteReviewHint.js\":\"da38215f2c77f2fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/DeckPicker.js\":\"64844b73c0ec6563\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewControls.js\":\"39a27d73a1297c7c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewDeckRenderer.js\":\"213716b51138135e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewSession.js\":\"e251e2a697e6a53a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/actions.js\":\"9aa2a9ff4125f175\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/archive.js\":\"7a2a7a7061d58bcd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/dataExtension.js\":\"a232cbccdecd8d8a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/deck.js\":\"ae653b45ae8f54d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/dueQuery.js\":\"394d35603f1d8f3e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/gradeDecision.js\":\"44786ce324440fa4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/index.js\":\"ef14b5b14b689a1e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/keyHints.js\":\"d3991ffb8c69b278\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/reviewCardLayout.js\":\"4d0ebec9abd29e12\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/reviewProgress.js\":\"1a9cad042ff8b287\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/schema.js\":\"2070179ee719728a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/useDueCards.js\":\"33549b607d6e8e3e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/startup-metrics/index.js\":\"5fb9e61b45630dcf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/startup-metrics/record.js\":\"0f80280ee9c9cefc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/index.js\":\"4811fb7d5cc6b307\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/persistenceStatus.js\":\"4b1dab0be7b1124a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/requestAction.js\":\"0a00069885f7a9a3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/TypeChipsDecorator.js\":\"de8e928c017465c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/codeMirrorExtensions.js\":\"7934098210837c5c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/index.js\":\"b87935cb21446d9a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/typeAutocomplete.js\":\"a6c02ad4866add58\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"518df52e7a419fee\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/actions.js\":\"2b7c40a54f863435\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/anchor.js\":\"006a7658c5d17a61\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/events.js\":\"3b1dc9303fdb6881\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/gestureActions.js\":\"363404ea1d958416\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/index.js\":\"747157ce11b20f20\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"aa0192a2372206a6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/collect.js\":\"567b527105565ecd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/index.js\":\"6fc3a057e3ab1809\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/record.js\":\"a7963318a4528373\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/RejectionDialog.js\":\"6f994f488ebf3acb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/SystemStatusHeaderItem.js\":\"14f254ef1e771ffd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/index.js\":\"5a7e1286e5bde0a2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/model.js\":\"7db34e25f47d9e2d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/queueCounts.js\":\"ae259c58c36cdbf7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/rejectedHelpers.js\":\"223a76e444d4351c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/rematerializeAction.js\":\"f0e5e179db23cff4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/useHysteresis.js\":\"d35e9890621326a9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/ColumnHeaders.js\":\"fc9f589c1eb357c3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/QueryUi.js\":\"f66cd4b5126f77f2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/TableLayout.js\":\"60cedf175db04e78\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/actions.js\":\"466a8dd8f75fd383\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/cellEdits.js\":\"d783b7f71c367685\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/childrenViews.js\":\"04c0e940f86cc624\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/columns.js\":\"165add133f11dd22\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/controller.js\":\"6f2f029c93dde0f2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/convert.js\":\"3a24d598ee2d6261\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/dataExtension.js\":\"230eb9456d76d464\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/index.js\":\"622a0d19dd03ec43\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/keys.js\":\"fc07f1acb159a9be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/model.js\":\"b8a404fb9cfbb7dd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/QueryText.js\":\"3f9b370ddf793be0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/backfill.js\":\"d29a487cb8100231\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/completion.js\":\"6d505961a9d3e3f5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/format.js\":\"44adfcfbe828cdc4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/parse.js\":\"ea27b14c6f33f7b1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/queryValue.js\":\"5ad26838a0a91751\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/registrations.js\":\"d69ef02de7d46bf4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/source.js\":\"adbbe9b72b72d254\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/registry.js\":\"5af2edb3f6a587b0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/rowGutter.js\":\"5ad98a442c87a78d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/rowVerbs.js\":\"f39e0388a62373e3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/schema.js\":\"4920db8c4557314e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/sort.js\":\"0116d427c39c0acd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/effect.js\":\"939ff4f2268e4417\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/index.js\":\"35a29c9be5243590\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/theme.js\":\"8fd5628adc35921c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/actions.js\":\"8e9d638945ebe0dd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/dataExtension.js\":\"b3f42e8b1beee624\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/index.js\":\"8d39860b93f62453\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/schema.js\":\"842484a16e8cc806\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e59e834531b88f47\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/actions.js\":\"84c758c31b2c6e14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/defaultItems.js\":\"787f3424bddc037a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/facet.js\":\"394ef2e26482da6c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/holdRecognizer.js\":\"ca6fa2461cf439d3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/index.js\":\"df26c5c86cd7df1a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/UpdateIndicator.js\":\"22b3e6c91078d645\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/index.js\":\"91ee8efe4f371bd6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/loadTimes.js\":\"1f7aab5cbb58718a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoNotesRenderer.js\":\"0e130e6ee96f781d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoPlayerRenderer.js\":\"09b0a12a1a06db02\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoTimeStamp.js\":\"3444df7ae542fddf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/actions.js\":\"77147100348c0f9d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/index.js\":\"9ce492c79cd16fe5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/markdown.js\":\"d12a2e6ed0aec30e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/notes.js\":\"b4d04a16bea5bb1c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/registry.js\":\"dfcc1e4e9f1866de\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/remark-timestamps.js\":\"83f42a9e62a94566\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/view.js\":\"cb81c086a122dba5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/LinkHints.js\":\"a5bf4ea35f9dd6e0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/index.js\":\"3244fff2292e4077\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/model.js\":\"614152d47e4164f8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/settings.js\":\"53b613f7e653ad9b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/actions.js\":\"d530941456cda91b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/index.js\":\"d6ce125f5866cabe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/interactions.js\":\"b0bfd9a117f40021\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/workspace-header/index.js\":\"ab03bb97f3839d85\",\"/knowledge-medium/pr-preview/pr-1914/src/registerServiceWorker.js\":\"9b508c39a178c9ec\",\"/knowledge-medium/pr-preview/pr-1914/src/requestPersistentStorage.js\":\"8986cd91ab8b2d7d\",\"/knowledge-medium/pr-preview/pr-1914/src/services/authRequestDeadline.js\":\"a63f324cfc8f239f\",\"/knowledge-medium/pr-preview/pr-1914/src/services/authStorage.js\":\"cc2c1d32c5e98013\",\"/knowledge-medium/pr-preview/pr-1914/src/services/powersync.js\":\"08c4d801b557f50f\",\"/knowledge-medium/pr-preview/pr-1914/src/services/supabase.js\":\"9798924cf1e4b178\",\"/knowledge-medium/pr-preview/pr-1914/src/services/uploadErrorClassifier.js\":\"cddf762d84353342\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/ActiveContexts.js\":\"df7db44dc08a96fa\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/HotkeyReconciler.js\":\"021cfd4b7096e302\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/WipeLocalDataDialog.js\":\"f4149af905bb16d7\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/actionDispatch.js\":\"88d15974cfcefdb5\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/actionRefItems.js\":\"8d5aac4d538a5781\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/applyKeybindingOverrides.js\":\"865edae7f3046456\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/blockActions.js\":\"70be3be037bba8b0\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/blockMergeGesture.js\":\"0c28516d29a1f0cc\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/canonicalizeChord.js\":\"3f50628a2bdb8897\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/defaultContexts.js\":\"d7491020bd25bfd5\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/defaultShortcuts.js\":\"08d5ec02219fddbc\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/effectiveActions.js\":\"b724743bf29b49fa\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/gestureAction.js\":\"b3d50281aaa0d58c\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/gestureBinding.js\":\"d8142360b1df1c97\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/holdRegistry.js\":\"bf3a96c173da2627\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/keybindingConflicts.js\":\"a4b964c0ab57fbfe\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/keybindingOverrides.js\":\"534629f07f455190\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/pointerAction.js\":\"e1ed3647211b9be4\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/resolve.js\":\"d93e43daa490d92e\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/runAction.js\":\"6eb237ccb275051f\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/sequenceMatcher.js\":\"e8ef51ee98e173da\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/types.js\":\"277fa744e57c9858\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/useActionContext.js\":\"f687ba4c86f50948\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/useActionDiscovery.js\":\"225a39e659c95f77\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/utils.js\":\"9cf01be19b5b3d93\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/bootStore.js\":\"be82befb6f2be175\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/previewDatabases.js\":\"39962c637f3ce23a\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/byteTransform.js\":\"a951868315f30b66\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/attachmentCleaner.js\":\"0a525bbdcb563ac0\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/attachmentParts.js\":\"a0700866ec7a29de\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/bundleParts.js\":\"23f5e786c7d2be7a\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/bundleRecord.js\":\"8fa8af88105e3c90\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/manifest.js\":\"5f9f1fbfa224fe2c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/takeBundle.js\":\"409091f926a9c63a\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/verifyBundle.js\":\"5f2cf1ddbc375a03\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/cleaningStage.js\":\"2c79d08598de3c90\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionKey.js\":\"1a0afbb9919f40b3\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionServer.js\":\"6253e4976c3e1cab\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/flip.js\":\"021207d527057b06\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/flipAttempts.js\":\"e914f8cfc5b68a84\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/pages.js\":\"8180be61b8db4b80\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/preflight.js\":\"59ee6257b6f7f892\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/reseal.js\":\"147ef738cdf47c75\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/runConversion.js\":\"33df0f6cddaaa11c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/runLock.js\":\"7575fe35c9e59e06\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/sealing.js\":\"6eb81e9383276b66\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/sealingStage.js\":\"ac2aa44b099402b7\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/stage.js\":\"98f9f24ec5047899\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/verifyReseal.js\":\"aa038a83629f4a4d\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/aad.js\":\"9c293495b0f0c591\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/aead.js\":\"2d653bd8aa960bf0\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/base32.js\":\"d052a364d4ef6d1d\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/base64url.js\":\"2293906e4f2ad5b2\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/binaryEnvelope.js\":\"c3490d4114624186\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/byteAead.js\":\"95ac03260f5b7107\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/canary.js\":\"ddf653ce54d129fe\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/contentHash.js\":\"7f97d00346e4e16a\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/contentKey.js\":\"6f12d2fca7c3e9ca\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/derivedIdNamespace.js\":\"a28426e24de4d98e\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/envelope.js\":\"3967e1c98ae107ae\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/hex.js\":\"0f4602f0e1085424\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/sha256Hex.js\":\"b33c28c5b2890813\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/workspaceKey.js\":\"6919a2dfb145c218\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/conversionState.js\":\"e5230d209fe78a5c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e9166b879696085b\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/pastedKey.js\":\"e455a6487ac6e863\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"8c79c386ddc70301\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/upgradeWorkspacePin.js\":\"5b9db8fcd971b0a0\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/keyStore.js\":\"8ee0b57b90371c90\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/mintWorkspaceKey.js\":\"ceadd2fbb4887680\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/modePin.js\":\"f567812b11205ef8\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/openWorkspaceKeys.js\":\"ec39bf8bde0b722c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/resolveWorkspaceEntry.js\":\"ba1f07a521958b45\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/resolver.js\":\"1c3bee40a1e6d8b9\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/workspaceAccess.js\":\"a091074697bba959\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/transform.js\":\"7e36b527f8c6de74\",\"/knowledge-medium/pr-preview/pr-1914/src/themeBootDefaults.js\":\"76e4ccb58ab9d2b8\",\"/knowledge-medium/pr-preview/pr-1914/src/types.js\":\"bb1b1b3812aa3d1a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/ClientLocalSettings.js\":\"11aa6f5c40e063c0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/abortableSleep.js\":\"d01c16831f027f56\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/array.js\":\"589300ac3162ea05\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/backlinkAutocomplete.js\":\"cd20191335ffad23\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/blockCrumbs.js\":\"fb3a34e47a87f0f1\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/blockrefAutocomplete.js\":\"f65f6dc89b1bddc3\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/cadencedIdleJob.js\":\"8c92daebdc0c82c6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/callbackSet.js\":\"3bc426b993700ab6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/clientId.js\":\"ea6af3c75c0ebbe0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/codemirror.js\":\"144e778fe6bc1580\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/codemirrorCompletion.js\":\"4f567a09b706d956\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/copy.js\":\"8495e91f7f0115ce\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dailyPage.js\":\"5761a7f089dcbe0d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dbForensics.js\":\"dd610bf2d813eb24\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dbForensicsHooks.js\":\"2c6a04a738f5f72a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/deleteBlockThroughUi.js\":\"d851b08e2a76e4ff\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dialogs.js\":\"38a6a1f120eab1bb\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dom.js\":\"7d6c0e0964113a17\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/downloadBlob.js\":\"2f1c22e8cc18c00c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/drawnWalk.js\":\"a424d4b313b64631\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/exportSqliteDb.js\":\"b6e2f9bde3f368a7\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fileSystemAccess.js\":\"857290bc6ffca738\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/flipSlide.js\":\"b4ee20238acc2836\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fnv1a.js\":\"b03763cddb701d7e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/formatBytes.js\":\"ad3890389926e7da\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fuzzyRank.js\":\"9b237946b318e90c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/idbKeyedStore.js\":\"68ded9dc04eb24d9\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/idleCallbackPolyfill.js\":\"736e206e5b6dc687\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/keyboardAwareScroll.js\":\"2ceb035d30dd2f26\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/keyboardViewport.js\":\"b2371f29a6575029\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/lastWorkspace.js\":\"d247c2a19e8e097e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutColumns.js\":\"0a5947038e27dd6d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutSessionDom.js\":\"7c0252d829947aca\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutSessionId.js\":\"dc1e140518b27ce5\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/linkClickGestures.js\":\"273b12d8c6b99907\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/linkTargetAutocomplete.js\":\"4f5b71bac7853f03\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/localDbCorruption.js\":\"64681c22b96e5047\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/localDbRecovery.js\":\"31ef78d6485fc726\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/markdownParser.js\":\"32f1f271325c9c56\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/memoize.js\":\"f7093107a0b851e4\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/nameFieldCommit.js\":\"a60915d8baac24bc\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/nameList.js\":\"edaeaaf5456dc7dd\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/navigation.js\":\"a275d87afb0a5a9d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/omnilinerNamespace.js\":\"5ad336bb44360591\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/opfsPageScan.js\":\"6abdcc0f5a927e96\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelClearance.js\":\"5fb632458715493e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelHistory.js\":\"3686589433d095a6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelLanes.js\":\"b34cb31fe09a04a6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelLayoutProjection.js\":\"1994e916fae7988b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelScrollAnchor.js\":\"02a38eacd747317f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelUrlFlags.js\":\"8902acbfe07b06f0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/platform.js\":\"e8af4b0a823ca135\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/pluralize.js\":\"95ba9d0cdaacdd16\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyCreation.js\":\"291d77d9aab1eaa1\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyNavigation.js\":\"4b0009f82604f940\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyValueContext.js\":\"24800a29d54e7dae\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/react.js\":\"8916e362691b25d0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/relativeDate.js\":\"1f0754795851b156\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/relativeTime.js\":\"5ff0e6892b4aa5de\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/renderScope.js\":\"633992660a5a6361\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/resolvedThenable.js\":\"4670e1f3537adef1\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/routing.js\":\"8fcb9df3e8be5207\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/safeMode.js\":\"876f536eb9283fa3\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/scheduleIdle.js\":\"aecfcb1c77f6a19f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/screenWakeLock.js\":\"d8a0dc56b8fbd47a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/selection.js\":\"1c1d4280a812839f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/softKeyboardGrab.js\":\"200d9e48c371f18d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/startupTimeline.js\":\"28e55100bd6378a0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/state.js\":\"4c15b7e1122e1294\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/string.js\":\"5332754c246917ed\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/surfaceZoom.js\":\"7d7719cb10f43372\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/time.js\":\"57e5cc00a90dae8e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/toast.js\":\"8b78254b23c94c4b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/toggleStore.js\":\"4dc92cd6049df379\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/untilStopped.js\":\"45b06dc0b21086c4\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/userActivity.js\":\"84cb3d35935618d2\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/viewTransition.js\":\"8c5fc22dfb722c7d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/viewport.js\":\"9ede02558dba8055\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/webLock.js\":\"d9bbcd6c2cb0b8ba\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/workspaceRecovery.js\":\"d00a72a52eca1d03\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/workspaceSnapshotStore.js\":\"b96f5b0ad0cdc5cc\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-compiler-runtime.js\":\"7b4078cb826ce726\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-client.js\":\"00cdb2be1f1437a7\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-server-edge.js\":\"889be0fbc12faee4\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-server.js\":\"5b582867225498af\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-static-edge.js\":\"f32ad3ce135754fc\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-static.js\":\"3e727ff4b7441204\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-test-utils.js\":\"2b210ea0bf1e603a\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom.js\":\"4195c66a97ff9aa4\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-jsx-runtime.js\":\"aa21fd8c1b700afa\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react.js\":\"b36d9d3a57583c1f\",\"/knowledge-medium/pr-preview/pr-1914/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1914/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1914/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
