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
		buildId: "381c14401975-697470e0",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1916/\":\"3a0985dd259070f4\",\"/knowledge-medium/pr-preview/pr-1916/index.html\":\"3a0985dd259070f4\",\"/knowledge-medium/pr-preview/pr-1916/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1916/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1916/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1916/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1916/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1916/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1916/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1916/assets/FacadeVFS-DhdvqaeK.js\":\"74d42663552b527f\",\"/knowledge-medium/pr-preview/pr-1916/assets/OPFSCoopSyncVFS-DQlB3uT3.js\":\"137fb64d93bf9762\",\"/knowledge-medium/pr-preview/pr-1916/assets/OPFSWriteAheadVFS-Cy0lIm8A.js\":\"15162a53640d1879\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-BewiWc-2.js\":\"75a3b930cd66a409\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-async-E1bnMMK-.js\":\"47c5fcc885f53636\",\"/knowledge-medium/pr-preview/pr-1916/assets/worker-HAfgs7JQ.js\":\"d97ad7e92eed5e02\",\"/knowledge-medium/pr-preview/pr-1916/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1916/chunks/app-COXBhNBn.js\":\"0d7ff904b2581997\",\"/knowledge-medium/pr-preview/pr-1916/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1916/index.js\":\"34e7e0055dce1ce7\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1916/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1916/assets/AccessHandlePoolVFS-B0vVIb6M.js\":\"41eeae41d24ed199\",\"/knowledge-medium/pr-preview/pr-1916/assets/IDBBatchAtomicVFS-Ci-ZhOtf.js\":\"9dd69fad9412c9e6\",\"/knowledge-medium/pr-preview/pr-1916/assets/MemoryVFS-Bn5jjt2n.js\":\"218f34a81ea1719f\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-DLXF1zOW.js\":\"6e64f63bfea7a3ad\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-async-2W7ep2P9.js\":\"5d2d96b39829449d\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1916/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1916/chunks/AccessHandlePoolVFS-BB5uEl1C.js\":\"9376081df34e0943\",\"/knowledge-medium/pr-preview/pr-1916/chunks/FacadeVFS-BCcw2m1V.js\":\"418be42b8dc3f661\",\"/knowledge-medium/pr-preview/pr-1916/chunks/IDBBatchAtomicVFS-Cu1ZyypJ.js\":\"d01d3f19e3c450d1\",\"/knowledge-medium/pr-preview/pr-1916/chunks/MemoryVFS-BmmUfl7s.js\":\"9ab9e79866cea75c\",\"/knowledge-medium/pr-preview/pr-1916/chunks/OPFSCoopSyncVFS-CVvrLckM.js\":\"51225db7061b2790\",\"/knowledge-medium/pr-preview/pr-1916/chunks/OPFSWriteAheadVFS-D4Z8NCm2.js\":\"8a5bb1a21d8cc237\",\"/knowledge-medium/pr-preview/pr-1916/chunks/Preview-sYOCRyJ8.js\":\"763e6a7dcf6d781e\",\"/knowledge-medium/pr-preview/pr-1916/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1916/chunks/card-D5cEvskO.js\":\"92abd0350373a078\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dist-PDR84eLD.js\":\"b432b19a5707248b\",\"/knowledge-medium/pr-preview/pr-1916/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1916/chunks/mc-wa-sqlite-Bg-w0mSB.js\":\"5440714520e22321\",\"/knowledge-medium/pr-preview/pr-1916/chunks/mc-wa-sqlite-async-CxqcxlFc.js\":\"bd8a4dc18bdcec3a\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-B9ssVr_M.js\":\"7d5ae0850795614e\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-BNVN1zXD.js\":\"6ad05c679563d027\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-BNqFq4XF.js\":\"ae6d418406acfb9a\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-CQyJS4Fr.js\":\"a7539f77f3398467\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-DBKkDPQ4.js\":\"f44a57c26f1bef3e\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-DKBC-MG1.js\":\"79f8307cae91470b\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-DTQn3XkP.js\":\"08957a7ac1ba2a2f\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-b2i0jrOu.js\":\"ebd758d84bc15c72\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-dom-server-legacy.browser.production-6LJ9bVps.js\":\"2a2a1bef3e3bf043\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-dom-server.browser.production-PGY2EP_N.js\":\"234aef135d898f71\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-dom-server.edge.production-Cd2Q-Dix.js\":\"ad2b5f111d8b7665\",\"/knowledge-medium/pr-preview/pr-1916/chunks/server.browser-CTcWcTBw.js\":\"e2d0f5fb508682fe\",\"/knowledge-medium/pr-preview/pr-1916/chunks/textarea-D0cPlq1w.js\":\"483ff37d2db02854\",\"/knowledge-medium/pr-preview/pr-1916/chunks/ui-C9KkgyBX.js\":\"a7850b522fa15732\",\"/knowledge-medium/pr-preview/pr-1916/chunks/wa-sqlite-Du-8vtp3.js\":\"506ed1f5841420f0\",\"/knowledge-medium/pr-preview/pr-1916/chunks/wa-sqlite-async-2LqwZ3Fk.js\":\"ea1444ce845050c3\",\"/knowledge-medium/pr-preview/pr-1916/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1916/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1916/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1916/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1916/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1916/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1916/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1916/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1916/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1916/src/App.js\":\"dc7d5cb83e0fa61e\",\"/knowledge-medium/pr-preview/pr-1916/src/appUpdate.js\":\"0b99025a9a59c3e5\",\"/knowledge-medium/pr-preview/pr-1916/src/appVersion.js\":\"3872ef922459939d\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/initialLayout.js\":\"376cb092ce3ebc1d\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/openWorkspaceData.js\":\"e997c8655a7b09b1\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/resolveWorkspace.js\":\"32ccaa3596c5d66f\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/workspaceBootstrap.js\":\"68b2cb412cad487c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockComponent.js\":\"bfbb463b3b18ec6d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockCrumbs.js\":\"bdbcc69e91ae9e6d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockEditor.js\":\"57be136674ff8ee2\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockLoadingPlaceholder.js\":\"0c42bfee5b78e8e8\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockProperties.js\":\"aadf452c8d59ccd6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockSearchPicker.js\":\"5bb45f0d821f6ae8\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ConfirmBulkDeleteDialog.js\":\"b5cf236d3fcae3a9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/DividerHandle.js\":\"5f5bb573059c6261\",\"/knowledge-medium/pr-preview/pr-1916/src/components/DraftEditor.js\":\"54faf5627a4237ec\",\"/knowledge-medium/pr-preview/pr-1916/src/components/GutterPill.js\":\"f4b0548b356b950c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/Header.js\":\"e6d300ce402e9649\",\"/knowledge-medium/pr-preview/pr-1916/src/components/LazyBlockComponent.js\":\"4e4af942114432f6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/Login.js\":\"0c6b227b13b6cd8b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ZoomableSurface.js\":\"eebffcc77e932074\",\"/knowledge-medium/pr-preview/pr-1916/src/components/editModeKeepalive.js\":\"0edbbb5ba08201a4\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d4a583d8cf5461a1\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"04d3577b3e6c3bdd\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/RefPropertyEditor.js\":\"535105c9f3c421d0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/RefTargetTypePicker.js\":\"b0fc0dae388a19d9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/SelectPropertyEditor.js\":\"01994622ac4a801c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/TypesPropertyEditor.js\":\"7c1fb23daddb1661\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/defaults.js\":\"232ddebed1a22401\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/kernelValuePresets.js\":\"4a382985dfff0c3a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/selectablePresets.js\":\"66650d2e5bc3b5e7\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/typesPropertyUi.js\":\"173ee299ae14d607\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/AddPropertyForm.js\":\"02f4e8fa3bbacd8b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/PropertyPicker.js\":\"d2c7f51d43b7023e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/PropertyRow.js\":\"3c16f980d44c8571\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/Rows.js\":\"2ae903aa932b124e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/actions.js\":\"02cd22d7a181de2f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/declarationOnly.js\":\"6b58eb949ae6e60d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/layout.js\":\"02c9d14b5b517f77\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/model.js\":\"d0addaabaffb606e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/shapeUi.js\":\"53d8420dd7149f62\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/shapes.js\":\"97d175441c116af5\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ccb3129d5305511e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/visibility.js\":\"c87d1e564f336168\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanelSections.js\":\"6999cceda713e594\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/BlockEmbed.js\":\"5684cfe675e0dcb0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/BlockLink.js\":\"e26471b7da551952\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/BlockRef.js\":\"bb83b8e94e5eec2b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/CompactReferenceLink.js\":\"22aedeabfbeb4c2b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/ReferenceLink.js\":\"85d66896acd483e0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/cycleGuard.js\":\"1863a75c255f2f67\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/cycleGuardContext.js\":\"7c78f871616353f8\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/linkInteraction.js\":\"a25a6c6a22a98ba9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/referenceLayout.js\":\"cfd643d0d37dfb1a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/useBlockRefAncestors.js\":\"70f3275d43e5f054\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockGutter.js\":\"d68f72e61159bec0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockInfoDialog.js\":\"3f938604179c4800\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockReadText.js\":\"b6c7f3e23ad9ab07\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockTypeBlockRenderer.js\":\"0b7b94f2bda66a43\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BulletHoverCard.js\":\"3311277cfb7a321f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/CodeMirrorContentRenderer.js\":\"c1ce1104076edfe9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6d4aeca54fe63dfc\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/ColumnResizeHandles.js\":\"ee127d11a87a91bc\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b4788cbd3e55589e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/DefaultBlockRenderer.js\":\"e12a1d35a1d357e8\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/LayoutRenderer.js\":\"595ed21e21b43df4\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/MarkdownContentRenderer.js\":\"7d05b3b247c7a3f5\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/MissingDataRenderer.js\":\"aef12dd840672d55\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/PanelRenderer.js\":\"47c4ee35d1bdc048\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/PropertySchemaBlockRenderer.js\":\"5dab385ff151722b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/TopLevelRenderer.js\":\"0c7e44d123d6b1bf\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/blockGutterMode.js\":\"1dd90a0a8650d6e8\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/blockTitleText.js\":\"84424e888e0d807e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/fieldCreationKeydown.js\":\"9c50edb343c1e0b0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/layoutRootContext.js\":\"e854b56bdbace763\",\"/knowledge-medium/pr-preview/pr-1916/src/components/typeChip/TypeChip.js\":\"9d15a8de8fa9d942\",\"/knowledge-medium/pr-preview/pr-1916/src/components/typeChip/chipStyle.js\":\"8cf625b68c6fdd72\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/anchored-floating.js\":\"c69f1309d942b1a6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/button.js\":\"664830a8d37b1507\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/card.js\":\"757a5c567dca7f7d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/checkbox.js\":\"39846919e45252c1\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/collapsible.js\":\"05e681479d78772b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/command.js\":\"777515ca2104a9bc\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/context-menu.js\":\"899dafa693cf8f8c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/dialog.js\":\"cf4330ce737348ea\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/dropdown-menu.js\":\"de625da3b8e9f046\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/floating-listbox.js\":\"49c52a7a10894500\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/index.js\":\"3e67739c436148a7\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/input.js\":\"388142b2de37a440\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/kbd.js\":\"2603bfed39dafedd\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/label.js\":\"444ab433a456fad3\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/textarea.js\":\"60bf03d6068ccd78\",\"/knowledge-medium/pr-preview/pr-1916/src/components/useEditModeYieldKeepalive.js\":\"d84fafeaf047efe9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/BootFallback.js\":\"cd89c20dd84a3a97\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/FocusedRowLazyMount.js\":\"9c460345f6d4b09f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/LazyViewportMount.js\":\"a6d28f930587c614\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/LocalDbCorruptionFallback.js\":\"21fe105904f05aee\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/error.js\":\"23fbf549acd4a989\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/lazyMountRegistry.js\":\"ff79fd36edb71369\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/suspense.js\":\"8489ea788281224b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/CreateWorkspaceDialog.js\":\"47f0487fe489d327\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/PendingInvitations.js\":\"fb2d1df094915431\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/SyncProgress.js\":\"e25a652dc330e87d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/UnlockProgress.js\":\"0a8f4fbcbb527284\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceKeyGate.js\":\"88e6a831f16f45d0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceSettingsDialog.js\":\"5a253c349a7796c0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceSwitcher.js\":\"1b463c2206e1c82c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceSyncGate.js\":\"15029e91f3bb2fb9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/ConversionFlow.js\":\"8c9a49f1be342bd1\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/ConversionFlowHost.js\":\"990a9538b58294fb\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/EncryptionSection.js\":\"dc8601e5a7e990ec\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/attachmentPrompts.js\":\"a12c7b50f3b4df24\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/bundleFolderPrompts.js\":\"b9e5fbd83ebc1248\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/conversionFlowDeps.js\":\"7d3709946fc1e83b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/conversionFlowStore.js\":\"02e0fffe95a6bd9e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/flowUi.js\":\"25046829337c1b6a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/useConversionRun.js\":\"9ccaccc360e3acdd\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/keyUi.js\":\"8a6167398f667bff\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/useCloseOnKeyLoss.js\":\"fe7350717f9c01ba\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/useCloseOnServerE2ee.js\":\"1fd60ed1cc6b2d88\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/workspaceUnlocked.js\":\"35108246286cc2e7\",\"/knowledge-medium/pr-preview/pr-1916/src/context/backgroundSubtree.js\":\"a1bf677b85f91e81\",\"/knowledge-medium/pr-preview/pr-1916/src/context/block.js\":\"aa40bc72276680d7\",\"/knowledge-medium/pr-preview/pr-1916/src/context/layoutWsContext.js\":\"899a3938f21101a6\",\"/knowledge-medium/pr-preview/pr-1916/src/context/propertyDisplay.js\":\"f49293b409f432db\",\"/knowledge-medium/pr-preview/pr-1916/src/context/repo.js\":\"fb7545ca61d9228c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/aliasClaim.js\":\"913e407676d505e0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/aliasSeatNamespace.js\":\"18098b3e58de1d22\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/blockData.js\":\"0224438e934fa951\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/blockType.js\":\"057faec0b7dca813\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/changeScope.js\":\"444bd126db00dda2\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/codecs.js\":\"8be032d017074fb5\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/derivedData.js\":\"15da3d2e66e9ac8d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/errors.js\":\"6c922db764d40859\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/events.js\":\"119526fa5f4c9ba4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/handle.js\":\"c309748b0c7e7598\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/index.js\":\"cf88ee6c2416e9e9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/mutator.js\":\"b1a6fe90ad5a3243\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/processor.js\":\"aef0413a68e8e2f3\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/propertySchema.js\":\"059d8b81de36b5e6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/query.js\":\"055861217b54b8b4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/sameTxProcessor.js\":\"f946fb47ba903ac0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/schema.js\":\"c309748b0c7e7598\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/tx.js\":\"c309748b0c7e7598\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/typedBlockQuery.js\":\"c988b6f0176ee63b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/user.js\":\"e87fe996e867c94e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/valuePresetCore.js\":\"0d9c1ecd13a45992\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/valuePresets.js\":\"42c38ff78e3da1fb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/attachmentCleanerIOVerb.js\":\"4edf46788989d42a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/block.js\":\"3ad7ee4452947411\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockCache.js\":\"f58ccdcc7e0c42ec\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockId.js\":\"f509a70b245c3c32\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockLiveness.js\":\"6aacdc6b2f4671fe\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockMerge.js\":\"eedf2fb02b827476\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockSchema.js\":\"6e99fa8d5e382902\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockTypeLookup.js\":\"b3f9ead028eb3e4d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockTypes.js\":\"8c7e33659e53a110\",\"/knowledge-medium/pr-preview/pr-1916/src/data/childrenView.js\":\"ce998e52de8a914a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/clientContext.js\":\"f78f583beaf22a46\",\"/knowledge-medium/pr-preview/pr-1916/src/data/dbFileSiblings.js\":\"93a34fa1ab80c913\",\"/knowledge-medium/pr-preview/pr-1916/src/data/definitionSeeds.js\":\"ef0a868378305824\",\"/knowledge-medium/pr-preview/pr-1916/src/data/derivedIds.js\":\"0a0999bf105f042c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/drawnSubtree.js\":\"8438953e7c4bf5a7\",\"/knowledge-medium/pr-preview/pr-1916/src/data/facetBridge.js\":\"8163f230652b82aa\",\"/knowledge-medium/pr-preview/pr-1916/src/data/facets.js\":\"ec7041e4ded5ec6c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/globalState.js\":\"2eb47f642e7a4318\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/aliasClaimRederiveProcessor.js\":\"32418401f5c2a6a3\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/ancestorBatch.js\":\"a53d8fabf7a9a284\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/blockTypeTypeifyProcessor.js\":\"0da4dc4683e9e246\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/clientSchema.js\":\"edac6d04a9c6262b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/commitPipeline.js\":\"e04fd997ebe433c1\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/devAssertions.js\":\"8bc5dcde353dec29\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/firstSync.js\":\"5167447322a7e6bb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/freshInitialLoad.js\":\"6f518b1238c54791\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/graphBackfillClaim.js\":\"0902035653bb3377\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/handleStore.js\":\"872be4ff3d6f30ae\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/idleMarkerJobs.js\":\"308e458beb8ed246\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/initialDownload.js\":\"097885cd960064a0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/initializeClientDatabase.js\":\"9d385db6a01b6517\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/jsonCanonical.js\":\"c74b72011b91af53\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/kernelInvalidation.js\":\"fc0e8a51a4f6e40a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/kernelProcessors.js\":\"b0783b06e9065a1b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/kernelQueries.js\":\"7686c50933d2c757\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/mergeTypeMembershipProcessor.js\":\"62c5bfe2a0ec8d13\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/normalizeReferencesProcessor.js\":\"6741d32a47c3fa61\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/poolInstrumentation.js\":\"21af67213fbfcc8f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/processorRunner.js\":\"54eb0f53d116cb5f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyCellBackfill.js\":\"869070414fb7cb31\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyChildMint.js\":\"162e253a8cf5c4cf\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyChildrenProcessor.js\":\"f020a3972166c947\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyDefinitionChangeProcessor.js\":\"0ddd66f369afa617\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyDefinitionSynthesis.js\":\"e31777d9556f6f17\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyKeyScan.js\":\"b50be1327b7aa2e0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertySchemaResolution.js\":\"315c1d51a83a7d8f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyValueEdits.js\":\"361c21adf4575373\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/raiseProtocol.js\":\"471486e7544405bc\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/readBatch.js\":\"0f88cae786152962\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/refProjection.js\":\"57f5749d6d80b482\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/referenceTargetLookups.js\":\"1eea4041ca7adf49\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/referenceTargetProcessor.js\":\"ac468de3e8a35575\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/replayMerge.js\":\"56e3c6e920537e7e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/sqlBinds.js\":\"981e2993285e6471\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ae730a1cfad37d81\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/arrivalProcessors.js\":\"f29aeed6467d4a0f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/invalidate.js\":\"aa4bc5be078d5501\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/materialize.js\":\"e80f713581963d40\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/observer.js\":\"d3face7c4d699d5d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/reconcile.js\":\"d848fa95a6250758\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/timingMetrics.js\":\"2d9153bf4b5d306c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/treeQueries.js\":\"0108453f77be359f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/txEngine.js\":\"24bc57852631ed7c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/txSnapshots.js\":\"204e3099e8c4435b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/typedBlockQuery.js\":\"a375aaca0bfa4b1f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/undoManager.js\":\"2c10fccff11d3674\",\"/knowledge-medium/pr-preview/pr-1916/src/data/invalidation.js\":\"cc8da30b4913ddee\",\"/knowledge-medium/pr-preview/pr-1916/src/data/kernelDataExtension.js\":\"2ba2f2af88710872\",\"/knowledge-medium/pr-preview/pr-1916/src/data/kernelPage.js\":\"769f19e5eaf1eec6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/kernelValuePresetCores.js\":\"f5c7ac0a4f672916\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localDbCorruptionSignal.js\":\"87b751857c53a230\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localDbStorage.js\":\"fb3f68bb26fd0107\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localDbVfs.js\":\"57b24a91d2074adb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localSchema.js\":\"68a23757f3949fef\",\"/knowledge-medium/pr-preview/pr-1916/src/data/maintenance.js\":\"d663a66675efd4ba\",\"/knowledge-medium/pr-preview/pr-1916/src/data/mergeProperties.js\":\"52cce6c9607f3e98\",\"/knowledge-medium/pr-preview/pr-1916/src/data/metricsConsoleHook.js\":\"05743fc766ec5f29\",\"/knowledge-medium/pr-preview/pr-1916/src/data/migrationsPage.js\":\"b886a76f3d0bffc5\",\"/knowledge-medium/pr-preview/pr-1916/src/data/mutators.js\":\"ca20365e3a54bf64\",\"/knowledge-medium/pr-preview/pr-1916/src/data/orderKey.js\":\"46a69791efdb3805\",\"/knowledge-medium/pr-preview/pr-1916/src/data/orderKeyPlacement.js\":\"f418d5567f7daed0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/outlineSurface.js\":\"dfd6c407e75b0b0f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/pendingEditorContent.js\":\"fd2ae18ee7eec85f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/pendingUploadsSql.js\":\"32b4cc2364547b5f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/pluginStateExtensions.js\":\"e8cbcf13f46911db\",\"/knowledge-medium/pr-preview/pr-1916/src/data/powerSyncLogger.js\":\"e41b02507c12d479\",\"/knowledge-medium/pr-preview/pr-1916/src/data/projectorRuntime.js\":\"9ade8a4ba7a88b28\",\"/knowledge-medium/pr-preview/pr-1916/src/data/properties.js\":\"64c7a920917f94e8\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertiesPage.js\":\"d10ef2af42c436e4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyChildren.js\":\"9e74ce192f4a27de\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDefinitionFanout.js\":\"2cbc3bcbc43a079b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDefinitionMetadata.js\":\"47334db348edbe31\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDefinitionRegistry.js\":\"c4fbd16d81bca381\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDisplayMode.js\":\"ed88d6c961fc4716\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyRowCreation.js\":\"518f8d7ee454976f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertySchemaCreation.js\":\"4a1cff4abdbc50ab\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertySeeds.js\":\"8625bd5f261178ae\",\"/knowledge-medium/pr-preview/pr-1916/src/data/recentsPage.js\":\"475e5fb34ef928e8\",\"/knowledge-medium/pr-preview/pr-1916/src/data/refTargetComparableProperty.js\":\"beea10b1edd2286d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/referenceBlock.js\":\"c5a0735705df6863\",\"/knowledge-medium/pr-preview/pr-1916/src/data/rejectedUploads.js\":\"a24a04dc0068e5ad\",\"/knowledge-medium/pr-preview/pr-1916/src/data/releasePowerSyncConnection.js\":\"403c603832dd22f6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/repo.js\":\"8c814edc4f5b30ec\",\"/knowledge-medium/pr-preview/pr-1916/src/data/repoProvider.js\":\"cbe4e24a214136d4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/rowProperty.js\":\"44034e17c558a33c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/searchFilter.js\":\"07ae56fcca5f11dd\",\"/knowledge-medium/pr-preview/pr-1916/src/data/seedIdentityLedger.js\":\"cef254b88577e6e0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/stateBlocks.js\":\"fb03a32b312eb388\",\"/knowledge-medium/pr-preview/pr-1916/src/data/structuralEditPolicy.js\":\"761347d4bfd15200\",\"/knowledge-medium/pr-preview/pr-1916/src/data/structuralInsert.js\":\"c64db3b2ab294560\",\"/knowledge-medium/pr-preview/pr-1916/src/data/subtreeDelete.js\":\"e42d5169909e8c66\",\"/knowledge-medium/pr-preview/pr-1916/src/data/syncStreamLock.js\":\"657079894821db25\",\"/knowledge-medium/pr-preview/pr-1916/src/data/syncedTableSqlRecognizer.js\":\"818bd99fff3a5ae4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/syncedTableWriteGuard.js\":\"ae00a1e363a3d302\",\"/knowledge-medium/pr-preview/pr-1916/src/data/targets.js\":\"b1a98817b7fe03f2\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeColors.js\":\"4bfc94199fff8513\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeDefinitionMetadata.js\":\"43887dee552981ae\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeDefinitionRegistry.js\":\"ea23feb4f8d17c18\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeExtraction.js\":\"af53f830ff01bd33\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeInitialValues.js\":\"5218891efa7f99ea\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typePropertyGroups.js\":\"967670edf76bf63f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeSeeds.js\":\"882ce53cb6b817ac\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeTagger.js\":\"628f50175d723147\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typedRecords.js\":\"b21400b6c442cf9c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typesPage.js\":\"21da9c793ff8f962\",\"/knowledge-medium/pr-preview/pr-1916/src/data/userPrefs.js\":\"fc42c3460e656216\",\"/knowledge-medium/pr-preview/pr-1916/src/data/userSchemasService.js\":\"3001d097f606a009\",\"/knowledge-medium/pr-preview/pr-1916/src/data/userTypesService.js\":\"e9e521f7e25ecfa1\",\"/knowledge-medium/pr-preview/pr-1916/src/data/valuePresetRegistry.js\":\"14dc2e1d1484d70f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/visibleChildren.js\":\"e7b56d2e6a511229\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceConversion.js\":\"465cb3fbb33df287\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceFirstSync.js\":\"65c39abc006e3dc9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceIdNamespace.js\":\"78f5527802277557\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceSchema.js\":\"94a836c973a99892\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaces.js\":\"0ba338990c27f829\",\"/knowledge-medium/pr-preview/pr-1916/src/data/writeAheadLog.js\":\"0649fc7e4c62ba94\",\"/knowledge-medium/pr-preview/pr-1916/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/BlockPasteShellDecorator.js\":\"d1eb35da5316dbf2\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/atTrigger.js\":\"b8a8365f723bd20d\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/autocomplete.js\":\"5828230b2c526ac9\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/codeMirrorExtensions.js\":\"4344734aea0e9af8\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/contentFlush.js\":\"d2516bbbf7f29473\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/defaultInteractions.js\":\"bbeaed175481f867\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/editSettleSignal.js\":\"c23e34ad517bb4c0\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/insertImage.js\":\"c272f0a7bd1cc61f\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/referenceCompletionRange.js\":\"bc6f72ee50187399\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/referenceTargetTypes.js\":\"f70ef0c3808377ed\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/syntaxContext.js\":\"fbe3a8128ee95c07\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/triggerMatch.js\":\"68d87988215e8a71\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/AppRuntimeProvider.js\":\"834d2504ad834d31\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/BlockFocusShellDecorator.js\":\"bee99e3e5af89d87\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/ExtensionRenderBoundary.js\":\"872cf5d1470a7d3f\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/PanelContentRecovery.js\":\"28aff9512e1bb236\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/apiCatalog.js\":\"a7ea03cb2edce17e\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/approveExtensionHere.js\":\"82fa62d6aee96ac3\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/armedCutAppMount.js\":\"d24d90f79dbb035d\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/batchableKeyedStore.js\":\"9387205c6dc77cb1\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/blockInteraction.js\":\"68f3c702ba674332\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/blockSelectionAction.js\":\"b6d2604bd6cad3d6\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/compileExtensionModule.js\":\"3c23a6fd0bb298c4\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/compiledModuleCache.js\":\"bb5031b69b1ad145\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/continuousGestures.js\":\"00f0e97d916d3ed5\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/core.js\":\"3c7f32bb89fbd435\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/defaultRenderers.js\":\"c5dccb8846938c3c\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/definitionFanoutAppMount.js\":\"a245ad80913324cd\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/dialogAppMount.js\":\"5405e1adc65b7af8\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/dynamicExtensionSeeds.js\":\"018de0ffe3521cb2\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/dynamicExtensions.js\":\"13e2c6d0ddb39138\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/exampleExtensions.js\":\"fa89f1843d7dc0b8\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionApprovalStatus.js\":\"783b2e9007b9d638\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionLoadErrorToast.js\":\"3ac9151fb2a3f045\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionLoadErrors.js\":\"4a2040dcfa715fe8\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionLookup.js\":\"d033f56306070475\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionToggles.js\":\"f39ff69535cb6295\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionUtilitiesCss.js\":\"36e109e5c46f010e\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/kernelPageDeletionGuard.js\":\"4f5bc13abbbf86aa\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/liveRuntime.js\":\"0ffe39dfae2c2b3d\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/openExtensionsSettings.js\":\"e04e7c1295483dc9\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/overridesCache.js\":\"e5d3c5b3a0128b22\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/pluginIds.js\":\"c6d91027fcf61636\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/processorRejectionToast.js\":\"8361de2046833078\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/runtimeActions.js\":\"7283f66bd1cb58f9\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/runtimeContext.js\":\"3b7e23da8cb3f667\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/staticAppExtensions.js\":\"102eae1061dc0bb7\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/staticDataExtensions.js\":\"f6757e7f4a467975\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/toastAppMount.js\":\"03f640917e9a9384\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/useOverrides.js\":\"aab15f1b7f3164d2\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/useShortcutSurfaceActivations.js\":\"9206734631baabf1\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/discoverToggleTree.js\":\"c9b2b593d9ca0f32\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/facet.js\":\"ba3859b5d4f6c046\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/resolveAppRuntime.js\":\"2790b3f3940c0125\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/runtimeEvents.js\":\"4f631ed903a32924\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/togglable.js\":\"326d22660119881a\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/variantFacet.js\":\"7135745062f47b36\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/verbFacet.js\":\"226e67a62d6aa876\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/block.js\":\"eaab552233fecd2a\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/focusedChild.js\":\"aae65c6521a7ee9d\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/propertySchemas.js\":\"41e420dfb7aa66e7\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/typeRegistry.js\":\"0dd158733a5ffbc4\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useAncestorCrumbs.js\":\"49f8e2b611e7e5e3\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useAutocompleteListbox.js\":\"9fe995205cc56697\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useDebouncedSearch.js\":\"6a162c68d145670c\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useDebouncedValue.js\":\"b5be6a98be929308\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useFacetValue.js\":\"4c6c343e72059c57\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useIsFocalRender.js\":\"9bbd8a03ffd8aa12\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useIsReadOnly.js\":\"5db1a0ec15ca26fd\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useMaterializeBacklog.js\":\"aa6f9d5944085269\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useMinuteClock.js\":\"8e7777f35d9dd70e\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/usePanelLayoutProjection.js\":\"cc13f9c82b3d2645\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/usePendingInvitations.js\":\"2cc5a1cfa8e87feb\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useRendererRegistry.js\":\"a3178e54ff73f61e\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useRetainedFieldRows.js\":\"e11f5bbf9d66e4ca\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useWorkspaces.js\":\"02ad610083829531\",\"/knowledge-medium/pr-preview/pr-1916/src/lib/utils.js\":\"bc1cc702e17d5ab6\",\"/knowledge-medium/pr-preview/pr-1916/src/main.js\":\"1d44795ed97f7470\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/MarkdownImage.js\":\"a7a9abe496cea644\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/blockSeparators.js\":\"beb9da9852cf4c10\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/context.js\":\"30bfb0701e9a576b\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/defaultMarkdownExtension.js\":\"72c263ccd7d9264b\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/extensions.js\":\"dab0b4cbfc82904c\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/renderMarkdownHtml.js\":\"dac8106eea04caeb\",\"/knowledge-medium/pr-preview/pr-1916/src/minimal-editor.js\":\"5491e9e77858ca25\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/armedCut.js\":\"1dd75ad92121cccd\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/captureMediaVerb.js\":\"f5e4fd3f24fac119\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/clipboard.js\":\"b40c6ff6dc15dafb\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/decision.js\":\"f083ec507d4bcd7b\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/operations.js\":\"2e2ba49a06f2c905\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/account-header/AccountHeaderItem.js\":\"96baffcfd5d20525\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/account-header/index.js\":\"b10dbc94e5855410\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"968e0f16f899c060\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/askAgent.js\":\"f93e70531bf98299\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/askedStore.js\":\"93b6fe5e28a42d8c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b49c4cccfdc933ec\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/chipState.js\":\"b6ef03c21b045cb7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8bb69237ebcf6761\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/index.js\":\"f8d051aa1c04ba14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"856a03cebfae65bc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/schema.js\":\"b71fde7a4ac7f13e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/AgentTokensDialog.js\":\"cbc0c745edefc6d2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9947171ee57fff9c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/addMedia.js\":\"983b53531f624d50\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7fd34d59d2eeca2b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/block.js\":\"25969674fad8eb0d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/context.js\":\"fad66a636ec7a0c0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/displayIds.js\":\"52238aa8782f8816\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/index.js\":\"7d1dcaabad284d82\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/outline.js\":\"11b61a05b9259eb5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/properties.js\":\"0069fac9c4ba239f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/refs.js\":\"da7a097898fd555d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ee89ea38f8528495\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/search.js\":\"8fa1bda9e2ea3ad8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/shared.js\":\"6ba32e3316bb1eae\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"e28b9a991db64bfd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/text.js\":\"bdc1744bbe88248e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentWrites.js\":\"efe81ba66e595cbb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/authoringCatalog.js\":\"d03c1a3fa9d473f3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/blockRefTargets.js\":\"9bf7ab3f49eaabc0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/bridge.js\":\"c8257b4995b68b62\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/bridgeLoop.js\":\"49b9a2cc75cdc7d5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/changeHistory.js\":\"8c66ac111b4e95be\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/commands.js\":\"3670c76cafbe6cd3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/commentsCommands.js\":\"d1758fb54b3ad98a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/dataExtension.js\":\"4d133566e4e65889\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/dataModelGuide.js\":\"fa5f0fed40786821\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/dayPropertyInputs.js\":\"ad63d68992ac3f03\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/describeRuntime.js\":\"8a577ece83ffa3a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/extensionLint.js\":\"71605cf4fc267fa9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/grainAudit.js\":\"4eedd58c0a380b71\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/healthCommand.js\":\"b889313b340552f3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/index.js\":\"7461cad9de534381\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/presetIdentity.js\":\"79203367e051447f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"110ce7ab876896f9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/readMedia.js\":\"5e98b02346a684ad\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/schema.js\":\"b83773dfa11e9284\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/serialization.js\":\"5ba3318db38ef5d4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/targets.js\":\"d368d57f88ab0666\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/tokens.js\":\"a53482c6524b4df3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/watchEvents.js\":\"e3bde6dd5a742075\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/workspaceGuard.js\":\"52b03fbe539820aa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/writeCommands.js\":\"8a6b45d42ec6a5c8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/AliasCollisionToast.js\":\"8b17f5a21ae461f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/DuplicateNameBanner.js\":\"ab0e40fb78d46118\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/collisionMerge.js\":\"bc5b9e0f56d75d19\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/dataExtension.js\":\"731c6c5eab66e72b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/index.js\":\"55476f77f1393bc7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/mergeCollisionAction.js\":\"0281710cf112d200\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/pageStyling.js\":\"991637d8beaa38ae\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/rejectionToast.js\":\"f05e36a4ee9678c7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/syncProcessor.js\":\"f397129a630fcd81\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/actions.js\":\"0be4037210660e16\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/addComment.js\":\"c2abd5bdb5bb75d2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/anchor.js\":\"e8046fea1d0d23a9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/anchorState.js\":\"009033781d55678a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/commentLinks.js\":\"29cf3e225e5874e8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/confirmThreadDeletion.js\":\"7fbf736955fd05a9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/container.js\":\"41b93e93be1fb074\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/dataExtension.js\":\"f38659f4689cb291\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/deleteComment.js\":\"a23cc0acc5e44027\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/highlights.js\":\"59fe9d8f47075116\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/index.js\":\"7bc6c6a0bd3314d8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/linkedCommentsPill.js\":\"9d6057ce2ef8b196\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/margin.js\":\"a4d61014f209f086\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/marginAnchorLinks.js\":\"62a910046d73b83e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/marginSchema.js\":\"bc66c464e0f471b6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/newComment.js\":\"bc168b7f28b2e8cb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/ownThreadPicker.js\":\"7590a4bd29662c97\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/placement.js\":\"3ec8e22c6a79375c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/queries.js\":\"cc14665f71cce121\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/quotePosition.js\":\"0b3de37c83c9cecc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/quotedIn.js\":\"e50cbb7918705d78\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/quotedRange.js\":\"d9e88dbfb78d1825\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/rangeRefs.js\":\"eb39e6eac8f54b63\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/readHighlights.js\":\"07254dd3eb599cc0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/readSelection.js\":\"ae13e0ddee0babbf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/readSelectionUi.js\":\"fec6e8f6bc1b3e9f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/reanchor.js\":\"bac18cea4ba46064\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/schema.js\":\"51aa0c2c8f64aeb8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/scope.js\":\"bd793f7740fa4683\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/scopeThreads.js\":\"2d2f7c20b9cb6c55\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/splitRetarget.js\":\"238939d0a976b356\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/suggestionCard.js\":\"59c4e975429d2762\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/suggestions.js\":\"36acd61d3c5c9cbd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/summaries.js\":\"77a24d461fe508bb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/summaryBatch.js\":\"c4af23e9ff0c4825\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/surface.js\":\"210be5cdf54161f4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/threadNavigation.js\":\"f552b24dc0b9aa62\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/threads.js\":\"fcb5d1541b8f2303\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/ui.js\":\"66ffd37bd4836efc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/uiStore.js\":\"01aefd191be7a707\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-intents/appIntents.js\":\"c2218a64a9648695\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-intents/index.js\":\"46ff611582c15321\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-update-prompt/index.js\":\"b16383e05930d65b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-update-prompt/status.js\":\"be4bb4f2937d4127\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"2f9082ff113e6138\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/MediaBlockRenderer.js\":\"6927bae05fc9dbd6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/MediaDownLaneReplicator.js\":\"fe319cc7f2f4f444\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/MediaUploadReconciler.js\":\"1e4d274635163e96\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/assetDownLane.js\":\"70e37703aea99276\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/assetResolver.js\":\"7606c396799a779d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/assetUpload.js\":\"1ff24a321af2d7d9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/attachmentCleanerIO.js\":\"4991e5358c35ca56\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/supabaseAuditIO.js\":\"051cd20c8a262be8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/blobStore.js\":\"507d611198584bd8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/browserMedia.js\":\"f9334371bd67e80c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/byteStore.js\":\"7cc895269c833cf2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/cleanerIO.js\":\"76752c731c61d81d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/cleanupAttachments.js\":\"b01873e5150cbbc3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/dataExtension.js\":\"495348b57d19f635\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/downLane.js\":\"768d9512fdfdf84c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/index.js\":\"f667edb7f6ca2b43\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/insertImageContribution.js\":\"ecb5c135b9bb8269\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/laneArming.js\":\"3266ee1f78166c07\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/laneLock.js\":\"7a84675b06834336\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaBlock.js\":\"167a848049111fe2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaCapture.js\":\"1a1c8369600ffb99\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaLanes.js\":\"26453a604954bf70\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaViewers.js\":\"908c9b0300baceba\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaViewersFacet.js\":\"a88e77228ba54012\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/pasteCapture.js\":\"9e8b16b97d893960\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/resolver.js\":\"db588ab3fd68d159\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/retryUploadsAction.js\":\"0badfc9c9518afb8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/storagePaths.js\":\"be9dea4db00e9599\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadDrain.js\":\"82362d88b9e5133d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadLaneStatus.js\":\"f31b0cb782d595f4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadReconcile.js\":\"132f63cfa312f0c0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadRecovery.js\":\"eb01f815b36dd43e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadStore.js\":\"7dddb20500256b19\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/useAssetObjectUrl.js\":\"9b2b01409639e510\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"3cd529652db7530c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a6384ec4f7138afb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/facet.js\":\"531f5b8a7d514675\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/index.js\":\"1b3dd5ad6a5cebbc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/prop.js\":\"8887ba2aa4e176f6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/BacklinkFilters.js\":\"708aa9c7ca1dc318\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"b40bd9da231f1839\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/BlockEntry.js\":\"11a3c7b1d779a3d3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/LinkedReferences.js\":\"6c9983f51057fc3a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8aa57852c656d838\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/dailyNoteDefaults.js\":\"f587ca63f48c002a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/dataExtension.js\":\"d1b0e34a60ec509e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/edgeExclusions.js\":\"a7ee014413d91121\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/filterProperty.js\":\"df67c918803e3194\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/index.js\":\"2699e540c72a5988\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2925c26f1919a893\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/applies.js\":\"a836830aae106db6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/countQuery.js\":\"7c6155180853161d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/expansionStore.js\":\"b323916c51b8c45e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/index.js\":\"44ed7f3081076318\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c2dce4abe5f54a04\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/presentationInvalidation.js\":\"42024a1a6ff3ec47\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/propertyEditorOverride.js\":\"3e5d2ee7a32fad41\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/propertyFilter.js\":\"6e4960f8a3f38599\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/query.js\":\"2a6b1be3ad4674b1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/resolveFilter.js\":\"9371a8a47bea0531\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/sourceBatch.js\":\"24e334511baeac55\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/sources.js\":\"5701650b6d99d782\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/useBacklinks.js\":\"4e7eb1252537c6a8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"69b7661847a2ee4f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/BirthdayCelebration.js\":\"7af15a550cd8f688\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/BirthdayOverlay.js\":\"ab3f82f44f77b93a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/gate.js\":\"3c8775aa042fc219\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/index.js\":\"05f96609157f6ceb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/wolfTheme.js\":\"cc7240f8be95804a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/BlockDragLayer.js\":\"b1f5caab56edaf12\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/dragController.js\":\"f84431fe6377d0fe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/dropTarget.js\":\"556718880ae50653\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/index.js\":\"4ece83010bf9827d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/projection.js\":\"8c69322fd5af81f6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-info/BlockMetaCard.js\":\"7da52a73c6dc4e76\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-info/index.js\":\"54b978ea7e4dbf4e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/AddTagDialog.js\":\"705fab23ce20fb13\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"34eabe9c033e6b1e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/TagNameIssueHint.js\":\"deaa63c40ab69529\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/addTagAction.js\":\"68779ba0a42c9233\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/appendTag.js\":\"d8e158fc5bf5e48b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/config.js\":\"82070e0db1986dad\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/dataExtension.js\":\"50ac942f14a0e32c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/index.js\":\"7c89ca76f1d081d6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/propertyEditorOverride.js\":\"92d7164c9a18075c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/BreadcrumbList.js\":\"47eb9fe8d7d61764\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c18d6367e80cb14a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8ae65c73e7b5acaa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"4de12902b0ad22ab\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3370c3e9b858b554\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/index.js\":\"4b632c28bb87e2f1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"1b004d331e650916\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/CharacterCountItem.js\":\"231745e9a74b0687\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/ProfilePropertyEditor.js\":\"eec25b43396f8323\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/actions.js\":\"94b3f5b37808d21d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/blockType.js\":\"b1fca25e45fe47fd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/charCount.js\":\"b3599e6400dc3445\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/dataExtension.js\":\"e5f0eeeb293b5a4a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/index.js\":\"b579b61347f64110\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/profiles.js\":\"e6da7f51a227a19e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/properties.js\":\"f9df077a09f898a5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/subtree.js\":\"f92680b38d5bdeb7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/textCounts.js\":\"b5abaa0046e1ad1c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/colemak-keybindings/index.js\":\"44645eab038584fe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/CommandPalette.js\":\"1a085846c1b38b07\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/HeaderItem.js\":\"1732865daa6c711f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/context.js\":\"e8edaa5fda85663c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/index.js\":\"0946926ea61ddc80\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/selection.js\":\"e5c2366ea3576357\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/toggleStore.js\":\"25c8d3e5a7737803\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/useCommandPaletteActions.js\":\"deda6b28888363c5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/ContributorBadges.js\":\"ad8e83d9c42b81f6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/ProfilePicture.js\":\"d0ea4bd9201a0da2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/author.js\":\"56ae8474c7ed5234\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/codeMirrorExtensions.js\":\"3917f079293cf1ca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/dataExtension.js\":\"609294294b61a2e6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/index.js\":\"a0e6d99c83dfa1c2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/mentionAutocomplete.js\":\"3ba63c7904933010\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/processor.js\":\"b55b24e58725abb6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/profiles.js\":\"388885e11b4d7a7a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/queries.js\":\"3b8ce10adf8826b2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/schema.js\":\"76446262a78c8c0e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/useCommentAuthor.js\":\"75c819356fa58cd9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7088c69c2e57950e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/followOrigin.js\":\"83f84f45c430f7ec\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/index.js\":\"09e5d2e4b5139798\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"18217149236f096c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d15de007c8a8cbab\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/CalendarGrid.js\":\"d4032f9de96a38e9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DailyNotePicker.js\":\"9577a5fbdb0b6aaf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"beb027fa32db42ed\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DateNavDecorator.js\":\"56dbb8372984b594\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DateScrubOverlay.js\":\"2848fe82a8c2dcaf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DayPropertyControl.js\":\"040ff58c07e1b086\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DayValueReferenceControl.js\":\"ac9f8f5f66929ed8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/HeaderItem.js\":\"6910ed711c370398\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/ReschedulePicker.js\":\"b883cbafff7288bf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/SpreadDatesDialog.js\":\"3137a6a5bb9eef9c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/actions.js\":\"4d1e7880433ec7e5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/blockDateAdapter.js\":\"f92d1e794b13b2a8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/calendar.js\":\"681f0333003411b8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dailyNotes.js\":\"d7c7a1f8440274d1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dataExtension.js\":\"b9d388b60330475e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubActions.js\":\"a7fdc6c9a6b07247\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubGesture.js\":\"faff5ee7bf22e847\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubGestureActions.js\":\"84a8d7258cfcecc7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubRecognizer.js\":\"530eb9871063281b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dayProperty.js\":\"2d554ca726b569a2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"7be3bac297d5d654\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/deletionGuard.js\":\"edf7c6a2a6d025ab\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dueQuery.js\":\"c0824bbf8ea365c3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/index.js\":\"ab563a8b4952b849\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/landing.js\":\"633eff5c69aa54c0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/localSchema.js\":\"ca55dfe72b3e5248\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/referenceDateAdapter.js\":\"969714474cabd0a8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/rescheduleAction.js\":\"a340234c291a2fb8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/schema.js\":\"6579b691e9ef2825\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/spreadBlockDates.js\":\"a408efb50ab00dfa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/spreadDatesAction.js\":\"c7b03387c84d8bd8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/today.js\":\"72313e96b8f80348\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5d1d82d0c3a6ff9a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9b7bcc45786c6254\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/audit.js\":\"e0215fd4b02c6900\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/auditAction.js\":\"44469d4d0c21570e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/auditRanges.js\":\"61045683f6c782d3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/diagnosticsSource.js\":\"387ab2416ca5ce9a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/divergenceScan.js\":\"6c06f15b24675f3a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/index.js\":\"53f71350cda1c712\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5ad1129622d48b4d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/referencesMirror.js\":\"748926622c5d5ea5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/rowJson.js\":\"65be6439e5c04dc9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/schedule.js\":\"6399bc69a190a355\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/store.js\":\"d7b7d7424aa44216\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-maintenance/action.js\":\"3485327b4b3e8239\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-maintenance/index.js\":\"3fac18bc7459678d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-maintenance/plugin.js\":\"28295f2a82874085\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"5a0a1049e1647d94\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/actions.js\":\"d7de0c029a0232e6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/changeMarker.js\":\"342e38da85bbbbee\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/diagnostics.js\":\"6e6b6add1e5892a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/fileSystemAccess.js\":\"07512e868c73e7e9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/filenames.js\":\"77bae620a82fc637\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/index.js\":\"7140ba98300ef4ca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/mirror.js\":\"37df7e3be9e9e071\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/runLock.js\":\"54e1be32341eb0ec\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/runtimeHealth.js\":\"eb158dcd11327242\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/schedule.js\":\"8b75a02300d8047b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/store.js\":\"ce0c98385a1ec159\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/default-themes/index.js\":\"406ffe99076362ae\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/default-themes/themes.js\":\"288a72b15cb3e035\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/diagnostics/facet.js\":\"eaa8040f898ed87b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/diagnostics/useDiagnostics.js\":\"a892f0affbfd58d8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/dismissals.js\":\"c0db9be2b15fcade\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/index.js\":\"f1520862bc90a402\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/status.js\":\"f426097a99c2e623\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/store.js\":\"575dd42480b7921e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"8488f3a5184f087b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/ExtensionsSettings.js\":\"f558837836d7e653\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/actions.js\":\"4a1a8cfdc416283b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/config.js\":\"68ce5f30825ac4a4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/dataExtension.js\":\"28bd9521237b1a06\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/effect.js\":\"cfc35441bc96cbfb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/index.js\":\"6fa9473afa53bb92\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/propertyEditorOverride.js\":\"261b840b513b1fcc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/useToggleTree.js\":\"3b257988abccc59e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/ExtractTypeDialog.js\":\"7729103534039b77\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b5543da1bc0607c6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/PropertyShapePicker.js\":\"97421fa36d0a085e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/action.js\":\"97a702d78c833cb3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/index.js\":\"16782293ca0a9708\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/FindReplaceDialog.js\":\"791d7c6ce6291639\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/HeaderItem.js\":\"e36d7e0205311445\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/dataExtension.js\":\"84a9dc763c1b4cf7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/index.js\":\"3f844edac9ff7a3d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/search.js\":\"c2f1ef6cff6bcc8e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/toggleStore.js\":\"8c48e1bfcb0e7bb9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/LocationPropertyEditor.js\":\"ffe7bd43b5cc395f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/MapView.js\":\"10cfda3e7a9ce3ab\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/blockTypes.js\":\"2285505a11cc304b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/codeMirrorExtensions.js\":\"b2a44ba6d47b4c03\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/createOrFindPlace.js\":\"ce2475e23b303780\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/currentLocation.js\":\"d179aa351a461bc6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/dataExtension.js\":\"d923f1ce88093120\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/geoContentDecorator.js\":\"305d731774f1e0c7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/googlePlacesClient.js\":\"285ce8a8d6a6f6d9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/index.js\":\"9af23ff36312bf12\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/locationsPage.js\":\"3fe5b492adf8acac\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/mapViewport.js\":\"0d4b80681daa7bba\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/pickCurrentLocation.js\":\"2ea0188fef10adeb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/placeAutocomplete.js\":\"d9150b7e11ca39b0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/placeNameCollision.js\":\"b512669c4b76fb0c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/properties.js\":\"108528ba89550ed9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/propertyEditorOverrides.js\":\"4bf70ebf5cc04420\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/query.js\":\"80b64d96c3e5e1b9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/usePlaceSearch.js\":\"abb0a9cbfc8e1339\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"48d62351297de47e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"633e6c88f894a518\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ed647d2c3e973124\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/config.js\":\"27b9d6c5ad5635b8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/dataExtension.js\":\"88074776f36595e0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/facet.js\":\"b4ba82e299e9857c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/grouping.js\":\"6cfab75e3fba1c72\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/index.js\":\"3960e28a3ec209ca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"88692121be492872\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/query.js\":\"84b17fdaff3980be\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/resolveConfig.js\":\"bffcbaa86434e42a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"02fe0d68a15ea277\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"cfce25638edf1fa2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/HtmlDocumentContent.js\":\"371b0dc6d1f63ef4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/HtmlFrame.js\":\"e3329944d8c5f3f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/actions.js\":\"dbca072aec19de2a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/blockType.js\":\"fa14ae8a2e58382d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/confirmRunScripts.js\":\"b4d78e3abaa075ac\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/dataExtension.js\":\"74db01cf49e8a376\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/frameAnnotations.js\":\"dfaa844666c35ceb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/frameDocument.js\":\"48033a056aef4289\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/frameTheme.js\":\"59b94619b945174d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/index.js\":\"c154141c7422d64c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/scriptConsent.js\":\"234015c45955f73f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/sourceMap.js\":\"dc3211173b2f259e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/useDocumentScripts.js\":\"7ce6a7d0fa3615be\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/index.js\":\"2d4747a527b72440\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/record.js\":\"6473d7487ff2c757\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/recordStore.js\":\"112e4c6589080325\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/responsiveness.js\":\"577b42010fcb933a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/schedule.js\":\"b0a4af86d7fd26df\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/sessionContext.js\":\"8b3fae1fa7f09876\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"cd1343b3895d3186\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f5aff603b44689b4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/actions.js\":\"273ea20f4f95d0d5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/config.js\":\"bfd8e08861a653ed\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/dataExtension.js\":\"5a7a11f8f351cf73\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/effect.js\":\"2902e805c13b0851\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/index.js\":\"be59b5e78235dbc8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/keyCapture.js\":\"67b095e164675915\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/overrideStore.js\":\"facbcab60886ed34\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"5e4cce55060913f5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/HeaderItem.js\":\"91279b440c3b3280\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/LeftSidebar.js\":\"bb7f7d5a416f2cec\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/actions.js\":\"ed666241d83e49f5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/facet.js\":\"f73bd7fdd03f0465\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/index.js\":\"ab64b71791a6a3a6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/shortcuts.js\":\"23aa95d144bef316\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/toggleStore.js\":\"99bfd99ec2b93fa8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/MergePicker.js\":\"5be2d68d51daef53\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/index.js\":\"a818d5661b4d6ab4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/mergeAction.js\":\"40430b52d7b6226a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/strategy.js\":\"1cabc1b1a659e862\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/Button.js\":\"4c042b90754a10b4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"190f434c53812ddc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/defaultItems.js\":\"fac6c29d3f02f277\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/facet.js\":\"2a4998c8b9377c93\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/index.js\":\"adfa5267c57e9cc8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"bd89121bf7120d2f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/actions.js\":\"953cdb4c641c8442\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"1cab3b79075e08c4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9d0cb5dc9aed0e01\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/index.js\":\"b7e31ab4f3ad0185\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/MoveDestinationPicker.js\":\"3c34f5a5c6b162e0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/blockSubtreeMembership.js\":\"82b23ed8fb7dcab5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/contextMenuItem.js\":\"9401c25bca9c8e27\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/index.js\":\"7ef439da84b54e2c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/moveAction.js\":\"4249827c62598036\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/moveBlocks.js\":\"094e3cfeaf846add\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/selectionAfterMove.js\":\"0cf5b42419671b62\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/TutorialBanner.js\":\"88b02fe0a46e4a09\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/action.js\":\"cb4d0eb83ee4869b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/bannerDismissal.js\":\"6f1f673bdd32ec30\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/documents/cheatSheet.js\":\"9010bb5f5cae525f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/index.js\":\"bb3b04736e3971a2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/keys.js\":\"99fb279a073fb55e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/landing.js\":\"124b390363e3b9f1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/outline.js\":\"8581165d8eb1528d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/seed.js\":\"0c37b9a8e2416cbe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/PerfTrendDialog.js\":\"9a11d0cd838c22f5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/analyze.js\":\"0b3ec0f117449735\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/diagnosticsSource.js\":\"f17ddbaeb1eeb78d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/index.js\":\"5ea7fde520c4d343\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/load.js\":\"6cd2ae1ffebae981\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/monitorRun.js\":\"abb77eea502291e1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/schedule.js\":\"0d7399e210e8ed3d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/series.js\":\"0bf4b014def2912e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/store.js\":\"f1f5a8940915ea52\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/trendAction.js\":\"4713c43d44d06859\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/verdict.js\":\"9ea1de1be14cc2ad\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/plain-outliner/clickToEditAction.js\":\"44a990098705215d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/plain-outliner/index.js\":\"4bd51c6c2aafd2a6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/plain-outliner/interactions.js\":\"7b4c2fa36f83dd7d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"c39fd6661e5b803b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/MigrationGate.js\":\"03e4cbd80499ccc6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/MigrationGateDialog.js\":\"dafecbea627b130b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/action.js\":\"53f84b3b45292e6d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/index.js\":\"4c1503cfb0a0f384\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/localRunMessage.js\":\"71989eab99ca706f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/plugin.js\":\"3b581e3886610d9d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/progressReport.js\":\"14125d460b9ea422\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/sweepProgress.js\":\"aa9417cbf8f97df8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/FieldRowRenderer.js\":\"eae5665904ae853d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/ValueRowRenderer.js\":\"dd040759a8b8266b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/actions.js\":\"f926d120edfbc216\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/autocomplete.js\":\"c55028dfc0b6140d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/fieldRow.js\":\"49797f442475a8d3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/index.js\":\"987ffde22a322fd7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/referenceWarning.js\":\"7cf8390242edf5b7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/valueAutocomplete.js\":\"5f38f79244ff20bf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/valueSchema.js\":\"95a7ac5bad79f62c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/HeaderItem.js\":\"a67fa45a01f611bc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/QuickFind.js\":\"0764033602275cd9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/index.js\":\"dfd45a46f132ac16\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/recents.js\":\"ff4fb31cfe04b5a3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/resultItems.js\":\"f9cee375ef3cb079\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/selection.js\":\"8561585f8a3d5437\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/toggleStore.js\":\"c2e4db99786373b5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/HeaderItem.js\":\"644777a9062d3636\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a1267f8351c44c0b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/grouping.js\":\"9be340c2d3843ebd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/index.js\":\"31bb45ef2e9dce28\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/target.js\":\"7f07abcd6580cbf1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/codeMirrorExtensions.js\":\"343e27ce3ba8b112\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/contentPrefill.js\":\"8c733ab446411bb5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/dataExtension.js\":\"70e467834bb1caeb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/index.js\":\"10ea75807897ef4b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a8d6764e7de5b9c8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/invalidation.js\":\"a864a88988848400\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/localSchema.js\":\"9d86f297dd6f5d4c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/blockrefs/index.js\":\"c9e23d2bf2f4f598\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"6d6a887a602aab21\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/index.js\":\"caeb082fd9503f9b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/referenceNode.js\":\"84b13d789c2302de\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/remark-reference-occurrences.js\":\"4934d56a40165095\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"153c2330631047c8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/index.js\":\"0b294b00a7cf7649\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"71c1e281ff292295\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7dbb30994ede6c26\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/mergeRetargetProcessor.js\":\"0f11d655e8376700\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/parseFence.js\":\"6a844a2494c6531c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/referenceParser.js\":\"fbe6b253c258f0f9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/referenceProjection.js\":\"55be423af61261da\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/referencesProcessor.js\":\"2dc168759af2ae5a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/renameProcessor.js\":\"c11ea1ed334bdf37\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/spanReplacement.js\":\"ec887a06dd6e55ad\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/htmlToOutline.js\":\"67a2d73aa4ee3ae0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/index.js\":\"b1582b874a8cb5a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7cfc769e6f438be3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/pasteDecision.js\":\"36db44769fbc2074\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/action.js\":\"6f5e60a0de6d8591\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/blockIds.js\":\"4c6e25d6bae0b593\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/content.js\":\"f28ea06087f8daee\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/effect.js\":\"a89b689fc869cd16\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/ids.js\":\"09f300d2c9dbfdbd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/import.js\":\"5a77e8ac266c8d1a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/index.js\":\"9797acd1ee07cd5c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/plan.js\":\"7f84d45210de94c0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/plugin.js\":\"ae8c75de1c0ecb2f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/promotion.js\":\"a632453bc4611741\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/properties.js\":\"e8c8770216b5be49\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/references.js\":\"77be9853a1d7b66c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/report.js\":\"24c079c881e3c7e7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/roamMemo.js\":\"8cec31b7c78402e6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/runtime.js\":\"8aab6a1fa7b11b8b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/schemaReconciliation.js\":\"6c2fbd7b05ed78bf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/srsMarkers.js\":\"1adebf5dce9051aa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/todo.js\":\"9c94eb5d05972aca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/typeCandidates.js\":\"13d981ab3a258926\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/types.js\":\"fe782de801d3ff52\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/search-health/index.js\":\"66693f43512e26d9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/search-health/store.js\":\"0b4f94e7295fc9e9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/HeaderItem.js\":\"7ffe819a97cf3139\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"10453ea0afd351f4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/index.js\":\"619356b732c9edcd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/model.js\":\"2f99c804eb09a4f6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/toggleStore.js\":\"ceb255ec2473ce14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/useKeyInspector.js\":\"182d3b29f4d9bda6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"a9d6b68748eab444\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/ShellDecorator.js\":\"6a4943b14523e5b2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/actions.js\":\"bffa6abec18b40a4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c9cb962dbfd95dc0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/index.js\":\"86913b92c3a91d0c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/shell.js\":\"31580ff9caea7742\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/surface.js\":\"9bc3d07fe7bba79a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/walker.js\":\"efd10206de650457\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/RescheduleToast.js\":\"a58ac0563d694acc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/dataExtension.js\":\"9704e25d0b143efe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/index.js\":\"72d2759d2380188c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/indicator.js\":\"4764ac6e4b6bbb71\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/moveSrsState.js\":\"59283cc84eae5361\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"9ac1da4704217f62\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/scheduler.js\":\"ca178c865a1c0117\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/schema.js\":\"6aca8966d7f54165\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"67b658d7da763e67\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/srsClipboard.js\":\"924f05db60a7eaf1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2a4e2e127842d98d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7b5c7182d90ba78b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/DeckPicker.js\":\"093f4186516dd262\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/ReviewControls.js\":\"42b3718318f2d0de\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/ReviewDeckRenderer.js\":\"e86ae70f65f46522\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/ReviewSession.js\":\"c38a683bd8e69770\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/actions.js\":\"c5753690777ce014\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/archive.js\":\"4a5a8afc8b45ec01\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/dataExtension.js\":\"3443d2bafc7ec6a0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/deck.js\":\"4195a1767ec63e0a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/dueQuery.js\":\"6b796aa5d874cf02\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/gradeDecision.js\":\"0f86cc1cb0f7f120\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/index.js\":\"25c6ddcde5923d56\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/keyHints.js\":\"e2ab495fe6ed5e12\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/reviewCardLayout.js\":\"f69233991bfd97fe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/reviewProgress.js\":\"e0b2e46cd461ff93\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/schema.js\":\"22b06755af17f1e8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/useDueCards.js\":\"2a1e835ec83454cf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/startup-metrics/index.js\":\"468815f2eb1e4f20\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/startup-metrics/record.js\":\"6d64a7c95f2bb31f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/storage-persistence/index.js\":\"3538b9c70d11bc93\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/storage-persistence/persistenceStatus.js\":\"65c812acb56ae696\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/storage-persistence/requestAction.js\":\"41b0d477e9843e63\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/TypeChipsDecorator.js\":\"cdff3e2b69d67017\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/codeMirrorExtensions.js\":\"46c88f9ee1bd9443\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/index.js\":\"a4cd82f0bd26151f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/typeAutocomplete.js\":\"a78794d32fd5b0a6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"853421647a40dbc8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/actions.js\":\"4d429d199ec5b2a3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/anchor.js\":\"53297f0c0a47795e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/events.js\":\"53a4a34c3cacbe1d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/gestureActions.js\":\"16c18d5f792606da\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/index.js\":\"128e1d8b61c5d497\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c3e39d79fe5105a5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/sync-metrics/collect.js\":\"e381ea30e8464f8d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/sync-metrics/index.js\":\"364ca04e5707cf8f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/sync-metrics/record.js\":\"5b38ca8af4cf2206\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/RejectionDialog.js\":\"e531b15e342fd1e0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/SystemStatusHeaderItem.js\":\"90b8c1386abdd90e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/index.js\":\"e8286424ba5ce388\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/model.js\":\"90cafca105e430ae\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/queueCounts.js\":\"20b310ba1d871cee\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/rejectedHelpers.js\":\"143e38d8033fc774\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/rematerializeAction.js\":\"dbbb255636b2f8c1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/useHysteresis.js\":\"aa7442ec9f115e75\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/ColumnHeaders.js\":\"0a5a24fb06001672\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/QueryUi.js\":\"c6238b275ab3efc4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/TableLayout.js\":\"83359411b26c48fb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/actions.js\":\"d23f34964646fb84\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/cellEdits.js\":\"3019ccc5711b6069\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/childrenViews.js\":\"7b31b9c4aa7bbfa3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/columns.js\":\"4c012e170bbb717f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/controller.js\":\"3e201659e13d3fdb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/convert.js\":\"60fd973914f81fcb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/dataExtension.js\":\"3c80833adced574a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/index.js\":\"6b720f073e3b655a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/keys.js\":\"56e178ab764377d4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/model.js\":\"da44e6cd5855b193\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/QueryText.js\":\"5da916e29e3df429\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/backfill.js\":\"e69e6b5f44d95a5d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/completion.js\":\"a4859aea6d4163be\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/format.js\":\"d251536a145c635f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/parse.js\":\"77a51b05808dcf1c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/queryValue.js\":\"c580b441dda3772e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/registrations.js\":\"4a40c890bfc6281d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/source.js\":\"dcb8bba9ca325d27\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/registry.js\":\"852f00bfc7ecdb08\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/rowGutter.js\":\"72bb296bda35d006\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/rowVerbs.js\":\"04bf3894a140a54a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/schema.js\":\"afa61ad11be818a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/sort.js\":\"41a27ea72d3ee2d9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/theme-toggle/effect.js\":\"b264222f78f55fd8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/theme-toggle/index.js\":\"318a7ce6defa595d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/theme-toggle/theme.js\":\"2c95cec568b7d699\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/actions.js\":\"e793fe3585da2f40\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/dataExtension.js\":\"8636be06548bf4d4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/index.js\":\"73355b9854acf021\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/schema.js\":\"1c2463fcc4d7c447\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/TouchSelectionLayer.js\":\"2e448d4e6ac68461\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/actions.js\":\"c93db239e92ff925\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/defaultItems.js\":\"bbecda7856013b1c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/facet.js\":\"c6e9d2b41b601243\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/holdRecognizer.js\":\"41a96707b53ae556\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/index.js\":\"9fa764d5d133dc52\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/update-indicator/UpdateIndicator.js\":\"805e3f1976c1df46\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/update-indicator/index.js\":\"6c44ddc53aa7ef8a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/update-indicator/loadTimes.js\":\"a5bc2baeefb11fcd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/VideoNotesRenderer.js\":\"560aeb08d0f1ee09\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/VideoPlayerRenderer.js\":\"20f11ceba3b71071\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/VideoTimeStamp.js\":\"c8da154a0ac05778\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/actions.js\":\"ec21255ac0da1752\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/index.js\":\"162b406b77568e2a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/markdown.js\":\"5db3334b1cbf67da\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/notes.js\":\"374890ac7f158479\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/registry.js\":\"03a713be7451280c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/remark-timestamps.js\":\"404889600f3af53e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/view.js\":\"a33e43b468fa4b8f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/LinkHints.js\":\"f632da64e26cc2e4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/index.js\":\"425ad4890875a345\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/model.js\":\"0e29988972e86f97\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/settings.js\":\"6aaf82b0fd66cab4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-normal-mode/actions.js\":\"68752787bd870098\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-normal-mode/index.js\":\"d398dcaf4cf02a41\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-normal-mode/interactions.js\":\"7f07031c2bf1b558\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/workspace-header/index.js\":\"d29b42ebce7925b6\",\"/knowledge-medium/pr-preview/pr-1916/src/registerServiceWorker.js\":\"3d24c422b60f9c0a\",\"/knowledge-medium/pr-preview/pr-1916/src/requestPersistentStorage.js\":\"cef5545c96f4cfdc\",\"/knowledge-medium/pr-preview/pr-1916/src/services/authRequestDeadline.js\":\"e1d626e2072abbd1\",\"/knowledge-medium/pr-preview/pr-1916/src/services/authStorage.js\":\"457785f216850699\",\"/knowledge-medium/pr-preview/pr-1916/src/services/powersync.js\":\"2e04f2f83e7af478\",\"/knowledge-medium/pr-preview/pr-1916/src/services/supabase.js\":\"b4fe5c24248c8027\",\"/knowledge-medium/pr-preview/pr-1916/src/services/uploadErrorClassifier.js\":\"4f593c7c813f3037\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/ActiveContexts.js\":\"439bdd28a8aa553b\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/HotkeyReconciler.js\":\"384d499d64fa3bfa\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/WipeLocalDataDialog.js\":\"ef57f0bbd05c61b3\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/actionDispatch.js\":\"6b525d48ea44c9b6\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/actionRefItems.js\":\"be3293d16db32def\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/applyKeybindingOverrides.js\":\"628d9f4968b555b2\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/blockActions.js\":\"dd772e934d0faeac\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/blockMergeGesture.js\":\"15cd908fbf159a7b\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/canonicalizeChord.js\":\"ec0e7bce5a76702e\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/defaultContexts.js\":\"2c2e5202cb69b0fe\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/defaultShortcuts.js\":\"7c7f51323ffb3a5a\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/effectiveActions.js\":\"2124feba3ff6d4a5\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/gestureAction.js\":\"2156321bd351a9a9\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/gestureBinding.js\":\"2db9f58d772331f1\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/holdRegistry.js\":\"14b70c206a93d22c\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/keybindingConflicts.js\":\"8f3937002777fab9\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/keybindingOverrides.js\":\"4fcc80e2d269b602\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/pointerAction.js\":\"1d0490efc270e962\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/resolve.js\":\"bc34fd732b46febb\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/runAction.js\":\"766feb71b50cfa87\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/sequenceMatcher.js\":\"5c380f1cf701b638\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/types.js\":\"d85b7ccbb7d39780\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/useActionContext.js\":\"0d3a1fa92237a7bc\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/useActionDiscovery.js\":\"4a7b82b06e6ffc72\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/utils.js\":\"5994ae1daf60b687\",\"/knowledge-medium/pr-preview/pr-1916/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1916/src/sw/bootStore.js\":\"0b1e6b0736dffe1b\",\"/knowledge-medium/pr-preview/pr-1916/src/sw/previewDatabases.js\":\"7c2e18c0e292e609\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/byteTransform.js\":\"45547a19a4d7a5e5\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/attachmentCleaner.js\":\"dbcbe14539149ce3\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/attachmentParts.js\":\"458d0b97b188c1dc\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/bundleParts.js\":\"11102310249308f0\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/bundleRecord.js\":\"7043ca4a76716a78\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/manifest.js\":\"15882de2d291fd7b\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/takeBundle.js\":\"543a970259f3820e\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/verifyBundle.js\":\"00e5b8fe4c60667e\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/cleaningStage.js\":\"aee540544fd474a4\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/conversionKey.js\":\"06737224b33c4af1\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/conversionServer.js\":\"8dca5fe9be029db2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/flip.js\":\"96f66d72aa2f3b43\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/flipAttempts.js\":\"15d2acdeaad6b517\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/pages.js\":\"6d11670620746cd8\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/preflight.js\":\"7804b919390bae3f\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/reseal.js\":\"39be476105b3ebbe\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/runConversion.js\":\"2c0901b9cd72859b\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/runLock.js\":\"bd6da1700d569da9\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/sealing.js\":\"5b60d0461d266109\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/sealingStage.js\":\"96a0535ffcf566e4\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/stage.js\":\"803f3a78e6610f37\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/verifyReseal.js\":\"ec310091c1070e30\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/aad.js\":\"0cc99f3bd6956d29\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/aead.js\":\"d0fb64c04cb46e86\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/base32.js\":\"41e91c798e9115bd\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/base64url.js\":\"c161e817a55bee84\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/binaryEnvelope.js\":\"8d3af7ba6faa71e0\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/byteAead.js\":\"993f4ec5cc0aa017\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/canary.js\":\"099bd3ed9a5e6d4b\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/contentHash.js\":\"ffb8f9cd199fb3eb\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/contentKey.js\":\"4775a2e40fc4b77e\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/derivedIdNamespace.js\":\"f0075d297cee757a\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/envelope.js\":\"c8ce24470e02f438\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/hex.js\":\"31c3e962cf7130c3\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/sha256Hex.js\":\"2464229a0cf315a5\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/workspaceKey.js\":\"941403cc19325c22\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/conversionState.js\":\"aaac1110a7c3abcb\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/createEncryptedWorkspace.js\":\"e93897ba4aebb9a2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/pastedKey.js\":\"abcb3fca8eaf2ed6\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"bfa0a5f940d97c0c\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/upgradeWorkspacePin.js\":\"97aff64a95f24d85\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/keyStore.js\":\"4ad79e153785d32c\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/mintWorkspaceKey.js\":\"3635fcf0936a9536\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/modePin.js\":\"a4000cf9f8cb4658\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/openWorkspaceKeys.js\":\"93b4a0cada6edd2b\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/resolveWorkspaceEntry.js\":\"770c26636a617dfe\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/resolver.js\":\"db023f6e1240301d\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/workspaceAccess.js\":\"ad881ff1567ba4c9\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/transform.js\":\"4a02ffb63228b0df\",\"/knowledge-medium/pr-preview/pr-1916/src/themeBootDefaults.js\":\"d107adaac22398ca\",\"/knowledge-medium/pr-preview/pr-1916/src/types.js\":\"5d9f99bea3224197\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/ClientLocalSettings.js\":\"dd3bb0945d5a0c90\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/abortableSleep.js\":\"ae4732983a72004f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/array.js\":\"0e51f1c7f8f83f1f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/backlinkAutocomplete.js\":\"489e8fca11ef9b28\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/blockCrumbs.js\":\"9627da129cc4b765\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/blockrefAutocomplete.js\":\"cb617c89eebc4a1a\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/cadencedIdleJob.js\":\"beb7bbc0d37a1296\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/callbackSet.js\":\"fdcc3b90936f5135\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/clientId.js\":\"51f2e94b494402ff\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/codemirror.js\":\"80da287fd7c5d135\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/codemirrorCompletion.js\":\"ea535e3b8f5c4bd4\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/copy.js\":\"a140d1de5f6c3fbb\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dailyPage.js\":\"cc1b0d6817b26d3c\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dbForensics.js\":\"62d98c57922809bc\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dbForensicsHooks.js\":\"5971ea8c393ef2b2\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/deleteBlockThroughUi.js\":\"32a0b7d505d021cf\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dialogs.js\":\"1c9a95abca39a913\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dom.js\":\"4e16e0374f7e2c87\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/downloadBlob.js\":\"a757ca5a1d650ff0\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/drawnWalk.js\":\"d5a0cefa18b899b3\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/exportSqliteDb.js\":\"4d79b0a496fd5116\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/fileSystemAccess.js\":\"b5bc284235ae04ec\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/flipSlide.js\":\"0477e6f3f08eafa9\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/fnv1a.js\":\"2cd29b1ce9cc4f2f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/formatBytes.js\":\"bc3d1bef150fe6fd\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/fuzzyRank.js\":\"90d0bdf74f7004aa\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/idbKeyedStore.js\":\"e19c2bade20ff65b\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/idleCallbackPolyfill.js\":\"3a86a7bc404772bc\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/keyboardAwareScroll.js\":\"ecab3bff38506378\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/keyboardViewport.js\":\"fb40d822987b834f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/lastWorkspace.js\":\"044d8cf90dcc1dfb\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/layoutColumns.js\":\"eb51a35fd0ad37bc\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/layoutSessionDom.js\":\"90a623a85aa62d09\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/layoutSessionId.js\":\"d4c16fb00363aa6d\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/linkClickGestures.js\":\"75656c1405d9ed1e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/linkTargetAutocomplete.js\":\"407326983a0c85cf\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/localDbCorruption.js\":\"6989cbea9d9acc34\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/localDbRecovery.js\":\"64c4bec2271579a1\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/markdownParser.js\":\"f06cd844df1e8202\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/memoize.js\":\"6c65d8cada5e24ef\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/nameFieldCommit.js\":\"ac0695cb02857d5d\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/nameList.js\":\"2b351649d4fb0403\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/navigation.js\":\"1e7cb5a12e8368d2\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/omnilinerNamespace.js\":\"c9a2b6ceb30432cf\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/opfsPageScan.js\":\"d6f2579dfbec7953\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelClearance.js\":\"0f4b9adc19338ed3\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelHistory.js\":\"360c2c64edff43cc\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelLanes.js\":\"e878674b0c95873a\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelLayoutProjection.js\":\"a10c7b83eed2bfdd\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelScrollAnchor.js\":\"70386395a060a6ec\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelUrlFlags.js\":\"4e91462831591dc8\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/platform.js\":\"3ff89896466b4772\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/pluralize.js\":\"611b76c4c286ac45\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/propertyCreation.js\":\"4a59929c988710ce\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/propertyNavigation.js\":\"46fdcb0a6b6e569e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/propertyValueContext.js\":\"8f69e013d4a18409\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/react.js\":\"dd8aac96c8569e4f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/relativeDate.js\":\"17d1cb44b4086244\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/relativeTime.js\":\"f55ae01631088191\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/renderScope.js\":\"ad6fd90f5a3be3ee\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/resolvedThenable.js\":\"134394c836d17db1\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/routing.js\":\"306fa4296ea6cc38\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/safeMode.js\":\"eb8416aa9c51f930\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/scheduleIdle.js\":\"e8ec5b15b2d972f5\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/screenWakeLock.js\":\"80ad6d2ec72161b2\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/selection.js\":\"83bc15eca0f4525d\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/softKeyboardGrab.js\":\"a0c90a1b1050d811\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/startupTimeline.js\":\"a1ef24926d690548\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/state.js\":\"b8816963c2fc148f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/string.js\":\"1ae46363e27d98e7\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/surfaceZoom.js\":\"da74999a94d35198\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/time.js\":\"643b9937d5da7c05\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/toast.js\":\"fa966d35125e0f9f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/toggleStore.js\":\"ae22ca2581075125\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/untilStopped.js\":\"24960872412a2976\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/userActivity.js\":\"f27d77c5110e0865\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/viewTransition.js\":\"1d185a4f4202fbc0\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/viewport.js\":\"b92b262d7e722524\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/webLock.js\":\"2b20555f22ced765\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/workspaceRecovery.js\":\"f57eeaee1bbf075c\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/workspaceSnapshotStore.js\":\"9f5f8b9cc37569b3\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-compiler-runtime.js\":\"94da835d8ace76c0\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-client.js\":\"63a21f0fbc03e3be\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-server-edge.js\":\"261dff5dc09efc35\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-server.js\":\"ed07c13d1c4c4f4f\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-static-edge.js\":\"19fbecc28f91ffbf\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-static.js\":\"918da8622ea4fa22\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-test-utils.js\":\"c50b2ea5fda24400\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom.js\":\"d6fab9a209cf317c\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-jsx-runtime.js\":\"b925d85efa866e8d\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react.js\":\"f6b2cd52156e349a\",\"/knowledge-medium/pr-preview/pr-1916/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1916/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1916/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
