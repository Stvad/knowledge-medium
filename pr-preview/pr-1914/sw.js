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
		buildId: "4d6cb3a5d314-e12e6f97",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/\":\"51d22a15b5153e74\",\"/knowledge-medium/pr-preview/pr-1914/index.html\":\"51d22a15b5153e74\",\"/knowledge-medium/pr-preview/pr-1914/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1914/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1914/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1914/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1914/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1914/assets/FacadeVFS-DhTj-ED6.js\":\"4df7aa3bc35edc90\",\"/knowledge-medium/pr-preview/pr-1914/assets/OPFSCoopSyncVFS-Cd3XGD6g.js\":\"3b23c213acd82b2d\",\"/knowledge-medium/pr-preview/pr-1914/assets/OPFSWriteAheadVFS-DvWalbDy.js\":\"96caa91eb48d7a3e\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-CjyKgg_a.js\":\"56f6f832d9de1d37\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-async-3zaSseyk.js\":\"3d643d8a7b0f4cf9\",\"/knowledge-medium/pr-preview/pr-1914/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1914/assets/worker-NVD9C0Bs.js\":\"abea3b1c560b81a2\",\"/knowledge-medium/pr-preview/pr-1914/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1914/chunks/app-Bb_Mjsf2.js\":\"a8241b30e9bb1292\",\"/knowledge-medium/pr-preview/pr-1914/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1914/index.js\":\"427a16096aae97f4\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1914/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1914/assets/AccessHandlePoolVFS-DxGzDC4K.js\":\"c8bfce4f50bfa012\",\"/knowledge-medium/pr-preview/pr-1914/assets/IDBBatchAtomicVFS-D0M47mwA.js\":\"4bcbe1a588588b0b\",\"/knowledge-medium/pr-preview/pr-1914/assets/MemoryVFS-Jebj8RPl.js\":\"52f390901ba9932d\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-DHk5QXgk.js\":\"dd071bf4ad932abf\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-async-BPG0drxK.js\":\"8e98161b29931b6f\",\"/knowledge-medium/pr-preview/pr-1914/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1914/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1914/chunks/AccessHandlePoolVFS-BRAU0Lj-.js\":\"a83d987f53549cd1\",\"/knowledge-medium/pr-preview/pr-1914/chunks/FacadeVFS-BzwHgA-e.js\":\"75418c163806b971\",\"/knowledge-medium/pr-preview/pr-1914/chunks/IDBBatchAtomicVFS-C-cnLuP8.js\":\"bbf3025334d14bfe\",\"/knowledge-medium/pr-preview/pr-1914/chunks/MemoryVFS-CLzWej0x.js\":\"68b780b36a43cc40\",\"/knowledge-medium/pr-preview/pr-1914/chunks/OPFSCoopSyncVFS-DW_IZVRD.js\":\"53a18b1afaedffb0\",\"/knowledge-medium/pr-preview/pr-1914/chunks/OPFSWriteAheadVFS-CEber0rF.js\":\"e457b9169ce4a4af\",\"/knowledge-medium/pr-preview/pr-1914/chunks/Preview-CXXfAN5a.js\":\"ad083d16d1ffdfaf\",\"/knowledge-medium/pr-preview/pr-1914/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1914/chunks/card-B8tR9pnd.js\":\"6412f919ee2570b0\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1914/chunks/dist-OQu7MTFJ.js\":\"62aae76453c35531\",\"/knowledge-medium/pr-preview/pr-1914/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1914/chunks/mc-wa-sqlite-DZSYCUdb.js\":\"38c336fd2aacefea\",\"/knowledge-medium/pr-preview/pr-1914/chunks/mc-wa-sqlite-async-CkerVRR-.js\":\"bef5b2bebef23cfc\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-7qkv3RNk.js\":\"29d4ae20e7abc612\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-CWwY31HF.js\":\"4c5998b95cf25f32\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-DDYpmWAa.js\":\"c1f44eec932aeaf3\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-DcWP-gzf.js\":\"349232255795462d\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-Dhuvor2z.js\":\"fab02a735ff20185\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-Dn4yTm5o.js\":\"1d665a91833e991e\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-H30ET_w_.js\":\"8840ead5ba7a915a\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server-legacy.browser.production--_yWyPL2.js\":\"5a80f48596fd841f\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server.browser.production-BDI9zhgg.js\":\"5bb100dd4898717e\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-dom-server.edge.production-CgEE_my9.js\":\"7f95f5a46b3bb981\",\"/knowledge-medium/pr-preview/pr-1914/chunks/react-hZCz2NFW.js\":\"956e16caf1f6fd11\",\"/knowledge-medium/pr-preview/pr-1914/chunks/server.browser-E6lJWnD7.js\":\"926449bf16c132d0\",\"/knowledge-medium/pr-preview/pr-1914/chunks/textarea-ChFuiR7a.js\":\"f67a48d34950ad03\",\"/knowledge-medium/pr-preview/pr-1914/chunks/ui-C3keM5pA.js\":\"8d574f85ea049b16\",\"/knowledge-medium/pr-preview/pr-1914/chunks/wa-sqlite-4u-7N4da.js\":\"ab6082f24cba190f\",\"/knowledge-medium/pr-preview/pr-1914/chunks/wa-sqlite-async-SP4Qp5Qh.js\":\"f1beff2159621739\",\"/knowledge-medium/pr-preview/pr-1914/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1914/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1914/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1914/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1914/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1914/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1914/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1914/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1914/src/App.js\":\"5aaf4a71c270ce66\",\"/knowledge-medium/pr-preview/pr-1914/src/appUpdate.js\":\"b9afcb3683667e19\",\"/knowledge-medium/pr-preview/pr-1914/src/appVersion.js\":\"f860d1f345f613ff\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/initialLayout.js\":\"09362faececdf3e2\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/openWorkspaceData.js\":\"50b8bd64ed94563b\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/resolveWorkspace.js\":\"8d0e3ccbb453e225\",\"/knowledge-medium/pr-preview/pr-1914/src/bootstrap/workspaceBootstrap.js\":\"1a361e3242479994\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockComponent.js\":\"03193d68561b2994\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockCrumbs.js\":\"3a9c77fa00c90775\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockEditor.js\":\"dfc363dca0c2f292\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockLoadingPlaceholder.js\":\"97aa79ab7a246237\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockProperties.js\":\"5937783f712b57ca\",\"/knowledge-medium/pr-preview/pr-1914/src/components/BlockSearchPicker.js\":\"fb32a4a409fcd067\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ConfirmBulkDeleteDialog.js\":\"05705e74ceee2c20\",\"/knowledge-medium/pr-preview/pr-1914/src/components/DividerHandle.js\":\"d89f8d3166d6cc0b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/DraftEditor.js\":\"71ce68f604b58c64\",\"/knowledge-medium/pr-preview/pr-1914/src/components/GutterPill.js\":\"2fedb7a6cbdbedbf\",\"/knowledge-medium/pr-preview/pr-1914/src/components/Header.js\":\"41c8c868c85c4b92\",\"/knowledge-medium/pr-preview/pr-1914/src/components/LazyBlockComponent.js\":\"4d6d8d503cc1e68e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/Login.js\":\"cfccde93b4654dd8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ZoomableSurface.js\":\"95f6095325f8002b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/editModeKeepalive.js\":\"1cb2fa725bf4378b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a77feb521cf796b6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"88e90d511fab15f3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/RefPropertyEditor.js\":\"d48949984d433977\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/RefTargetTypePicker.js\":\"0a8c15a8cf226135\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/SelectPropertyEditor.js\":\"60cad16b1f63fe9d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/TypesPropertyEditor.js\":\"ff5ba57fd9486231\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/defaults.js\":\"b853990801411d46\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/kernelValuePresets.js\":\"bbed51042185450b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/selectablePresets.js\":\"f6aec3c541922b38\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyEditors/typesPropertyUi.js\":\"f119a2634fcd67fd\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/AddPropertyForm.js\":\"203cf907acd5c7f0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/PropertyPicker.js\":\"84def683df2fa84e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/PropertyRow.js\":\"4bd92d357bf8da29\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/Rows.js\":\"7c190bd3a348ebfc\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/actions.js\":\"bf395f3a14b20095\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/declarationOnly.js\":\"d84076f661be72b6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/layout.js\":\"b1f6c36a07d1cf44\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/model.js\":\"f8d59eae10ca61f0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/shapeUi.js\":\"ac240150932a0891\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/shapes.js\":\"565d5d6504fd7121\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c3612f5d55115f2a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanel/visibility.js\":\"2c0274c5316ebdea\",\"/knowledge-medium/pr-preview/pr-1914/src/components/propertyPanelSections.js\":\"07ee9c4eb460d6c0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockEmbed.js\":\"0edb25506b47d8bc\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockLink.js\":\"a829b05efafe614b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/BlockRef.js\":\"d45669e532805882\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/CompactReferenceLink.js\":\"cf2214f357b47f5e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/ReferenceLink.js\":\"4695ba011c018dc9\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/cycleGuard.js\":\"3afd5b120c7fd43a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/cycleGuardContext.js\":\"24cf50de7715181d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/linkInteraction.js\":\"fa443aae233bc97c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/referenceLayout.js\":\"a1ffe5a41e5e80b0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/references/useBlockRefAncestors.js\":\"783fd64a52f02528\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockGutter.js\":\"8a8c76c470714058\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockInfoDialog.js\":\"c63d668d2cb102b5\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockReadText.js\":\"dd867ec1c24216b4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BlockTypeBlockRenderer.js\":\"6d94e897c8b69272\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/BulletHoverCard.js\":\"e214bfdb14f7f821\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/CodeMirrorContentRenderer.js\":\"c8f40c398db3b8b2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"ca5aec0095016771\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/ColumnResizeHandles.js\":\"3e9d0e427670f1e2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"615c33c6cf513b3a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/DefaultBlockRenderer.js\":\"2641beca7bd7d26b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/LayoutRenderer.js\":\"43a6738fff244a37\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/MarkdownContentRenderer.js\":\"223ec10a9f3eec88\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/MissingDataRenderer.js\":\"a974bff716c13b64\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/PanelRenderer.js\":\"374bf3259d4534da\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8fc1f82aefa18004\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/TopLevelRenderer.js\":\"e1b585118ffd2078\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/blockGutterMode.js\":\"f3fa4c3b52020224\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/blockTitleText.js\":\"fc00990f81020ef4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/fieldCreationKeydown.js\":\"34b49d6b8546f9d4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/renderer/layoutRootContext.js\":\"f97487546ceff77d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/typeChip/TypeChip.js\":\"f307b9f145a9ce79\",\"/knowledge-medium/pr-preview/pr-1914/src/components/typeChip/chipStyle.js\":\"4ef66aa8f42b194a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/anchored-floating.js\":\"d7260a8b8181c916\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/button.js\":\"c39d5eb5fbe16cac\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/card.js\":\"e73c6c2df1a980c2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/checkbox.js\":\"1b56b92308a927b2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/collapsible.js\":\"5315209d9eaa57ec\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/command.js\":\"b97b7042b6f83e1f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/context-menu.js\":\"cb19e28fbe63a70b\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/dialog.js\":\"945db9c8697b5f98\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/dropdown-menu.js\":\"cff722f034f445b2\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/floating-listbox.js\":\"4615f8c74d0d0cae\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/index.js\":\"efbf2f66ce4dbeae\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/input.js\":\"6e216e05e98943da\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/kbd.js\":\"a5c23bd54acd8030\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/label.js\":\"3a0ea1ba8a2df031\",\"/knowledge-medium/pr-preview/pr-1914/src/components/ui/textarea.js\":\"0bfc7eff0fac8ef4\",\"/knowledge-medium/pr-preview/pr-1914/src/components/useEditModeYieldKeepalive.js\":\"752013cc4eb75fd1\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/BootFallback.js\":\"29f5253fd10a68c8\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/FocusedRowLazyMount.js\":\"d1b0e5674dfd6f9e\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/LazyViewportMount.js\":\"a47d3a8562af2c84\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/LocalDbCorruptionFallback.js\":\"da6e78d0745d8492\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/error.js\":\"94eef7908e5eb684\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/lazyMountRegistry.js\":\"549cbb81023accba\",\"/knowledge-medium/pr-preview/pr-1914/src/components/util/suspense.js\":\"86903d6d76376da3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/CreateWorkspaceDialog.js\":\"1b47f23571ab71d0\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/PendingInvitations.js\":\"2ab4c3ea720f608c\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/SyncProgress.js\":\"9364d88420584ae3\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/UnlockProgress.js\":\"2f452a066b4f161a\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceKeyGate.js\":\"b4bee01f45fec74d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSettingsDialog.js\":\"a8e2ab72c03cdaa6\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSwitcher.js\":\"0b516f6643c8326f\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/WorkspaceSyncGate.js\":\"e139128bc1b0ea9d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/ConversionFlow.js\":\"24fd9cb873cf2091\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/ConversionFlowHost.js\":\"38c356d982af36df\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/EncryptionSection.js\":\"33217bea752fce41\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/attachmentPrompts.js\":\"612817e42d027303\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e71b154c38286b79\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/conversionFlowDeps.js\":\"668ce248bdc7b4fd\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/conversionFlowStore.js\":\"af60e08795c57cae\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/flowUi.js\":\"57b2b1fc4fb66831\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/conversion/useConversionRun.js\":\"94ee682c336553ae\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/keyUi.js\":\"4ee2b3e335f7de4d\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/useCloseOnKeyLoss.js\":\"742fb82cf85c3595\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/useCloseOnServerE2ee.js\":\"7087af57f92a8754\",\"/knowledge-medium/pr-preview/pr-1914/src/components/workspace/workspaceUnlocked.js\":\"78916959e14bd68c\",\"/knowledge-medium/pr-preview/pr-1914/src/context/backgroundSubtree.js\":\"4c353699a8528c0d\",\"/knowledge-medium/pr-preview/pr-1914/src/context/block.js\":\"8425cc19bde2f9c1\",\"/knowledge-medium/pr-preview/pr-1914/src/context/layoutWsContext.js\":\"68dc3a0f4a0a5661\",\"/knowledge-medium/pr-preview/pr-1914/src/context/propertyDisplay.js\":\"9735a3544b577c26\",\"/knowledge-medium/pr-preview/pr-1914/src/context/repo.js\":\"2fe96e4dff016c26\",\"/knowledge-medium/pr-preview/pr-1914/src/data/aliasClaim.js\":\"8ec63f51763becda\",\"/knowledge-medium/pr-preview/pr-1914/src/data/aliasSeatNamespace.js\":\"9c7e151521c80881\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/blockData.js\":\"7f26e1b16c153da5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/blockType.js\":\"71149031b3c34878\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/changeScope.js\":\"de66ed876bddceb9\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/codecs.js\":\"8596d9cbd876b6af\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/derivedData.js\":\"5a70fb812c5673b2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/errors.js\":\"654588de53e09ffc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/events.js\":\"1e606448b2297697\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/handle.js\":\"3b1a75aa8f906ee7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/index.js\":\"a9310fe3592432e0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/mutator.js\":\"e5aead7ba310e31f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/processor.js\":\"8aa71de1c6ee4cd3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/propertySchema.js\":\"fa5a9424de601e23\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/query.js\":\"922ec7be58a16caf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/sameTxProcessor.js\":\"1bd9db9ba513ee99\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/schema.js\":\"3b1a75aa8f906ee7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/tx.js\":\"3b1a75aa8f906ee7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/typedBlockQuery.js\":\"e55066cfb0e91842\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/user.js\":\"bb784499e5598c50\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/valuePresetCore.js\":\"f1c59484dc05023b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/api/valuePresets.js\":\"e7f054f67038f248\",\"/knowledge-medium/pr-preview/pr-1914/src/data/attachmentCleanerIOVerb.js\":\"18329cea4616c9f8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/block.js\":\"3a7b2d2300ba0318\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockCache.js\":\"a4ecc2bab2976ab2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockId.js\":\"0d38016bc121f1d4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockLiveness.js\":\"03684405187c7bac\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockMerge.js\":\"556d906cd47e1143\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockSchema.js\":\"944a7f0cc216a9c5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockTypeLookup.js\":\"10e5892102f02705\",\"/knowledge-medium/pr-preview/pr-1914/src/data/blockTypes.js\":\"045762d52a81cfcd\",\"/knowledge-medium/pr-preview/pr-1914/src/data/childrenView.js\":\"2093e167b8e1b2f2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/clientContext.js\":\"3f8f2b17f413259f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/dbFileSiblings.js\":\"868c74de1a7deec3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/definitionSeeds.js\":\"cb28570df08d4238\",\"/knowledge-medium/pr-preview/pr-1914/src/data/derivedIds.js\":\"a5d01ef6c042d548\",\"/knowledge-medium/pr-preview/pr-1914/src/data/drawnSubtree.js\":\"ec1fda2b8b316e99\",\"/knowledge-medium/pr-preview/pr-1914/src/data/facetBridge.js\":\"3de712c437e3b18e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/facets.js\":\"f439424fb9663771\",\"/knowledge-medium/pr-preview/pr-1914/src/data/globalState.js\":\"7a892c9b2aca6223\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/aliasClaimRederiveProcessor.js\":\"eb28421fc1baf379\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/ancestorBatch.js\":\"60846f0a0a36cc75\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/blockTypeTypeifyProcessor.js\":\"1763a6b2e0de7c67\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/clientSchema.js\":\"8c74823ee987a090\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/commitPipeline.js\":\"9e1bfa33c54757a4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/devAssertions.js\":\"b4fbf64330a22beb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/firstSync.js\":\"5e479587c2016d8b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/freshInitialLoad.js\":\"2ffea68024ee9513\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/graphBackfillClaim.js\":\"622e6f27c7fcab0a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/handleStore.js\":\"9a91e5bfe8d56f72\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/idleMarkerJobs.js\":\"50ffc0966a27619b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/initialDownload.js\":\"e45a71a09ea24619\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/initializeClientDatabase.js\":\"df40d8e4385e5762\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/jsonCanonical.js\":\"3d7bf81f73da6029\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelInvalidation.js\":\"2c23a563cf016acd\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelProcessors.js\":\"ae4403a615fcfc52\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/kernelQueries.js\":\"86ff64eb22fcbbf0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/mergeTypeMembershipProcessor.js\":\"881da25aa63af458\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/normalizeReferencesProcessor.js\":\"f6a6df4b03366210\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/poolInstrumentation.js\":\"9b3c83ed78670b9d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/processorRunner.js\":\"0dda686e11f40906\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyCellBackfill.js\":\"8585a003c5b3a787\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyChildMint.js\":\"bec89eab508b29d1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyChildrenProcessor.js\":\"287200085d969cf3\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyDefinitionChangeProcessor.js\":\"af70bfec59afaccc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyDefinitionSynthesis.js\":\"a9ad2dc71fe8aaa2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyKeyScan.js\":\"15008b3f41d981eb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertySchemaResolution.js\":\"a76901b06d919ad0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/propertyValueEdits.js\":\"8375f106efa6e197\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/raiseProtocol.js\":\"798e25271f0a6bd2\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/readBatch.js\":\"7e7e2147f96e5880\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/refProjection.js\":\"bb368493ded80fcb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/referenceTargetLookups.js\":\"0853a0b87a93cb9e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/referenceTargetProcessor.js\":\"085af4448f0474f4\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/replayMerge.js\":\"9ae9a520158070eb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/sqlBinds.js\":\"61e7a7eae2b22c7c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6447629bf4ca2688\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/arrivalProcessors.js\":\"208505ff448f1ccb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/invalidate.js\":\"5b697e103de2b05c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/materialize.js\":\"0119159149a281db\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/observer.js\":\"4b908259a09935bc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/syncObserver/reconcile.js\":\"fef81c619f9c32ce\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/timingMetrics.js\":\"249880229d556bac\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/treeQueries.js\":\"bab21a26a92ccb6d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/txEngine.js\":\"46029a88e876f155\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/txSnapshots.js\":\"d60544ee1e5b29af\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/typedBlockQuery.js\":\"d4669dd1e6b6e4bc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/internals/undoManager.js\":\"1d69e9d45223cbf7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/invalidation.js\":\"1300c5841a615e90\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelDataExtension.js\":\"5bd7c58f2e4b5b9b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelPage.js\":\"f00ae0a07a66beaa\",\"/knowledge-medium/pr-preview/pr-1914/src/data/kernelValuePresetCores.js\":\"805cb41876a9ef7a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbCorruptionSignal.js\":\"71d1c6fec6715e1f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbStorage.js\":\"11bab69059529832\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localDbVfs.js\":\"7e0abf9181fb2f2d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/localSchema.js\":\"a128698302079e2e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/maintenance.js\":\"247a3074e8586fb5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/mergeProperties.js\":\"f33f95f6aa193d20\",\"/knowledge-medium/pr-preview/pr-1914/src/data/metricsConsoleHook.js\":\"32091c6dc4695fba\",\"/knowledge-medium/pr-preview/pr-1914/src/data/migrationsPage.js\":\"5af9e1ef77009923\",\"/knowledge-medium/pr-preview/pr-1914/src/data/mutators.js\":\"510c108615cacf9b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/orderKey.js\":\"a356f8f735968772\",\"/knowledge-medium/pr-preview/pr-1914/src/data/orderKeyPlacement.js\":\"b7d6549280ca1eec\",\"/knowledge-medium/pr-preview/pr-1914/src/data/outlineSurface.js\":\"0534eed88c0bed2c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pendingEditorContent.js\":\"3d235fccada5092b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pendingUploadsSql.js\":\"8e5a6a27ca8c69da\",\"/knowledge-medium/pr-preview/pr-1914/src/data/pluginStateExtensions.js\":\"d1bc25aa6816cd9f\",\"/knowledge-medium/pr-preview/pr-1914/src/data/powerSyncLogger.js\":\"034abe470fcf702c\",\"/knowledge-medium/pr-preview/pr-1914/src/data/projectorRuntime.js\":\"d1ca07b4d998afbe\",\"/knowledge-medium/pr-preview/pr-1914/src/data/properties.js\":\"022753e0da654aed\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertiesPage.js\":\"670109b7abedb258\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyChildren.js\":\"054d966faa25d0e5\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionFanout.js\":\"35e8c1822ddbaf26\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionMetadata.js\":\"e27af0aea07b9a70\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDefinitionRegistry.js\":\"9dbd183291dd83a7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyDisplayMode.js\":\"99cceef871ab977d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertyRowCreation.js\":\"9879d4c0f69687e1\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertySchemaCreation.js\":\"5d8c745f704b3fbd\",\"/knowledge-medium/pr-preview/pr-1914/src/data/propertySeeds.js\":\"ca913462843d0d09\",\"/knowledge-medium/pr-preview/pr-1914/src/data/recentsPage.js\":\"af429bcd2bb6f3c9\",\"/knowledge-medium/pr-preview/pr-1914/src/data/refTargetComparableProperty.js\":\"ed6fd085656d4683\",\"/knowledge-medium/pr-preview/pr-1914/src/data/referenceBlock.js\":\"90de10716d920256\",\"/knowledge-medium/pr-preview/pr-1914/src/data/rejectedUploads.js\":\"8335990fa8191629\",\"/knowledge-medium/pr-preview/pr-1914/src/data/releasePowerSyncConnection.js\":\"50723ece9ee52578\",\"/knowledge-medium/pr-preview/pr-1914/src/data/repo.js\":\"957e9958de6ed18b\",\"/knowledge-medium/pr-preview/pr-1914/src/data/repoProvider.js\":\"edb0912a2f9e794e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/rowProperty.js\":\"b177fe4bb6280b1d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/searchFilter.js\":\"c4e5e624492f97cf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/seedIdentityLedger.js\":\"432076f0242efef0\",\"/knowledge-medium/pr-preview/pr-1914/src/data/stateBlocks.js\":\"b572ec5f9f618fcf\",\"/knowledge-medium/pr-preview/pr-1914/src/data/structuralEditPolicy.js\":\"7f82021cd856241e\",\"/knowledge-medium/pr-preview/pr-1914/src/data/structuralInsert.js\":\"fae4c607cca865a8\",\"/knowledge-medium/pr-preview/pr-1914/src/data/subtreeDelete.js\":\"6fd2d0c3b31e611d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncStreamLock.js\":\"175cc4347de33158\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncedTableSqlRecognizer.js\":\"8d9b0fe10b0f9e60\",\"/knowledge-medium/pr-preview/pr-1914/src/data/syncedTableWriteGuard.js\":\"62b39b426980f17d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/targets.js\":\"cc14e08100f62cc6\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeColors.js\":\"00c18425b64c52c7\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeDefinitionMetadata.js\":\"ed36cfa2aaa7ed2a\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeDefinitionRegistry.js\":\"a1f4232be1f561db\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeExtraction.js\":\"1b56d13dccc4e4cc\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeInitialValues.js\":\"15d28ead24613f16\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typePropertyGroups.js\":\"56c263cad7eb1f06\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeSeeds.js\":\"256227808d3b4a40\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typeTagger.js\":\"ff56de0f1a2577ac\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typedRecords.js\":\"dbfef2952337fa57\",\"/knowledge-medium/pr-preview/pr-1914/src/data/typesPage.js\":\"628fb32053400f91\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userPrefs.js\":\"bba0855fb55b4104\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userSchemasService.js\":\"faca9edee489bd11\",\"/knowledge-medium/pr-preview/pr-1914/src/data/userTypesService.js\":\"391d1468b8a30066\",\"/knowledge-medium/pr-preview/pr-1914/src/data/valuePresetRegistry.js\":\"369a4930fd6a1fbb\",\"/knowledge-medium/pr-preview/pr-1914/src/data/visibleChildren.js\":\"54a3b52a23c07f23\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceConversion.js\":\"17bc29473adb05ab\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceFirstSync.js\":\"dc256f0f2a922017\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceIdNamespace.js\":\"da367a3736c99625\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaceSchema.js\":\"86b7c80b8d0d9168\",\"/knowledge-medium/pr-preview/pr-1914/src/data/workspaces.js\":\"b4200a68db4e726d\",\"/knowledge-medium/pr-preview/pr-1914/src/data/writeAheadLog.js\":\"171ac17f82c992af\",\"/knowledge-medium/pr-preview/pr-1914/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/BlockPasteShellDecorator.js\":\"400cdb28e3d436d2\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/atTrigger.js\":\"6232bea03d7d4e8b\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/autocomplete.js\":\"793621627416781f\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/codeMirrorExtensions.js\":\"ed1a08365fd97fb5\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/contentFlush.js\":\"c47110854c5ac195\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/defaultInteractions.js\":\"9c029df590149f50\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/editSettleSignal.js\":\"871406ec38eb43a2\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/insertImage.js\":\"9b7833ff21605693\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/referenceCompletionRange.js\":\"83c126c22d879cfb\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/referenceTargetTypes.js\":\"93d4fceadf6b507c\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/syntaxContext.js\":\"2e9cbd9182344b0b\",\"/knowledge-medium/pr-preview/pr-1914/src/editor/triggerMatch.js\":\"7ea04d1cf6a7e81b\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/AppRuntimeProvider.js\":\"601d55788cd524fe\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/BlockFocusShellDecorator.js\":\"6ba14c6fd0ac8505\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/ExtensionRenderBoundary.js\":\"9b6b7835e5ac1160\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/PanelContentRecovery.js\":\"6a877d4d5b2b53b5\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/apiCatalog.js\":\"8c6152d32b5e7810\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/appRuntimeController.js\":\"09cee40c8066e569\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/approveExtensionHere.js\":\"14e338ecf3a23ed0\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/armedCutAppMount.js\":\"b2c4e292c346a507\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/batchableKeyedStore.js\":\"6655a1c56a4704b1\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/blockInteraction.js\":\"5bd9d9ec25f2a7ba\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/blockSelectionAction.js\":\"427d5cde682662c9\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/compileExtensionModule.js\":\"6753569c4d42d641\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/compiledModuleCache.js\":\"b055f35ba70a9319\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/continuousGestures.js\":\"4ae485aa1d898037\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/core.js\":\"6f93833bffe97292\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/defaultRenderers.js\":\"d011c1bffb534fbb\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/definitionFanoutAppMount.js\":\"808dc6b70465f845\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dialogAppMount.js\":\"b5efa3129ebc9386\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dynamicExtensionSeeds.js\":\"0287119347c3b6f5\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/dynamicExtensions.js\":\"a8b54c18ef27a2cb\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/exampleExtensions.js\":\"b5b7f6772cfa098d\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionApprovalStatus.js\":\"14356cba802228e9\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLoadErrorToast.js\":\"87ce0321dc4a4633\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLoadErrors.js\":\"3389c44c5bed2de3\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionLookup.js\":\"a4213c54c93857df\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionToggles.js\":\"d6efc6a9a5b1e3cb\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/extensionUtilitiesCss.js\":\"e2b8528e13b91f7e\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/kernelPageDeletionGuard.js\":\"494a99723f75ef25\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/liveRuntime.js\":\"69fdf92281ea6941\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/openExtensionsSettings.js\":\"82e9b017d33de4a5\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/overridesCache.js\":\"b379f9fa799290de\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/pluginIds.js\":\"c846d261f4769c33\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/processorRejectionToast.js\":\"79a7adfdf311bb13\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/runtimeActions.js\":\"237b5b8f43bc1861\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/runtimeContext.js\":\"d0108d1baa0b6761\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/staticAppExtensions.js\":\"9ef964e0609d516d\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/staticDataExtensions.js\":\"ca5de2d2862c93ed\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/toastAppMount.js\":\"0585637f338ee09f\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/useOverrides.js\":\"5cd200fa3cd4733b\",\"/knowledge-medium/pr-preview/pr-1914/src/extensions/useShortcutSurfaceActivations.js\":\"c3b2f07c9a09eae6\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/discoverToggleTree.js\":\"f358fe5e3d836ddd\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/facet.js\":\"6690d7d0d1e3a482\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/resolveAppRuntime.js\":\"a1fe57a20bdbe22c\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/runtimeEvents.js\":\"1460a89983c56da2\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/togglable.js\":\"a8c94dbd43fb2b30\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/variantFacet.js\":\"e1d38e97e5e15656\",\"/knowledge-medium/pr-preview/pr-1914/src/facets/verbFacet.js\":\"dbe5840e22716891\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/block.js\":\"d09f442c0470367c\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/focusedChild.js\":\"30bf3991e9238c3f\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/propertySchemas.js\":\"ad2d384a985352fe\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/typeRegistry.js\":\"fa22d9db17f542f8\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useAncestorCrumbs.js\":\"57b92d019d7ed103\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useAutocompleteListbox.js\":\"842e454d418cc69b\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useDebouncedSearch.js\":\"8b0367e74636d01e\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useDebouncedValue.js\":\"40156a101350db41\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useFacetValue.js\":\"9d256324a732fb4e\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useIsFocalRender.js\":\"51dcaf233c009a93\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useIsReadOnly.js\":\"97218091b4ed3b6d\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useMaterializeBacklog.js\":\"587f5f7ae90d6de5\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useMinuteClock.js\":\"5d000937ccfd158c\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/usePanelLayoutProjection.js\":\"51e37ca63eff65f1\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/usePendingInvitations.js\":\"f2e4ec761d5e878d\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useRendererRegistry.js\":\"7cf47cdb74dbea78\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useRetainedFieldRows.js\":\"df3ac7758bd42a50\",\"/knowledge-medium/pr-preview/pr-1914/src/hooks/useWorkspaces.js\":\"0f0abded3e03fdb4\",\"/knowledge-medium/pr-preview/pr-1914/src/lib/utils.js\":\"f41e1bf8d1676f93\",\"/knowledge-medium/pr-preview/pr-1914/src/main.js\":\"35ce4e174a91c5a1\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/MarkdownImage.js\":\"928729379ff1f8d1\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/blockSeparators.js\":\"3eb227fce7e17399\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/context.js\":\"529181bf8b778895\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/defaultMarkdownExtension.js\":\"90acbb427fab92cd\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/extensions.js\":\"55c45f6becdb7472\",\"/knowledge-medium/pr-preview/pr-1914/src/markdown/renderMarkdownHtml.js\":\"c4600ffaa89411fc\",\"/knowledge-medium/pr-preview/pr-1914/src/minimal-editor.js\":\"30e0e47593ae3d2d\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/armedCut.js\":\"7982d0aa9acde9aa\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/captureMediaVerb.js\":\"d904ead521a196c8\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/clipboard.js\":\"eea8c6982b46765f\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/decision.js\":\"549c1c331929e60b\",\"/knowledge-medium/pr-preview/pr-1914/src/paste/operations.js\":\"7a8962a83c350041\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/account-header/AccountHeaderItem.js\":\"3834deb2c494eb6b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/account-header/index.js\":\"1e5064a48e0a9221\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"55bfb47c28acfcd1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/askAgent.js\":\"555f79f5969f5585\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/askedStore.js\":\"6515b6a2a886c857\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"61184415d0945355\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/chipState.js\":\"ae28f8d241cb4557\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/dataExtension.js\":\"1bb1dbf6bfcbb205\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/index.js\":\"be554dd4e2ed1f73\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9e13e70893bce74a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-dispatch-companion/schema.js\":\"e8f72bea427da420\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e47048748b2ac886\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6835b46d96e1a266\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/addMedia.js\":\"9826737075cd66ee\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9cb219a7bd52048e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/block.js\":\"161d0d55e6b651bb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/context.js\":\"7dc48a4fdd5fe482\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/displayIds.js\":\"22f930e80f1e00ae\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/index.js\":\"10586447dccdf0ce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/outline.js\":\"2f0f1d6d4bce3510\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/properties.js\":\"c014762e20154a81\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/refs.js\":\"595ed3b9e5aecc3d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"b641fd46c25cbb32\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/search.js\":\"8d43c51b7ff41a87\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/shared.js\":\"3aaa1de0e9e19399\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"cc9134802185705f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentViews/text.js\":\"ec01a9bdd9110b73\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/agentWrites.js\":\"176ac4b94e465d1e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/authoringCatalog.js\":\"052ff95593c3858d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/blockRefTargets.js\":\"b70a894531ce2bf1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/bridge.js\":\"b4bde7b98b63ab08\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/bridgeLoop.js\":\"85f1b4fc4aff510c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/changeHistory.js\":\"257dd5bf40bbc53b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/commands.js\":\"3fb8679a395acbbc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/commentsCommands.js\":\"627a3b05a8a442e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dataExtension.js\":\"464c5ec4930c4082\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dataModelGuide.js\":\"1c969675269f8ac1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/dayPropertyInputs.js\":\"58d318d0c509442d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/describeRuntime.js\":\"222c19bfbad78164\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/extensionLint.js\":\"693464f8d4ac6a80\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/grainAudit.js\":\"50c278f6c69ae057\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/healthCommand.js\":\"ed95f7317e707424\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/index.js\":\"d6ec162b6786a67f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/presetIdentity.js\":\"0563d7b5f1809ff8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1c5e9964b6702b3d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/readMedia.js\":\"a9bddf60e2b77fc8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/schema.js\":\"28ebefd511cb30e0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/serialization.js\":\"6215afe9503a0755\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/targets.js\":\"ea9b058f5e5155da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/tokens.js\":\"79dbc8576efe2d5e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/watchEvents.js\":\"3d93b32e28220d06\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/workspaceGuard.js\":\"10611d4b36a86856\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/agent-runtime/writeCommands.js\":\"39f2de565c944993\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/AliasCollisionToast.js\":\"3f37e9c47afd54ec\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/DuplicateNameBanner.js\":\"af912dd2b842c8f5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/collisionMerge.js\":\"9bc076e965303c55\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/dataExtension.js\":\"9af35fba7ad71d67\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/index.js\":\"96b48ccd3bd1d0d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/mergeCollisionAction.js\":\"eb171182c476dd91\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/pageStyling.js\":\"d01564d2847e1603\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/rejectionToast.js\":\"62c5bc6eb0dd2cd8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/alias/syncProcessor.js\":\"88d193b0ed550cc1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/actions.js\":\"c269d7d4f907198d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/addComment.js\":\"f21d60c4253a8ca9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/anchor.js\":\"808319076eb22077\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/anchorState.js\":\"5dadbb3c3b962106\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/commentLinks.js\":\"ee1769ba24357807\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/confirmThreadDeletion.js\":\"7316a93e0dd9ae9e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/container.js\":\"c47a68f10e744f81\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/dataExtension.js\":\"0af5753448056cfe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/deleteComment.js\":\"2af76fd4eeb36f15\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/highlights.js\":\"9bcde54ba1f0738d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/index.js\":\"d08822ff963f47f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/linkedCommentsPill.js\":\"467fdb8ba4d7c073\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/margin.js\":\"4fa68c8353bac9d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/marginAnchorLinks.js\":\"e988525e5300a61d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/marginSchema.js\":\"c83b75db5e869636\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/newComment.js\":\"9f3cf5dfe42e3c95\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/ownThreadPicker.js\":\"a07b17be66a308c0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/placement.js\":\"84d6a11c6b95dbbb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/queries.js\":\"b4c5d07e241368cd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotePosition.js\":\"e78f0314da3bda34\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotedIn.js\":\"ff085d944de482dd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/quotedRange.js\":\"405452c5871fc77e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/rangeRefs.js\":\"e9a8c2ba4fb133bd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readHighlights.js\":\"bea6f79de9d6c749\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readSelection.js\":\"1d206a37455c5870\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/readSelectionUi.js\":\"1b955aff1c89b32b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/reanchor.js\":\"392fea8b7f016181\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/schema.js\":\"3babe323bed8cb98\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/scope.js\":\"ca482d1a79a224c0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/scopeThreads.js\":\"0152a616d5e8f851\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/splitRetarget.js\":\"67d4eaf89de2f6e8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/suggestionCard.js\":\"5a0c8c6074c3f781\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/suggestions.js\":\"9f2330c693559a13\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/summaries.js\":\"e45b2188a582744b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/summaryBatch.js\":\"8c72b731209c47a0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/surface.js\":\"793feb14165f0633\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/threadNavigation.js\":\"b2895b4d31cd0179\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/threads.js\":\"1eee227af1a8c752\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/ui.js\":\"31a0923ebcfc08f8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/annotations/uiStore.js\":\"34a14c0b52108704\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-intents/appIntents.js\":\"1c694a6f1f54c12c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-intents/index.js\":\"4d1f205f15063f2e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-update-prompt/index.js\":\"b7841f423b52e1ca\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/app-update-prompt/status.js\":\"f5c46b466d849ea2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ea0193f379f3ba85\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaBlockRenderer.js\":\"7615f007d11d2f82\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaDownLaneReplicator.js\":\"15f36be15619513f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/MediaUploadReconciler.js\":\"cc1185153ae55c58\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetDownLane.js\":\"7db06af268ba5adb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetResolver.js\":\"bcea5eca5d478092\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/assetUpload.js\":\"99e7c07de81f8096\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/attachmentCleanerIO.js\":\"3748707f40373c16\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/supabaseAuditIO.js\":\"5a96340203ea1ace\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/blobStore.js\":\"9d7fb9d13efca053\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/browserMedia.js\":\"028a0aa2220300ba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/byteStore.js\":\"2173fe42e197aab2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/cleanerIO.js\":\"87e7e4ae73a28281\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/cleanupAttachments.js\":\"7887139d60d59341\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/dataExtension.js\":\"e9cb20739b546a38\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/downLane.js\":\"ef2e542b644b74f5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/index.js\":\"14eeebc8bbc3af4d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/insertImageContribution.js\":\"883eb2ca49a52b4d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/laneArming.js\":\"974069b5a68b09be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/laneLock.js\":\"557dc90ad0299461\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaBlock.js\":\"b1454fa8b6d2b1a8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaCapture.js\":\"2bdf211e5288f51a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaLanes.js\":\"a34b4280879f62fb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaViewers.js\":\"c3a0ecdf6bb40a23\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/mediaViewersFacet.js\":\"bc540fba5e10e517\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/pasteCapture.js\":\"a3c4cf20da274458\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/resolver.js\":\"41db801b7ac34059\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/retryUploadsAction.js\":\"bb2bb5f4295282a3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/storagePaths.js\":\"ec1551218de6c8cb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadDrain.js\":\"0c09c2295ed4d2cc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadLaneStatus.js\":\"6ba1f222f7056ce6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadReconcile.js\":\"d8c6ddb419637afd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadRecovery.js\":\"53ab071d63111f1b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/uploadStore.js\":\"f9d9d605a28f621c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/attachments/useAssetObjectUrl.js\":\"65204e7e8f90a87f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d5ce876bbba160c4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ad3577e6f3610bc3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/facet.js\":\"f46a39a670696d56\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/index.js\":\"49a163e6a8ebf8b2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks-view/prop.js\":\"7e3d19bd9b32fcbe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BacklinkFilters.js\":\"ebe1567a7f3d4192\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d4ba487389e0ce1b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/BlockEntry.js\":\"001068a5d8e20bf6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/LinkedReferences.js\":\"a98180611f080efd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"33bf7a3eba084515\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/dailyNoteDefaults.js\":\"47c59b8dc7fe40fc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/dataExtension.js\":\"33a81a641969523b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/edgeExclusions.js\":\"4a3445d717e6b063\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/filterProperty.js\":\"e8834fdd2b87a904\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/index.js\":\"884a7c2f8946edfa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"c0240b45fb25497a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/applies.js\":\"51b29c3def41dc5b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/countQuery.js\":\"02894a7715216c06\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/expansionStore.js\":\"615a90d35a884c64\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/index.js\":\"dbbd31aaeb888588\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"1821ced704fda162\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/presentationInvalidation.js\":\"45fff64d1331df66\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/propertyEditorOverride.js\":\"2f1f80dda684cf02\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/propertyFilter.js\":\"8199f38eb96f3fb9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/query.js\":\"f8e575016fe24d9a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/resolveFilter.js\":\"d671e00f741e652b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/sourceBatch.js\":\"7f1c15fdb19673ce\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/sources.js\":\"c231bd9544af9425\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/useBacklinks.js\":\"5eeaf60e9b32b46a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6b04995faf56686f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/BirthdayCelebration.js\":\"a549d50064688c0c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/BirthdayOverlay.js\":\"5ec80ea946a07f4d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/gate.js\":\"72d5bb67df0c40f7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/index.js\":\"42f78fc2163275e6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/birthday/wolfTheme.js\":\"c169bd8ea0dc4f58\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/BlockDragLayer.js\":\"11a370ded66dc907\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/dragController.js\":\"53d3f7d871115f73\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/dropTarget.js\":\"c58a0f4dfdc9f8e3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/index.js\":\"a5c3e7fa930fe53e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-drag/projection.js\":\"ebf659985a2a618f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-info/BlockMetaCard.js\":\"3bcd7f066e4dc856\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-info/index.js\":\"7558948736abcb86\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/AddTagDialog.js\":\"dc1a77ef2c9e409a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"193dbdd62018f1d6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/TagNameIssueHint.js\":\"f12912d4370f210f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/addTagAction.js\":\"72ad83be4a48a581\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/appendTag.js\":\"6271939b2c648a05\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/config.js\":\"791a055f1bcef929\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/dataExtension.js\":\"a0595c9e2cb97eb2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/index.js\":\"488cbd4b401cc861\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/block-tagging/propertyEditorOverride.js\":\"aa086e86317e8c86\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f0d9c5824b809a4d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3f2fc4ee8b692991\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/Breadcrumbs.js\":\"a286339ed7107024\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"1f5511cbe1b68911\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2108448ae9a7306d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/index.js\":\"6c036cc54b77ca02\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"306040b954acad71\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/CharacterCountItem.js\":\"a6ed685167036d80\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/ProfilePropertyEditor.js\":\"13eb5f6cca65b3d5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/actions.js\":\"17a164dbe834c034\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/blockType.js\":\"6d455e7dbad8bb3c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/charCount.js\":\"bf64cf69476df7a5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/dataExtension.js\":\"cef9b5e15aefcef4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/index.js\":\"f420100f6ec83c60\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/profiles.js\":\"60f59586e5c69dc9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/properties.js\":\"cad3811442ad5b05\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/subtree.js\":\"c569a39343893674\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/character-counter/textCounts.js\":\"b6c93bd05c1baf40\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/colemak-keybindings/index.js\":\"1c456b0b29e3cff5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/CommandPalette.js\":\"51e7e39d54faef29\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/HeaderItem.js\":\"b17ea30d71b97c34\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/context.js\":\"a51402f563904933\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/index.js\":\"4b3a06243f827067\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/selection.js\":\"1254a19dcbcf1c1d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/toggleStore.js\":\"a50dbf985b6f956b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/command-palette/useCommandPaletteActions.js\":\"9b594f2e58bd05c1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/ContributorBadges.js\":\"c9ca999f3be841a6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/ProfilePicture.js\":\"fe67d9dbed65a44a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/author.js\":\"ae5bc8fa986e8713\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/codeMirrorExtensions.js\":\"f3418c03bd71a824\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/dataExtension.js\":\"0176e35b13f2c105\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/index.js\":\"8663ef178e9ac9e0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/mentionAutocomplete.js\":\"003c2bb588a0d433\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/processor.js\":\"25163b837fdd7d38\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/profiles.js\":\"8c0851e8240b6c6e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/queries.js\":\"8c66f0caae33bbf7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/schema.js\":\"0d900530f1e86d42\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/contributors/useCommentAuthor.js\":\"e00c9ea9bb87f530\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"019269ae4b9e09ca\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/followOrigin.js\":\"45418cff2c84743b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/index.js\":\"fafa593004774830\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"29cd3cad5734c4e3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"8efa3e367bc8778d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/CalendarGrid.js\":\"2fb5a7ebab2f1f95\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DailyNotePicker.js\":\"81f37a7a3b3d57ee\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"16614fefd8801759\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateNavDecorator.js\":\"66d3c7f73c7257c2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DateScrubOverlay.js\":\"148614d31d443fd7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DayPropertyControl.js\":\"1862b744731c328b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/DayValueReferenceControl.js\":\"40e8a04550c2bc45\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/HeaderItem.js\":\"fc12607e8a67c314\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/ReschedulePicker.js\":\"3f8a1a2c435c483d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/SpreadDatesDialog.js\":\"b603e00c11b3dfc6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/actions.js\":\"a7d13d96daa37048\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/blockDateAdapter.js\":\"89c4760ebf37e620\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/calendar.js\":\"7cfede01e791f1b1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dailyNotes.js\":\"0969feed6137b1be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dataExtension.js\":\"2381f4e146f2b354\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubActions.js\":\"623947a3f232c374\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubGesture.js\":\"e9243b799fa7aabe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubGestureActions.js\":\"bcbd25146c70d544\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dateScrubRecognizer.js\":\"86d78eec98a24a03\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dayProperty.js\":\"e1a4c64854aed7cc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"50c5edbdc4ac5229\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/deletionGuard.js\":\"85daa03633494909\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/dueQuery.js\":\"8aae6f823222e469\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/index.js\":\"99b8528e4e93186e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/landing.js\":\"ca919383fede022a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/localSchema.js\":\"be8d82f37ac98b26\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/referenceDateAdapter.js\":\"651c2c00bd0cd2fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/rescheduleAction.js\":\"cdc6a8cf72c6cf55\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/schema.js\":\"2b238ec8e8014d34\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/spreadBlockDates.js\":\"e28a44f84344a5fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/spreadDatesAction.js\":\"cb396d852affbee4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/today.js\":\"c68b9605b893ab54\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"7a3d3cf652057029\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"895862fc2a990182\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/audit.js\":\"28b18b05ae2ae55d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/auditAction.js\":\"2413a09420ed646f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/auditRanges.js\":\"5576d618bf11cd7f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/diagnosticsSource.js\":\"0f8455941f29670b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/divergenceScan.js\":\"f4e2625e9aacc2d7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/index.js\":\"35d75fc2b48a01fe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d4bc30b78132bc15\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/referencesMirror.js\":\"a1a57cc1f1305421\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/rowJson.js\":\"3379ca63f0b496c8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/schedule.js\":\"23f9b86f5f304b1a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/data-integrity/store.js\":\"4627eed7445450d1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/action.js\":\"71e00bba8c40ecd1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/index.js\":\"a17db60f014b499b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-maintenance/plugin.js\":\"f3be9884a3d4073b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"300c97418fd09703\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/actions.js\":\"2e89861858d50081\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/changeMarker.js\":\"15b503b5cedd2717\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/diagnostics.js\":\"38369713c1097434\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/fileSystemAccess.js\":\"ab0d154b60e41fe9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/filenames.js\":\"3aba50fd7e9c2713\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/index.js\":\"1f022fa9e0392846\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/mirror.js\":\"37c8bf87538a3d2b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/runLock.js\":\"f44aec6a4a62db76\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/runtimeHealth.js\":\"f45b6f9211f8fce1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/schedule.js\":\"b36d98fa69859865\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/db-mirror/store.js\":\"b432178998e714ec\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/default-themes/index.js\":\"02c163c0e500344e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/default-themes/themes.js\":\"4ad1eeb85a5839c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/diagnostics/facet.js\":\"63640eea8532cc2f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/diagnostics/useDiagnostics.js\":\"b1c135d0b8ca9700\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/dismissals.js\":\"71b8313cf18a2401\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/index.js\":\"a594b8666d50096f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/status.js\":\"f481712c2353e55f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extension-prompts/store.js\":\"b7ffb3d76db5261f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b3a7cce5e3620ce3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7bec794c9dda6a5f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/actions.js\":\"8f4d8da846c374e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/config.js\":\"d718f881a3e9193e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/dataExtension.js\":\"76e083b9bbbe466e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/effect.js\":\"30e81518f44be7d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/index.js\":\"d3e5e8b5cc6e899e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/propertyEditorOverride.js\":\"ff5b53093f1736b0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extensions-settings/useToggleTree.js\":\"60e4f8b0e335418c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/ExtractTypeDialog.js\":\"a8e77c50c72e7f67\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"7a9372727a53efac\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/PropertyShapePicker.js\":\"5996cb13ccac6744\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/action.js\":\"59aaab62d4ff241d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/extract-type/index.js\":\"69736774c7d47a1c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/FindReplaceDialog.js\":\"cb31ad5709c7bd81\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/HeaderItem.js\":\"6cec343504d28121\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/dataExtension.js\":\"00228973c76c66eb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/index.js\":\"45e1b5c3a9aa8f38\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/search.js\":\"087c2cb13af526c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/toggleStore.js\":\"b69cd173f046c045\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/LocationPropertyEditor.js\":\"e896fdeeec33577e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/MapView.js\":\"32fb8113ec8e7fda\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/blockTypes.js\":\"c20553fb768fb7d3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/codeMirrorExtensions.js\":\"7387feb61f80d39c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/createOrFindPlace.js\":\"5d4fb3cef9e1a1ba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/currentLocation.js\":\"a3c1b32cf1e97652\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/dataExtension.js\":\"17298b584df583d9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/geoContentDecorator.js\":\"2ec25d813cf626ac\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/googlePlacesClient.js\":\"5ec23f6c1a793067\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/index.js\":\"483c963e29295259\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/locationsPage.js\":\"4b1133307b1f1906\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/mapViewport.js\":\"56d6d1d04de4f9da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/pickCurrentLocation.js\":\"daade7b4e34b9d4f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/placeAutocomplete.js\":\"af1ec71b604f1901\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/placeNameCollision.js\":\"a60fed0538af9319\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/properties.js\":\"d0b40aa07deda024\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/propertyEditorOverrides.js\":\"b79ee54079dd72d8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/query.js\":\"62ae0e0f97c2ce51\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/geo/usePlaceSearch.js\":\"7bafdd17c541314e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"60fbfe87177ca9d7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"bcc493739b20153a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"d6d16df7859b647e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/config.js\":\"a08ea97e3582a648\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/dataExtension.js\":\"780d7bf2a1ce7ea7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/facet.js\":\"ae03e17029ed26aa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/grouping.js\":\"6d7941074b15b812\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/index.js\":\"a62b798dba367783\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"41393d9a193f49c3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/query.js\":\"0ed8e99846e3c9bc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/resolveConfig.js\":\"fdf70a284d6e5279\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4aeabaa711ca6f27\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d4aac14a057e50b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/HtmlDocumentContent.js\":\"3bd8d193cc68d0be\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/HtmlFrame.js\":\"e4e0dab8f948dd79\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/actions.js\":\"065cd26243f12fbe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/blockType.js\":\"61ddd17b2fda8dea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/confirmRunScripts.js\":\"2934b245f26b48da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/dataExtension.js\":\"3c8588666ff6919b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameAnnotations.js\":\"c3cbc39d79c9ecb9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameDocument.js\":\"ad40c9d2ab500ba7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/frameTheme.js\":\"d05035ca7c0346ec\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/index.js\":\"53b460b430da462f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/scriptConsent.js\":\"c763f4e1e0159ba6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/sourceMap.js\":\"1d39abb42dfce20b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/html-document/useDocumentScripts.js\":\"6f618df8f9f50605\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/index.js\":\"1d1bcd933e932cea\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/record.js\":\"a6e6878d89f1f3db\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/recordStore.js\":\"6b0ba2cf75d237fe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/responsiveness.js\":\"2e66412b01c1f161\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/schedule.js\":\"57acd8fcc280bae7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/interaction-metrics/sessionContext.js\":\"6238f304927967ad\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"a8daaf7659f90ecf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"99ec90ab182355da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/actions.js\":\"a08f8892da075ca4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/config.js\":\"0c898c50c5ddd6cd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/dataExtension.js\":\"c9bd7d25efec9b75\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/effect.js\":\"abbe6abc72804a4f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/index.js\":\"694da394043b512d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/keyCapture.js\":\"c43e9742afd15717\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/overrideStore.js\":\"64ec67861dbf755a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"054e5e50294c4ecd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/HeaderItem.js\":\"8289ae1235722841\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/LeftSidebar.js\":\"bd661df18650d467\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/actions.js\":\"4eace48de02e4a35\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/facet.js\":\"c4344e8af7292647\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/index.js\":\"d27535500f8a5ecb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/shortcuts.js\":\"f55e66cde804f5d1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/left-sidebar/toggleStore.js\":\"0d93ee14d8f58b0d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/MergePicker.js\":\"83e945292077900f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/index.js\":\"7ce85637f5eda5e1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/mergeAction.js\":\"c2ad22a2f9733664\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/merge-blocks/strategy.js\":\"5299f72ed4396d93\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/Button.js\":\"6e6582a683d2d2b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"4111d97a4f04ae00\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e673075876b722c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/facet.js\":\"333291d627b6c930\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-bottom-nav/index.js\":\"1721ac6c69d71afc\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"472b29b7c533e56d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5e9a1ea7f1293b28\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"50521baedf7c84da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/facet.js\":\"19cdc154ecac4b47\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/mobile-keyboard-toolbar/index.js\":\"cd29e3d4f95c0667\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/MoveDestinationPicker.js\":\"990a928d035aefe6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1f8849ae06a315fa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/contextMenuItem.js\":\"0d6a46e52b7a17bf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/index.js\":\"428203dd21f7466d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/moveAction.js\":\"ea86fd08d8bc12fe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/moveBlocks.js\":\"5905f41a2195d439\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/move-blocks/selectionAfterMove.js\":\"bf5e5d7a4f5a3efd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/TutorialBanner.js\":\"5ea3af8f2a7c94a4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/action.js\":\"9d3a6786d0956f52\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/bannerDismissal.js\":\"3631f8aa553314eb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/documents/cheatSheet.js\":\"fbe7fcb5663d2879\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/index.js\":\"4693637c348d933a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/keys.js\":\"72109f82b19fe5b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/landing.js\":\"2813ba443d4464b2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/outline.js\":\"8ccdb532377f665b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/onboarding/seed.js\":\"e259a7185748c73d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b06de04a278f2869\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/analyze.js\":\"38b0f09356d98b7c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/diagnosticsSource.js\":\"0e4ec19a664258aa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/index.js\":\"572219279a17bffb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/load.js\":\"3219ec33b0bbe894\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/monitorRun.js\":\"5eb194fe80bf32d1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/schedule.js\":\"8c5e89e3d4fab892\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/series.js\":\"5d2b80da7c4a6d1f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/store.js\":\"fd20ccff5a2e0600\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/trendAction.js\":\"a51b9a0ec5208540\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/perf-monitor/verdict.js\":\"63f8e0398fa9e997\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/clickToEditAction.js\":\"c8ba818b63df1b08\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/index.js\":\"981228128b56fcca\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/plain-outliner/interactions.js\":\"2d72514a207a72bd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2f857928cceb0ad4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/MigrationGate.js\":\"24a62a1fac386542\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/MigrationGateDialog.js\":\"25083c606e96cb5e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/action.js\":\"fd63fb4174362dcd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/index.js\":\"c964c7e661b47cc2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/localRunMessage.js\":\"ef9024481ce92ed9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/plugin.js\":\"2c34c6e487c2ab9a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/progressReport.js\":\"71aed9f23de5b5b1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/properties-migration/sweepProgress.js\":\"97fd17cc7e6c23cf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/FieldRowRenderer.js\":\"94742b409a095652\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/ValueRowRenderer.js\":\"3a1ecf912ce1d149\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/actions.js\":\"89410ebb0773e86b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/autocomplete.js\":\"eac021c85b392b78\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/fieldRow.js\":\"b83d2551c8f94837\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/index.js\":\"5283b71c0b486339\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/referenceWarning.js\":\"a53fb90be10db8cd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/valueAutocomplete.js\":\"f7a8bc32ae8e63da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/property-rows/valueSchema.js\":\"34df4a065a2f9282\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/HeaderItem.js\":\"cbfddff4f58f3fcf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/QuickFind.js\":\"c8d9ab5e1b058e38\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/index.js\":\"26b1da70ad2bc299\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/recents.js\":\"1810ee89c55f93da\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/resultItems.js\":\"7a9447a6ddce62d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/selection.js\":\"1dfb57d6725cf89f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/quick-find/toggleStore.js\":\"99ea483197c4877b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/HeaderItem.js\":\"7abb480392b0bf87\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0e7b2abe0c660530\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/grouping.js\":\"dcb748ab4fb9f3a9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/index.js\":\"978647edd1417f9b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/recents/target.js\":\"859bf1b3851f5d3f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/codeMirrorExtensions.js\":\"d92405ff6390b808\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/contentPrefill.js\":\"51958eb05372a85a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/dataExtension.js\":\"fe6c9ae44ae17434\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/index.js\":\"9bb3df5255a5ee14\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"b00b019ec2b93e32\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/invalidation.js\":\"ac503399c57f568b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/localSchema.js\":\"f3643422a1e35089\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/blockrefs/index.js\":\"58a68903f0ee2631\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"14dcb6b62242dfc1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/index.js\":\"08bfbace4db944e5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/referenceNode.js\":\"b19015f96616a672\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b2a0af1a4a14becb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7609704e6a2d36ba\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/index.js\":\"78537a64e98ac692\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8d8352cd478e90a1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d89584a2515bc2a0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/mergeRetargetProcessor.js\":\"f62b0cf073ad12c6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/parseFence.js\":\"be78f98a213da588\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referenceParser.js\":\"8b687f7947a4c2a0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referenceProjection.js\":\"a0892571155dc416\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/referencesProcessor.js\":\"6f09688d448fae3b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/renameProcessor.js\":\"4a8ccd5d0d51ffc4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/references/spanReplacement.js\":\"adacbd694e2cbdbd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/htmlToOutline.js\":\"e2bda7b67dcd7568\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/index.js\":\"dbacaa906ef5b6d4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/normalizeClipboardDom.js\":\"bbd5a6c1bbfe614d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/rich-paste/pasteDecision.js\":\"4b9d3adf8ca2356c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/action.js\":\"f714ecb1cb4f158e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/blockIds.js\":\"3f97265914462238\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/content.js\":\"8a019831db4f42eb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/effect.js\":\"ad67e7e8fb241ab6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/ids.js\":\"7ed1ed8c97006b41\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/import.js\":\"48c205ec0d92fae3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/index.js\":\"f6ad5f5cff81d974\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/plan.js\":\"8fb4db691f22e9ff\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/plugin.js\":\"a09fe6b371cd2870\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/promotion.js\":\"8370c37211add898\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/properties.js\":\"087dab108daaae42\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/references.js\":\"f2f11112f275ec5c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/report.js\":\"dc78c7dec7ec8d99\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/roamMemo.js\":\"09ab805a85991387\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/runtime.js\":\"accf79d771d00b85\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/schemaReconciliation.js\":\"6997c916873aee0c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/srsMarkers.js\":\"cc3f36c160b2f169\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/todo.js\":\"99fd94f20551607d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/typeCandidates.js\":\"2761d4c6a17df871\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/roam-import/types.js\":\"e0a2a2900d66ceaf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/search-health/index.js\":\"2ec957deaa51bb08\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/search-health/store.js\":\"dbefe225e82b8a8a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/HeaderItem.js\":\"5f35bb1c25d19642\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a0173a555207417e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/index.js\":\"9c64d1de14c35195\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/model.js\":\"4ce0b5281fd7fc5b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/toggleStore.js\":\"15d9d497aeac238c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/shortcut-help/useKeyInspector.js\":\"e8865008fc26d100\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"344e3ff2f2c47129\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/ShellDecorator.js\":\"d378469ed1e16991\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/actions.js\":\"32d61e3195015e29\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/exclusionsFacet.js\":\"64db660ee21cdc6f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/index.js\":\"e940951333dc5e0f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/shell.js\":\"04d0d1a86c51a3a5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/surface.js\":\"4cece032e3f39e18\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/spatial-navigation/walker.js\":\"4f668119aba55696\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ef701173311357c0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/dataExtension.js\":\"0df4d6484154fe5d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/index.js\":\"c5d1cd64e2f14d21\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/indicator.js\":\"a9d18337488e3cd5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/moveSrsState.js\":\"26664b112bb8bba8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"10ee3c324d7f6513\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/scheduler.js\":\"0d0d2584aa7a4c8b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/schema.js\":\"7bcc2d8affd05884\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b681f291cf2659bd\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/srsClipboard.js\":\"87a383f75750833d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"54d0ae3ef0f5b6a9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/DailyNoteReviewHint.js\":\"89d5772aee5646cb\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/DeckPicker.js\":\"b3bb9ed4495f222f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewControls.js\":\"f3e777eeb6924b28\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4409c00b7ba9232d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/ReviewSession.js\":\"a1b71e2ffbc0bc33\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/actions.js\":\"b9e429fd48777200\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/archive.js\":\"d51179d6c6f5962d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/dataExtension.js\":\"5908dba9a96a3a7b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/deck.js\":\"48f69fe5e773d14b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/dueQuery.js\":\"c6e4006519247302\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/gradeDecision.js\":\"4ef18ac0c7976fc9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/index.js\":\"dd215c17742dcd62\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/keyHints.js\":\"7cf26d8a6a023a8f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/reviewCardLayout.js\":\"b8159b4108b29914\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/reviewProgress.js\":\"ccc5a0b65296a678\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/schema.js\":\"9ac304cf073c43b4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/srs-review/useDueCards.js\":\"f3c3016ebfec73d0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/startup-metrics/index.js\":\"1b12e83a047ed31a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/startup-metrics/record.js\":\"85a346074414ffe9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/index.js\":\"0100235369b28dfa\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/persistenceStatus.js\":\"c33391c8a1084cc2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/storage-persistence/requestAction.js\":\"ab44f024ee7108c3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/TypeChipsDecorator.js\":\"8b695e9865d3c809\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/codeMirrorExtensions.js\":\"2d603b22afc4461a\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/index.js\":\"23c662deb71b9b1d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/supertags/typeAutocomplete.js\":\"d9c753264a857657\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"b0fea320a74e7d7e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/actions.js\":\"c56a35b016cdb539\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/anchor.js\":\"7d4004c5f0acc1c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/events.js\":\"7e162f0f17150257\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/gestureActions.js\":\"22a11611eebb3093\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/index.js\":\"609c6c8a922b413f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"6321e33dcde8e2d4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/collect.js\":\"0fdf9469941b74a6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/index.js\":\"dd4ddbe1ed29b924\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/sync-metrics/record.js\":\"0710752a4309fdf7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/RejectionDialog.js\":\"2d502f576816f322\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/SystemStatusHeaderItem.js\":\"2ce74ede677b1537\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/index.js\":\"68c7b02e6e8a699b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/model.js\":\"3ebd4e53b40096b6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/queueCounts.js\":\"d19d57c1b1136a55\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/rejectedHelpers.js\":\"648ac17a10bb554f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/rematerializeAction.js\":\"dbf67d05e4d0ab74\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/system-status/useHysteresis.js\":\"2a417bc77db75dd8\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/ColumnHeaders.js\":\"899827954d20e8b0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/QueryUi.js\":\"d4021146a3aff077\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/TableLayout.js\":\"a9264eb12715c077\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/actions.js\":\"f0b3b55070b6e98f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/cellEdits.js\":\"2a1652ec5af24828\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/childrenViews.js\":\"89c8f682fe31fc6e\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/columns.js\":\"0fbf3026c800241b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/controller.js\":\"231a588364ae3abf\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/convert.js\":\"922c5a5425397da3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/dataExtension.js\":\"df148fd564112b51\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/index.js\":\"3acbdb611ccf0ece\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/keys.js\":\"ce6dc33b3920c670\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/model.js\":\"cdfb90e1bd733814\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/QueryText.js\":\"5bf5b7b220eb2be3\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/backfill.js\":\"0dc9b7398939a3fe\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/completion.js\":\"320c924a00074183\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/format.js\":\"519c668ab759974d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/parse.js\":\"12f292b63855e8e5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/queryValue.js\":\"7982ce86a9756387\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/registrations.js\":\"27a06088a7798281\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/query/source.js\":\"b179da3a9ce6534b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/registry.js\":\"00f8fc56cf401723\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/rowGutter.js\":\"70ed71785bf0c781\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/rowVerbs.js\":\"3ff3bf1ad9a7f3c2\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/schema.js\":\"f515a69f5e1c484b\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/tables/sort.js\":\"f2c65e745049112d\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/effect.js\":\"2457246d578b0bf5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/index.js\":\"fbf30ab36a2fdd81\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/theme-toggle/theme.js\":\"ab063851c36682ed\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/actions.js\":\"1e76fe69842c5ac5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/dataExtension.js\":\"519897dcaecb9dde\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/index.js\":\"ca9297a74a4c648c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/todo/schema.js\":\"8eaf97f308671d87\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/TouchSelectionLayer.js\":\"55d82352010004c7\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/actions.js\":\"daec9ad98e03a859\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/defaultItems.js\":\"da4d90f9c3387dd0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/facet.js\":\"f395d16c3c717eb6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/holdRecognizer.js\":\"616b1e3325d40677\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/touch-selection/index.js\":\"eb4f867c41dbe2a6\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/UpdateIndicator.js\":\"fd84cd97ea43fbc1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/index.js\":\"651567f57d2f1ba4\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/update-indicator/loadTimes.js\":\"9963262f5e41e843\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoNotesRenderer.js\":\"9e911529d8a8c9ee\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoPlayerRenderer.js\":\"a7b0c6c45f44e72f\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/VideoTimeStamp.js\":\"b687d7a1681e4f47\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/actions.js\":\"1845c847fcda5eb5\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/index.js\":\"66dbab2a9fe12975\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/markdown.js\":\"ed060599c1537ba9\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/notes.js\":\"b3c3439ea3cacc64\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/registry.js\":\"92f7dac1b07a6767\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/remark-timestamps.js\":\"454b1d76c4626a17\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/video-player/view.js\":\"33059c419bc1dca1\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/LinkHints.js\":\"c8f0416e559d6fa0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/index.js\":\"8d6adf6dd586023c\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/model.js\":\"0a4e8f0428ef34b0\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-link-hints/settings.js\":\"4655fd1ad9b70564\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/actions.js\":\"a0f1b52547466723\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/index.js\":\"f448e306ef3ea341\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/vim-normal-mode/interactions.js\":\"0533e7a1d086ea64\",\"/knowledge-medium/pr-preview/pr-1914/src/plugins/workspace-header/index.js\":\"0ce2ef5da14bf63c\",\"/knowledge-medium/pr-preview/pr-1914/src/registerServiceWorker.js\":\"1001f57b2607a32a\",\"/knowledge-medium/pr-preview/pr-1914/src/requestPersistentStorage.js\":\"8e9e399b16b70d6b\",\"/knowledge-medium/pr-preview/pr-1914/src/services/authRequestDeadline.js\":\"90b8ded39d3811ea\",\"/knowledge-medium/pr-preview/pr-1914/src/services/authStorage.js\":\"97471de6d188e63a\",\"/knowledge-medium/pr-preview/pr-1914/src/services/powersync.js\":\"bc4d7b0a7a2e4ba1\",\"/knowledge-medium/pr-preview/pr-1914/src/services/supabase.js\":\"dcd93b0c70980d83\",\"/knowledge-medium/pr-preview/pr-1914/src/services/uploadErrorClassifier.js\":\"1f5ae9f7ffa2af07\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/ActiveContexts.js\":\"3b9a44f474a83903\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/HotkeyReconciler.js\":\"7aed13b4faf3161a\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/WipeLocalDataDialog.js\":\"90798f7607322834\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/actionDispatch.js\":\"7c7ab2eeb2ee3249\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/actionRefItems.js\":\"9ddbc9c867ce4be1\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/applyKeybindingOverrides.js\":\"a514a3722e05f95c\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/blockActions.js\":\"df420bc7f9fa4ef5\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/blockMergeGesture.js\":\"8efdd262ef38029b\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/canonicalizeChord.js\":\"7658a41722457511\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/defaultContexts.js\":\"ba9ecc09119da0b0\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/defaultShortcuts.js\":\"6c649b55e770d8ba\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/effectiveActions.js\":\"4cba6b085efd11ae\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/gestureAction.js\":\"b3fa79148ab846ad\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/gestureBinding.js\":\"7ac6c8b79799f47c\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/holdRegistry.js\":\"5fe5c58b53b5506d\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/keybindingConflicts.js\":\"ed3ce21129164f4b\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/keybindingOverrides.js\":\"fec194ba314a7d40\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/pointerAction.js\":\"8979e792341b1e9c\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/resolve.js\":\"4d16ab3d4a2819f6\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/runAction.js\":\"49cc3c60068c54b6\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/sequenceMatcher.js\":\"f7e17cc7872ee921\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/types.js\":\"8a052e11f2fb9132\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/useActionContext.js\":\"9cdbb4b83cc14256\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/useActionDiscovery.js\":\"310eb73e0a851601\",\"/knowledge-medium/pr-preview/pr-1914/src/shortcuts/utils.js\":\"b1bd0646ec8fbbe1\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/bootStore.js\":\"e92243ad6fc69613\",\"/knowledge-medium/pr-preview/pr-1914/src/sw/previewDatabases.js\":\"d027206134aec1a4\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/byteTransform.js\":\"ee3aca5636041c0f\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/attachmentCleaner.js\":\"ec00e14f852bd18b\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/attachmentParts.js\":\"89d31a92a0dce12c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/bundleParts.js\":\"4fdb7d40bd801ad4\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/bundleRecord.js\":\"bd7dd9ab4a85897c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/manifest.js\":\"77b1b14ec49e97fe\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/takeBundle.js\":\"4c47c019f6488f82\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/bundle/verifyBundle.js\":\"b4b39b7a85be420e\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/cleaningStage.js\":\"a60479bd493f9ea7\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionKey.js\":\"550164bdfc430287\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/conversionServer.js\":\"998739d2b302673d\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/flip.js\":\"9b15c84aac71fa39\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/flipAttempts.js\":\"dc7f085f33e77df0\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/pages.js\":\"5aa89fc97d342285\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/preflight.js\":\"52e72da50ec04ffe\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/reseal.js\":\"3bf35da17188f84e\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/runConversion.js\":\"200091f2812f4260\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/runLock.js\":\"0b8fafd7280cbfc2\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/sealing.js\":\"49ffbd2ae33f6fe8\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/sealingStage.js\":\"1813da4d75f4c227\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/stage.js\":\"b0603bbaacf76b9f\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/conversion/verifyReseal.js\":\"06b7ff9cd525ef36\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/aad.js\":\"ce23cefeae5ca69e\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/aead.js\":\"7c02338cf0cda8dc\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/base32.js\":\"1ee3608982838b15\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/base64url.js\":\"d46470523ae16596\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/binaryEnvelope.js\":\"90967d58da10f8b0\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/byteAead.js\":\"46f0c14dbe5f9801\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/canary.js\":\"b1ee604c5fc23401\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/contentHash.js\":\"9fd3f3c4dc03df4d\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/contentKey.js\":\"936e4b63eee3b043\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/derivedIdNamespace.js\":\"6e507fa31655d101\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/envelope.js\":\"c71cb5aac9f9be3b\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/hex.js\":\"defd8c7941e101e8\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/sha256Hex.js\":\"d87068311b262a87\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/crypto/workspaceKey.js\":\"2a4e5b116e22f78c\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/conversionState.js\":\"8777183192ebe120\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/createEncryptedWorkspace.js\":\"bee29a362ae11d81\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/pastedKey.js\":\"0880f323cf4794d4\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"400ca4b422b57fb2\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8ccf50913db5e0f5\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/keyStore.js\":\"64626fa8406c4f03\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/mintWorkspaceKey.js\":\"e1e447c39f622cd6\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/modePin.js\":\"e3d099b0bd94c615\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/openWorkspaceKeys.js\":\"effa48d1ad96438a\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/resolveWorkspaceEntry.js\":\"190532d782556a00\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/resolver.js\":\"79053dd616b71c46\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/keys/workspaceAccess.js\":\"546584152ab8a74f\",\"/knowledge-medium/pr-preview/pr-1914/src/sync/transform.js\":\"aec3c9c782f0f7e4\",\"/knowledge-medium/pr-preview/pr-1914/src/themeBootDefaults.js\":\"75182352e7a7f39a\",\"/knowledge-medium/pr-preview/pr-1914/src/types.js\":\"628fa69aacb76ae3\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/ClientLocalSettings.js\":\"f006b46119423b72\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/abortableSleep.js\":\"e53f64e68c69654c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/array.js\":\"d0a0190103326c19\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/backlinkAutocomplete.js\":\"0dac45a2821b05cc\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/blockCrumbs.js\":\"3cb83fec10879cd5\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/blockrefAutocomplete.js\":\"fc1547d9467832af\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/cadencedIdleJob.js\":\"2e364ce8ecd35a4a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/callbackSet.js\":\"3985c1588bdcbc08\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/clientId.js\":\"f54bb4b26a1e474d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/codemirror.js\":\"ad64ac634bc998cb\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/codemirrorCompletion.js\":\"cfe131d564943cd3\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/copy.js\":\"c24c51ee4bd2cf76\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dailyPage.js\":\"7c96f70e416068ca\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dbForensics.js\":\"0538011042c9ad3d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dbForensicsHooks.js\":\"4db52f97d421d6b1\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/deleteBlockThroughUi.js\":\"4363bb3da3a6cb93\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dialogs.js\":\"447f9a61acaef980\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/dom.js\":\"744018a1e476157a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/downloadBlob.js\":\"7a44de2aa82aace5\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/drawnWalk.js\":\"e99e2f9b6006a1cd\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/exportSqliteDb.js\":\"954fb1a0a6812e10\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fileSystemAccess.js\":\"ab01d6cb881779b2\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/flipSlide.js\":\"172b413cdf4e01ba\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fnv1a.js\":\"51b22099550e55c6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/formatBytes.js\":\"43d29278fb3ee4fc\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/fuzzyRank.js\":\"d552487b0a9d448f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/idbKeyedStore.js\":\"4aff834de60b1872\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/idleCallbackPolyfill.js\":\"113c0882325bc47b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/keyboardAwareScroll.js\":\"be8943710c98a08e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/keyboardViewport.js\":\"6cfaa2ea7b8c3fb5\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/lastWorkspace.js\":\"6ec380e1b1a58ee1\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutColumns.js\":\"772b4e8566b9edb1\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutSessionDom.js\":\"e1e5b0269556e2d3\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/layoutSessionId.js\":\"1e8e963e46ee689c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/linkClickGestures.js\":\"4c144b792b10cfc9\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/linkTargetAutocomplete.js\":\"7530ccf9d27e7751\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/localDbCorruption.js\":\"7a567a3da9edaade\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/localDbRecovery.js\":\"0db08a3cdcb20237\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/markdownParser.js\":\"70f61e6f41f0cb50\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/memoize.js\":\"69f503e30187f82e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/nameFieldCommit.js\":\"34ec3435f29496f0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/nameList.js\":\"7f69476da4051e94\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/navigation.js\":\"46f6ca0f628a393c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/omnilinerNamespace.js\":\"dd3910783e5ecaec\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/opfsPageScan.js\":\"4968b17542962876\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelClearance.js\":\"7f25f565e04fd589\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelHistory.js\":\"7739c818c14c2c32\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelLanes.js\":\"1f1579145468aa66\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelLayoutProjection.js\":\"00c019b4b61fbbb8\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelScrollAnchor.js\":\"5e8582ca9d598786\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/panelUrlFlags.js\":\"6ffba47418ed5e42\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/platform.js\":\"03446b7433d1341c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/pluralize.js\":\"8fc4e468cee7e9f6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyCreation.js\":\"61ae7b167bab2b3e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyNavigation.js\":\"c7f3f7c956f0155b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/propertyValueContext.js\":\"98be9bdc7a82cfad\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/react.js\":\"d5130aeed24f084b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/relativeDate.js\":\"f5dbc64b693dd695\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/relativeTime.js\":\"73e21324e3cfc8c0\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/renderScope.js\":\"7152c6de599f7f85\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/resolvedThenable.js\":\"08522680f54c9e8f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/routing.js\":\"0990f1085296dc5f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/safeMode.js\":\"f1ef98757eafc8dd\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/scheduleIdle.js\":\"224ec6f84bfa9cf2\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/screenWakeLock.js\":\"ac593e1af4a57616\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/selection.js\":\"5a41ccb9a497f046\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/softKeyboardGrab.js\":\"02dee9ae874971df\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/startupTimeline.js\":\"fd9d2c5c66f6910e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/state.js\":\"79957d0b6b9b6e3e\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/string.js\":\"f05d285ec90a0029\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/surfaceZoom.js\":\"9c471c0c16ead66c\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/time.js\":\"00b02f8180d86b1a\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/toast.js\":\"0cbd1855f7d02e09\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/toggleStore.js\":\"a556e4c99ffde21b\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/untilStopped.js\":\"0181fad82fbdc274\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/userActivity.js\":\"ec16f300677927e4\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/viewTransition.js\":\"29fa7a0f4748376f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/viewport.js\":\"573b762177b7af4d\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/webLock.js\":\"6fdd53217d83674f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/workspaceRecovery.js\":\"3da1b4d30610773f\",\"/knowledge-medium/pr-preview/pr-1914/src/utils/workspaceSnapshotStore.js\":\"82c5eabc9b67b78c\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-compiler-runtime.js\":\"d3ba2d140d82fa29\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-client.js\":\"412c76d055e0b0a4\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-server-edge.js\":\"ef03e37052898c1c\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-server.js\":\"fe20d55c9e6f5a0d\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-static-edge.js\":\"d9aa58aa2dd25185\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-static.js\":\"1fb5671c421b02a3\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom-test-utils.js\":\"c3c667346d41cb15\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-dom.js\":\"3c1f4c37fb77b0a1\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react-jsx-runtime.js\":\"066c1a40143703b2\",\"/knowledge-medium/pr-preview/pr-1914/src/vendor/react.js\":\"2a2b0023674c17f5\",\"/knowledge-medium/pr-preview/pr-1914/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1914/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1914/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
