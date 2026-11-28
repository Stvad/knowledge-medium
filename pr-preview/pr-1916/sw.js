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
		buildId: "097f05b8a4b8-bc6abcc8",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1916/\":\"16231753660752b1\",\"/knowledge-medium/pr-preview/pr-1916/index.html\":\"16231753660752b1\",\"/knowledge-medium/pr-preview/pr-1916/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1916/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1916/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1916/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1916/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1916/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1916/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1916/assets/FacadeVFS-DhdvqaeK.js\":\"74d42663552b527f\",\"/knowledge-medium/pr-preview/pr-1916/assets/OPFSCoopSyncVFS-DQlB3uT3.js\":\"137fb64d93bf9762\",\"/knowledge-medium/pr-preview/pr-1916/assets/OPFSWriteAheadVFS-Cy0lIm8A.js\":\"15162a53640d1879\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-BewiWc-2.js\":\"75a3b930cd66a409\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-async-E1bnMMK-.js\":\"47c5fcc885f53636\",\"/knowledge-medium/pr-preview/pr-1916/assets/worker-HAfgs7JQ.js\":\"d97ad7e92eed5e02\",\"/knowledge-medium/pr-preview/pr-1916/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1916/chunks/app-Dq9ODRJ3.js\":\"94c6752859ea9eb3\",\"/knowledge-medium/pr-preview/pr-1916/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1916/index.js\":\"9cb66e919c6159ca\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1916/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1916/assets/AccessHandlePoolVFS-B0vVIb6M.js\":\"41eeae41d24ed199\",\"/knowledge-medium/pr-preview/pr-1916/assets/IDBBatchAtomicVFS-Ci-ZhOtf.js\":\"9dd69fad9412c9e6\",\"/knowledge-medium/pr-preview/pr-1916/assets/MemoryVFS-Bn5jjt2n.js\":\"218f34a81ea1719f\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-DLXF1zOW.js\":\"6e64f63bfea7a3ad\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-async-2W7ep2P9.js\":\"5d2d96b39829449d\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1916/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1916/chunks/AccessHandlePoolVFS-DCFpOzwj.js\":\"d587f9c03ea1d2e9\",\"/knowledge-medium/pr-preview/pr-1916/chunks/FacadeVFS-gdFnX8HR.js\":\"1bfb56a1e5e51307\",\"/knowledge-medium/pr-preview/pr-1916/chunks/IDBBatchAtomicVFS-csOJ9VP2.js\":\"0cbeca93958c76d8\",\"/knowledge-medium/pr-preview/pr-1916/chunks/MemoryVFS-8q_WcP66.js\":\"010644203e16251d\",\"/knowledge-medium/pr-preview/pr-1916/chunks/OPFSCoopSyncVFS-4MOrtU5l.js\":\"496f738e866e8baa\",\"/knowledge-medium/pr-preview/pr-1916/chunks/OPFSWriteAheadVFS-DJplxewv.js\":\"a9265ede6f3f402b\",\"/knowledge-medium/pr-preview/pr-1916/chunks/Preview-7Qp1kmyc.js\":\"05623ea5b0818343\",\"/knowledge-medium/pr-preview/pr-1916/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1916/chunks/card-EY7nOfPA.js\":\"4fc67dccce1037e8\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dist-CIV7xsTJ.js\":\"7b02e050a9491f7e\",\"/knowledge-medium/pr-preview/pr-1916/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1916/chunks/mc-wa-sqlite-Bg-w0mSB.js\":\"5440714520e22321\",\"/knowledge-medium/pr-preview/pr-1916/chunks/mc-wa-sqlite-async-CxqcxlFc.js\":\"bd8a4dc18bdcec3a\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-BoFQdwe7.js\":\"21f606690506b9ac\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-C8H5g-Ve.js\":\"ac73787d16a77fac\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-CEw4WuuU.js\":\"add69f2c202be847\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-CY1IeUcw.js\":\"3fde035e63c902ff\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-Cdj-qq-l.js\":\"9a933445b41f1886\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-Cyk4x7_c.js\":\"c14f3f9d8f591762\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-Df6AKH8J.js\":\"e85ea55fa593820f\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-dom-server-legacy.browser.production-B43uYWKt.js\":\"892a90d357a5c1a2\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-dom-server.browser.production-Bd17i8Jv.js\":\"7b1a019904db4a88\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-dom-server.edge.production-C_syPAFw.js\":\"ea7ab73b2b157d4a\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-m1ca4eb5.js\":\"18ce2689c10a7034\",\"/knowledge-medium/pr-preview/pr-1916/chunks/server.browser-C8BZ37kP.js\":\"d1eb8bf5fe26b41c\",\"/knowledge-medium/pr-preview/pr-1916/chunks/textarea-BXxj28f2.js\":\"9db765b33f44c586\",\"/knowledge-medium/pr-preview/pr-1916/chunks/ui-CY7PVkOQ.js\":\"8ac3a60b0759824b\",\"/knowledge-medium/pr-preview/pr-1916/chunks/wa-sqlite-Du-8vtp3.js\":\"506ed1f5841420f0\",\"/knowledge-medium/pr-preview/pr-1916/chunks/wa-sqlite-async-2LqwZ3Fk.js\":\"ea1444ce845050c3\",\"/knowledge-medium/pr-preview/pr-1916/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1916/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1916/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1916/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1916/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1916/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1916/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1916/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1916/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1916/src/App.js\":\"7818579ad63e1cbf\",\"/knowledge-medium/pr-preview/pr-1916/src/appUpdate.js\":\"819087409f03f6e2\",\"/knowledge-medium/pr-preview/pr-1916/src/appVersion.js\":\"aa11dd6655749c3d\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/initialLayout.js\":\"21ea29e2b36f7d06\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/openWorkspaceData.js\":\"32b087d7fb6ea831\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/resolveWorkspace.js\":\"55ff2e562f02b8a7\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/workspaceBootstrap.js\":\"d8adf170a25a8a02\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockComponent.js\":\"9c3960365b20941b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockCrumbs.js\":\"835a0103e964e19a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockEditor.js\":\"e55a3e81dad11dca\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockLoadingPlaceholder.js\":\"6bc1c0cc98716b5e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockProperties.js\":\"e83f0e636fc7ff4f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockSearchPicker.js\":\"bd9a2c8dce12fb3a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ConfirmBulkDeleteDialog.js\":\"e6dfe72cde386b95\",\"/knowledge-medium/pr-preview/pr-1916/src/components/DividerHandle.js\":\"65a165355ef80164\",\"/knowledge-medium/pr-preview/pr-1916/src/components/DraftEditor.js\":\"bdabcbfff20f93ce\",\"/knowledge-medium/pr-preview/pr-1916/src/components/GutterPill.js\":\"83af34325cedc70b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/Header.js\":\"ca70780e6e691346\",\"/knowledge-medium/pr-preview/pr-1916/src/components/LazyBlockComponent.js\":\"527336cfa1efd8b1\",\"/knowledge-medium/pr-preview/pr-1916/src/components/Login.js\":\"cc813bf922a49881\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ZoomableSurface.js\":\"56ff4a3b2ffab6b2\",\"/knowledge-medium/pr-preview/pr-1916/src/components/editModeKeepalive.js\":\"e4239c7df7dfd20f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyDisplay/PropertyDisplayScope.js\":\"13222fbcbc04f8cf\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"a75bb2634d97d8ed\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/RefPropertyEditor.js\":\"f65612ca33e0d353\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/RefTargetTypePicker.js\":\"c07cc54e383a9c83\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/SelectPropertyEditor.js\":\"773807df41b2271f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/TypesPropertyEditor.js\":\"515daf600e53b6fa\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/defaults.js\":\"ce1ad862d7f03c50\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/kernelValuePresets.js\":\"b6dc1ccfa3ac402d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/selectablePresets.js\":\"a3484c75598f32f2\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/typesPropertyUi.js\":\"267637d0e06aa67e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/AddPropertyForm.js\":\"a119310950697668\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/PropertyPicker.js\":\"e2fc796f22ed6f84\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/PropertyRow.js\":\"b763e4764059ab61\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/Rows.js\":\"09faec9fb110257e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/actions.js\":\"b0570af217230935\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/declarationOnly.js\":\"eac2e7208754b6e2\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/layout.js\":\"f3b0ed2afa2f1632\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/model.js\":\"b163960d4c7ceec3\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/shapeUi.js\":\"7de80880d7ed80e6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/shapes.js\":\"4d002101eecc8f4b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/usePropertyEditingActivation.js\":\"91380d1f63db9516\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/visibility.js\":\"32c26e48dec6821a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanelSections.js\":\"b2569afb85ec050e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/BlockEmbed.js\":\"cf190e7f1a1e2bbc\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/BlockLink.js\":\"a8aa4f9266c1f22a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/BlockRef.js\":\"45da2f100b5f8d07\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/CompactReferenceLink.js\":\"4d09b11be9c57f09\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/ReferenceLink.js\":\"d7fcd30ff2eb42a0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/cycleGuard.js\":\"be12cb6027f3ff0a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/cycleGuardContext.js\":\"d2754d69eb8b2fea\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/linkInteraction.js\":\"41d4b13848f197fe\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/referenceLayout.js\":\"4b741adc92fb4e01\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/useBlockRefAncestors.js\":\"2624ca6f63dc7928\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockGutter.js\":\"bc2906791ab38b72\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockInfoDialog.js\":\"b24750048ef35ed4\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockReadText.js\":\"1891975dce1deccd\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockTypeBlockRenderer.js\":\"0c3133a1418a260e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BulletHoverCard.js\":\"1276304ebd78f30f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/CodeMirrorContentRenderer.js\":\"d43ac4f2ddff3e7d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"1412014a6797b83d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/ColumnResizeHandles.js\":\"bffedce0f908a183\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"91522f45850d7002\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/DefaultBlockRenderer.js\":\"948ef8797051d8b6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/LayoutRenderer.js\":\"cec24f7c3318bc17\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/MarkdownContentRenderer.js\":\"74adf9765f7272a8\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/MissingDataRenderer.js\":\"9a571aea3bd02c6f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/PanelRenderer.js\":\"e05aa496d330496f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/PropertySchemaBlockRenderer.js\":\"9b453028909c186f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/TopLevelRenderer.js\":\"245240290eb37d3d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/blockGutterMode.js\":\"63fc4cbd716cc818\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/blockTitleText.js\":\"9055f7c7d55b62c6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/fieldCreationKeydown.js\":\"be39dba2aeb81ee3\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/layoutRootContext.js\":\"7c0d55cbc9a4b980\",\"/knowledge-medium/pr-preview/pr-1916/src/components/typeChip/TypeChip.js\":\"3de36d5b65f30e45\",\"/knowledge-medium/pr-preview/pr-1916/src/components/typeChip/chipStyle.js\":\"36ea9d0430777803\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/anchored-floating.js\":\"81eb16ea50a94824\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/button.js\":\"32566ad83bbc579f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/card.js\":\"6a645ed518dd7e37\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/checkbox.js\":\"d8bb664f05d36564\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/collapsible.js\":\"7f16b9285e5f7c1f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/command.js\":\"d658bc9672571a97\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/context-menu.js\":\"446796171ba261e0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/dialog.js\":\"acdc18e814902397\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/dropdown-menu.js\":\"ea88ec15dfdb4dd2\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/floating-listbox.js\":\"c921959f143a0044\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/index.js\":\"83d5ea30517870ae\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/input.js\":\"54d5172eca43c52c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/kbd.js\":\"47d55622f9a6c855\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/label.js\":\"4fea40ba32c149ab\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/textarea.js\":\"33d67868e869466f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/useEditModeYieldKeepalive.js\":\"920e7de03d64827d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/BootFallback.js\":\"f732df6b3167a2d9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/FocusedRowLazyMount.js\":\"b280c504407ce83a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/LazyViewportMount.js\":\"71bf944e685a4872\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/LocalDbCorruptionFallback.js\":\"9306ac6bf61575c6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/error.js\":\"98484e5d491ed151\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/lazyMountRegistry.js\":\"69a5f55df0ba92cf\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/suspense.js\":\"c47d37d4f3ad8c87\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/CreateWorkspaceDialog.js\":\"383d0388af210a12\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/PendingInvitations.js\":\"5abdbed7acf90f7c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/SyncProgress.js\":\"75afdc6a46a72191\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/UnlockProgress.js\":\"b1a4d629dbcdec85\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceKeyGate.js\":\"c5ada895912902b6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceSettingsDialog.js\":\"289933e32b98c865\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceSwitcher.js\":\"8b1ce5696d18be71\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceSyncGate.js\":\"a91d08294d339155\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/ConversionFlow.js\":\"fac61f2019e2f0a6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/ConversionFlowHost.js\":\"4dabd02cd48866ed\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/EncryptionSection.js\":\"af9d5230c133bad0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/attachmentPrompts.js\":\"1f1d366a54dcbc24\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/bundleFolderPrompts.js\":\"863fcf3048d3c450\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/conversionFlowDeps.js\":\"b84fbf9bf2864a11\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/conversionFlowStore.js\":\"c09896a73cc40d72\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/flowUi.js\":\"cd62dbab2f43cffa\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/useConversionRun.js\":\"d17d9226ce31416e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/keyUi.js\":\"fb24ff42a7d47f51\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/useCloseOnKeyLoss.js\":\"da680cb55ed79fe2\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/useCloseOnServerE2ee.js\":\"9dea7bc0e42e111c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/workspaceUnlocked.js\":\"8ff6bfe91b7e5db8\",\"/knowledge-medium/pr-preview/pr-1916/src/context/backgroundSubtree.js\":\"52a762db03e30cd2\",\"/knowledge-medium/pr-preview/pr-1916/src/context/block.js\":\"ee30531ea650403e\",\"/knowledge-medium/pr-preview/pr-1916/src/context/layoutWsContext.js\":\"917f2e7823d28b44\",\"/knowledge-medium/pr-preview/pr-1916/src/context/propertyDisplay.js\":\"412cf94b0699b683\",\"/knowledge-medium/pr-preview/pr-1916/src/context/repo.js\":\"0e35c23231569398\",\"/knowledge-medium/pr-preview/pr-1916/src/data/aliasClaim.js\":\"3094574d0d80a296\",\"/knowledge-medium/pr-preview/pr-1916/src/data/aliasSeatNamespace.js\":\"8a426a51003ac5ba\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/blockData.js\":\"dea5616b5d093a51\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/blockType.js\":\"ce146f93c383cf58\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/changeScope.js\":\"819a055fb632e7b1\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/codecs.js\":\"2e06b2e45836d0c1\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/derivedData.js\":\"b53aa3ba43194d3f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/errors.js\":\"01995562069b641c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/events.js\":\"c837f890c455b414\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/handle.js\":\"3937caf444544c47\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/index.js\":\"f0bcb745aa6a4272\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/mutator.js\":\"8d11b9fc64903f8f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/processor.js\":\"b830566b0e74af8d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/propertySchema.js\":\"ba9270a2cd8a88eb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/query.js\":\"846c9d3a33fa2786\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/sameTxProcessor.js\":\"f14ffb32a1393bef\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/schema.js\":\"3937caf444544c47\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/tx.js\":\"3937caf444544c47\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/typedBlockQuery.js\":\"7a0eebf7e68409f0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/user.js\":\"5e00a5d099f5ae13\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/valuePresetCore.js\":\"82f2b69a4d2ba0e6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/valuePresets.js\":\"afed97cd003c28e4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/attachmentCleanerIOVerb.js\":\"efa97269d3c383c0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/block.js\":\"398c02c4908059b6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockCache.js\":\"eed6086ff91a1801\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockId.js\":\"9300630213ff65d3\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockLiveness.js\":\"52622030d40e088e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockMerge.js\":\"fb1b06e704e6dcda\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockSchema.js\":\"abac1897a1544308\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockTypeLookup.js\":\"70d7a7980cecdbb5\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockTypes.js\":\"944da1445a47f969\",\"/knowledge-medium/pr-preview/pr-1916/src/data/childrenView.js\":\"b4af0a60e904d77c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/clientContext.js\":\"2284b8515556ba87\",\"/knowledge-medium/pr-preview/pr-1916/src/data/dbFileSiblings.js\":\"370da5a2796d561b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/definitionSeeds.js\":\"4bd6b4c7ecfec8bd\",\"/knowledge-medium/pr-preview/pr-1916/src/data/derivedIds.js\":\"9020d862a613604a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/drawnSubtree.js\":\"93e4205305b495bd\",\"/knowledge-medium/pr-preview/pr-1916/src/data/facetBridge.js\":\"98846c5db97d030a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/facets.js\":\"86429f425b259e3b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/globalState.js\":\"8ed1a85920e20737\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/aliasClaimRederiveProcessor.js\":\"e2386e124ca31a3d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/ancestorBatch.js\":\"263231cc9da90da0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/blockTypeTypeifyProcessor.js\":\"09e22500fd220758\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/clientSchema.js\":\"6c6ca8a2c962961a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/commitPipeline.js\":\"100790b6e02c0c15\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/devAssertions.js\":\"173ff87bbd61cbd6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/firstSync.js\":\"050e200f0dd1abed\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/freshInitialLoad.js\":\"8bef0837bc334526\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/graphBackfillClaim.js\":\"a9be9f9e44b665bf\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/handleStore.js\":\"34b237b60c1a2b01\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/idleMarkerJobs.js\":\"4844880698d01e66\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/initialDownload.js\":\"5b04edad03af6a56\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/initializeClientDatabase.js\":\"8e727c50b95fc13c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/jsonCanonical.js\":\"6507f4de913ef0ff\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/kernelInvalidation.js\":\"c04aa680a0b4a652\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/kernelProcessors.js\":\"88a5b247fe71172e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/kernelQueries.js\":\"642663c51a762d76\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/mergeTypeMembershipProcessor.js\":\"24dc4a934b23ea04\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/normalizeReferencesProcessor.js\":\"40db8fd23eaa9971\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/poolInstrumentation.js\":\"e95907e6134181a0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/processorRunner.js\":\"9a3761cbde73c69d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyCellBackfill.js\":\"cf37e4a914697ff6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyChildMint.js\":\"cf56ec91d418771f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyChildrenProcessor.js\":\"fd811eac1b537fe7\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e6801ede741b7a7c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyDefinitionSynthesis.js\":\"0cd3fd569e3074db\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyKeyScan.js\":\"67443ae3ef40fece\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertySchemaResolution.js\":\"6d6d3777d23b8cd9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyValueEdits.js\":\"5c7231b41b218408\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/raiseProtocol.js\":\"6f9f571e5a466fe9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/readBatch.js\":\"4fe31ed2bbe64192\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/refProjection.js\":\"dbba754dd4a770d2\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/referenceTargetLookups.js\":\"306d9cf1ce4d2d05\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/referenceTargetProcessor.js\":\"e69f0f912c00c25c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/replayMerge.js\":\"99000632828a0774\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/sqlBinds.js\":\"4097c5eb380a6041\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"34e0b1f2060b5481\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/arrivalProcessors.js\":\"b73c320277882d26\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/invalidate.js\":\"cf9658ada849094f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/materialize.js\":\"c70c6bbd32d76c82\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/observer.js\":\"678a55ab47b083a6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/reconcile.js\":\"683164358fbff11f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/timingMetrics.js\":\"a152394b61f3806a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/treeQueries.js\":\"3d60e0d1f180af09\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/txEngine.js\":\"e859a3614360663e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/txSnapshots.js\":\"9143621c4bada962\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/typedBlockQuery.js\":\"765760249bbaeb4b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/undoManager.js\":\"eaa004816319030a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/invalidation.js\":\"e87bb67794484ba4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/kernelDataExtension.js\":\"26b4ea6e997f2100\",\"/knowledge-medium/pr-preview/pr-1916/src/data/kernelPage.js\":\"408f422e60f74d40\",\"/knowledge-medium/pr-preview/pr-1916/src/data/kernelValuePresetCores.js\":\"30d9e7e0e8bd631a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localDbCorruptionSignal.js\":\"fdd6d52abfb20da5\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localDbStorage.js\":\"d5111d4d971df49a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localDbVfs.js\":\"7b252dab3a83c9cc\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localSchema.js\":\"971ffc2d9bed7652\",\"/knowledge-medium/pr-preview/pr-1916/src/data/maintenance.js\":\"2bc455b3950a6378\",\"/knowledge-medium/pr-preview/pr-1916/src/data/mergeProperties.js\":\"11bc12d073912e43\",\"/knowledge-medium/pr-preview/pr-1916/src/data/metricsConsoleHook.js\":\"5b9b727853fd1d84\",\"/knowledge-medium/pr-preview/pr-1916/src/data/migrationsPage.js\":\"c6fc1677333cf239\",\"/knowledge-medium/pr-preview/pr-1916/src/data/mutators.js\":\"5b8ce8cf70bab108\",\"/knowledge-medium/pr-preview/pr-1916/src/data/orderKey.js\":\"740767539f91cf48\",\"/knowledge-medium/pr-preview/pr-1916/src/data/orderKeyPlacement.js\":\"4abbec72facab232\",\"/knowledge-medium/pr-preview/pr-1916/src/data/outlineSurface.js\":\"65f608f658c0e416\",\"/knowledge-medium/pr-preview/pr-1916/src/data/pendingEditorContent.js\":\"4f1e7a5bcf1910e4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/pendingUploadsSql.js\":\"6b3de52e4bafad7f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/pluginStateExtensions.js\":\"5ee0efce0065608f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/powerSyncLogger.js\":\"597d1ea694b7558a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/projectorRuntime.js\":\"aa4e155bedead2d6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/properties.js\":\"e75f85ae388ee60b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertiesPage.js\":\"3ca1dd97bfef0a1d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyChildren.js\":\"6e76fdf4fdb34752\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDefinitionFanout.js\":\"5b076c3eaa89cc24\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDefinitionMetadata.js\":\"3070a957d4897486\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDefinitionRegistry.js\":\"6009aacfa73abcb0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDisplayMode.js\":\"48ef1864e0c4e7c0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyRowCreation.js\":\"054722ea05c9d680\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertySchemaCreation.js\":\"b79f7a94443a50a9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertySeeds.js\":\"1f7455405a9ac6d6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/recentsPage.js\":\"85c591610cc09271\",\"/knowledge-medium/pr-preview/pr-1916/src/data/refTargetComparableProperty.js\":\"05dd797678db0f70\",\"/knowledge-medium/pr-preview/pr-1916/src/data/referenceBlock.js\":\"de0c7de7096d5920\",\"/knowledge-medium/pr-preview/pr-1916/src/data/rejectedUploads.js\":\"f69fd70748166a1f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/releasePowerSyncConnection.js\":\"b9c7de0dcb8481da\",\"/knowledge-medium/pr-preview/pr-1916/src/data/repo.js\":\"755d25993b8efc93\",\"/knowledge-medium/pr-preview/pr-1916/src/data/repoProvider.js\":\"28df0925d74c411b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/rowProperty.js\":\"664564e09eed28a5\",\"/knowledge-medium/pr-preview/pr-1916/src/data/searchFilter.js\":\"641d270b71f81c70\",\"/knowledge-medium/pr-preview/pr-1916/src/data/seedIdentityLedger.js\":\"21fd8b7c15a299ea\",\"/knowledge-medium/pr-preview/pr-1916/src/data/stateBlocks.js\":\"d43c0d90cf8f68b8\",\"/knowledge-medium/pr-preview/pr-1916/src/data/structuralEditPolicy.js\":\"43c5f357918938f0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/structuralInsert.js\":\"37eb58ec724e6327\",\"/knowledge-medium/pr-preview/pr-1916/src/data/subtreeDelete.js\":\"8cc4b3e195c65624\",\"/knowledge-medium/pr-preview/pr-1916/src/data/syncStreamLock.js\":\"952cc68eb90d90be\",\"/knowledge-medium/pr-preview/pr-1916/src/data/syncedTableSqlRecognizer.js\":\"3e6b2f54025731d6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/syncedTableWriteGuard.js\":\"bce59ee47853ac69\",\"/knowledge-medium/pr-preview/pr-1916/src/data/targets.js\":\"e3cad2073bd46daf\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeColors.js\":\"31f336a4bd442fb7\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeDefinitionMetadata.js\":\"721fd40b50fe276a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeDefinitionRegistry.js\":\"dab5cbd87168d1b6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeExtraction.js\":\"161f2489e643a503\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeInitialValues.js\":\"eb397db083350c9d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typePropertyGroups.js\":\"4ddb2f04eb604fcc\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeSeeds.js\":\"8c9840ec4ab273fe\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeTagger.js\":\"c27f225c79d55fd5\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typedRecords.js\":\"bd5ca1becb3acf8d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typesPage.js\":\"a14feb5921e63f7d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/userPrefs.js\":\"e60e19ea3c9e15e0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/userSchemasService.js\":\"f62f9cb6a551cc19\",\"/knowledge-medium/pr-preview/pr-1916/src/data/userTypesService.js\":\"d23647e042a4f3e6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/valuePresetRegistry.js\":\"4c0973e9aeab50b7\",\"/knowledge-medium/pr-preview/pr-1916/src/data/visibleChildren.js\":\"27697529263ef6a6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceConversion.js\":\"d692bafb2f0c2d04\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceFirstSync.js\":\"e7ec8c2a821b9c2b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceIdNamespace.js\":\"0c53e3339375f647\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceSchema.js\":\"18acafc48b3c6104\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaces.js\":\"9ffcb4fe1f7820fc\",\"/knowledge-medium/pr-preview/pr-1916/src/data/writeAheadLog.js\":\"a757acbe2e359c85\",\"/knowledge-medium/pr-preview/pr-1916/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/BlockPasteShellDecorator.js\":\"0b742cca16739063\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/atTrigger.js\":\"a30e526d562b2f76\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/autocomplete.js\":\"048a2789fcff0366\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/codeMirrorExtensions.js\":\"fa31ed37a2178c2f\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/contentFlush.js\":\"c1f6967fa45f3b04\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/defaultInteractions.js\":\"71bcec4569b940d6\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/editSettleSignal.js\":\"8839dceeb5bb5f12\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/insertImage.js\":\"a0d5debeb0053845\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/referenceCompletionRange.js\":\"c1764010de235c09\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/referenceTargetTypes.js\":\"34389c138616c4bc\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/syntaxContext.js\":\"730f3f02e5a6a07d\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/triggerMatch.js\":\"8de0a0b364796fa8\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/AppRuntimeProvider.js\":\"6e6fcdcfa01d8d76\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/BlockFocusShellDecorator.js\":\"70528934b492d71b\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/ExtensionRenderBoundary.js\":\"19242f6b2dac48e1\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/PanelContentRecovery.js\":\"90a3125670e43c16\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/apiCatalog.js\":\"2c4484de55cbcdca\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/approveExtensionHere.js\":\"882e154b8349506c\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/armedCutAppMount.js\":\"f155239d07683bb9\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/batchableKeyedStore.js\":\"f49ba5f2af684c94\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/blockInteraction.js\":\"786192a4f31abe48\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/blockSelectionAction.js\":\"abbd1e78a92c014e\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/compileExtensionModule.js\":\"cfd5166243e08f76\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/compiledModuleCache.js\":\"6761146f8d411578\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/continuousGestures.js\":\"c8040c2ece14ea27\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/core.js\":\"e3a7b34cc96c3f0a\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/defaultRenderers.js\":\"626bdc7bd1edcbf7\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/definitionFanoutAppMount.js\":\"a0e50e2b3c00507c\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/dialogAppMount.js\":\"8926c1411ea9b2d1\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/dynamicExtensionSeeds.js\":\"dd7da855e12dd5cf\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/dynamicExtensions.js\":\"c5bd2b1d56338045\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/exampleExtensions.js\":\"318af1f23979e8bb\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionApprovalStatus.js\":\"5b8fba4536c9ab94\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionLoadErrorToast.js\":\"c79229da0872617c\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionLoadErrors.js\":\"5d02e20233352fac\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionLookup.js\":\"861b9943c2b0acfe\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionToggles.js\":\"d09178c96f35ce85\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionUtilitiesCss.js\":\"80b2433d5a199c6a\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/kernelPageDeletionGuard.js\":\"de2bf6d532ba5353\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/liveRuntime.js\":\"d888a234b091861b\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/openExtensionsSettings.js\":\"e5eb5de19e16ce1d\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/overridesCache.js\":\"d7afd6e11ddfbfad\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/pluginIds.js\":\"7acceae3f9599714\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/processorRejectionToast.js\":\"c56c21e441fcad84\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/runtimeActions.js\":\"3ee7f1758e56472f\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/runtimeContext.js\":\"98e3aed332135dc5\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/staticAppExtensions.js\":\"07da4161df012510\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/staticDataExtensions.js\":\"c5b40390250742f1\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/toastAppMount.js\":\"03593f6a853ee96b\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/useOverrides.js\":\"e76001f223e27d68\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/useShortcutSurfaceActivations.js\":\"33282b0785a64674\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/discoverToggleTree.js\":\"a1492243d6826583\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/facet.js\":\"2ad048a68bb52ccf\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/resolveAppRuntime.js\":\"d3b72742bfca4268\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/runtimeEvents.js\":\"657f8b1c89897340\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/togglable.js\":\"b3b305e92085c0f5\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/variantFacet.js\":\"e389e5be52516a37\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/verbFacet.js\":\"88c5de5799ba56af\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/block.js\":\"abf91bc964dc6b4d\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/focusedChild.js\":\"99f2bb8d9cc2a4d6\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/propertySchemas.js\":\"50d528a22f5ce6b0\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/typeRegistry.js\":\"055bb5ff00005ec4\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useAncestorCrumbs.js\":\"8e48178bf3757158\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useAutocompleteListbox.js\":\"2cae15c86b2037bb\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useDebouncedSearch.js\":\"7c02810c7b6766c2\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useDebouncedValue.js\":\"3f488619323f132e\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useFacetValue.js\":\"4bcc76c6a977fe87\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useIsFocalRender.js\":\"32c421ceefbf305a\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useIsReadOnly.js\":\"7ac7f7904122e90c\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useMaterializeBacklog.js\":\"9836bd02e4911e8b\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useMinuteClock.js\":\"e08f2a1b2e83a5fd\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/usePanelLayoutProjection.js\":\"617d8d34920faa29\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/usePendingInvitations.js\":\"1035a51d811f99c1\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useRendererRegistry.js\":\"fd7a8266a49e6da9\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useRetainedFieldRows.js\":\"c9c8e213b14225a3\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useWorkspaces.js\":\"e710cbb92917ff7e\",\"/knowledge-medium/pr-preview/pr-1916/src/lib/utils.js\":\"81820b0fad6be79a\",\"/knowledge-medium/pr-preview/pr-1916/src/main.js\":\"abb3c7e42e690969\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/MarkdownImage.js\":\"0f3ca15d01c22bc2\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/blockSeparators.js\":\"21a2d77999da645b\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/context.js\":\"f1b31665c72cea6e\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/defaultMarkdownExtension.js\":\"46eff8d30c0736e1\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/extensions.js\":\"854f23d53fe6cc90\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/renderMarkdownHtml.js\":\"98dd822ff941535d\",\"/knowledge-medium/pr-preview/pr-1916/src/minimal-editor.js\":\"2b461e668f9abac2\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/armedCut.js\":\"5e3727d14040a19b\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/captureMediaVerb.js\":\"5507619b84a675f6\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/clipboard.js\":\"dd44da95cefcc829\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/decision.js\":\"456166f511c69b54\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/operations.js\":\"d2b44d6a3bdd8c67\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/account-header/AccountHeaderItem.js\":\"253b7ff75fe1ae49\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/account-header/index.js\":\"8a139186c1965bab\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"e1f1d44b3bd40597\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/askAgent.js\":\"84943b7bac8380f7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/askedStore.js\":\"fd6d05c644815609\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"742b998502c0fae7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/chipState.js\":\"52d242a1adcacf63\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/dataExtension.js\":\"9d5ee10847d027cc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/index.js\":\"413c4fb9e7dc8847\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"69386c7e9ee3033d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/schema.js\":\"71e909032853f4c6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/AgentTokensDialog.js\":\"c4606466279f17d0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a1eab2c5abded285\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/addMedia.js\":\"45711bfe708abcb1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/backlinks.js\":\"20470df39cea1879\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/block.js\":\"a6054ffc0af12995\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/context.js\":\"2ec8b5d42055b1b1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a0ca81a87048ba6b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/index.js\":\"ccfafe12f74c96d2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/outline.js\":\"2579ac224ee71563\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/properties.js\":\"c4e93be940d1ea44\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/refs.js\":\"f50ff1160e953ac1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"eaa790b241b16472\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/search.js\":\"f605160a2699b155\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/shared.js\":\"40f5fa9c5bc376aa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a5dddee73351dc6b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/text.js\":\"cc4d2c41d7590b39\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentWrites.js\":\"8e12ddbfee50a0c6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/authoringCatalog.js\":\"08c96ef298fc0c06\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/blockRefTargets.js\":\"5eebfdb133608bc3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/bridge.js\":\"3f51ba2639248373\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/bridgeLoop.js\":\"23aec76a54a0391f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/changeHistory.js\":\"3ee481cf30574e7a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/commands.js\":\"86d00a03d911c646\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/commentsCommands.js\":\"aa8a7dd812671df9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/dataExtension.js\":\"a4ea49b052f0531d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/dataModelGuide.js\":\"7c4f964f643bbb9a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/dayPropertyInputs.js\":\"df70be823d304087\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/describeRuntime.js\":\"1d60e58121e9a09e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/extensionLint.js\":\"66402d8b4329b377\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/grainAudit.js\":\"7516291003a7c6ed\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/healthCommand.js\":\"c8664d9b69660d9c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/index.js\":\"9ca87a96ab44e9d6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/presetIdentity.js\":\"8cf8579f76543125\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"02fb11a85242187b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/readMedia.js\":\"87f9b2d8c083db45\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/schema.js\":\"b66b5b53bd85f789\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/serialization.js\":\"7a7baddc0a813d9e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/targets.js\":\"37234d73ba93df5c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/tokens.js\":\"b4a6d43b88a65899\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/watchEvents.js\":\"145d76f0028eaa53\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/workspaceGuard.js\":\"82c7748372bf610b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/writeCommands.js\":\"efe04353c05546ea\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/AliasCollisionToast.js\":\"c8aa10ed09368843\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/DuplicateNameBanner.js\":\"b21024269b43b28f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/collisionMerge.js\":\"ae98dbcb78927226\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/dataExtension.js\":\"e92c4650015b4baa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/index.js\":\"4dc0a5ec50781d4a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/mergeCollisionAction.js\":\"7b14d898a913c12f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/pageStyling.js\":\"d1d75411f3a42a5b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/rejectionToast.js\":\"a7fe8769f8e82554\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/syncProcessor.js\":\"1cbdb57a38aec1fa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/actions.js\":\"5851c3db3864c401\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/addComment.js\":\"16036fa6160106cc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/anchor.js\":\"fd8e508bd27fa957\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/anchorState.js\":\"a8bee4591832870f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/commentLinks.js\":\"c0d90a7f3c031bdb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/confirmThreadDeletion.js\":\"05982c3b6d4989d0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/container.js\":\"1b617a3b57d59ea6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/dataExtension.js\":\"04ab1043f7e40bf1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/deleteComment.js\":\"16d1d2208c2fdcc2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/highlights.js\":\"7c0cc177c9a29f3e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/index.js\":\"01b521e73ebe7fb7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/linkedCommentsPill.js\":\"c8f6806a104fafcc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/margin.js\":\"62a9a0bdc016cfe3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/marginAnchorLinks.js\":\"c541f9492246dffd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/marginSchema.js\":\"b32131efae6916b0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/newComment.js\":\"6e96aa570b9824d4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/ownThreadPicker.js\":\"9abf6f39da2e2989\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/placement.js\":\"399b64f770cfe7b3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/queries.js\":\"e215a14618f06bf0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/quotePosition.js\":\"122ea8af287d0ab0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/quotedIn.js\":\"f49f6d5f2f5eb6ab\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/quotedRange.js\":\"7cd07f2ab992279c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/rangeRefs.js\":\"0d5038960b997b75\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/readHighlights.js\":\"e648d14bd84d2c06\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/readSelection.js\":\"c7a567b9885ca96a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/readSelectionUi.js\":\"7f488640ac87d873\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/reanchor.js\":\"58ad691caff84682\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/schema.js\":\"d4c3e95b84449df7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/scope.js\":\"6875d8beca8ae414\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/scopeThreads.js\":\"adb49c1b33bbae15\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/splitRetarget.js\":\"895f8fb0eb07ac4f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/suggestionCard.js\":\"c08f2841600a0f8e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/suggestions.js\":\"8b1304b7629582bd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/summaries.js\":\"de35477a98de31b2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/summaryBatch.js\":\"5636d1b1d05340a4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/surface.js\":\"a62368a2fcfde5b8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/threadNavigation.js\":\"7c6c66710a69ae1f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/threads.js\":\"ff69c1feefa12343\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/ui.js\":\"edbb28bc96ffdd5f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/uiStore.js\":\"d03c74cdfb15f4a5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-intents/appIntents.js\":\"c23c31dcf289cbc3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-intents/index.js\":\"3969e720f75e84da\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-update-prompt/index.js\":\"fe8ff10371a05210\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-update-prompt/status.js\":\"c9ed5451cf18d9f6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"ca1a4abf7df5e813\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/MediaBlockRenderer.js\":\"7f896306624929af\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/MediaDownLaneReplicator.js\":\"d27e625c875c9926\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/MediaUploadReconciler.js\":\"edae906f350f983f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/assetDownLane.js\":\"96041026d60ee85b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/assetResolver.js\":\"afd5813eb9073eb5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/assetUpload.js\":\"d33ee8836ad9d8dd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/attachmentCleanerIO.js\":\"feada69178ef4925\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/supabaseAuditIO.js\":\"131fe7954c3778fe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/blobStore.js\":\"5daf4d49070a41d3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/browserMedia.js\":\"4e0d0db06df048cb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/byteStore.js\":\"7ecb1d18e88eef3a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/cleanerIO.js\":\"1eec618869d80dba\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/cleanupAttachments.js\":\"ceb014e5d5a74737\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/dataExtension.js\":\"b9e96983fa87a780\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/downLane.js\":\"ba948ff9c39f9ce7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/index.js\":\"fb04417abdbfc108\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/insertImageContribution.js\":\"e739f41b58423041\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/laneArming.js\":\"2e86ebc81426ac1b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/laneLock.js\":\"2ed86960d3aaba6d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaBlock.js\":\"a88ea1da5195e359\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaCapture.js\":\"acac36a640043785\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaLanes.js\":\"c5f615df092bc1f0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaViewers.js\":\"786d478328697b2f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaViewersFacet.js\":\"0582c97f4a7c91c2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/pasteCapture.js\":\"6265e82687c0bcd6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/resolver.js\":\"709fa259fd3ce523\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/retryUploadsAction.js\":\"caa7fd8a249d566a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/storagePaths.js\":\"d9add6d6f2df0463\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadDrain.js\":\"5bc064cafef097a5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadLaneStatus.js\":\"94df18aa921fdf5e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadReconcile.js\":\"e581e26d73b05903\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadRecovery.js\":\"b0c7efbf4925cdb9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadStore.js\":\"31ec84103292e81e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/useAssetObjectUrl.js\":\"07c0027d65521637\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ff5f096c979201e0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2875bb7d419c6317\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/facet.js\":\"5294810360381311\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/index.js\":\"70ab6e3ffb109894\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/prop.js\":\"1e8519cf51fc1b80\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/BacklinkFilters.js\":\"8b639f5f38efbf76\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1069d8f2048595b6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/BlockEntry.js\":\"4f1d1fc48d172106\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/LinkedReferences.js\":\"bc172e723572c882\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"94f384079114aece\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/dailyNoteDefaults.js\":\"bba4919dad2a006f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/dataExtension.js\":\"233dcc66bf3596ef\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/edgeExclusions.js\":\"2d490b2dcd46f720\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/filterProperty.js\":\"5a81d926416937a5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/index.js\":\"78815f2d3083ee25\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"cde665482a92142b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/applies.js\":\"f1168ab23614b10b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/countQuery.js\":\"a539dae4c55f0197\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/expansionStore.js\":\"761163b1c55ad1c7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/index.js\":\"1d92ca4e9ef4acc0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"ee0edf4c5e0368db\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/presentationInvalidation.js\":\"798f153830f00649\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/propertyEditorOverride.js\":\"b37ea9816656399e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/propertyFilter.js\":\"e2f61c62eaefbdfa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/query.js\":\"c9bd00bf7953df2b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/resolveFilter.js\":\"e08932975572189d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/sourceBatch.js\":\"f4e477d5ad7dd7b3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/sources.js\":\"9cecef6d05c9681c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/useBacklinks.js\":\"012c44be407a1063\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"858ee9c007d95c89\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/BirthdayCelebration.js\":\"6cd7899e699f50c9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/BirthdayOverlay.js\":\"93829307c1295a03\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/gate.js\":\"63c2fbee77e7c065\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/index.js\":\"d7ae9861305ef089\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/wolfTheme.js\":\"da65ffff51006a45\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/BlockDragLayer.js\":\"f93007f08afe8ef0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/dragController.js\":\"159378f154ffb4be\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/dropTarget.js\":\"8ed3dca6aec5349f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/index.js\":\"33f95cbb3df890d1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/projection.js\":\"6658d5cba534bde1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-info/BlockMetaCard.js\":\"ae2c49f658364621\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-info/index.js\":\"891a60919643ca26\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/AddTagDialog.js\":\"c1ebf90d9ff6bf73\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"bd75a3431ac475c8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/TagNameIssueHint.js\":\"03157077a9913c7e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/addTagAction.js\":\"a94c4262be35b9c1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/appendTag.js\":\"feb1bc111baf78f5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/config.js\":\"38d0dd48d77f0e4d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/dataExtension.js\":\"55b57cd1b7c970d7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/index.js\":\"81276ad7d16d7633\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/propertyEditorOverride.js\":\"b6226a1897f0c63f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0b5281cd764e9410\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"57fe53aba3061226\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/Breadcrumbs.js\":\"55092aac602e4522\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4f2c3327eda55244\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e7a1ebd8523dc62b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/index.js\":\"7f052ac77b15f930\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f4e54bcdd63decf3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/CharacterCountItem.js\":\"c20db1691b3535d2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/ProfilePropertyEditor.js\":\"75120424945f9214\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/actions.js\":\"98627f1f0c0e67e0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/blockType.js\":\"639771f91f7aa11f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/charCount.js\":\"74a64ab558a344a7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/dataExtension.js\":\"33741ea379c43f64\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/index.js\":\"614b6b9e62ec68d7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/profiles.js\":\"e47fba0a18ca944d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/properties.js\":\"c274ed9ac7f0f5f0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/subtree.js\":\"24703058a40084cd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/textCounts.js\":\"a4e58e189d926d3e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/colemak-keybindings/index.js\":\"3fd8fe614599823d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/CommandPalette.js\":\"0a79a0bbb5bd77ce\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/HeaderItem.js\":\"5f17878d9d4a7238\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/context.js\":\"e9d22aeab26db81f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/index.js\":\"3a1fd853497e3d7f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/selection.js\":\"d6f462d57896bb9a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/toggleStore.js\":\"62f49d7509abacce\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/useCommandPaletteActions.js\":\"a458ddd1242743f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/ContributorBadges.js\":\"600179610faa4e1e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/ProfilePicture.js\":\"335c46d84ebb690d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/author.js\":\"877ae79ec4cd5fd3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/codeMirrorExtensions.js\":\"e5a6f922c49d6ec4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/dataExtension.js\":\"f9ff5b5a9df78c88\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/index.js\":\"7a25115b547b76ef\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/mentionAutocomplete.js\":\"7c604c679fe87c82\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/processor.js\":\"b4ec378b79416a90\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/profiles.js\":\"1274b4b31b26f130\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/queries.js\":\"d8f8444e2fc07bd3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/schema.js\":\"38dca62ab00f2b18\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/useCommentAuthor.js\":\"d1dd3b964033d89b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"1dd4ee35463fa5c5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ef001bf4cd1ca30e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/index.js\":\"18a7649e19641c17\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"91d085167ca030f7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"c6adb03edb265991\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/CalendarGrid.js\":\"04fe29f5e428cea0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DailyNotePicker.js\":\"edfb08e34d1a3196\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"006462412d7277e9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DateNavDecorator.js\":\"4ef12d43fa58714e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DateScrubOverlay.js\":\"38763ccff953759b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DayPropertyControl.js\":\"9a30fb526f1f3f22\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DayValueReferenceControl.js\":\"1cf0d7f8a6d6ded9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/HeaderItem.js\":\"8cc07163e7ba7fd8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/ReschedulePicker.js\":\"cedcddcd876bfd76\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1ef211fdbe32ae74\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/actions.js\":\"61999e3ea815a4b9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/blockDateAdapter.js\":\"449b006d8f6a07f4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/calendar.js\":\"f680b06c5252f7cb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dailyNotes.js\":\"6fd996cf46dd7cb9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dataExtension.js\":\"e635fb8f024fb2f1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubActions.js\":\"f51b7b08f2ce3645\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubGesture.js\":\"49a873dd711af23a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubGestureActions.js\":\"88f6ce66e0b6c0f7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubRecognizer.js\":\"00eb7e2d626e408d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dayProperty.js\":\"9253f2a57baa15b0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"d3bcee2da2005e9b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/deletionGuard.js\":\"9e7dec40fca3ddc3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dueQuery.js\":\"24f0541ee298d841\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/index.js\":\"df9d8736aaa11092\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/landing.js\":\"5b68338f50eecf8a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/localSchema.js\":\"a0aed8ae77dea64b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/referenceDateAdapter.js\":\"24179fe7a60bd6ba\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/rescheduleAction.js\":\"a6415683f8de8d65\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/schema.js\":\"3800a692403acb8c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/spreadBlockDates.js\":\"0d99cd90cfdaf6b6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/spreadDatesAction.js\":\"d92c5262451599b1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/today.js\":\"30ac62cff498fd72\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"e5a2c9db0c7e36c6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b0274e81ea66f7d3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/audit.js\":\"ae9faf1c94843a42\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/auditAction.js\":\"1b056416346b9c2f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/auditRanges.js\":\"c08397a4d54ce81a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/diagnosticsSource.js\":\"e64ff97a66cc77f3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/divergenceScan.js\":\"88d6b3e727005e77\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/index.js\":\"9b7e005c64c491cf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/propertyChildrenChecks.js\":\"b4f10a857822ffd8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/referencesMirror.js\":\"56f239e46d5a4f63\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/rowJson.js\":\"92079ecd2f0e26f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/schedule.js\":\"e5e15bd01f13128b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/store.js\":\"a5ea2d7846b98320\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-maintenance/action.js\":\"f1dcba179418dcba\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-maintenance/index.js\":\"bc8cef02526a9059\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-maintenance/plugin.js\":\"23f56be3f625535f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"c590839173fc0ee6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/actions.js\":\"9f66d58dd4602f5b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/changeMarker.js\":\"01e8b2ef1a2069eb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/diagnostics.js\":\"5ede3134bfd3dd9f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/fileSystemAccess.js\":\"c8f539dac9af7e18\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/filenames.js\":\"e731117624cc8cb9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/index.js\":\"a473fb2dce9cbe23\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/mirror.js\":\"26c3276f760757a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/runLock.js\":\"2fb3a1a60ee83f86\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/runtimeHealth.js\":\"9493871b9cc59875\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/schedule.js\":\"6f61b3bc69609ad7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/store.js\":\"98d69006d156bba2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/default-themes/index.js\":\"be47a54b4ad3043d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/default-themes/themes.js\":\"7f6d13a85761b59d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/diagnostics/facet.js\":\"60bd452d9db13ae8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/diagnostics/useDiagnostics.js\":\"c59044636c0ca5c7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/dismissals.js\":\"b901f36310066c55\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/index.js\":\"4283b7720364e8b9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/status.js\":\"fa86e4145c9d19af\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/store.js\":\"a79f8acfab52d880\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"619f00ed5c546068\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/ExtensionsSettings.js\":\"bfe9f6d2eab6c4bc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/actions.js\":\"e7a1e9228d273f74\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/config.js\":\"1c7ccf001f7cd478\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/dataExtension.js\":\"f30b47251b646fe1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/effect.js\":\"3bc960443bd7236c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/index.js\":\"b7fd12f95fdfa775\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/propertyEditorOverride.js\":\"4fdb0c8d2d24d2ac\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/useToggleTree.js\":\"3a76c2b48a3b6f1f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/ExtractTypeDialog.js\":\"c7b8bdb137e8e0b0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4714872a9a3cc42e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/PropertyShapePicker.js\":\"86681143ffb654de\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/action.js\":\"c3b86915d8ce775b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/index.js\":\"432b43b6dec659dc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/FindReplaceDialog.js\":\"df221e5917d52066\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/HeaderItem.js\":\"7b65ae7b5bd9b223\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/dataExtension.js\":\"507c01aa52bbcdc7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/index.js\":\"dc275f3c6a1e0985\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/search.js\":\"b62e24c45cc21b6f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/toggleStore.js\":\"f16b250f2e5fd133\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/LocationPropertyEditor.js\":\"03cde1fac313d751\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/MapView.js\":\"bafaea8fc0b5e46b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/blockTypes.js\":\"2fd1246bd57ee714\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/codeMirrorExtensions.js\":\"89c77ca3c4738ab4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/createOrFindPlace.js\":\"b56e8b77bc596253\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/currentLocation.js\":\"320ecbd677fa9d74\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/dataExtension.js\":\"1426005ccdf84e59\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/geoContentDecorator.js\":\"d630f7f406aabfbe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/googlePlacesClient.js\":\"2a4d11b81c3e11ae\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/index.js\":\"8fddb3ab8983a2f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/locationsPage.js\":\"6e23bd3eeb97430c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/mapViewport.js\":\"6346fd30f03c5472\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/pickCurrentLocation.js\":\"847dccbd067fbf7c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/placeAutocomplete.js\":\"b1596f68f227f13a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/placeNameCollision.js\":\"a67fa6018cc61546\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/properties.js\":\"40ed6ee6be72eb75\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/propertyEditorOverrides.js\":\"9b131df940d7951c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/query.js\":\"6debaf8c07f64fe7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/usePlaceSearch.js\":\"b5339e0ecbb29dc6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4f480f7f97f22856\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"bfa1a519331996ce\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5e39f6e612475810\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/config.js\":\"fd5cf9a6ec7fd846\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/dataExtension.js\":\"645ae43dcf63b4bf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/facet.js\":\"24f33c9a698617c0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/grouping.js\":\"7d9de71ed7a28bf2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/index.js\":\"4380ec4ccb451566\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"092a2a275ec41fbe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/query.js\":\"aa2aed89194de3dd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/resolveConfig.js\":\"b1acc16de4703bd4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"6eedba6d3746e3ae\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"92c3f9e3ea303033\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/HtmlDocumentContent.js\":\"b215d8a10e1304f9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/HtmlFrame.js\":\"7bbf25cde59d9ce7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/actions.js\":\"96eef42ac7894d48\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/blockType.js\":\"c7a318ca7fc91d82\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/confirmRunScripts.js\":\"9e65220403118999\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/dataExtension.js\":\"f87a561472b2945d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/frameAnnotations.js\":\"fe30abef8d111ef0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/frameDocument.js\":\"9a01a0eeb0ba596f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/frameTheme.js\":\"8289ffe9f972d591\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/index.js\":\"4d74d2f5453b01f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/scriptConsent.js\":\"cabbf6dd398a5758\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/sourceMap.js\":\"bc0aafc9cc44a09b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/useDocumentScripts.js\":\"80dc95251adb0c6d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/index.js\":\"de9267b97791265b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/record.js\":\"35858c472ee77c70\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/recordStore.js\":\"25f62b7b7890ac14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/responsiveness.js\":\"b7a91fd293d8f56a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/schedule.js\":\"2dc9286f107eab49\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/sessionContext.js\":\"ae0ee629f070c7cb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"36159a3244a2059f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"95a8edfda883d4ce\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/actions.js\":\"d6b9870b85f02d0b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/config.js\":\"777b60992365bdcf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/dataExtension.js\":\"4e542928b176cdd7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/effect.js\":\"e47c44fdd380b66e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/index.js\":\"fbd1394512ae2cf9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/keyCapture.js\":\"4bd805d3b831f56f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/overrideStore.js\":\"bead7176a422d3d4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"fd7fb48667a58626\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/HeaderItem.js\":\"38b72959162c6246\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/LeftSidebar.js\":\"8fbd388ce3fb52ce\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/actions.js\":\"d0cdfa7d7d16a5ac\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/facet.js\":\"cc3d355e43cda9e4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/index.js\":\"c6c64195d92bf6c3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/shortcuts.js\":\"44f627ef7b4a80e9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/toggleStore.js\":\"a846bfbfab85ae43\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/MergePicker.js\":\"bfaf8b866e1ee58c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/index.js\":\"b8755fbc05fafcfb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/mergeAction.js\":\"83a897e0b430ffd5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/strategy.js\":\"4a48580b90c53eb6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/Button.js\":\"ccfe1ab6429a4b91\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"ee45a6e603e68833\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/defaultItems.js\":\"37a47fc4ca073fe2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/facet.js\":\"591acd1ef9819a1d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/index.js\":\"90b17e4adae17416\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"14a142a32f6053fd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/actions.js\":\"24d86b513fea1a4d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"0ea53f55581f6df6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/facet.js\":\"20bc539310ca4f53\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/index.js\":\"7b6b997eaedc8a90\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e3f014168192c7df\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/blockSubtreeMembership.js\":\"f867f15f51504b98\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/contextMenuItem.js\":\"e8740fd85f91b4c3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/index.js\":\"236ae15da6a757b5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/moveAction.js\":\"455b5d6a44c2f675\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/moveBlocks.js\":\"d2dd6521c48f5ac7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/selectionAfterMove.js\":\"25f63f4a83598f6f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/TutorialBanner.js\":\"389cedea5641be6c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/action.js\":\"0ab586f8bc42b1a6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/bannerDismissal.js\":\"110d74a5cb149abb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/documents/cheatSheet.js\":\"9db80e6a6495793a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/index.js\":\"753d6f975754cbfe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/keys.js\":\"3f9141a1ae8f1411\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/landing.js\":\"e2d8c9bf577be82a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/outline.js\":\"90a107235a8083c3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/seed.js\":\"bb4b8a3a564fdb4b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b2f6da54dd4619d8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/analyze.js\":\"060d2894b955ea3b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/diagnosticsSource.js\":\"b263121c58b1c968\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/index.js\":\"1756f8def870e3f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/load.js\":\"393e2acc590a8b5e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/monitorRun.js\":\"8eec906c06656e65\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/schedule.js\":\"e9f6ed565aa78fb6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/series.js\":\"ecccfc5be75f4eeb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/store.js\":\"e93fa67469943bd1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/trendAction.js\":\"377c8c8ca0fec563\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/verdict.js\":\"c154713eed32674d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/plain-outliner/clickToEditAction.js\":\"ad08f8751a1bedc2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/plain-outliner/index.js\":\"c91a231937ab9a1c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/plain-outliner/interactions.js\":\"8d8a0abbab505cad\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"790a46eee3e3b8f1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/MigrationGate.js\":\"1b86ebe692170a6f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/MigrationGateDialog.js\":\"75025ecf69c1c2a2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/action.js\":\"b7baf48032e21c5f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/index.js\":\"9f5dc3c83065ee89\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/localRunMessage.js\":\"ad8c1aab8a96417a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/plugin.js\":\"47c5f55f9447e88e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/progressReport.js\":\"8581989f7c4038b9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/sweepProgress.js\":\"87c5e8e39257782e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/FieldRowRenderer.js\":\"0cb30d289f101949\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/ValueRowRenderer.js\":\"f1be19d3de95edcc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/actions.js\":\"184201a22afa5c34\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/autocomplete.js\":\"0ca86065ae1dbb91\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/fieldRow.js\":\"921912fea831362c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/index.js\":\"c8a1ea3e279d09e4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/referenceWarning.js\":\"d6468789624d4f46\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/valueAutocomplete.js\":\"4d2df13e2e819879\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/valueSchema.js\":\"ceab26bb3c63dc96\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/HeaderItem.js\":\"63991af44bfe3ff0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/QuickFind.js\":\"34e491026cebfd9f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/index.js\":\"386015bca2c3325d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/recents.js\":\"47a48b863fd870f4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/resultItems.js\":\"afa9cb72bf574a38\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/selection.js\":\"c4207bb3cf0f6b47\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/toggleStore.js\":\"68ba9736408263fb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/HeaderItem.js\":\"28c439dca79dfa65\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d2b762c08b9221dd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/grouping.js\":\"178f7ee8c90f50b8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/index.js\":\"cad4067bfc3c7eec\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/target.js\":\"8eb122f1827544b4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/codeMirrorExtensions.js\":\"6657892bd1fd40fc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/contentPrefill.js\":\"ef6e58978ff3afce\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/dataExtension.js\":\"313ac2ab06f86d9f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/index.js\":\"bc9f59f341b72c21\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c30a9d0670021974\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/invalidation.js\":\"9416787ae038262e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/localSchema.js\":\"f31bddf15140eb7d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/blockrefs/index.js\":\"455f3e7a22a46c3a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"44907acea5871a75\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/index.js\":\"255ae9dc5d01227e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/referenceNode.js\":\"753e22af05d0f38a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cbbf593210883832\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"013750f41acf54a5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/index.js\":\"4343fb3a102a50dd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"f803acec58cdb37a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"eeeb2def02760794\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/mergeRetargetProcessor.js\":\"f457ded197fd7326\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/parseFence.js\":\"f2b467bfa3040675\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/referenceParser.js\":\"783c6584bea518a4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/referenceProjection.js\":\"94cff2009e83a4c2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/referencesProcessor.js\":\"52cfcdd878d03029\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/renameProcessor.js\":\"02f8785598fdfeb4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/spanReplacement.js\":\"747ee38a1fb1d156\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/htmlToOutline.js\":\"f1f817eadbdd2ecb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/index.js\":\"090927e80255be04\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/normalizeClipboardDom.js\":\"a86423d24e5d206f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/pasteDecision.js\":\"0c71d6c3e5c8ab2d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/action.js\":\"3b0fd89c30fc17c3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/blockIds.js\":\"c3aa9ef0f33e53c4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/content.js\":\"d2a9a981ce87c8fa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/effect.js\":\"7916689cdcbb9080\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/ids.js\":\"b809d2ec594b7009\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/import.js\":\"6428b544807b8fe3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/index.js\":\"de8de4eb95fd5f60\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/plan.js\":\"a8bc8326dbf26c76\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/plugin.js\":\"fbba6e3578e3581a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/promotion.js\":\"d5207644e7f3f867\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/properties.js\":\"f6761f11cf4b2855\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/references.js\":\"249498eb0a201e5d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/report.js\":\"d17a95153cd4fccf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/roamMemo.js\":\"5a0f29c548cfad98\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/runtime.js\":\"a41bdc3294b72586\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/schemaReconciliation.js\":\"98780a7ec4351f08\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/srsMarkers.js\":\"c3d042ebf5590c80\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/todo.js\":\"e43b3e1c70c8db20\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/typeCandidates.js\":\"5967d46d8c4420b9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/types.js\":\"cd948863c375465f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/search-health/index.js\":\"e2d7c5f72eb8e37c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/search-health/store.js\":\"9810e049fee220f8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/HeaderItem.js\":\"08762ba10e67d665\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"50051d29adcdca04\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/index.js\":\"accd2a22bbb36c07\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/model.js\":\"d81b2c975e1b1cb8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/toggleStore.js\":\"1dd4ab81ff352c86\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/useKeyInspector.js\":\"fcd2c7a044444a49\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"02bf5814edd60fb2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/ShellDecorator.js\":\"259e32a9b08c8994\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/actions.js\":\"faebbe01c985c36c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d81c5068650f1fef\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/index.js\":\"893ae7e20d327cfe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/shell.js\":\"084b65202bdf9dfa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/surface.js\":\"8103906da2f64178\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/walker.js\":\"af7d5895b3bb9233\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/RescheduleToast.js\":\"611c6249d27af4ee\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/dataExtension.js\":\"f92aedf35daf2354\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/index.js\":\"93fa195ab013b9bb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/indicator.js\":\"2d1ae40abd45e989\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/moveSrsState.js\":\"85e1473e712cc72d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6304c2507c3a351c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/scheduler.js\":\"062cde6c77ec5016\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/schema.js\":\"e6e5d3fb8e3cfc77\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0e75ee2c2e3a6811\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/srsClipboard.js\":\"28d90ca288336a0a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9a22c67ec4157479\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0c6aa89e9d796682\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/DeckPicker.js\":\"4cbb5bd9010b2f57\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/ReviewControls.js\":\"cbd5d529eeb138ad\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/ReviewDeckRenderer.js\":\"3e7dba6b270640fb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/ReviewSession.js\":\"0760d60895dcc23d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/actions.js\":\"454359960d1d639e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/archive.js\":\"403b3eb5c48bf6fd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/dataExtension.js\":\"9634e931f9dee116\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/deck.js\":\"ca30f7bf33dcbf07\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/dueQuery.js\":\"776a0037d62774d2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/gradeDecision.js\":\"6dd093b322e9a8ad\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/index.js\":\"70bad7362574fabd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/keyHints.js\":\"e37e969abd2a46e4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/reviewCardLayout.js\":\"73c04354d54d4a15\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/reviewProgress.js\":\"8c2aef3d4c9e0b74\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/schema.js\":\"4b89165a01ea5952\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/useDueCards.js\":\"2b26eb5fbc9e76aa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/startup-metrics/index.js\":\"fd5c7d1252ef2b55\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/startup-metrics/record.js\":\"04d9d32d7eea9d92\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/storage-persistence/index.js\":\"4e48a43480489b56\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/storage-persistence/persistenceStatus.js\":\"1ba22ba4b14c01d7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/storage-persistence/requestAction.js\":\"52d2505122e3b6e8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/TypeChipsDecorator.js\":\"809bd76ebb17bf7e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/codeMirrorExtensions.js\":\"fa12f5734c9e5872\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/index.js\":\"9e6a38a9777c39a0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/typeAutocomplete.js\":\"ece83c1c8349e7e9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"469ab3cbb80dd606\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/actions.js\":\"4511241dfcb6790f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/anchor.js\":\"c643fb40ce4a56d7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/events.js\":\"079e4dea22299bbc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/gestureActions.js\":\"616ce760b413fc9a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/index.js\":\"898639657bad7704\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"9b82ab5cefdd1ffe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/sync-metrics/collect.js\":\"0a484d6f13a79ca8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/sync-metrics/index.js\":\"27e974b07d83d399\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/sync-metrics/record.js\":\"f6e3f10fb3ef4b34\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/RejectionDialog.js\":\"b345fe6998d3c9be\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/SystemStatusHeaderItem.js\":\"583fc49d7c02cf9a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/index.js\":\"cd91f0f9a310940d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/model.js\":\"80553a4eba83dcea\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/queueCounts.js\":\"8f5416b2ab17b494\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/rejectedHelpers.js\":\"d8f142dc31c80ab5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/rematerializeAction.js\":\"97ecd5febabc813b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/useHysteresis.js\":\"160c1a39d641d0a5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/ColumnHeaders.js\":\"1538188b26039206\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/QueryUi.js\":\"781009e652f6aba9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/TableLayout.js\":\"bbb19461367681ec\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/actions.js\":\"6a3749c73d3ecc5d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/cellEdits.js\":\"d65824fe2edf6a84\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/childrenViews.js\":\"27996edee8792ed2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/columns.js\":\"4d7998ff7b15c50e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/controller.js\":\"5ff113ab07371328\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/convert.js\":\"f0aa210dcebaa714\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/dataExtension.js\":\"ad203b3369b7d46a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/index.js\":\"58e17c630f2b420e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/keys.js\":\"3ee83d367f567f03\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/model.js\":\"f293ccbd0bb0d50b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/QueryText.js\":\"14691177a53fdae6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/backfill.js\":\"754e21b07f399cb6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/completion.js\":\"cb1f8ecad272999e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/format.js\":\"5f6b48eef8473911\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/parse.js\":\"6a0a681382767520\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/queryValue.js\":\"79e3f6abc1d63439\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/registrations.js\":\"8ab5427d5406f96b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/source.js\":\"1c5fa202a6aa0c1e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/registry.js\":\"14ae9d14f6fadef7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/rowGutter.js\":\"836a2ea8ceb1c087\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/rowVerbs.js\":\"ccce6389b5e277cf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/schema.js\":\"fa603a1c32fcad2e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/sort.js\":\"3833456bebb38559\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/theme-toggle/effect.js\":\"addb244d882be619\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/theme-toggle/index.js\":\"7ee8b8af7992a519\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/theme-toggle/theme.js\":\"8808070dd3f12bc4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/actions.js\":\"3428485325462abf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/dataExtension.js\":\"2a999505587bee12\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/index.js\":\"fb24e7c6ab2e9489\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/schema.js\":\"b77ebe5d129fd502\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1f658e84910d65d6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/actions.js\":\"bb5664bc328e2103\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/defaultItems.js\":\"dd06bb08748758dc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/facet.js\":\"5f427b3dbb2f6a9a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/holdRecognizer.js\":\"99c04cd568e830fb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/index.js\":\"47c43d18f4f7bee5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/update-indicator/UpdateIndicator.js\":\"eb6e0c67bf8c701e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/update-indicator/index.js\":\"92cc07b26409df4f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/update-indicator/loadTimes.js\":\"32a328ba483ca574\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/VideoNotesRenderer.js\":\"2b5dc7624f05c11b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/VideoPlayerRenderer.js\":\"8045507745c87646\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/VideoTimeStamp.js\":\"b4cc6f8a80a2619e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/actions.js\":\"a0ae57affc32ee5e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/index.js\":\"11601bb7b2823823\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/markdown.js\":\"9dc8d39c54d562e6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/notes.js\":\"6ae14961b4e06067\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/registry.js\":\"4c433a75ed261be4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/remark-timestamps.js\":\"c16b4e2581f260f5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/view.js\":\"8a6783b8e01eca3d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/LinkHints.js\":\"129c5ac305f3f739\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/index.js\":\"65c15154d7b81d20\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/model.js\":\"f8e7f0a5d0f3114d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/settings.js\":\"e3afa0325990e638\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-normal-mode/actions.js\":\"ccce989ff94b8caa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-normal-mode/index.js\":\"63379e383f52adb6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-normal-mode/interactions.js\":\"8285a74dd85f9a23\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/workspace-header/index.js\":\"3c25101d1c72b68e\",\"/knowledge-medium/pr-preview/pr-1916/src/registerServiceWorker.js\":\"9f7e546383c7c576\",\"/knowledge-medium/pr-preview/pr-1916/src/requestPersistentStorage.js\":\"007c4af8a9bb42be\",\"/knowledge-medium/pr-preview/pr-1916/src/services/authRequestDeadline.js\":\"8b19c89a4c1add6f\",\"/knowledge-medium/pr-preview/pr-1916/src/services/authStorage.js\":\"98d232cc84f4ed8a\",\"/knowledge-medium/pr-preview/pr-1916/src/services/powersync.js\":\"6b5562a35eda2374\",\"/knowledge-medium/pr-preview/pr-1916/src/services/supabase.js\":\"f25b2e9cdc97067a\",\"/knowledge-medium/pr-preview/pr-1916/src/services/uploadErrorClassifier.js\":\"032529b75227f037\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/ActiveContexts.js\":\"fcf57afadc497bbd\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/HotkeyReconciler.js\":\"bae987b2d9f84bd9\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/WipeLocalDataDialog.js\":\"e75307cec0ee2cc9\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/actionDispatch.js\":\"fd2ee4889f462cc8\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/actionRefItems.js\":\"4fdc2601e6d6ee47\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/applyKeybindingOverrides.js\":\"1c7c8e55f787a3ca\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/blockActions.js\":\"6be4462aac79a934\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/blockMergeGesture.js\":\"afcd7933dd76f272\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/canonicalizeChord.js\":\"0f26faf54ddbc56d\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/defaultContexts.js\":\"0bed377791778037\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/defaultShortcuts.js\":\"9f81a9ffe948fb3d\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/effectiveActions.js\":\"4fcdaac2314073f3\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/gestureAction.js\":\"697266eeaefb5610\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/gestureBinding.js\":\"72aff4b6553c96c6\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/holdRegistry.js\":\"d579dd7a2b0f0763\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/keybindingConflicts.js\":\"6ec10289607f0c95\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/keybindingOverrides.js\":\"00ec03dcb64eb961\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/pointerAction.js\":\"085074d7ee7b3d64\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/resolve.js\":\"ab5e96b8a452c0da\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/runAction.js\":\"6095a0eaca0a08bd\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/sequenceMatcher.js\":\"055929ed9ec3005d\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/types.js\":\"2d13e9ddd013060d\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/useActionContext.js\":\"a2f8bd4d546be9a2\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/useActionDiscovery.js\":\"114a84fa7daee5d2\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/utils.js\":\"5637f5885b6a2985\",\"/knowledge-medium/pr-preview/pr-1916/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1916/src/sw/bootStore.js\":\"3842796700499074\",\"/knowledge-medium/pr-preview/pr-1916/src/sw/previewDatabases.js\":\"c41d2dc5d12e0764\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/byteTransform.js\":\"ea674966ef667a61\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/attachmentCleaner.js\":\"290632bbc29613cd\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/attachmentParts.js\":\"e56b012497545646\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/bundleParts.js\":\"6a911ff2b28e401f\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/bundleRecord.js\":\"19f493dd80d83053\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/manifest.js\":\"08d2c8c15d676364\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/takeBundle.js\":\"e85c1ad5b67bd593\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/verifyBundle.js\":\"0070affd11b3caee\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/cleaningStage.js\":\"6793b8f0c73466e2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/conversionKey.js\":\"1c21ab7c8c8796b0\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/conversionServer.js\":\"a2ad5937396a1fcb\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/flip.js\":\"a0900901733a1bf2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/flipAttempts.js\":\"5c9c3faae0084576\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/pages.js\":\"3b83aafbc415f7e4\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/preflight.js\":\"2d2a1bacf254b299\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/reseal.js\":\"a790591b06bf16e9\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/runConversion.js\":\"771d331f37b5056d\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/runLock.js\":\"97d5199e59865f1a\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/sealing.js\":\"37aad1cc88993fc2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/sealingStage.js\":\"3eded4b3ec5f2f74\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/stage.js\":\"3940963f41dcd8c1\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/verifyReseal.js\":\"d8c2f2b2182bbf87\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/aad.js\":\"54fe4ebd46ef7eed\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/aead.js\":\"b9cfe7b6604a991b\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/base32.js\":\"a8d18ff706636396\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/base64url.js\":\"31aee5e670f01088\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/binaryEnvelope.js\":\"6c83e34df92f555b\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/byteAead.js\":\"1d5f331801dcc8cd\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/canary.js\":\"64f6709d16ec7d68\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/contentHash.js\":\"9aaa3512b295b459\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/contentKey.js\":\"3aaef04c684ee4bb\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/derivedIdNamespace.js\":\"964d63c85ca87752\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/envelope.js\":\"f348ee167e37b0bc\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/hex.js\":\"4e0d6a56407e9294\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/sha256Hex.js\":\"834453491dc1f50f\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/workspaceKey.js\":\"0f3face612a592ea\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/conversionState.js\":\"f9eeaefd2251a836\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/createEncryptedWorkspace.js\":\"f9b935b6b4335b26\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/pastedKey.js\":\"97ce39768addf22d\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"f0f0a3c87f21788d\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/upgradeWorkspacePin.js\":\"af1109b84c022ae9\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/keyStore.js\":\"745d6a5fecfc6c50\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/mintWorkspaceKey.js\":\"d5c3488451fecb42\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/modePin.js\":\"51f1b1a7da42155b\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/openWorkspaceKeys.js\":\"a8938443d9d17362\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/resolveWorkspaceEntry.js\":\"083fdddfaf0383e2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/resolver.js\":\"029bab3bc1f7b820\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/workspaceAccess.js\":\"ab7d1833a1bf21e8\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/transform.js\":\"f82bdfb2a17bed36\",\"/knowledge-medium/pr-preview/pr-1916/src/themeBootDefaults.js\":\"e564827c40d238d0\",\"/knowledge-medium/pr-preview/pr-1916/src/types.js\":\"69ae16d2ae2acbc8\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/ClientLocalSettings.js\":\"8e52f849a7022b50\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/abortableSleep.js\":\"95b38cc15ee7e2f6\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/array.js\":\"88d68fb2b49e009b\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/backlinkAutocomplete.js\":\"ab9895135cddf3d9\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/blockCrumbs.js\":\"74d43b0f9f1a63a6\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/blockrefAutocomplete.js\":\"1effc45514c568ab\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/cadencedIdleJob.js\":\"25bd5f33a704564e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/callbackSet.js\":\"dc8658f339e5b13b\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/clientId.js\":\"c1d989ec88da2cbb\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/codemirror.js\":\"c3237cb71dbb618e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/codemirrorCompletion.js\":\"114794d64152d4e0\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/copy.js\":\"f058f0cb469db795\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dailyPage.js\":\"178d17605e211ca7\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dbForensics.js\":\"967a4bf6c4f3c0ff\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dbForensicsHooks.js\":\"1a3c39ed48249800\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/deleteBlockThroughUi.js\":\"8703c8660b0c8f76\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dialogs.js\":\"59f82241b37db863\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dom.js\":\"dd6c5faa2e067ae9\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/downloadBlob.js\":\"983b64f05714c0c2\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/drawnWalk.js\":\"bb994311b28113f0\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/exportSqliteDb.js\":\"cc4780bea3ff494f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/fileSystemAccess.js\":\"b7ea4738e631f824\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/flipSlide.js\":\"812e2c672875778a\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/fnv1a.js\":\"b4d02e71f0240dd3\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/formatBytes.js\":\"9f3b15a7c0331f19\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/fuzzyRank.js\":\"ca0a11c081fcf1c5\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/idbKeyedStore.js\":\"38a2185f99cf1c56\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/idleCallbackPolyfill.js\":\"9678e2eb5f172e8a\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/keyboardAwareScroll.js\":\"a4d3b15884799fbd\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/keyboardViewport.js\":\"9e688fbf6693c47e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/lastWorkspace.js\":\"fc50793931f3d740\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/layoutColumns.js\":\"8ea618135361616c\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/layoutSessionDom.js\":\"7a7615d8ebe32ca6\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/layoutSessionId.js\":\"9c3b0ac48e5def85\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/linkClickGestures.js\":\"25dc3a330fbe757e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/linkTargetAutocomplete.js\":\"954d9c044098e1b6\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/localDbCorruption.js\":\"b9a0128e85100599\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/localDbRecovery.js\":\"3633985a60fb0cca\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/markdownParser.js\":\"c8c0770188525bbf\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/memoize.js\":\"e15e52caf1b94253\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/nameFieldCommit.js\":\"8f4e9bd521c8dfcb\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/nameList.js\":\"373acd3a86ea6213\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/navigation.js\":\"11ff0a7d882351c5\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/omnilinerNamespace.js\":\"89c1e45c5b37535a\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/opfsPageScan.js\":\"4b152390df597630\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelClearance.js\":\"18d78c03c88cdec4\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelHistory.js\":\"bb683cc818eb3243\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelLanes.js\":\"8df912bc4108e4af\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelLayoutProjection.js\":\"950edb5f89aae0c5\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelScrollAnchor.js\":\"991b0f9c97f9c51f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelUrlFlags.js\":\"979b5942a38f3ac8\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/platform.js\":\"161c394fec816130\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/pluralize.js\":\"d84dbfc167616fe0\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/propertyCreation.js\":\"4fe1a5dda97dec57\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/propertyNavigation.js\":\"e478dd5b35ed1d82\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/propertyValueContext.js\":\"62ebe9f2da90b3d8\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/react.js\":\"5e62af6df3bcef9d\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/relativeDate.js\":\"b0988a33cb1ade0c\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/relativeTime.js\":\"577e7098fdeb2ea0\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/renderScope.js\":\"b8428c4fb882bc46\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/resolvedThenable.js\":\"859492f576444bed\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/routing.js\":\"a09b3e5a06963f46\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/safeMode.js\":\"275a519c6ffc6244\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/scheduleIdle.js\":\"a0c5571a6d57eccc\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/screenWakeLock.js\":\"f72c66e766531346\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/selection.js\":\"d61b861dc23e7417\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/softKeyboardGrab.js\":\"3d772a58bcd0369f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/startupTimeline.js\":\"ba1aea9731a35a22\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/state.js\":\"b5360bafea1acbc4\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/string.js\":\"7ee6e877b26e6194\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/surfaceZoom.js\":\"9eb18503b98dfcd3\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/time.js\":\"4dee4a039483e328\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/toast.js\":\"ff37d97729a11e69\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/toggleStore.js\":\"ce1d557957dc9e6c\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/untilStopped.js\":\"432c5fa3143e7904\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/userActivity.js\":\"9e84d148e8190e6e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/viewTransition.js\":\"a901d31282368cd3\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/viewport.js\":\"1beddaa1a23a5b76\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/webLock.js\":\"0d77ef72ee212e67\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/workspaceRecovery.js\":\"74cdbedaedf9f02d\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/workspaceSnapshotStore.js\":\"cf31bca0e6b6a589\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-compiler-runtime.js\":\"ecad85ac35108cdb\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-client.js\":\"a5590eee26ab489d\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-server-edge.js\":\"bf0415f527fd12f6\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-server.js\":\"0870cd312f59804d\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-static-edge.js\":\"e76eed35b7deba77\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-static.js\":\"d98a0681820ff924\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-test-utils.js\":\"0cc3cf3f2a6ad24f\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom.js\":\"05ffe521585bf3a1\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-jsx-runtime.js\":\"8200f02542788fbe\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react.js\":\"73d5b1abce04e451\",\"/knowledge-medium/pr-preview/pr-1916/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1916/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1916/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
