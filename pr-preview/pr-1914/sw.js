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
		buildId: "68d7c1eda3f6-926e2390",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/\":\"f5c5169e0c37f393\",\"/knowledge-medium/pr-preview/pr-1914/index.html\":\"f5c5169e0c37f393\",\"/knowledge-medium/pr-preview/pr-1914/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1914/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1914/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1914/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1914/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1914/assets/FacadeVFS-DhTj-ED6.js\":\"4df7aa3bc35edc90\",\"/knowledge-medium/pr-preview/pr-1914/assets/OPFSCoopSyncVFS-Cd3XGD6g.js\":\"3b23c213acd82b2d\",\"/knowledge-medium/pr-preview/pr-1914/assets/OPFSWriteAheadVFS-DvWalbDy.js\":\"96caa91eb48d7a3e\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-CjyKgg_a.js\":\"56f6f832d9de1d37\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-async-3zaSseyk.js\":\"3d643d8a7b0f4cf9\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1914/assets/worker-NVD9C0Bs.js\":\"abea3b1c560b81a2\",\"/knowledge-medium/pr-preview/pr-1914/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1914/chunks/app-DM_lul7p.js\":\"59a4ee7f3e69c0b6\",\"/knowledge-medium/pr-preview/pr-1914/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1914/index.js\":\"dc36a04187613a0e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1914/assets/AccessHandlePoolVFS-DxGzDC4K.js\":\"c8bfce4f50bfa012\",\"/knowledge-medium/pr-preview/pr-1914/assets/IDBBatchAtomicVFS-D0M47mwA.js\":\"4bcbe1a588588b0b\",\"/knowledge-medium/pr-preview/pr-1914/assets/MemoryVFS-Jebj8RPl.js\":\"52f390901ba9932d\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-DHk5QXgk.js\":\"dd071bf4ad932abf\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-async-BPG0drxK.js\":\"8e98161b29931b6f\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1914/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1914/chunks/AccessHandlePoolVFS-DpTVvUy_.js\":\"4d11c5fd8f78956d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/FacadeVFS-BXiX0pJZ.js\":\"e0f46b8485c63262\",\"/knowledge-medium/pr-preview/pr-1914/chunks/IDBBatchAtomicVFS-IhNiU73C.js\":\"e4ce0b39f2d1c794\",\"/knowledge-medium/pr-preview/pr-1914/chunks/MemoryVFS-Dk0Xg9Lk.js\":\"f7875f058f452585\",\"/knowledge-medium/pr-preview/pr-1914/chunks/OPFSCoopSyncVFS-B-5iOKY8.js\":\"3f24a893de6ebe23\",\"/knowledge-medium/pr-preview/pr-1914/chunks/OPFSWriteAheadVFS-CpZ-_Mgl.js\":\"6f7266077c97368a\",\"/knowledge-medium/pr-preview/pr-1914/chunks/Preview-CJa_JfJV.js\":\"2ed509656e03c7b9\",\"/knowledge-medium/pr-preview/pr-1914/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1914/chunks/card-45LaD50o.js\":\"5e12469acc7d8de0\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-DywC7TSp.js\":\"a2a4f023c48b8fb5\",\"/knowledge-medium/pr-preview/pr-1914/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1914/chunks/mc-wa-sqlite-DZSYCUdb.js\":\"38c336fd2aacefea\",\"/knowledge-medium/pr-preview/pr-1914/chunks/mc-wa-sqlite-async-CkerVRR-.js\":\"bef5b2bebef23cfc\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-3JaTDOYN.js\":\"1629a5813fde7811\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-A0Ebnksp.js\":\"13b238b9f2d936eb\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-Bmx1wQmn.js\":\"5454e3ac0785032f\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-Cj3rD-Hi.js\":\"12bb3bd3cbf82a3b\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-DRGIWkS7.js\":\"e6288437c9084dd4\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-DiecsWF9.js\":\"5195cf28bfe423c0\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-QViv3Jqt.js\":\"a9eaadabe1196b2d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server-legacy.browser.production-DvTlbsSg.js\":\"608acd8b11b8b67a\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server.browser.production-BuA8jKia.js\":\"67c74385f6df7a5b\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server.edge.production-DdYEgKNV.js\":\"d854e81e75ee0c7d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-oDIYlSSt.js\":\"cf852d0754f3d5a4\",\"/knowledge-medium/pr-preview/pr-1914/chunks/server.browser-JAgzj7Oo.js\":\"f1325007e2b36f50\",\"/knowledge-medium/pr-preview/pr-1914/chunks/textarea-DeV8ma_z.js\":\"bbe526571c5effac\",\"/knowledge-medium/pr-preview/pr-1914/chunks/ui-CxYfeznM.js\":\"72c0c375046d6028\",\"/knowledge-medium/pr-preview/pr-1914/chunks/wa-sqlite-4u-7N4da.js\":\"ab6082f24cba190f\",\"/knowledge-medium/pr-preview/pr-1914/chunks/wa-sqlite-async-SP4Qp5Qh.js\":\"f1beff2159621739\",\"/knowledge-medium/pr-preview/pr-1914/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1914/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1914/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1914/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1914/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1914/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1914/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1914/src/App.js\":\"bb5e78598ddb7fdf\",\"/knowledge-medium/pr-preview/pr-1914/src/appUpdate.js\":\"f7d78801f2ed182b\",\"/knowledge-medium/pr-preview/pr-1914/src/appVersion.js\":\"288bc396abb32c8b\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/initialLayout.js\":\"4e64dceed6a5f23b\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/openWorkspaceData.js\":\"5461265d0d300665\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/resolveWorkspace.js\":\"2fe46f44b491c088\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/workspaceBootstrap.js\":\"4efd62f3b871a44e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockComponent.js\":\"1dbe225a31cd357e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockCrumbs.js\":\"4d9419dcb8dec46f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockEditor.js\":\"f39ac7ca4f16a2f9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockLoadingPlaceholder.js\":\"7bfa4dd3b20cd6fb\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockProperties.js\":\"21daae2ec7025a3c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockSearchPicker.js\":\"ea2542b940969bfd\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ConfirmBulkDeleteDialog.js\":\"43a813307f499204\",\"/knowledge-medium/pr-preview/pr-1914/src/components/DividerHandle.js\":\"9dcb404ca3b60e5c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/DraftEditor.js\":\"70384e8e27873cfd\",\"/knowledge-medium/pr-preview/pr-1914/src/components/GutterPill.js\":\"937dcf42dd864770\",\"/knowledge-medium/pr-preview/pr-1914/src/components/Header.js\":\"67c38c343c5eedc2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/LazyBlockComponent.js\":\"ee975214ff98de87\",\"/knowledge-medium/pr-preview/pr-1914/src/components/Login.js\":\"9d50eea14d14ec50\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ZoomableSurface.js\":\"7933ed2fe9b01bd9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/editModeKeepalive.js\":\"5fc43ed64fafaca8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyDisplay/PropertyDisplayScope.js\":\"6a7bef3dd43978cd\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"b0aa0a1e47203411\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/RefPropertyEditor.js\":\"96f0eac249844d0b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/RefTargetTypePicker.js\":\"4b41c02ca8021ef9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/SelectPropertyEditor.js\":\"bc6c407384366c4e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/TypesPropertyEditor.js\":\"02a95a448a2cb9c9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/defaults.js\":\"7e9a446432eda70b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/kernelValuePresets.js\":\"ae18a8c29d35c585\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/selectablePresets.js\":\"d4e7a8b174d7d07b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/typesPropertyUi.js\":\"978ef40de0f40c2d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/AddPropertyForm.js\":\"05b360ae4a470461\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/PropertyPicker.js\":\"dc7e81a2be3bd34e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/PropertyRow.js\":\"9b8e4a0da94fc272\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/Rows.js\":\"70a52c020dae6e54\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/actions.js\":\"2d43ab54ceb6db03\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/declarationOnly.js\":\"39438a8b073828c2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/layout.js\":\"4397d8c860057749\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/model.js\":\"9f12b956a546cfba\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/shapeUi.js\":\"f90135b14b677883\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/shapes.js\":\"8a3ec754b422dd2c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/usePropertyEditingActivation.js\":\"76d275aeaeec68e7\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/visibility.js\":\"14abfa94ca518291\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanelSections.js\":\"deb76937a3b7198c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockEmbed.js\":\"590d1f0d7aeaecd8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockLink.js\":\"132725180e810499\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockRef.js\":\"8c17e00ee3478088\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/CompactReferenceLink.js\":\"0f16ed0da6bde726\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/ReferenceLink.js\":\"dff02869bcbc35b9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/cycleGuard.js\":\"b5352679b1f4c9e8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/cycleGuardContext.js\":\"996b4c18f4eb1bb3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/linkInteraction.js\":\"c628b867d65abad1\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/referenceLayout.js\":\"55f58e0e6c8476ae\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/useBlockRefAncestors.js\":\"a7404668b95bc670\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockGutter.js\":\"8d66cded5c796dab\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockInfoDialog.js\":\"83f04c933eea01a6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockReadText.js\":\"3a79a28042dbd49c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockTypeBlockRenderer.js\":\"00a5b0cab711a53a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BulletHoverCard.js\":\"c98e3f836a5eee13\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/CodeMirrorContentRenderer.js\":\"fe67cd1bb7f6bcb9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"41b0d52dc110de99\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/ColumnResizeHandles.js\":\"9e3e46012bdfc36b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"09dadf619f6f7b31\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/DefaultBlockRenderer.js\":\"e187801eef8f8bb3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/LayoutRenderer.js\":\"f20aaa3163bfaba6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/MarkdownContentRenderer.js\":\"4f3d8fa7c643745d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/MissingDataRenderer.js\":\"ca26d0188436f227\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/PanelRenderer.js\":\"21f3af9c07e0bc32\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/PropertySchemaBlockRenderer.js\":\"160292e27eb1794b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/TopLevelRenderer.js\":\"cef01d06de30e888\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/blockGutterMode.js\":\"79e69e581c08552d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/blockTitleText.js\":\"2e653521e0806000\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/fieldCreationKeydown.js\":\"606bb17d52c5d4bb\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/layoutRootContext.js\":\"25a0c48f351488c5\",\"/knowledge-medium/pr-preview/pr-1914/src/components/typeChip/TypeChip.js\":\"fd7b12dd93006e34\",\"/knowledge-medium/pr-preview/pr-1914/src/components/typeChip/chipStyle.js\":\"3c26bc20714de55e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/anchored-floating.js\":\"7a4681e7f1edb88e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/button.js\":\"0364bee4a4f7f352\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/card.js\":\"86ba8eb17473aa0c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/checkbox.js\":\"a033addb7b81a03d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/collapsible.js\":\"1a0b9a2160694242\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/command.js\":\"23978f9aa8e51676\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/context-menu.js\":\"f5c2355532051cb4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/dialog.js\":\"58365b46c2c70fcf\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/dropdown-menu.js\":\"a68afe0693a24d47\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/floating-listbox.js\":\"0578ccd171826d35\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/index.js\":\"f8bc1842a5971d69\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/input.js\":\"45230fad8ed152ab\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/kbd.js\":\"db67e61e7f4d54e8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/label.js\":\"aa412f81eb8056d6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/textarea.js\":\"dfc04a0d27ad3a66\",\"/knowledge-medium/pr-preview/pr-1914/src/components/useEditModeYieldKeepalive.js\":\"89d87a3016b03c70\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/BootFallback.js\":\"903ba9341613bc3b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/FocusedRowLazyMount.js\":\"f451cd9bce166470\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/LazyViewportMount.js\":\"cc6340e508378d25\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/LocalDbCorruptionFallback.js\":\"0ea80a37b7cf22be\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/error.js\":\"8adefbcd4fa86eaf\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/lazyMountRegistry.js\":\"28ec6403ca1f692b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/suspense.js\":\"671204242427467d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/CreateWorkspaceDialog.js\":\"1cf8748c6423860f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/PendingInvitations.js\":\"73640632970a5c52\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/SyncProgress.js\":\"ba880f7f659055cc\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/UnlockProgress.js\":\"e971c7094e7d7f9d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceKeyGate.js\":\"bcb284477c298fe7\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSettingsDialog.js\":\"7c069c106c048180\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSwitcher.js\":\"842321815974d83b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSyncGate.js\":\"71c5d268431d324c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/ConversionFlow.js\":\"5fd56f76c654fcc1\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/ConversionFlowHost.js\":\"1a129afd2293228f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/EncryptionSection.js\":\"a59f331a6e5242c9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/attachmentPrompts.js\":\"29419ca2e9ab3d59\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0b481421f6cd0bee\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/conversionFlowDeps.js\":\"146adc1db1cdfb72\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/conversionFlowStore.js\":\"c56beb7d6b8ebad9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/flowUi.js\":\"3522d36069742182\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/useConversionRun.js\":\"2f3374334a330738\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/keyUi.js\":\"977d28775aea011c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/useCloseOnKeyLoss.js\":\"408fe7ea066d650e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/useCloseOnServerE2ee.js\":\"c72e9a5f700bf494\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/workspaceUnlocked.js\":\"d7a268806e4d73c0\",\"/knowledge-medium/pr-preview/pr-1914/src/context/backgroundSubtree.js\":\"538060ca10a2516b\",\"/knowledge-medium/pr-preview/pr-1914/src/context/block.js\":\"8269716fc6ff3e02\",\"/knowledge-medium/pr-preview/pr-1914/src/context/layoutWsContext.js\":\"40d95886e1c93f2d\",\"/knowledge-medium/pr-preview/pr-1914/src/context/propertyDisplay.js\":\"18e84c4d51d7218e\",\"/knowledge-medium/pr-preview/pr-1914/src/context/repo.js\":\"5ee5f12f9e34b6c3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/aliasClaim.js\":\"e773882add343a59\",\"/knowledge-medium/pr-preview/pr-1914/src/data/aliasSeatNamespace.js\":\"043564c721b9efa3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/blockData.js\":\"a5c7e7c366f03151\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/blockType.js\":\"8b3d6eb8937e96d8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/changeScope.js\":\"2935a7b80e57d2e8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/codecs.js\":\"654be5db48641eb2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/derivedData.js\":\"f583430a12233e4c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/errors.js\":\"b45ceeb47eebc10b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/events.js\":\"17476dc97745fa77\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/handle.js\":\"9b59f16cca138092\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/index.js\":\"afb42e9212434330\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/mutator.js\":\"4abb13171bb2dc13\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/processor.js\":\"aab3d9e3b87b9d77\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/propertySchema.js\":\"b1329359c4365d92\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/query.js\":\"96a67f5e9ce33080\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/sameTxProcessor.js\":\"f657ef2eb4f39088\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/schema.js\":\"9b59f16cca138092\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/tx.js\":\"9b59f16cca138092\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/typedBlockQuery.js\":\"4b0d3d0e37348d02\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/user.js\":\"0dbf3a6a60a8fd3b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/valuePresetCore.js\":\"bbce50d1d98f96b2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/valuePresets.js\":\"a00763dcef492341\",\"/knowledge-medium/pr-preview/pr-1914/src/data/attachmentCleanerIOVerb.js\":\"0cc6961333479594\",\"/knowledge-medium/pr-preview/pr-1914/src/data/block.js\":\"83907991d9cdc381\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockCache.js\":\"276a1b53724a6ff9\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockId.js\":\"39c26c38ecb75ea6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockLiveness.js\":\"1ce4c752258daedf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockMerge.js\":\"c3ff0b2da5128325\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockSchema.js\":\"eea22767f692723d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockTypeLookup.js\":\"bfcaf46af3147d11\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockTypes.js\":\"3fe4a2e7565e747c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/childrenView.js\":\"561d049b3e0683c1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/clientContext.js\":\"67059350877c9385\",\"/knowledge-medium/pr-preview/pr-1914/src/data/dbFileSiblings.js\":\"c21e4dd59cd1cb90\",\"/knowledge-medium/pr-preview/pr-1914/src/data/definitionSeeds.js\":\"7fc9a052be821d23\",\"/knowledge-medium/pr-preview/pr-1914/src/data/derivedIds.js\":\"c0da3dd8f321c701\",\"/knowledge-medium/pr-preview/pr-1914/src/data/drawnSubtree.js\":\"c30497e4494b976b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/facetBridge.js\":\"1c8e69c4b10f9930\",\"/knowledge-medium/pr-preview/pr-1914/src/data/facets.js\":\"a05973e61c97376b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/globalState.js\":\"7871f3dea6b1c206\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/aliasClaimRederiveProcessor.js\":\"380ad22c5b023d0a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/ancestorBatch.js\":\"ce026214886e47ab\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/blockTypeTypeifyProcessor.js\":\"68195c08bca36b9f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/clientSchema.js\":\"fc4407be0d910d06\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/commitPipeline.js\":\"6fe183b69585c59c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/devAssertions.js\":\"a20c618b3515a283\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/firstSync.js\":\"8ef077d73ec76334\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/freshInitialLoad.js\":\"5e121bad9ef61a48\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/graphBackfillClaim.js\":\"82fbdab109fc320f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/handleStore.js\":\"fa8fd3f3a3cdbbbf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/idleMarkerJobs.js\":\"192f2e7a8f38087a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/initialDownload.js\":\"24064e7eb81f75a6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/initializeClientDatabase.js\":\"f12182e6e2dfe012\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/jsonCanonical.js\":\"eb06275354e967f6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelInvalidation.js\":\"5a2fb02308de22ae\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelProcessors.js\":\"73f783e080d7c5e4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelQueries.js\":\"e70ef5c58362b863\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/mergeTypeMembershipProcessor.js\":\"cedc96f7ab74b91d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/normalizeReferencesProcessor.js\":\"237e9557a79a99b7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/poolInstrumentation.js\":\"5dab13d61dc50b6f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/processorRunner.js\":\"78800b9f105239bc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyCellBackfill.js\":\"add1598e9ba83d66\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyChildMint.js\":\"e69a6d4acdd11e70\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyChildrenProcessor.js\":\"c12bcbaca3b488a0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyDefinitionChangeProcessor.js\":\"24535a2d46a4a8cd\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyDefinitionSynthesis.js\":\"a162f794290bf281\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyKeyScan.js\":\"8d6cb07c09a81f49\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertySchemaResolution.js\":\"d5e5eaa6fc5f5066\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyValueEdits.js\":\"2ac49a9a0995ce60\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/raiseProtocol.js\":\"a398a40c10e85e6f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/readBatch.js\":\"1fee5b24473a5b9a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/refProjection.js\":\"153752bed3e0adf0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/referenceTargetLookups.js\":\"f93b15f19e89f23c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/referenceTargetProcessor.js\":\"fdc9b896e45bb535\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/replayMerge.js\":\"dac8f7d36b58b3cc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/sqlBinds.js\":\"04d8d9f4fc9188d1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"deb91e47c20c3bca\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/arrivalProcessors.js\":\"c68d46e307f1275a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/invalidate.js\":\"1c3a5e04fd9271fc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/materialize.js\":\"82c3cf8115195624\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/observer.js\":\"49b0939870f4d608\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/reconcile.js\":\"c0f69e38bc748e90\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/timingMetrics.js\":\"cc020d00b6d6cade\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/treeQueries.js\":\"195b0a29f689f328\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/txEngine.js\":\"8df219ae652fbfa9\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/txSnapshots.js\":\"1a2986a8fcbd9365\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/typedBlockQuery.js\":\"9c2e38dd39827b6d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/undoManager.js\":\"7c1d4620cf040623\",\"/knowledge-medium/pr-preview/pr-1914/src/data/invalidation.js\":\"8702f442b672935d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelDataExtension.js\":\"48f0914a9fdf8c9f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelPage.js\":\"9ffac56c39908112\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelValuePresetCores.js\":\"12f673f39ed32b99\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbCorruptionSignal.js\":\"3e0ee6feee065227\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbStorage.js\":\"00d385d75f24086d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbVfs.js\":\"8749a31e7e71a414\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localSchema.js\":\"765462d3a76518e0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/maintenance.js\":\"888ab071083a9b07\",\"/knowledge-medium/pr-preview/pr-1914/src/data/mergeProperties.js\":\"65049e181d174d00\",\"/knowledge-medium/pr-preview/pr-1914/src/data/metricsConsoleHook.js\":\"3f2497f066fd2c01\",\"/knowledge-medium/pr-preview/pr-1914/src/data/migrationsPage.js\":\"1fbfc8358ee6f02f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/mutators.js\":\"f3183e6b51508066\",\"/knowledge-medium/pr-preview/pr-1914/src/data/orderKey.js\":\"9b3f690d03603020\",\"/knowledge-medium/pr-preview/pr-1914/src/data/orderKeyPlacement.js\":\"3f58e9f9d99b0a57\",\"/knowledge-medium/pr-preview/pr-1914/src/data/outlineSurface.js\":\"78b02936914fe8d4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pendingEditorContent.js\":\"bc25ac7c6aa4f475\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pendingUploadsSql.js\":\"8214bcfdb74e64e4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pluginStateExtensions.js\":\"02394214eb22b3cb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/powerSyncLogger.js\":\"ef79db41209e34d7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/projectorRuntime.js\":\"86f042fae47ffe86\",\"/knowledge-medium/pr-preview/pr-1914/src/data/properties.js\":\"7184c4f7ac5cb0c2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertiesPage.js\":\"c25ba71fd825467e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyChildren.js\":\"84e9b8697d5e6084\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionFanout.js\":\"5845226c15cecc03\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionMetadata.js\":\"d84be016a563fb62\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionRegistry.js\":\"266502be998a082c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDisplayMode.js\":\"6587dc11fac49e6a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyRowCreation.js\":\"11491814ee67387f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertySchemaCreation.js\":\"eda917bb031afaa4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertySeeds.js\":\"b6c8e82c4047bfad\",\"/knowledge-medium/pr-preview/pr-1914/src/data/recentsPage.js\":\"28c385aeae866333\",\"/knowledge-medium/pr-preview/pr-1914/src/data/refTargetComparableProperty.js\":\"ed122bc168544f3c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/referenceBlock.js\":\"7b927613f5cc8802\",\"/knowledge-medium/pr-preview/pr-1914/src/data/rejectedUploads.js\":\"5450dd9645510a0f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/releasePowerSyncConnection.js\":\"3fac85d02594e3d0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/repo.js\":\"c2d2e2a4846688aa\",\"/knowledge-medium/pr-preview/pr-1914/src/data/repoProvider.js\":\"6edf5beee24f243e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/rowProperty.js\":\"fba30fc450dcedbf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/searchFilter.js\":\"1561c173e8738ebc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/seedIdentityLedger.js\":\"e42e822273bcf452\",\"/knowledge-medium/pr-preview/pr-1914/src/data/stateBlocks.js\":\"05473803690a5a4d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/structuralEditPolicy.js\":\"b480542686f2cd02\",\"/knowledge-medium/pr-preview/pr-1914/src/data/structuralInsert.js\":\"07d34bd5f9f790dd\",\"/knowledge-medium/pr-preview/pr-1914/src/data/subtreeDelete.js\":\"c333d4a07e2e5fb1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncStreamLock.js\":\"0f164fb75203acd4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncedTableSqlRecognizer.js\":\"2daa63c486095a8b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncedTableWriteGuard.js\":\"2cb262c8808b8edf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/targets.js\":\"ba86cf279da2e18c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeColors.js\":\"1d3132a07bfb5e8b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeDefinitionMetadata.js\":\"a78702467b2fb2f4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeDefinitionRegistry.js\":\"a7b76500c9c4a7df\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeExtraction.js\":\"48107cfae6f53f2c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeInitialValues.js\":\"9422d5f27c91311d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typePropertyGroups.js\":\"c49d6ad75bbabeb3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeSeeds.js\":\"4e8560b9a67660a5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeTagger.js\":\"b2ad8e2628e57ad1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typedRecords.js\":\"6ab3cbd2b6bc6869\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typesPage.js\":\"1a9b177f6f00a963\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userPrefs.js\":\"4416109c0f17e3f2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userSchemasService.js\":\"06479f2b235d180d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userTypesService.js\":\"d5ad40f889387869\",\"/knowledge-medium/pr-preview/pr-1914/src/data/valuePresetRegistry.js\":\"614c77d65f6f9cc6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/visibleChildren.js\":\"39148b8757a63b78\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceConversion.js\":\"76af6cf8c4fd4146\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceFirstSync.js\":\"2f7be966c204f3e2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceIdNamespace.js\":\"962ee92287a4a21c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceSchema.js\":\"3ea62283bb6497bd\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaces.js\":\"3da3cfb37d03e1cc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/writeAheadLog.js\":\"57389b47623d0ee3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/BlockPasteShellDecorator.js\":\"a8d6a773234db38e\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/atTrigger.js\":\"d509132206e5943e\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/autocomplete.js\":\"1013271c3c438f53\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/codeMirrorExtensions.js\":\"ba820fa0fedcd60e\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/contentFlush.js\":\"2680cf83be9e23b8\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/defaultInteractions.js\":\"7a6582bc71d48728\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/editSettleSignal.js\":\"4c2411b91ddd50ca\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/insertImage.js\":\"63f413693e68215b\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/referenceCompletionRange.js\":\"db5db1561466b087\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/referenceTargetTypes.js\":\"d7a2f487ebe16a32\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/syntaxContext.js\":\"b080155c53c2986e\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/triggerMatch.js\":\"31b55b2a89dbfdc3\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/AppRuntimeProvider.js\":\"96c789b842edf412\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/BlockFocusShellDecorator.js\":\"79164f6993e94a98\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/ExtensionRenderBoundary.js\":\"6566c32dfe1aa757\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/PanelContentRecovery.js\":\"9e45da473c41823c\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/apiCatalog.js\":\"a57e3b3bace42e08\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/approveExtensionHere.js\":\"d3547eb520263aef\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/armedCutAppMount.js\":\"68c81be95f37f4e9\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/batchableKeyedStore.js\":\"5770e3a3010d9eee\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/blockInteraction.js\":\"3b8589d16d544a14\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/blockSelectionAction.js\":\"45d60427e74fe77d\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/compileExtensionModule.js\":\"9b221483237c8b7b\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/compiledModuleCache.js\":\"978d293fe47aeea0\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/continuousGestures.js\":\"5142aa7445f9a3a0\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/core.js\":\"55040458a9f88b34\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/defaultRenderers.js\":\"aedd2f2850f91f72\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/definitionFanoutAppMount.js\":\"d122610015843482\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dialogAppMount.js\":\"a3dec959884e76cf\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dynamicExtensionSeeds.js\":\"129f95abdd41c1ff\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dynamicExtensions.js\":\"a239ce38f9b59438\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/exampleExtensions.js\":\"030bf5ed57314753\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionApprovalStatus.js\":\"14736edf59a39624\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLoadErrorToast.js\":\"3688df7836067fb6\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLoadErrors.js\":\"6de93ba0ced7a21c\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLookup.js\":\"54d1fb6110eabe55\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionToggles.js\":\"755ae9b8f27ceded\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionUtilitiesCss.js\":\"ed9ce980228a894d\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/kernelPageDeletionGuard.js\":\"529a8daaa532c458\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/liveRuntime.js\":\"0fb1f6040c37b425\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/openExtensionsSettings.js\":\"9df4ee0980414d9c\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/overridesCache.js\":\"522d293bf295d654\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/pluginIds.js\":\"145cdb5c2e22e991\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/processorRejectionToast.js\":\"80de47525e87f655\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/runtimeActions.js\":\"bc7aa2206886306a\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/runtimeContext.js\":\"2a803af0895f8a7b\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/staticAppExtensions.js\":\"2ddf9096c53b5641\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/staticDataExtensions.js\":\"08f408dc0f468493\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/toastAppMount.js\":\"9cfc2e6d1b7ed1a9\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/useOverrides.js\":\"6ab4630831064a09\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/useShortcutSurfaceActivations.js\":\"85fc1263d1e81ba1\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/discoverToggleTree.js\":\"15f7b87fa1ee9bdf\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/facet.js\":\"d796968b4b2afe04\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/resolveAppRuntime.js\":\"a87d58f768448f15\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/runtimeEvents.js\":\"95f73265f5a77b21\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/togglable.js\":\"d10b9849bba03a2e\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/variantFacet.js\":\"b3e197f906392c96\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/verbFacet.js\":\"ef59420dcf4e35f0\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/block.js\":\"fb8f5658b0c39644\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/focusedChild.js\":\"e84517a23e44939e\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/propertySchemas.js\":\"3f5f26ba015047a9\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/typeRegistry.js\":\"e1c7c9201fa14190\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useAncestorCrumbs.js\":\"a02f09cb406e98c9\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useAutocompleteListbox.js\":\"09885b04d71d6b4c\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useDebouncedSearch.js\":\"2c405bd21e590716\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useDebouncedValue.js\":\"084139cd0723e3d6\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useFacetValue.js\":\"a17bcb67095688fc\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useIsFocalRender.js\":\"df4fc621fb42a790\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useIsReadOnly.js\":\"56e1d43a9c16da4e\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useMaterializeBacklog.js\":\"21393d6025547b43\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useMinuteClock.js\":\"04631701bc48c0fd\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/usePanelLayoutProjection.js\":\"e970c90316f22582\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/usePendingInvitations.js\":\"9c4d73c43b86b07e\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useRendererRegistry.js\":\"99270feff95c168f\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useRetainedFieldRows.js\":\"7215869651ae324d\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useWorkspaces.js\":\"4f9a0307ae2ed160\",\"/knowledge-medium/pr-preview/pr-1914/src/lib/utils.js\":\"520088dbc8e8f1fa\",\"/knowledge-medium/pr-preview/pr-1914/src/main.js\":\"0a042930c2562521\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/MarkdownImage.js\":\"9973c961f8feca25\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/blockSeparators.js\":\"c3fdaf4f8d9949e8\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/context.js\":\"8c80d761a88c01cc\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/defaultMarkdownExtension.js\":\"0e720905a2e5f283\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/extensions.js\":\"5864ed3018d1a141\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/renderMarkdownHtml.js\":\"0148e3295feb7956\",\"/knowledge-medium/pr-preview/pr-1914/src/minimal-editor.js\":\"a21afb9ac528c0b5\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/armedCut.js\":\"0088900c885282ea\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/captureMediaVerb.js\":\"43d3fe2984805eee\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/clipboard.js\":\"eb0584fd71ed2e06\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/decision.js\":\"d47986f7afe133ea\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/operations.js\":\"dd2e4f8990bd8f14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/account-header/AccountHeaderItem.js\":\"57eb09136da3f731\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/account-header/index.js\":\"5893fba48527d702\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f61dc7a34c602507\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/askAgent.js\":\"6be05743be721d43\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/askedStore.js\":\"8d51ee6e7117b6e3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"5dd02bff78e1e057\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/chipState.js\":\"9a17da9a1d200fd2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/dataExtension.js\":\"64bc8bcfbb23e2f5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/index.js\":\"cce0d39d0db49aa3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"c22fdde3bb0c1ff9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/schema.js\":\"c790bd48e662d51e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/AgentTokensDialog.js\":\"381498dd1cdee2f8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0760469f9e3980c3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/addMedia.js\":\"163e02d88096857b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/backlinks.js\":\"b54fbca2dfd9e331\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/block.js\":\"763228c47c3f63b0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/context.js\":\"8d7b538229a5c993\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/displayIds.js\":\"3ef4e2e4b35a5517\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/index.js\":\"7e142811932acef3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/outline.js\":\"6173f83846aeae61\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/properties.js\":\"a375e683e762599d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/refs.js\":\"dfb0bb3b3c433dfd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"21a579da59159071\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/search.js\":\"e4859544b07e1571\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/shared.js\":\"532ca98167fab574\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"1d85cbcfbd261c6c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/text.js\":\"30dcd8cc3dd269fe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentWrites.js\":\"7a9daa632166020a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/authoringCatalog.js\":\"be739707cd300589\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/blockRefTargets.js\":\"c7c9a210f5b925c5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/bridge.js\":\"cb36be1cda236ae3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/bridgeLoop.js\":\"94bbb2a0734a5732\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/changeHistory.js\":\"bbf98d66cbdf4d05\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/commands.js\":\"c219c4c039d8c4e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/commentsCommands.js\":\"c071f7d76f435667\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dataExtension.js\":\"834d36d8814b4635\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dataModelGuide.js\":\"b3d75d46d54fe143\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dayPropertyInputs.js\":\"8e30cf789b9f0feb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/describeRuntime.js\":\"3d77903020e75416\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/extensionLint.js\":\"60e7606e0d684d8f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/grainAudit.js\":\"80123fa145bc3ac7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/healthCommand.js\":\"b2a2fd75f2531eae\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/index.js\":\"62a21c2d839c6df0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/presetIdentity.js\":\"a1d351e26175121d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"78d129d793231510\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/readMedia.js\":\"ab5d49b2b6080eb4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/schema.js\":\"aebf6124fec5021b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/serialization.js\":\"d70765bdc5e0aeab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/targets.js\":\"0da78268742e11fb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/tokens.js\":\"3f3473ec94a550c5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/watchEvents.js\":\"7bb2373a05513d06\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/workspaceGuard.js\":\"71aad72266111c24\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/writeCommands.js\":\"786f4bdd7e458883\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/AliasCollisionToast.js\":\"feff98f12d878058\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/DuplicateNameBanner.js\":\"37f7da2625bb1feb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/collisionMerge.js\":\"99c2ded58e4cce29\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/dataExtension.js\":\"ad06f22a4819c569\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/index.js\":\"a53079bfd0435e99\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/mergeCollisionAction.js\":\"923c495f16f08b39\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/pageStyling.js\":\"6de7aa886f27798c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/rejectionToast.js\":\"fdb9c1fcf0c46d8e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/syncProcessor.js\":\"7125de472728c685\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/actions.js\":\"7c3657d29100c854\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/addComment.js\":\"1c4abed418cd050e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/anchor.js\":\"0f437643a9638559\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/anchorState.js\":\"aca5967bff780fd6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/commentLinks.js\":\"c7e563efdab4ce92\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/confirmThreadDeletion.js\":\"a5403df3545b1417\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/container.js\":\"658c366d8865a4cd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/dataExtension.js\":\"b076c6206bc8586a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/deleteComment.js\":\"45c716f50ef27fb2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/highlights.js\":\"64a82508ae6d64ac\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/index.js\":\"b9cfaaa7e2e6834d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/linkedCommentsPill.js\":\"d76a3fc3229c51cc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/margin.js\":\"c34d16c6ac2b53ab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/marginAnchorLinks.js\":\"7ec0013ff44b611e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/marginSchema.js\":\"54838848785dc8f2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/newComment.js\":\"9b5b8d9febc0aa1b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/ownThreadPicker.js\":\"3ed3250d82222f86\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/placement.js\":\"0f839487f8448de7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/queries.js\":\"3cf546b206e5fb32\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotePosition.js\":\"4d683faedea5e317\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotedIn.js\":\"f20a8601ae32e5f2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotedRange.js\":\"876a037749e5403a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/rangeRefs.js\":\"86eca0c3d74aca57\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readHighlights.js\":\"f5650481231d2c94\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readSelection.js\":\"15d8eb3546e8d724\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readSelectionUi.js\":\"34deeab68c1132b7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/reanchor.js\":\"088dc539d4c7b7c6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/schema.js\":\"afc0503e81d5a6dc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/scope.js\":\"701493b0f1e22dff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/scopeThreads.js\":\"872aea8b826d226c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/splitRetarget.js\":\"e0767011ad207cbc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/suggestionCard.js\":\"fadcdcc4d5b51c29\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/suggestions.js\":\"0061ebbd0430c42b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/summaries.js\":\"73906e5d29e02923\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/summaryBatch.js\":\"a4e65f473d1e0129\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/surface.js\":\"d87f6dd466dc7c39\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/threadNavigation.js\":\"011bc17ecfb2159f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/threads.js\":\"35029384284f97bc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/ui.js\":\"0c6e16854932f8be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/uiStore.js\":\"5090ced0448d9d3f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-intents/appIntents.js\":\"a16ab44f4031e73f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-intents/index.js\":\"afe658fa9be6e807\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-update-prompt/index.js\":\"96bc02b27edfe15a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-update-prompt/status.js\":\"be50314fa7af2722\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"4dfd821055621f79\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaBlockRenderer.js\":\"4409bd00dafc5c48\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaDownLaneReplicator.js\":\"fad5c4cf763e1f90\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaUploadReconciler.js\":\"c833172c91845ae0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetDownLane.js\":\"3a29399904510779\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetResolver.js\":\"230ca60b6573375b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetUpload.js\":\"eec1c1038274f5b1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/attachmentCleanerIO.js\":\"e2dc2aae0962b42f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c3e769ca48e098ee\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/blobStore.js\":\"8c85d0852aeb85e9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/browserMedia.js\":\"7f6a5a2576d0b688\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/byteStore.js\":\"aef66009175649f4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/cleanerIO.js\":\"91a96d1a5f9eec63\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/cleanupAttachments.js\":\"8160f3479a66c123\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/dataExtension.js\":\"65f26d2ec50bd2dc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/downLane.js\":\"8330a96dc9d862ce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/index.js\":\"fa77ca87c3a23904\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/insertImageContribution.js\":\"200b8559fbd4f77b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/laneArming.js\":\"cd9c6ad84fe43665\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/laneLock.js\":\"82f4518cedbe88a7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaBlock.js\":\"a35749c5eb658b35\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaCapture.js\":\"39061b61a82410f8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaLanes.js\":\"204faa3d2a502699\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaViewers.js\":\"970c985b164d57ce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaViewersFacet.js\":\"391bb6e496d46328\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/pasteCapture.js\":\"9ec24839d9761172\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/resolver.js\":\"ca960c4032f7b91d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/retryUploadsAction.js\":\"a2863cfe853bbcff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/storagePaths.js\":\"7a4436c4a8abb26b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadDrain.js\":\"4c4045b59a8a2723\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadLaneStatus.js\":\"52cb457ffb790069\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadReconcile.js\":\"c59c2d83f8453a80\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadRecovery.js\":\"e7eb9cb42b0632bf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadStore.js\":\"ac0aee9057e01a96\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/useAssetObjectUrl.js\":\"9ad216bfb7764c6c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"2cf9de894c7ba965\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/BacklinksViewSection.js\":\"720f4b6c8615c4d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/facet.js\":\"5b9165869ed65efa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/index.js\":\"836f12ffbe158eb6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/prop.js\":\"7d0f6d85f6ba0fa1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BacklinkFilters.js\":\"7edd78342c1b72f6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"5ae595514ea75953\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BlockEntry.js\":\"5de79147e10705a9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/LinkedReferences.js\":\"71b5b8549a07b1f5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"75f132a0dfee8267\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/dailyNoteDefaults.js\":\"ca565cbe1ec48590\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/dataExtension.js\":\"ad8cb258a388daf9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/edgeExclusions.js\":\"58bad0a4a945e04e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/filterProperty.js\":\"0164e4554c3d8891\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/index.js\":\"20b9089c6d70b0da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9e50da87b6453b2f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/applies.js\":\"444a6578dd02c206\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/countQuery.js\":\"e673d67e7f105034\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/expansionStore.js\":\"902f1fe86ef68606\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/index.js\":\"282fa96e708452be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"aa4848fe8ba95f50\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/presentationInvalidation.js\":\"08bc937652b7580d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/propertyEditorOverride.js\":\"04670a267dc56a4a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/propertyFilter.js\":\"621ded208a132a53\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/query.js\":\"c0ed722b2c258591\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/resolveFilter.js\":\"a88ebef132ff703f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/sourceBatch.js\":\"76934b77536a447c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/sources.js\":\"dd0548b6d5c54972\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/useBacklinks.js\":\"ca3d12126a29d0a1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"cc3e580ebedf9232\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/BirthdayCelebration.js\":\"08d992f8a7b8b67a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/BirthdayOverlay.js\":\"bebb99aeb3edd239\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/gate.js\":\"e70a1dadd6ce1e47\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/index.js\":\"4172b881648bbf05\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/wolfTheme.js\":\"9bc2d219441637b5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/BlockDragLayer.js\":\"178e1c7f20fefbe2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/dragController.js\":\"6c9d4910b63def72\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/dropTarget.js\":\"c49c43fef9e0945a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/index.js\":\"b4d67d8cfdd4b125\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/projection.js\":\"d09a10a0d0db2e4f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-info/BlockMetaCard.js\":\"8376e912caf32a29\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-info/index.js\":\"76f2b91bbbbf9d1c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/AddTagDialog.js\":\"0360fe64fdf85920\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"56ac94fa7c904254\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/TagNameIssueHint.js\":\"19d0573388a9cb1c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/addTagAction.js\":\"20511f57ec971f11\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/appendTag.js\":\"1657ff6458280521\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/config.js\":\"b465a2bf81880ecc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/dataExtension.js\":\"7ec549784833336c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/index.js\":\"cf79bff6bee2d16b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/propertyEditorOverride.js\":\"9f684e824dd42339\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f611aab4fb4d8106\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"0d6454a113ae7740\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/Breadcrumbs.js\":\"5e2f1b5aa6e6d22a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"f171931e7ab03acc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4f3a95a0b6a1fbd0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/index.js\":\"da6ba7492ad25e41\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"15fb43986aa2c45f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/CharacterCountItem.js\":\"266758be6ad80095\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/ProfilePropertyEditor.js\":\"772cc68d14347ff2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/actions.js\":\"71f8035680dd443d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/blockType.js\":\"1015823286fe0401\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/charCount.js\":\"c23b30f566630fe3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/dataExtension.js\":\"82537a51fda89c30\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/index.js\":\"03003c3a361ba0aa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/profiles.js\":\"8bff9b4540150a93\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/properties.js\":\"acd2f38b0f694e64\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/subtree.js\":\"dbd60180a2f3fca0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/textCounts.js\":\"6cacdcdf6daebc19\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/colemak-keybindings/index.js\":\"394618c26182a9d4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/CommandPalette.js\":\"0a2defb1d169a3f3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/HeaderItem.js\":\"0a036652390fd210\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/context.js\":\"496d6666011a8d22\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/index.js\":\"af8cfdc7099419d6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/selection.js\":\"eace0c181294e507\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/toggleStore.js\":\"2e18ae83909dd2db\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/useCommandPaletteActions.js\":\"1b023e1f9354c506\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/ContributorBadges.js\":\"a80e7a81d75aa495\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/ProfilePicture.js\":\"01be77de2e5d6150\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/author.js\":\"b415a2e1dac0d8d5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/codeMirrorExtensions.js\":\"a16cf9d662460cff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/dataExtension.js\":\"3db2337715ed15c1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/index.js\":\"d1e9a16fb651c098\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/mentionAutocomplete.js\":\"d5072ce1524e5a54\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/processor.js\":\"33edd51f0ddd69df\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/profiles.js\":\"cda845ae80f92cf3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/queries.js\":\"e312b257a8ce8de5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/schema.js\":\"59588f7b0f89a995\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/useCommentAuthor.js\":\"dcb8437115df8b67\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"08f66217865b01ea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/followOrigin.js\":\"13c89776ab4cbaac\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/index.js\":\"16174b79d30fc769\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d0e282e84935f201\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4f148c9aafe64d7c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/CalendarGrid.js\":\"712dc06dc9687317\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DailyNotePicker.js\":\"caa6c6998fa62fc8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"f6a91076fe9ba85c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateNavDecorator.js\":\"1c7e005c7a9b9a5c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateScrubOverlay.js\":\"37ef6bccbd9d5364\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DayPropertyControl.js\":\"8461a63e48971053\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DayValueReferenceControl.js\":\"a5f3e9f5209dc26d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/HeaderItem.js\":\"e6dba27312eb0606\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/ReschedulePicker.js\":\"3b7fa1c66564a706\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/SpreadDatesDialog.js\":\"c6eb7de8e2241502\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/actions.js\":\"d2f74106932ca1be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/blockDateAdapter.js\":\"0d0a24baecf1bfba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/calendar.js\":\"5b2073732514ed06\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dailyNotes.js\":\"eb31003887781356\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dataExtension.js\":\"69b3cb5976fc8c98\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubActions.js\":\"77352713aa9cb1c0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubGesture.js\":\"dc4c571028ac7ec3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e1c4360352e63476\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubRecognizer.js\":\"aeac1bbfeb955ea2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dayProperty.js\":\"7b7ca0ba97e77018\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"bd0f2ee567368bbd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/deletionGuard.js\":\"c20b433c92421535\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dueQuery.js\":\"92af79a5f93ef106\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/index.js\":\"cb05587e7ba3ef46\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/landing.js\":\"ac22bbed987da1cf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/localSchema.js\":\"ec4db63a983d9231\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/referenceDateAdapter.js\":\"7e2281798e482af5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/rescheduleAction.js\":\"b220c2aee06740c3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/schema.js\":\"c534f2df10cb9eac\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/spreadBlockDates.js\":\"b659b78a1de6f800\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/spreadDatesAction.js\":\"93a1130c89afad1e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/today.js\":\"df45f7d5711237e4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"30f265c9b4925e7a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1bfa4b54c010bd27\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/audit.js\":\"e83baf28e7e2f59d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/auditAction.js\":\"c888334ef46ffd0c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/auditRanges.js\":\"12adf8b5fc38796a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/diagnosticsSource.js\":\"9587ee1a04fd33e0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/divergenceScan.js\":\"46b8afc76da01d55\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/index.js\":\"688b8ec93e3c6dd5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4205881bc372c5fb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/referencesMirror.js\":\"f724a80b8581b378\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/rowJson.js\":\"deded852656962ab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/schedule.js\":\"a04ce9da1d74aba2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/store.js\":\"7c2d6e76e03fd597\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/action.js\":\"50eeaf9e5ae1d566\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/index.js\":\"5a091dc83f248e7b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/plugin.js\":\"8ad330cb6136680e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f923d4bc91545142\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/actions.js\":\"2259cf698e1a7a69\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/changeMarker.js\":\"eaf9a7bae2a5402e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/diagnostics.js\":\"249372fc96f19fa9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/fileSystemAccess.js\":\"b1874268ecb4cfe0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/filenames.js\":\"7feff02682e7240c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/index.js\":\"f876ceb90357629f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/mirror.js\":\"954421e05acad96c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/runLock.js\":\"dfe355e9aa28761d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/runtimeHealth.js\":\"56e8e28ac736e159\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/schedule.js\":\"05c566aa9891f4c3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/store.js\":\"4dfb39fbbbb4b169\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/default-themes/index.js\":\"dc9faafe324346cf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/default-themes/themes.js\":\"3ad804c77e9b2933\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/diagnostics/facet.js\":\"647712bf019550f9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/diagnostics/useDiagnostics.js\":\"cb27c34a7113240d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/dismissals.js\":\"3edfb9e77b5ae2c8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/index.js\":\"1623d285c163e785\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/status.js\":\"1154f12de99e99dc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/store.js\":\"f2d7669cd0cf19c2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"c9120d0e7b8bd02c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/ExtensionsSettings.js\":\"debc3ad04efdf3e3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/actions.js\":\"d1a768dbec208280\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/config.js\":\"5b0ac43a80f3e4c9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/dataExtension.js\":\"6b559e90ca2a7ee5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/effect.js\":\"9c6dfb544049fb1c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/index.js\":\"bc861b6cf416adf9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0dc925ff6c7335b2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/useToggleTree.js\":\"aad8baa1d0a7eafc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/ExtractTypeDialog.js\":\"66bece050415e609\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5b435382668c60aa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/PropertyShapePicker.js\":\"825fa18186e6905f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/action.js\":\"1330d7ee0ef25a4c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/index.js\":\"18c760bb7017704f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/FindReplaceDialog.js\":\"d939355bbe8f5d63\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/HeaderItem.js\":\"b57ad8728526db34\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/dataExtension.js\":\"a8835cf4d1be400c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/index.js\":\"35e97d70bf8ce43c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/search.js\":\"c4e306702691e31b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/toggleStore.js\":\"95ee0e82317dbdba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/LocationPropertyEditor.js\":\"f283278a886ff447\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/MapView.js\":\"9c1c06aebf9ec1d6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/blockTypes.js\":\"5bae075f932e36f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/codeMirrorExtensions.js\":\"c84454c1b7883270\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/createOrFindPlace.js\":\"fbdb38d889fdcb88\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/currentLocation.js\":\"72c13b3644f0de3b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/dataExtension.js\":\"44450911597e7ba7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/geoContentDecorator.js\":\"19bbb7a01f23d0fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/googlePlacesClient.js\":\"04ce098109e2d08f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/index.js\":\"d58fe8b77801a41a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/locationsPage.js\":\"176200bc23e0217d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/mapViewport.js\":\"d07b631a5023e2ec\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/pickCurrentLocation.js\":\"08041c481a6403bb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/placeAutocomplete.js\":\"ea044e326a2f5a94\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/placeNameCollision.js\":\"88ef367b837d8d39\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/properties.js\":\"a55c4d58ecf5cfc4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/propertyEditorOverrides.js\":\"3d26c1581a880b18\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/query.js\":\"94073b41d8a224d1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/usePlaceSearch.js\":\"b19f9db7ecd0ee84\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"463988c8b12d0951\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"3ae9900eebda32ac\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7a3199b8f49c515a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/config.js\":\"710f730e6dda30b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/dataExtension.js\":\"e6e4348475e7f0e9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/facet.js\":\"9ac2f18f5b2dca73\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/grouping.js\":\"75f357121e71cde8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/index.js\":\"cd04b8a418e04ecb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4459ef620f150786\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/query.js\":\"d34766eab37730f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/resolveConfig.js\":\"f08fce9879aeb825\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"e0da64c26920ffed\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"28d0acae0ef2d088\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/HtmlDocumentContent.js\":\"bc533a9e6bdb550c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/HtmlFrame.js\":\"fdd7eead26810d86\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/actions.js\":\"e04d5c73cd073f11\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/blockType.js\":\"c5b4d3226f5d5291\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/confirmRunScripts.js\":\"07560025849db9d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/dataExtension.js\":\"17e632be57c8c46a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameAnnotations.js\":\"c20e5e495a22ef7b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameDocument.js\":\"de805de8160b2499\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameTheme.js\":\"f7625402960daac3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/index.js\":\"f71fd6f8d959d268\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/scriptConsent.js\":\"e274ac2340025ad6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/sourceMap.js\":\"d01ba320ce2107bb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/useDocumentScripts.js\":\"c77eb532f187203e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/index.js\":\"6b5f594008876254\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/record.js\":\"421bff6c04c0aca8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/recordStore.js\":\"f4d010ccadb113b1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/responsiveness.js\":\"78be9e1507652905\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/schedule.js\":\"46bd2df8234fe334\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/sessionContext.js\":\"f2b003a50a894ab9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"224df9f8609ee5a7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a2ae6a237927a911\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/actions.js\":\"d3fbaade0f90b4eb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/config.js\":\"ad719beb2e5bd55e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/dataExtension.js\":\"cdb6b53a2dae1f70\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/effect.js\":\"29a3b8311743f6c5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/index.js\":\"e8da3c34f026be43\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/keyCapture.js\":\"fcd3f490141bc8d6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/overrideStore.js\":\"80e059dcf6b49039\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"c832a516be0fe2c2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/HeaderItem.js\":\"ef1b93eb21ae5ee3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/LeftSidebar.js\":\"b906c372a605a027\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/actions.js\":\"baa270b1c3674022\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/facet.js\":\"23755d094a02272d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/index.js\":\"3c203b3cab040601\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/shortcuts.js\":\"c7cdf3beb5183f4a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/toggleStore.js\":\"141b57eb8c153dd5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/MergePicker.js\":\"96f632387dcc84f6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/index.js\":\"b48c60438f3ade07\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/mergeAction.js\":\"8773e9ef76aec171\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/strategy.js\":\"95df56572e581052\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/Button.js\":\"c95526a53ca9e53f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"2d51bbdec6b055d1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d295392f93fc218e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/facet.js\":\"7c5ded5c57bd2fed\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/index.js\":\"cb4271bd98f87549\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"3c95b0ed1d7f682a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4c4ff295d92add1b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"285aa8b8edab29b8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/facet.js\":\"dd11768a5fa814f2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/index.js\":\"2e3dd19bc87a29cd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/MoveDestinationPicker.js\":\"49887e868b637df8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6d92e31a8fef158c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/contextMenuItem.js\":\"75865ffce89ef08b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/index.js\":\"10a4f1225290e5ae\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/moveAction.js\":\"dcea486a25ec084c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/moveBlocks.js\":\"4b210bc59d1f3ea5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/selectionAfterMove.js\":\"14ad9beaecc93595\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/TutorialBanner.js\":\"0056b86ebad73bb5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/action.js\":\"ad56da285dc2c4c8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/bannerDismissal.js\":\"32ab95dea1fd448c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/documents/cheatSheet.js\":\"0bea8c0600722c73\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/index.js\":\"eeb5095a9153c602\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/keys.js\":\"b1de945f09fe1e31\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/landing.js\":\"c010058a32ca5865\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/outline.js\":\"3fc3701713230d00\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/seed.js\":\"3ead541277744d2a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/PerfTrendDialog.js\":\"47207a84b65520e2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/analyze.js\":\"9adbf8778337cb91\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/diagnosticsSource.js\":\"8d9e7860c651ab0c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/index.js\":\"ce0ee70ed69e00c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/load.js\":\"a52daef02f17c347\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/monitorRun.js\":\"a1906596c8443467\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/schedule.js\":\"31b97e77d0916345\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/series.js\":\"278f2427459253c5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/store.js\":\"6d7b38ce2ae4d0d1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/trendAction.js\":\"8daeb990df014212\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/verdict.js\":\"2a8b84642aa2b198\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/clickToEditAction.js\":\"6e3019be95aa048a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/index.js\":\"16398069bf45e0f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/interactions.js\":\"954adab19b818cdf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"580af19e566d6cb9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/MigrationGate.js\":\"f79f86ee3c989b66\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/MigrationGateDialog.js\":\"9d6fa94294bdcd02\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/action.js\":\"ab990ab7a4581830\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/index.js\":\"3c3c398c0f066c97\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/localRunMessage.js\":\"bff8586a41109ba3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/plugin.js\":\"6b7b136c439820fd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/progressReport.js\":\"19b2e5abc2643265\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/sweepProgress.js\":\"2eaf226c9bac72d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/FieldRowRenderer.js\":\"a652c54b26a5caf4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/ValueRowRenderer.js\":\"eee6f81f4ef577dc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/actions.js\":\"d12587799f5e60e9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/autocomplete.js\":\"db55b721db553b5b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/fieldRow.js\":\"8b930c668045d9b9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/index.js\":\"13ff37bfb0407219\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/referenceWarning.js\":\"ca05ffadb90e39a8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/valueAutocomplete.js\":\"f5bac862785cf781\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/valueSchema.js\":\"a646544b896a0b25\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/HeaderItem.js\":\"e0517139c889a7a8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/QuickFind.js\":\"295884c1bc77aa6a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/index.js\":\"61bae6e1ed248388\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/recents.js\":\"8ef1f266cef190a6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/resultItems.js\":\"80341b654608df74\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/selection.js\":\"314cd066019fed6b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/toggleStore.js\":\"1df55d13de637cf6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/HeaderItem.js\":\"eb382d2855e446f6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9b614048c36517f5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/grouping.js\":\"c7e89a24bab8bd0b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/index.js\":\"026e467d92b7d595\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/target.js\":\"daf13dc982e2cb61\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/codeMirrorExtensions.js\":\"c7522ae48a306586\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/contentPrefill.js\":\"c5048b23d22d1035\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/dataExtension.js\":\"177e32dd6b7b32d7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/index.js\":\"359f616de79be9cb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b390d56210a813d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/invalidation.js\":\"70e0c42f6be9bb08\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/localSchema.js\":\"b6555aa115bc229b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/blockrefs/index.js\":\"2bf81e14ba14af45\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d66358d5fb0f6c81\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/index.js\":\"cf3f371fddc60426\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/referenceNode.js\":\"8f8b097c4fef5d4d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/remark-reference-occurrences.js\":\"5917163f6353ed14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c238392bbe9cc72e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/index.js\":\"59bc892c3978e940\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"86fb552eac9f7499\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"2081989c57bad3bc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/mergeRetargetProcessor.js\":\"a308f0ee72e48184\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/parseFence.js\":\"d1b074bd76ecf3b0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referenceParser.js\":\"1a224f6c88fae590\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referenceProjection.js\":\"1554b62a81b1a0c3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referencesProcessor.js\":\"ef734befac02b56c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/renameProcessor.js\":\"99cca1ddfd777fef\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/spanReplacement.js\":\"6107dfce0e8e5f5f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/htmlToOutline.js\":\"423497af935925bf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/index.js\":\"cef0d43b1970a92f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c0875914afce7931\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/pasteDecision.js\":\"6002fde6927d7152\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/action.js\":\"0245e5fc9cf5fc71\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/blockIds.js\":\"c9331d4d068fef8a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/content.js\":\"69ea1dd48d1d4c6b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/effect.js\":\"286c4f33d5ff8e81\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/ids.js\":\"8e7cddbd407a07a3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/import.js\":\"d8c91520349444b0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/index.js\":\"0c7e58c2853333e9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/plan.js\":\"e7379544c68d01b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/plugin.js\":\"6ccb3202e8505523\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/promotion.js\":\"354a87b7a6abbe3e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/properties.js\":\"208bd26141d3a036\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/references.js\":\"5d1d61531de31645\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/report.js\":\"239640b1f31b6307\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/roamMemo.js\":\"0430810f989f9e27\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/runtime.js\":\"cfeec57cc68fe0e4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/schemaReconciliation.js\":\"d30def4aed0930d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/srsMarkers.js\":\"a13f4cd83dde0f09\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/todo.js\":\"5c05133ce669986e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/typeCandidates.js\":\"f3c731340c518b13\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/types.js\":\"df0dc9729e25c6de\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/search-health/index.js\":\"11d13ab0e5e1632e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/search-health/store.js\":\"c83a854e7305c479\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/HeaderItem.js\":\"1402222b306e7069\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"b30059cf85fbebf8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/index.js\":\"6197df1d1bf23e93\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/model.js\":\"8f8b0cdc0d700f67\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/toggleStore.js\":\"73b3c447cdae7328\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/useKeyInspector.js\":\"220dd051fd60592a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5e492eda6c29957b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/ShellDecorator.js\":\"4451ad6ddb35dbe9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/actions.js\":\"cca48d9747c7e52b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e28b10e52c19e187\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/index.js\":\"8afb23c0b0253ea6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/shell.js\":\"e4c12d293bc02cb4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/surface.js\":\"67015804c117ceb3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/walker.js\":\"87a3fe60aa692fc6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ed88f9f66be18864\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/dataExtension.js\":\"6c7ee2794675a14b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/index.js\":\"926253354bbb9262\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/indicator.js\":\"ff1d81b203d6696b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/moveSrsState.js\":\"97003ffc80a24822\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"a7afcb9eafe5854e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/scheduler.js\":\"33671791171d6940\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/schema.js\":\"9da2c4aada0a14e0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e7d4dcb43f87cfb2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/srsClipboard.js\":\"ac19edfd818aebc8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2129f0cd6ae15667\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/DailyNoteReviewHint.js\":\"cb6dc9695e2dc60e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/DeckPicker.js\":\"347aef3dc621b3c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewControls.js\":\"52c9ab8e9e5cf889\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewDeckRenderer.js\":\"622af26fd40cc35f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewSession.js\":\"3e536936a4189c48\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/actions.js\":\"017f42b9dbc44580\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/archive.js\":\"4834fbf296da2229\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/dataExtension.js\":\"b9f1a6d881309a04\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/deck.js\":\"b22f01097b64a513\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/dueQuery.js\":\"a6d2463c1cfcecbd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/gradeDecision.js\":\"eebd0b09df9ab99a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/index.js\":\"df035ee0c13661f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/keyHints.js\":\"3181e39468b5267b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/reviewCardLayout.js\":\"a9f7fd5f86db41c1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/reviewProgress.js\":\"f7bd861b898d9867\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/schema.js\":\"3b582cbd66e27901\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/useDueCards.js\":\"256067ca7722b2f6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/startup-metrics/index.js\":\"03fa2cead6fd3788\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/startup-metrics/record.js\":\"58165f633d141cdf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/index.js\":\"9186b45ee00b8085\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/persistenceStatus.js\":\"279b3e8bc9b8838f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/requestAction.js\":\"490b85f051f62a1d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/TypeChipsDecorator.js\":\"2ef2d953748a95fd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/codeMirrorExtensions.js\":\"70a24e0662355e51\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/index.js\":\"c3b5d1b465d4fa36\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/typeAutocomplete.js\":\"36fcda672fea0469\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"ef6442dff0d115b7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/actions.js\":\"35534d3601a6c97f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/anchor.js\":\"6e404bede260998f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/events.js\":\"3e999550cd619dce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/gestureActions.js\":\"f6b89dd2a0e322a7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/index.js\":\"45260bf2ed0850ef\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8eeaa8fd0d0e128a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/collect.js\":\"ebf081dac03a983d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/index.js\":\"dba9dfb1b3509e52\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/record.js\":\"6f336d3cd55af349\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/RejectionDialog.js\":\"42665d319ee3f512\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5153ae3dc5c008b2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/index.js\":\"e687c8db48593326\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/model.js\":\"6788f8a0f778c088\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/queueCounts.js\":\"d493f6227741ba96\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/rejectedHelpers.js\":\"c4f36356b5301a83\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/rematerializeAction.js\":\"18a5b794ec34be7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/useHysteresis.js\":\"66fad08d959ef589\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/ColumnHeaders.js\":\"3df8191b9c6dee39\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/QueryUi.js\":\"ac35253103d9aa58\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/TableLayout.js\":\"02c542f54dec0306\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/actions.js\":\"540e32b1a00fd3ab\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/cellEdits.js\":\"208f3133fa011a03\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/childrenViews.js\":\"1770aced52df6b3d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/columns.js\":\"54892a1cb0dd2c75\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/controller.js\":\"0a23c8a195ddd60c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/convert.js\":\"2c5c805a6a4cb240\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/dataExtension.js\":\"353a00040a8081b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/index.js\":\"2277c45a3b52e72e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/keys.js\":\"03a8b1725fa4350b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/model.js\":\"42e10b95aad62255\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/QueryText.js\":\"78b88c6afa6e6d71\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/backfill.js\":\"87a50e387643d889\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/completion.js\":\"039f13187951d436\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/format.js\":\"3c53e2772053c0fd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/parse.js\":\"3d87403d09bda584\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/queryValue.js\":\"b2aea219883d89af\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/registrations.js\":\"7d1c25670aa1bba6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/source.js\":\"78bf8b25a6eb4afd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/registry.js\":\"aec6f7ac40b53602\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/rowGutter.js\":\"a9cf6b7428a8f76a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/rowVerbs.js\":\"79cfe5ce16c2a330\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/schema.js\":\"96abfd6e5c50df97\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/sort.js\":\"ff10f882cd781717\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/effect.js\":\"28248a2059391ba1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/index.js\":\"fbaade18a685278a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/theme.js\":\"af7920733c9e5eeb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/actions.js\":\"3e6cb0cdd9c61ac3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/dataExtension.js\":\"f5e0823b9450e628\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/index.js\":\"8340ebd52fcf1393\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/schema.js\":\"5f0faddfbad15833\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/TouchSelectionLayer.js\":\"c2977dc0d765295e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/actions.js\":\"5f22fcf6c8e67387\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/defaultItems.js\":\"02084fd1889d818f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/facet.js\":\"492baf467b55e985\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/holdRecognizer.js\":\"e704425d0c168c0e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/index.js\":\"b41a5450c2e99ceb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/UpdateIndicator.js\":\"17789877fffa3b5d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/index.js\":\"e4666d4bad311167\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/loadTimes.js\":\"195629940edb1784\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoNotesRenderer.js\":\"d4a6eac7e4ebf70b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoPlayerRenderer.js\":\"a6c3f83e0da4c49f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoTimeStamp.js\":\"c5f7b3eea0302c13\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/actions.js\":\"1df07c26414a17ac\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/index.js\":\"f134c50bfff1f7da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/markdown.js\":\"9e46c1999844f459\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/notes.js\":\"f6f4e999b5406115\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/registry.js\":\"e61df3bb6e4b20df\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/remark-timestamps.js\":\"76071fcbc745cc39\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/view.js\":\"16a9e44c6d0ce034\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/LinkHints.js\":\"0300ce05457f17a4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/index.js\":\"876fece910d4d346\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/model.js\":\"5e856984c144e195\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/settings.js\":\"bfb7c585d80182df\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/actions.js\":\"e5c189bab1d6da66\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/index.js\":\"1a71523765208d25\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/interactions.js\":\"d67ff05616da9d91\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/workspace-header/index.js\":\"0a254fdcdcc2b410\",\"/knowledge-medium/pr-preview/pr-1914/src/registerServiceWorker.js\":\"6afab12da7ecb3e5\",\"/knowledge-medium/pr-preview/pr-1914/src/requestPersistentStorage.js\":\"bba3a6e7a735a861\",\"/knowledge-medium/pr-preview/pr-1914/src/services/authRequestDeadline.js\":\"4dc8099bb68fd039\",\"/knowledge-medium/pr-preview/pr-1914/src/services/authStorage.js\":\"bb715b34f1e96136\",\"/knowledge-medium/pr-preview/pr-1914/src/services/powersync.js\":\"6675352de0a566fb\",\"/knowledge-medium/pr-preview/pr-1914/src/services/supabase.js\":\"0c218fc6aee3e114\",\"/knowledge-medium/pr-preview/pr-1914/src/services/uploadErrorClassifier.js\":\"713b5deb70254d3c\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/ActiveContexts.js\":\"b090892c89013597\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/HotkeyReconciler.js\":\"232b78548b76927a\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/WipeLocalDataDialog.js\":\"bdc8d600b263011b\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/actionDispatch.js\":\"5ea521d527044c7c\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/actionRefItems.js\":\"44300094ca6dea92\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/applyKeybindingOverrides.js\":\"b84505829f99c1d0\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/blockActions.js\":\"a27d881eb30e56ad\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/blockMergeGesture.js\":\"9ddbe37d18c39200\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/canonicalizeChord.js\":\"5df9e88c3d672b20\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/defaultContexts.js\":\"812efb841c35a7b7\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/defaultShortcuts.js\":\"e438d54845ce4ae1\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/effectiveActions.js\":\"36fa40d06b26d690\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/gestureAction.js\":\"e437118abbc31e33\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/gestureBinding.js\":\"60fd6f6a74f884fc\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/holdRegistry.js\":\"eebb6946becf9511\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/keybindingConflicts.js\":\"7dd6b744a72c7cac\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/keybindingOverrides.js\":\"a4800d134888bf83\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/pointerAction.js\":\"a54a30dce7ad9179\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/resolve.js\":\"5f85c9cd4efe4174\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/runAction.js\":\"7e8012025c989122\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/sequenceMatcher.js\":\"ba8a717f44e5cf5a\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/types.js\":\"ec1f946a75961a41\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/useActionContext.js\":\"bce70fc82877741d\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/useActionDiscovery.js\":\"d1e1fd5882b237a3\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/utils.js\":\"88f90bb4e63110b9\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/bootStore.js\":\"1a195196e55dbc9b\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/previewDatabases.js\":\"a6199e23c1f19855\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/byteTransform.js\":\"7cb7e60837014dcf\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/attachmentCleaner.js\":\"0b7ea5a325079bd7\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/attachmentParts.js\":\"7960fe71f5b573b8\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/bundleParts.js\":\"792ceb577871b4cf\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/bundleRecord.js\":\"10f23466854167b6\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/manifest.js\":\"ceb49c95bdeb5fb0\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/takeBundle.js\":\"8997f510e5853df0\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/verifyBundle.js\":\"a54bf3c546a378bb\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/cleaningStage.js\":\"00da75e9be11876c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionKey.js\":\"40be1442f1fa3ee6\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionServer.js\":\"5055a5eb82b22166\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/flip.js\":\"aa7eb5a90186d80f\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/flipAttempts.js\":\"c0a43c927902c35a\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/pages.js\":\"ddde6f6d6da7ea7d\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/preflight.js\":\"c5c383a4f710c62c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/reseal.js\":\"4a6a4637ac642c57\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/runConversion.js\":\"a31bdbb38b3ed665\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/runLock.js\":\"377483b313bee231\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/sealing.js\":\"38cf1695e38f2fa9\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/sealingStage.js\":\"d4bfdbfb5885e68e\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/stage.js\":\"fcb137cd228a5a2b\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/verifyReseal.js\":\"73d3dd020ae16f72\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/aad.js\":\"b8d128243586b7f3\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/aead.js\":\"22844fa73b225f50\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/base32.js\":\"44632443d4579e74\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/base64url.js\":\"c4f9749ab3dc57e3\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/binaryEnvelope.js\":\"d8ce3d2c80168f52\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/byteAead.js\":\"0139b19d6e3c67db\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/canary.js\":\"06501d2325dc675c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/contentHash.js\":\"be930771daf00705\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/contentKey.js\":\"aea44255a748c3bc\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/derivedIdNamespace.js\":\"927097c2e239233b\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/envelope.js\":\"26dc99979abbc233\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/hex.js\":\"ad3f2b8bc8addc93\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/sha256Hex.js\":\"02d0c6d8252272fb\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/workspaceKey.js\":\"d831b40babe15419\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/conversionState.js\":\"47bee6494b9aba81\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/createEncryptedWorkspace.js\":\"c7fff040b51c1b12\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/pastedKey.js\":\"9c54523dd5c139dd\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"9635ef6ea364ffc9\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/upgradeWorkspacePin.js\":\"808072b1fd830aeb\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/keyStore.js\":\"6da8a6bcee805198\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/mintWorkspaceKey.js\":\"812ed13223510ec1\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/modePin.js\":\"a482181097191bcc\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/openWorkspaceKeys.js\":\"bb0ddc101900abca\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/resolveWorkspaceEntry.js\":\"842ce9a7dc758d8c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/resolver.js\":\"8cdbd058a0bc1428\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/workspaceAccess.js\":\"334741487d1dda85\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/transform.js\":\"e9e9365fcca85ad0\",\"/knowledge-medium/pr-preview/pr-1914/src/themeBootDefaults.js\":\"a18cc96817da2c3d\",\"/knowledge-medium/pr-preview/pr-1914/src/types.js\":\"5f20216b18dab007\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/ClientLocalSettings.js\":\"638fc6d22ea92621\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/abortableSleep.js\":\"507f921966fb6e4b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/array.js\":\"49b4678201e74a03\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/backlinkAutocomplete.js\":\"b18059e094c7305a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/blockCrumbs.js\":\"6ce89c45575d9ecf\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/blockrefAutocomplete.js\":\"6be1271ce945afa6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/cadencedIdleJob.js\":\"152ee35e3c36d0ee\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/callbackSet.js\":\"41bfbd46a5ea62ca\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/clientId.js\":\"974295ec5f004f36\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/codemirror.js\":\"16ae892442c0a759\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/codemirrorCompletion.js\":\"7504fc1afdca2f11\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/copy.js\":\"a549d164d67980b7\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dailyPage.js\":\"8d43620064ea275f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dbForensics.js\":\"b7c4de2ac0dccf94\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dbForensicsHooks.js\":\"0e0a25f52d212fa5\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/deleteBlockThroughUi.js\":\"b72aeb1690a71daa\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dialogs.js\":\"10dff843ceb7d3cd\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dom.js\":\"747c7f884fe9dccd\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/downloadBlob.js\":\"4f977ace1842cc00\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/drawnWalk.js\":\"24955f2a30a7c4a5\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/exportSqliteDb.js\":\"154e2cdb8cac01e9\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fileSystemAccess.js\":\"6df10fa3677d6643\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/flipSlide.js\":\"055295a7704b5e8a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fnv1a.js\":\"6a02868e4747810a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/formatBytes.js\":\"0fde8a47c53304bc\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fuzzyRank.js\":\"e3c793f8e0b9ac5f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/idbKeyedStore.js\":\"b6af7c1ff7af6c17\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/idleCallbackPolyfill.js\":\"90022dc0881dfa97\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/keyboardAwareScroll.js\":\"faa947d007714601\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/keyboardViewport.js\":\"c60c2bcdebb97211\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/lastWorkspace.js\":\"637e7e4b4bdbc69f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutColumns.js\":\"d543caab95f6a3ad\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutSessionDom.js\":\"2d72283f20c26477\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutSessionId.js\":\"2eb08fc72f3011b9\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/linkClickGestures.js\":\"4465957aa53aafde\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/linkTargetAutocomplete.js\":\"4f706d39fa184ca9\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/localDbCorruption.js\":\"4b1b52e104d68c9f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/localDbRecovery.js\":\"3326b0ab54bf2324\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/markdownParser.js\":\"8fee64bd4cb1f2a2\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/memoize.js\":\"cb9d082353f20225\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/nameFieldCommit.js\":\"81f1d21dd8a8ae8e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/nameList.js\":\"b9d81faf88125d4c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/navigation.js\":\"d5c1f4aa7e201942\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/omnilinerNamespace.js\":\"f836056c2e0e4836\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/opfsPageScan.js\":\"ca6f95b1f8e615d7\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelClearance.js\":\"44dbeef9d9fccabc\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelHistory.js\":\"50916dc7db188edc\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelLanes.js\":\"2eef559e4cbcab24\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelLayoutProjection.js\":\"d90fc9f8de7a7b28\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelScrollAnchor.js\":\"f264637c0f3f28c1\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelUrlFlags.js\":\"d5ad83cccf260fb2\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/platform.js\":\"272391717142bf1d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/pluralize.js\":\"f0f98c126802db2b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyCreation.js\":\"a1a6b396ac44bbae\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyNavigation.js\":\"f6be46ba5643a020\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyValueContext.js\":\"8dffbde126b8d030\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/react.js\":\"e4d01deeeb4a225b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/relativeDate.js\":\"2e1c148159cc493c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/relativeTime.js\":\"f048e3301ab64128\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/renderScope.js\":\"9f1e5ba8df3bb440\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/resolvedThenable.js\":\"2d7ee5c119c4b83d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/routing.js\":\"c9864914dba1e00a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/safeMode.js\":\"bba4106f4235e276\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/scheduleIdle.js\":\"61b0022da76e275a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/screenWakeLock.js\":\"97fbd0cc0a1d8c47\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/selection.js\":\"ff2c657d71cc55a2\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/softKeyboardGrab.js\":\"e8cd07b0dbc6e356\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/startupTimeline.js\":\"26d4d69bf54090ee\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/state.js\":\"12f3a114b9b3685c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/string.js\":\"87fe5f8461a7cc43\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/surfaceZoom.js\":\"937f7d2897b103b2\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/time.js\":\"3c3b77fc610197a2\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/toast.js\":\"4e67a0f084ba1f4d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/toggleStore.js\":\"d2774edfba085420\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/untilStopped.js\":\"4ec2dc2b646703fc\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/userActivity.js\":\"451bb15de74b3f97\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/viewTransition.js\":\"83cf74915c8e65f5\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/viewport.js\":\"5da0f9b002647acf\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/webLock.js\":\"1b6ac40b13b7300e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/workspaceRecovery.js\":\"6edfb52e2567e94d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/workspaceSnapshotStore.js\":\"02ace14f62139c73\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-compiler-runtime.js\":\"15591e25235bc714\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-client.js\":\"921864c77148f9fa\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-server-edge.js\":\"ee3dd6dcd5201777\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-server.js\":\"14ca235820a55e1e\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-static-edge.js\":\"0defff60e40f0f25\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-static.js\":\"296b8aeebd6f5e80\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-test-utils.js\":\"e68d829d9bba81f5\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom.js\":\"5ebc302a8dabfd1d\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-jsx-runtime.js\":\"e84c8b1d0b062b79\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react.js\":\"ff7139d1eda70f7c\",\"/knowledge-medium/pr-preview/pr-1914/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1914/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1914/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
