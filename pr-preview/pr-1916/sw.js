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
		buildId: "4041c29762b2-78e3b54b",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1916/\":\"4d4805e1f355464a\",\"/knowledge-medium/pr-preview/pr-1916/index.html\":\"4d4805e1f355464a\",\"/knowledge-medium/pr-preview/pr-1916/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1916/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1916/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1916/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1916/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1916/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1916/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1916/assets/FacadeVFS-DhdvqaeK.js\":\"74d42663552b527f\",\"/knowledge-medium/pr-preview/pr-1916/assets/OPFSCoopSyncVFS-DQlB3uT3.js\":\"137fb64d93bf9762\",\"/knowledge-medium/pr-preview/pr-1916/assets/OPFSWriteAheadVFS-Cy0lIm8A.js\":\"15162a53640d1879\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-BewiWc-2.js\":\"75a3b930cd66a409\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1916/assets/wa-sqlite-async-E1bnMMK-.js\":\"47c5fcc885f53636\",\"/knowledge-medium/pr-preview/pr-1916/assets/worker-HAfgs7JQ.js\":\"d97ad7e92eed5e02\",\"/knowledge-medium/pr-preview/pr-1916/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1916/chunks/app-CQ6NE-ie.js\":\"dd7c69e6b32d827a\",\"/knowledge-medium/pr-preview/pr-1916/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1916/index.js\":\"041a84d39e67e643\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1916/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1916/assets/AccessHandlePoolVFS-B0vVIb6M.js\":\"41eeae41d24ed199\",\"/knowledge-medium/pr-preview/pr-1916/assets/IDBBatchAtomicVFS-Ci-ZhOtf.js\":\"9dd69fad9412c9e6\",\"/knowledge-medium/pr-preview/pr-1916/assets/MemoryVFS-Bn5jjt2n.js\":\"218f34a81ea1719f\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-DLXF1zOW.js\":\"6e64f63bfea7a3ad\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-async-2W7ep2P9.js\":\"5d2d96b39829449d\",\"/knowledge-medium/pr-preview/pr-1916/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1916/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1916/chunks/AccessHandlePoolVFS-jNPo-jBW.js\":\"5e402d3ed7e174f4\",\"/knowledge-medium/pr-preview/pr-1916/chunks/FacadeVFS-BE7gNDFE.js\":\"15463514ae8da853\",\"/knowledge-medium/pr-preview/pr-1916/chunks/IDBBatchAtomicVFS-pTZ13bUq.js\":\"50a0515745edcf9a\",\"/knowledge-medium/pr-preview/pr-1916/chunks/MemoryVFS-B3kM7yp5.js\":\"59c8e57432b3ce65\",\"/knowledge-medium/pr-preview/pr-1916/chunks/OPFSCoopSyncVFS-B-rHVLyc.js\":\"0f92b497d19c4ce4\",\"/knowledge-medium/pr-preview/pr-1916/chunks/OPFSWriteAheadVFS-D4CWeJdk.js\":\"c301643013ebef02\",\"/knowledge-medium/pr-preview/pr-1916/chunks/Preview-BCqefT49.js\":\"0046d2c9dbac800c\",\"/knowledge-medium/pr-preview/pr-1916/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1916/chunks/card-C4JGDvaZ.js\":\"47ba66313201cf75\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1916/chunks/dist-CKZVM_Cn.js\":\"3c41376f3438e7b4\",\"/knowledge-medium/pr-preview/pr-1916/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1916/chunks/mc-wa-sqlite-Bg-w0mSB.js\":\"5440714520e22321\",\"/knowledge-medium/pr-preview/pr-1916/chunks/mc-wa-sqlite-async-CxqcxlFc.js\":\"bd8a4dc18bdcec3a\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-2l8Mzy2m.js\":\"fad611b71aa6960b\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-B2YfFN9_.js\":\"afe45ef9222ca622\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-BPCI3u8m.js\":\"c9214fc8c9519426\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-ChjL1I4a.js\":\"e9be22e0192d4e4c\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-DEOoRhTl.js\":\"93d4b586da4fcc17\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-Dah2CU-c.js\":\"b48a598870b40a46\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-DcKRdxuA.js\":\"10e7b5ee1f99ef65\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-dom-server-legacy.browser.production-BFh1pi4M.js\":\"8e3dc109d7b87404\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-dom-server.browser.production-B_9PFlXk.js\":\"a159e26e41e45200\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-dom-server.edge.production-CnqtJBbT.js\":\"9860d312a460266f\",\"/knowledge-medium/pr-preview/pr-1916/chunks/react-t7IsPAnA.js\":\"381e22272bbe3acb\",\"/knowledge-medium/pr-preview/pr-1916/chunks/server.browser-C1aS6SQA.js\":\"84c8a7a1c2d3c1f0\",\"/knowledge-medium/pr-preview/pr-1916/chunks/textarea-CkrsBGjn.js\":\"4eff6c807bb6f054\",\"/knowledge-medium/pr-preview/pr-1916/chunks/ui-BidSpdwa.js\":\"2b9c301da2fe77bb\",\"/knowledge-medium/pr-preview/pr-1916/chunks/wa-sqlite-Du-8vtp3.js\":\"506ed1f5841420f0\",\"/knowledge-medium/pr-preview/pr-1916/chunks/wa-sqlite-async-2LqwZ3Fk.js\":\"ea1444ce845050c3\",\"/knowledge-medium/pr-preview/pr-1916/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1916/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1916/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1916/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1916/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1916/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1916/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1916/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1916/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1916/src/App.js\":\"e31aee12841c2778\",\"/knowledge-medium/pr-preview/pr-1916/src/appUpdate.js\":\"9fd0b77884161a8f\",\"/knowledge-medium/pr-preview/pr-1916/src/appVersion.js\":\"55679850650ff1b7\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/initialLayout.js\":\"f39fa47668fae0d0\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/openWorkspaceData.js\":\"7362a90f9e9063ed\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/resolveWorkspace.js\":\"91b1714d73e43d92\",\"/knowledge-medium/pr-preview/pr-1916/src/bootstrap/workspaceBootstrap.js\":\"58f0fe103327ed61\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockComponent.js\":\"a319a93742a9df3d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockCrumbs.js\":\"044896c048119dc4\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockEditor.js\":\"213d718f7431cb93\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockLoadingPlaceholder.js\":\"e2fa652adc064ecb\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockProperties.js\":\"c19e4175863a2a6c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/BlockSearchPicker.js\":\"09f7c3389407496a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ConfirmBulkDeleteDialog.js\":\"f397c7c14a38ffad\",\"/knowledge-medium/pr-preview/pr-1916/src/components/DividerHandle.js\":\"3a09fade4c34a237\",\"/knowledge-medium/pr-preview/pr-1916/src/components/DraftEditor.js\":\"a9e8f877fba8899b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/GutterPill.js\":\"24fcc09f6ab730ac\",\"/knowledge-medium/pr-preview/pr-1916/src/components/Header.js\":\"1c7a0d57c7431794\",\"/knowledge-medium/pr-preview/pr-1916/src/components/LazyBlockComponent.js\":\"356e5487a009437c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/Login.js\":\"0db2402e9cced061\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ZoomableSurface.js\":\"65a81a9191df092c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/editModeKeepalive.js\":\"9f889c2bda31dc3e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyDisplay/PropertyDisplayScope.js\":\"785237dcf71df6a3\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"ea59cced11249521\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/RefPropertyEditor.js\":\"4a95cdc4b288186c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/RefTargetTypePicker.js\":\"9289c12f0cbb7fab\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/SelectPropertyEditor.js\":\"e93b629ed0d1d5de\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/TypesPropertyEditor.js\":\"88e110381220e335\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/defaults.js\":\"b0320ced34d65292\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/kernelValuePresets.js\":\"9f88d5c9df60c2fa\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/selectablePresets.js\":\"1105a371d1e4adb3\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyEditors/typesPropertyUi.js\":\"062b4dbaf531df5a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/AddPropertyForm.js\":\"eed85db3af277d54\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/PropertyPicker.js\":\"b926f85db961b309\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/PropertyRow.js\":\"f398e5ed1e275029\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/Rows.js\":\"8c52f5ea64e0667d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/actions.js\":\"4b974bf5e635640d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/declarationOnly.js\":\"5e5c91746402c835\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/layout.js\":\"85f18505bba90636\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/model.js\":\"7bd1c4036a9a2110\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/shapeUi.js\":\"b6ed6ff6a4abcafd\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/shapes.js\":\"38ba14d3d940b53e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0d7c2f91a0d180ba\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanel/visibility.js\":\"f783cf46e98f1a28\",\"/knowledge-medium/pr-preview/pr-1916/src/components/propertyPanelSections.js\":\"018e8c1bdeaa9635\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/BlockEmbed.js\":\"8aeeff1170f0fecc\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/BlockLink.js\":\"af3593e40cc0b576\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/BlockRef.js\":\"a946b12d73c8b144\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/CompactReferenceLink.js\":\"b67b569d3aee3bdd\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/ReferenceLink.js\":\"e0a22b83d783ccd7\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/cycleGuard.js\":\"5bc62dbdd1f9d146\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/cycleGuardContext.js\":\"29d5ec8e11710212\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/linkInteraction.js\":\"b10cbd2442fafe07\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/referenceLayout.js\":\"7ab5a9d56e654a14\",\"/knowledge-medium/pr-preview/pr-1916/src/components/references/useBlockRefAncestors.js\":\"ea918ee1ecb4cb76\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockGutter.js\":\"31a1aa7e72996b5b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockInfoDialog.js\":\"93db424fd1b875cd\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockReadText.js\":\"cbfb7d12bbfc32f1\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BlockTypeBlockRenderer.js\":\"965a2c0bf4ce7c7e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/BulletHoverCard.js\":\"692d19e57c901c66\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/CodeMirrorContentRenderer.js\":\"85d52016af8a6bc9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"02dd6a824fa91df6\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/ColumnResizeHandles.js\":\"783448b90dd44257\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"96324c4628268a27\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/DefaultBlockRenderer.js\":\"b0b3705aaf7e185c\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/LayoutRenderer.js\":\"16f5472ad4dcdce0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/MarkdownContentRenderer.js\":\"5f72550f48800573\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/MissingDataRenderer.js\":\"a101b2ff7cebca5f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/PanelRenderer.js\":\"673a094878168aee\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/PropertySchemaBlockRenderer.js\":\"b383c1a4cf5ff59b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/TopLevelRenderer.js\":\"85a7af8f7b63832b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/blockGutterMode.js\":\"f47fb2aed6dfebc0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/blockTitleText.js\":\"08065d0b5dbb5a0f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/fieldCreationKeydown.js\":\"4710bf7d661f6040\",\"/knowledge-medium/pr-preview/pr-1916/src/components/renderer/layoutRootContext.js\":\"de56956cc73a1fb9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/typeChip/TypeChip.js\":\"6cd192f1ba6078a2\",\"/knowledge-medium/pr-preview/pr-1916/src/components/typeChip/chipStyle.js\":\"2dcac00f1454af41\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/anchored-floating.js\":\"e715fa7ce52d986a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/button.js\":\"86041d2e84b919ad\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/card.js\":\"627796cbc013007f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/checkbox.js\":\"53223b3c547f81f0\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/collapsible.js\":\"77001e46fab56085\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/command.js\":\"eed8f759c5de01a5\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/context-menu.js\":\"398c787ab043d87b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/dialog.js\":\"c0c7de09208d89eb\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/dropdown-menu.js\":\"aca2cb952f33a297\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/floating-listbox.js\":\"b2fa11c8112aa498\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/index.js\":\"e6519a202a49390d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/input.js\":\"118fee1ba39b19b1\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/kbd.js\":\"e2ee84855b2983ef\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/label.js\":\"8a0a4488c92bfffe\",\"/knowledge-medium/pr-preview/pr-1916/src/components/ui/textarea.js\":\"cd6fe54b4d5ca677\",\"/knowledge-medium/pr-preview/pr-1916/src/components/useEditModeYieldKeepalive.js\":\"b6698d52383cf6ad\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/BootFallback.js\":\"3f5ee691834cc12f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/FocusedRowLazyMount.js\":\"2496644115c1a0c3\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/LazyViewportMount.js\":\"8c9948162c1ddd50\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/LocalDbCorruptionFallback.js\":\"a1a14910b4a8ec1f\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/error.js\":\"8da0fb7f160b0e20\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/lazyMountRegistry.js\":\"ae2835f3397b41b9\",\"/knowledge-medium/pr-preview/pr-1916/src/components/util/suspense.js\":\"ffa15b9564162537\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/CreateWorkspaceDialog.js\":\"1c4dd82e1fba381d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/PendingInvitations.js\":\"e8b2607bc7a75b0e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/SyncProgress.js\":\"f9fe556638a99a33\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/UnlockProgress.js\":\"e2a87ffb77e8f3ee\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceKeyGate.js\":\"1e40f0e44064bc2d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceSettingsDialog.js\":\"4c4773dbd9622f51\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceSwitcher.js\":\"c018d31f3abf322b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/WorkspaceSyncGate.js\":\"1dbbccad42f2b02a\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/ConversionFlow.js\":\"34677c25fb0113b2\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/ConversionFlowHost.js\":\"e47f000a5308d767\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/EncryptionSection.js\":\"20d8a36a858e591e\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/attachmentPrompts.js\":\"b1e62a04debf9622\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/bundleFolderPrompts.js\":\"bc96465c34c61327\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/conversionFlowDeps.js\":\"a9f4668364592d3d\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/conversionFlowStore.js\":\"b266be1b3d328ff2\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/flowUi.js\":\"291b548ce6fb3199\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/conversion/useConversionRun.js\":\"75773253a0df2084\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/keyUi.js\":\"a99167da4adebefe\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/useCloseOnKeyLoss.js\":\"ee1c073e7929ff27\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/useCloseOnServerE2ee.js\":\"f30d5d054e89a90b\",\"/knowledge-medium/pr-preview/pr-1916/src/components/workspace/workspaceUnlocked.js\":\"9f2dc2db6526ccae\",\"/knowledge-medium/pr-preview/pr-1916/src/context/backgroundSubtree.js\":\"666be386ca6671eb\",\"/knowledge-medium/pr-preview/pr-1916/src/context/block.js\":\"1c2dd64addc53232\",\"/knowledge-medium/pr-preview/pr-1916/src/context/layoutWsContext.js\":\"6177dee9e95336ed\",\"/knowledge-medium/pr-preview/pr-1916/src/context/propertyDisplay.js\":\"a75a8ba69c595dc6\",\"/knowledge-medium/pr-preview/pr-1916/src/context/repo.js\":\"ef5d1e8f853fd09d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/aliasClaim.js\":\"6a4bd7dba9494453\",\"/knowledge-medium/pr-preview/pr-1916/src/data/aliasSeatNamespace.js\":\"cdb2ccd8bcdee0ab\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/blockData.js\":\"977d504da300498c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/blockType.js\":\"6c97a66eb9a3e3d7\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/changeScope.js\":\"507c0da4905c73a7\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/codecs.js\":\"cee6eda71e590166\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/derivedData.js\":\"61556837b8df5b10\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/errors.js\":\"ab1bb9e2e0ff2cd8\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/events.js\":\"f38a9c15d8a35bbf\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/handle.js\":\"649b7a52775530a9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/index.js\":\"1ad54a090e558942\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/mutator.js\":\"16935d6452e5c021\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/processor.js\":\"fbb429b8d69b7878\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/propertySchema.js\":\"67d441839ddf24b3\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/query.js\":\"4c4abe7c0148b5b9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/sameTxProcessor.js\":\"7a225592011e6351\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/schema.js\":\"649b7a52775530a9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/tx.js\":\"649b7a52775530a9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/typedBlockQuery.js\":\"3e9c82e77fa32f66\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/user.js\":\"999540534d44bb52\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/valuePresetCore.js\":\"0a0940e4037cd438\",\"/knowledge-medium/pr-preview/pr-1916/src/data/api/valuePresets.js\":\"2bf3b54e20bf660d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/attachmentCleanerIOVerb.js\":\"1283b1a05c7fcc0b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/block.js\":\"65b982c9d452db6e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockCache.js\":\"85037daf5fd7fc62\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockId.js\":\"6005bde7d45c5902\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockLiveness.js\":\"018183e9503d05fc\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockMerge.js\":\"cf6ca189af4fe939\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockSchema.js\":\"2bed639014e5dc02\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockTypeLookup.js\":\"deaa63d7df8fe393\",\"/knowledge-medium/pr-preview/pr-1916/src/data/blockTypes.js\":\"786c37df4e011ec6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/childrenView.js\":\"a9e84d4da9c9beab\",\"/knowledge-medium/pr-preview/pr-1916/src/data/clientContext.js\":\"4fabab2bcbb3e42e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/dbFileSiblings.js\":\"df108a7c69f93849\",\"/knowledge-medium/pr-preview/pr-1916/src/data/definitionSeeds.js\":\"9b179cbb5333b72b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/derivedIds.js\":\"094d9e98e7014863\",\"/knowledge-medium/pr-preview/pr-1916/src/data/drawnSubtree.js\":\"688a6a73e0eedc73\",\"/knowledge-medium/pr-preview/pr-1916/src/data/facetBridge.js\":\"19c986ef76438d6f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/facets.js\":\"04cf4d4d04c3983b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/globalState.js\":\"b1d1ebec76de6ddd\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/aliasClaimRederiveProcessor.js\":\"d59ab6d5d8b73a1b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/ancestorBatch.js\":\"850a9055aa881c6b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/blockTypeTypeifyProcessor.js\":\"778ef6d5e42b04c5\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/clientSchema.js\":\"b4518ef8410de883\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/commitPipeline.js\":\"889da978faca8562\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/devAssertions.js\":\"d8eb1e210be95885\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/firstSync.js\":\"b94090a1575d69ea\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/freshInitialLoad.js\":\"8a49d70b75de0ac6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/graphBackfillClaim.js\":\"7d3e120f08974242\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/handleStore.js\":\"83211df2d3b31293\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/idleMarkerJobs.js\":\"dc2a3485cd9ef431\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/initialDownload.js\":\"2b66fddcc2046543\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/initializeClientDatabase.js\":\"d3d616cdb9ed183f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/jsonCanonical.js\":\"3c76dd2632c37bd4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/kernelInvalidation.js\":\"8730233479bbb76c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/kernelProcessors.js\":\"5555af877586361b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/kernelQueries.js\":\"16fa47770e364f27\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/mergeTypeMembershipProcessor.js\":\"1a15beb1622d2462\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/normalizeReferencesProcessor.js\":\"764c1a815d2b18eb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/poolInstrumentation.js\":\"4f1289aec9f15c9b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/processorRunner.js\":\"535a28f19e1dd727\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyCellBackfill.js\":\"c64a6d4b902cea29\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyChildMint.js\":\"306587d623940eeb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyChildrenProcessor.js\":\"d2b1b87e09fc54bc\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyDefinitionChangeProcessor.js\":\"21e03e35d302f521\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyDefinitionSynthesis.js\":\"bed6a65e2ab2d60e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyKeyScan.js\":\"6b3e9e56b5600059\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertySchemaResolution.js\":\"207b7d61203a1041\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/propertyValueEdits.js\":\"fe5510ff977c2959\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/raiseProtocol.js\":\"e81da3ec667e9b60\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/readBatch.js\":\"9929d7cac5426740\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/refProjection.js\":\"8c84254839d9646a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/referenceTargetLookups.js\":\"b328125697f91756\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/referenceTargetProcessor.js\":\"d5bb871efaf528d0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/replayMerge.js\":\"31185b54cb2caae9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/sqlBinds.js\":\"a719a4b4d6392c9d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"e25f55fd6f94c9f2\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/arrivalProcessors.js\":\"4d1ad90f15005bdb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/invalidate.js\":\"42e514f1d57a246d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/materialize.js\":\"2a946a2fc3e6da97\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/observer.js\":\"44f5cb36699bf5ea\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/syncObserver/reconcile.js\":\"50b2530ce54ff9f3\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/timingMetrics.js\":\"0af85217fa2e3172\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/treeQueries.js\":\"5b32f6134de7687a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/txEngine.js\":\"e8f599bb166203fb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/txSnapshots.js\":\"0824cd983a9b5333\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/typedBlockQuery.js\":\"c788a4a1a69ce136\",\"/knowledge-medium/pr-preview/pr-1916/src/data/internals/undoManager.js\":\"a694a73a205d492a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/invalidation.js\":\"c6cd6d8eaadbefce\",\"/knowledge-medium/pr-preview/pr-1916/src/data/kernelDataExtension.js\":\"553adab8d7248f1e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/kernelPage.js\":\"b755c2e11eaea84f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/kernelValuePresetCores.js\":\"56a7b1cda4ab4124\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localDbCorruptionSignal.js\":\"79771b5ba5ac6041\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localDbStorage.js\":\"c9fbab20edae4848\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localDbVfs.js\":\"80e5a1bd33223299\",\"/knowledge-medium/pr-preview/pr-1916/src/data/localSchema.js\":\"2ef44543be2c71e1\",\"/knowledge-medium/pr-preview/pr-1916/src/data/maintenance.js\":\"ae501b0e266e9cc6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/mergeProperties.js\":\"67ffcb1b0d416fe3\",\"/knowledge-medium/pr-preview/pr-1916/src/data/metricsConsoleHook.js\":\"828c18eea10417fb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/migrationsPage.js\":\"6388346e338d73eb\",\"/knowledge-medium/pr-preview/pr-1916/src/data/mutators.js\":\"042fc9d1c7076dae\",\"/knowledge-medium/pr-preview/pr-1916/src/data/orderKey.js\":\"10bff77f10534de0\",\"/knowledge-medium/pr-preview/pr-1916/src/data/orderKeyPlacement.js\":\"106c1f3e1a2a1af2\",\"/knowledge-medium/pr-preview/pr-1916/src/data/outlineSurface.js\":\"975c44245dbff156\",\"/knowledge-medium/pr-preview/pr-1916/src/data/pendingEditorContent.js\":\"f7cfee5be9309c8a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/pendingUploadsSql.js\":\"8127d6f2b46cb439\",\"/knowledge-medium/pr-preview/pr-1916/src/data/pluginStateExtensions.js\":\"91dba3c4e3338362\",\"/knowledge-medium/pr-preview/pr-1916/src/data/powerSyncLogger.js\":\"2ef21510384678b8\",\"/knowledge-medium/pr-preview/pr-1916/src/data/projectorRuntime.js\":\"f72a94be71b331d4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/properties.js\":\"3460c3060a0345f7\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertiesPage.js\":\"876ced00cf99f922\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyChildren.js\":\"421b37c48e7d823b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDefinitionFanout.js\":\"a20aaecd08dc6071\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDefinitionMetadata.js\":\"1d09f505306e2787\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDefinitionRegistry.js\":\"08624e828139c0b8\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyDisplayMode.js\":\"410ab113129cf063\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertyRowCreation.js\":\"6b21a974d5aef7b1\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertySchemaCreation.js\":\"2b518bf1b33f24d6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/propertySeeds.js\":\"6b3f0bc481ef1e81\",\"/knowledge-medium/pr-preview/pr-1916/src/data/recentsPage.js\":\"fc08fc75113d90fc\",\"/knowledge-medium/pr-preview/pr-1916/src/data/refTargetComparableProperty.js\":\"ae7be4ae95c82ad4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/referenceBlock.js\":\"d34a3453d6fbff9e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/rejectedUploads.js\":\"e1971d29acf6f280\",\"/knowledge-medium/pr-preview/pr-1916/src/data/releasePowerSyncConnection.js\":\"871cd0602cd5903d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/repo.js\":\"94fef3cc557ea628\",\"/knowledge-medium/pr-preview/pr-1916/src/data/repoProvider.js\":\"bde2ac3af8a58f6b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/rowProperty.js\":\"f4629ced62b402f2\",\"/knowledge-medium/pr-preview/pr-1916/src/data/searchFilter.js\":\"c68ba500bd05a90d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/seedIdentityLedger.js\":\"0919504a7cae24ae\",\"/knowledge-medium/pr-preview/pr-1916/src/data/stateBlocks.js\":\"8c5b8c3b8c61c0d9\",\"/knowledge-medium/pr-preview/pr-1916/src/data/structuralEditPolicy.js\":\"e9e7cab2d8917c0e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/structuralInsert.js\":\"1b6b49d9eff86161\",\"/knowledge-medium/pr-preview/pr-1916/src/data/subtreeDelete.js\":\"46036a3b75359731\",\"/knowledge-medium/pr-preview/pr-1916/src/data/syncStreamLock.js\":\"e7b54d0a9becce73\",\"/knowledge-medium/pr-preview/pr-1916/src/data/syncedTableSqlRecognizer.js\":\"0339908f1e031db2\",\"/knowledge-medium/pr-preview/pr-1916/src/data/syncedTableWriteGuard.js\":\"1669e681168124ba\",\"/knowledge-medium/pr-preview/pr-1916/src/data/targets.js\":\"9636b10d2c0bd65e\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeColors.js\":\"bb2627b06b836345\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeDefinitionMetadata.js\":\"cf4c5945b4f0af0d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeDefinitionRegistry.js\":\"9f6fd3f165c5fda4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeExtraction.js\":\"d72b1e7c5d80669c\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeInitialValues.js\":\"cbfc196fafed8445\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typePropertyGroups.js\":\"23720e9ebd2ecfb4\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeSeeds.js\":\"c3c5852b2febe172\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typeTagger.js\":\"c1791aad0ed3f289\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typedRecords.js\":\"aba76c6afc7f362a\",\"/knowledge-medium/pr-preview/pr-1916/src/data/typesPage.js\":\"e1e81432f3e3c1b7\",\"/knowledge-medium/pr-preview/pr-1916/src/data/userPrefs.js\":\"0ce94b12b1ef751f\",\"/knowledge-medium/pr-preview/pr-1916/src/data/userSchemasService.js\":\"e9c2e33d655310b3\",\"/knowledge-medium/pr-preview/pr-1916/src/data/userTypesService.js\":\"f5b43033aa4cb3a6\",\"/knowledge-medium/pr-preview/pr-1916/src/data/valuePresetRegistry.js\":\"e06c86e534b97073\",\"/knowledge-medium/pr-preview/pr-1916/src/data/visibleChildren.js\":\"593f62e1ea30a57d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceConversion.js\":\"7e419f45b89f97e5\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceFirstSync.js\":\"c687381bd32b229b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceIdNamespace.js\":\"2fe998c128c5f73d\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaceSchema.js\":\"62d58c7db188ab54\",\"/knowledge-medium/pr-preview/pr-1916/src/data/workspaces.js\":\"5726d1a13db9bd4b\",\"/knowledge-medium/pr-preview/pr-1916/src/data/writeAheadLog.js\":\"b65a51afdab0e278\",\"/knowledge-medium/pr-preview/pr-1916/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/BlockPasteShellDecorator.js\":\"1cfba904401162e4\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/atTrigger.js\":\"c1bf805a877db8a6\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/autocomplete.js\":\"dcd69cbb162c25a2\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/codeMirrorExtensions.js\":\"89dd9840402f317f\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/contentFlush.js\":\"24d0a8815931f8bd\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/defaultInteractions.js\":\"a291db160b16b722\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/editSettleSignal.js\":\"5904e0a58a772415\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/insertImage.js\":\"383dd4684c921e14\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/referenceCompletionRange.js\":\"21aaae4515580c33\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/referenceTargetTypes.js\":\"d66f38cafd598887\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/syntaxContext.js\":\"98dc7b07ed7a2089\",\"/knowledge-medium/pr-preview/pr-1916/src/editor/triggerMatch.js\":\"94cf0ba644d495d9\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/AppRuntimeProvider.js\":\"d798a6569b90eb56\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/BlockFocusShellDecorator.js\":\"430dd6cbef53b57b\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/ExtensionRenderBoundary.js\":\"e6fe3990eca698a6\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/PanelContentRecovery.js\":\"c7d69b5125fd2885\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/apiCatalog.js\":\"0054c45316f598c8\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/approveExtensionHere.js\":\"441421017ea282e0\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/armedCutAppMount.js\":\"aa6e3938e983fbdd\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/batchableKeyedStore.js\":\"a840ef7ff8f1f1f7\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/blockInteraction.js\":\"f25a677ef8e0605d\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/blockSelectionAction.js\":\"3bf6cb6f6f8df97b\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/compileExtensionModule.js\":\"e99c66edd44998cc\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/compiledModuleCache.js\":\"b5eca6cc86f75dd1\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/continuousGestures.js\":\"ebaa1cf6de554e4e\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/core.js\":\"92998db2f2561da4\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/defaultRenderers.js\":\"44af35abb87dd2b0\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/definitionFanoutAppMount.js\":\"0c8d9dcf0d9f62f9\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/dialogAppMount.js\":\"8f26f8ead5c789a9\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/dynamicExtensionSeeds.js\":\"e6e2cf4ecf69697e\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/dynamicExtensions.js\":\"66ef35bc67f16166\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/exampleExtensions.js\":\"9490c400e7599b99\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionApprovalStatus.js\":\"320f5f577a3e5db6\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionLoadErrorToast.js\":\"8c8f016ecbbc8af5\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionLoadErrors.js\":\"682fe6acf891bf31\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionLookup.js\":\"6a6cf46bd448e2de\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionToggles.js\":\"9d0930d1cc184353\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/extensionUtilitiesCss.js\":\"8fc07caa47e39e51\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/kernelPageDeletionGuard.js\":\"54f2947281d42b13\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/liveRuntime.js\":\"d170f7455e785255\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/openExtensionsSettings.js\":\"b7718657834d239c\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/overridesCache.js\":\"562a7645d56181ee\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/pluginIds.js\":\"597873c5ff0b1cbf\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/processorRejectionToast.js\":\"71e6ca80221c4158\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/runtimeActions.js\":\"00471d335a6eb673\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/runtimeContext.js\":\"48ec0219b9c6476b\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/staticAppExtensions.js\":\"b52cde631dbdd758\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/staticDataExtensions.js\":\"c3726f138531a4c1\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/toastAppMount.js\":\"160decd9434045d7\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/useOverrides.js\":\"61a9be4c3cf2dc11\",\"/knowledge-medium/pr-preview/pr-1916/src/extensions/useShortcutSurfaceActivations.js\":\"8230c29dc5596e19\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/discoverToggleTree.js\":\"1769360791348947\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/facet.js\":\"4ee74fea0f0e1764\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/resolveAppRuntime.js\":\"86b294d10bf5943f\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/runtimeEvents.js\":\"81100c6b88e2f868\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/togglable.js\":\"31e5db9bf16c1055\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/variantFacet.js\":\"e79462812cb3cd9f\",\"/knowledge-medium/pr-preview/pr-1916/src/facets/verbFacet.js\":\"9245ce7f3fc96314\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/block.js\":\"5587ed51339e738c\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/focusedChild.js\":\"af35b8f9558d2017\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/propertySchemas.js\":\"4b67b626b792491d\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/typeRegistry.js\":\"667585d575a5f57b\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useAncestorCrumbs.js\":\"749db98543f941e9\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useAutocompleteListbox.js\":\"1f0daf39dc614354\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useDebouncedSearch.js\":\"ee2df94cd8482ff6\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useDebouncedValue.js\":\"b7bb5ec275d26479\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useFacetValue.js\":\"b6611da08e575c13\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useIsFocalRender.js\":\"7cd3f8929b53c905\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useIsReadOnly.js\":\"ef9dedbfbc9ea8df\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useMaterializeBacklog.js\":\"5241ab9f41da7a01\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useMinuteClock.js\":\"ca1bcbf8fe34ee1e\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/usePanelLayoutProjection.js\":\"391e4be4d89825ef\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/usePendingInvitations.js\":\"6371a5bdcb852a23\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useRendererRegistry.js\":\"9491aa283567851d\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useRetainedFieldRows.js\":\"8bde7b4681de8f3e\",\"/knowledge-medium/pr-preview/pr-1916/src/hooks/useWorkspaces.js\":\"52b8aa2b8bb83b4b\",\"/knowledge-medium/pr-preview/pr-1916/src/lib/utils.js\":\"58e114488c0c7e65\",\"/knowledge-medium/pr-preview/pr-1916/src/main.js\":\"37ce18b44d8d8b76\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/MarkdownImage.js\":\"597b2fc87db58bce\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/blockSeparators.js\":\"044a112159584566\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/context.js\":\"916e8cbc80efc41d\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/defaultMarkdownExtension.js\":\"0c32e72edef7e9bc\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/extensions.js\":\"43052d733a086f6f\",\"/knowledge-medium/pr-preview/pr-1916/src/markdown/renderMarkdownHtml.js\":\"d013f6d74ae0ac9b\",\"/knowledge-medium/pr-preview/pr-1916/src/minimal-editor.js\":\"706a2dea3773d1a2\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/armedCut.js\":\"b5af7c1dfd28faa9\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/captureMediaVerb.js\":\"d73ce6b109119dca\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/clipboard.js\":\"339758796c4b35e2\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/decision.js\":\"98b0fdec0e729a17\",\"/knowledge-medium/pr-preview/pr-1916/src/paste/operations.js\":\"40dd43b2bd7df705\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/account-header/AccountHeaderItem.js\":\"fa75779957bd08bc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/account-header/index.js\":\"56a9577c109230f3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"94612bd6d8a9a7b9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/askAgent.js\":\"cedfc54783d936ec\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/askedStore.js\":\"efdbce6cd68051aa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"95cd422f0ded9fc4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/chipState.js\":\"504750eeedf950c6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4af148ccd3f809cd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/index.js\":\"717cd103888e04f1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"35e1d03373af2bc1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-dispatch-companion/schema.js\":\"dee2c26db1455d66\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/AgentTokensDialog.js\":\"87ed357b34e324d8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/BridgePairingDialog.js\":\"9a58dd32153abbea\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/addMedia.js\":\"20d5bc5ac2b3d38a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/backlinks.js\":\"24d42f14f145b9c2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/block.js\":\"9aa1bd787ec668c8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/context.js\":\"8ddde152409b5994\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/displayIds.js\":\"826ba1b267523bd1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/index.js\":\"d7ff181d4c487d30\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/outline.js\":\"9aa5ce437b2da7db\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/properties.js\":\"b58e5f30ed3743fa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/refs.js\":\"9d99e0eccba4ad1e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"f91427d5c65ac479\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/search.js\":\"6c78821a2de41ce7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/shared.js\":\"ed2eeddea6c3b66b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6e52c3dc88ebbcd8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentViews/text.js\":\"74e09831b0230c97\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/agentWrites.js\":\"a9a19b42e7a6d43f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/authoringCatalog.js\":\"e72c4be6ebe6fa25\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/blockRefTargets.js\":\"f930368d15984a61\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/bridge.js\":\"b36ae1428d02b179\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/bridgeLoop.js\":\"93b065c28f9628e6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/changeHistory.js\":\"d0a118e514b5385b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/commands.js\":\"48f32f5332d22c91\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/commentsCommands.js\":\"572d544e5be5f28f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/dataExtension.js\":\"ed64dca5f486d1b3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/dataModelGuide.js\":\"1ef88fe777c8e1aa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/dayPropertyInputs.js\":\"50c2c25417bb9223\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/describeRuntime.js\":\"769baf7764d832af\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/extensionLint.js\":\"a6b59e51f34c057e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/grainAudit.js\":\"93cfe322ffacffcc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/healthCommand.js\":\"334640c79e61695c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/index.js\":\"c643b67897c77360\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/presetIdentity.js\":\"88600b9ab2b66c67\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3a478adaa770cf27\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/readMedia.js\":\"ae3bbbe6083a87a4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/schema.js\":\"1973fdea00b607a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/serialization.js\":\"9a7a3a17ee8cc69c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/targets.js\":\"24b30b2231a043fc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/tokens.js\":\"5f9bbfe23cbf2166\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/watchEvents.js\":\"4a4f02fa0b0d389c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/workspaceGuard.js\":\"e0100f1946288017\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/agent-runtime/writeCommands.js\":\"15759fe860ede4e2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/AliasCollisionToast.js\":\"ad5aa47fb681e875\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/DuplicateNameBanner.js\":\"1e172dfe0eb67be1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/collisionMerge.js\":\"709337a3532c06a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/dataExtension.js\":\"d0ba00bfb495dc3f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/index.js\":\"5e29d3f4e672c302\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/mergeCollisionAction.js\":\"39ffcd08af1bfd36\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/pageStyling.js\":\"4191fa3499b68d0f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/rejectionToast.js\":\"25a98056d2969d85\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/alias/syncProcessor.js\":\"fca02e12a2b329de\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/actions.js\":\"1dab6f73ba328fa0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/addComment.js\":\"b436a4951203e05d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/anchor.js\":\"62fe50094f24b7da\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/anchorState.js\":\"5e7e518920ece164\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/commentLinks.js\":\"feeb1b259f6c108e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/confirmThreadDeletion.js\":\"e47932255fc67cd3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/container.js\":\"d5749bb5d6a3dc0f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/dataExtension.js\":\"51cb0d4835ae1df0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/deleteComment.js\":\"259031e5a3fdd123\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/highlights.js\":\"01a37b3143ba0487\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/index.js\":\"0e5364067dee498d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/linkedCommentsPill.js\":\"cbb475ac8eb90f76\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/margin.js\":\"8ef41e3d457a0b69\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/marginAnchorLinks.js\":\"bd9f0e37bb2df1bc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/marginSchema.js\":\"6a3ff1f42abf986e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/newComment.js\":\"0d07b818c84598d1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/ownThreadPicker.js\":\"dac85276633650bc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/placement.js\":\"90c588e76ecc74c6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/queries.js\":\"0fa5213fa3943930\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/quotePosition.js\":\"4af4e25273b95495\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/quotedIn.js\":\"92da4b4ccbb32b82\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/quotedRange.js\":\"f9f5731f104a1724\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/rangeRefs.js\":\"fc196e4a4dd7aeaa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/readHighlights.js\":\"18d252cfa6ec4a3e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/readSelection.js\":\"276785fb2d74ff3c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/readSelectionUi.js\":\"aee6517817f033e0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/reanchor.js\":\"bed40e6d7dbb76b4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/schema.js\":\"0041d4400889d2d0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/scope.js\":\"0ac4e3a5571e9f71\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/scopeThreads.js\":\"0072767f6e1ac836\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/splitRetarget.js\":\"4f94b24e36c5dfed\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/suggestionCard.js\":\"06b51b8a858c8acb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/suggestions.js\":\"8e2536220aff81b2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/summaries.js\":\"5d865bcf1c5886f7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/summaryBatch.js\":\"3ee03fe3e847a30d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/surface.js\":\"6fa133e9d6fbd9c9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/threadNavigation.js\":\"3e5a5e5a84319407\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/threads.js\":\"848f53be9f06f1d6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/ui.js\":\"4ad9cad8b3c575fb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/annotations/uiStore.js\":\"967eb8f4ee165ee1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-intents/appIntents.js\":\"c21757fbcc660b06\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-intents/index.js\":\"bd369f6beb7e9ee1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-update-prompt/index.js\":\"d174193d24e44413\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/app-update-prompt/status.js\":\"fb224a8fbba98add\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a546819e5461eb0f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/MediaBlockRenderer.js\":\"37ca53feff82abbd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/MediaDownLaneReplicator.js\":\"39f1b01690a18494\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/MediaUploadReconciler.js\":\"3fe4786d00c20675\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/assetDownLane.js\":\"2e4a4937c3de8955\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/assetResolver.js\":\"25a685507394d05b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/assetUpload.js\":\"b22494ab562e5c30\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/attachmentCleanerIO.js\":\"8ea5c8acdc14800f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/supabaseAuditIO.js\":\"831044f60e73b1aa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/blobStore.js\":\"99b5c88ef8c577b9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/browserMedia.js\":\"1567586b2d94d1f9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/byteStore.js\":\"8e5f3d31f29f7ee8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/cleanerIO.js\":\"2fe4adada719434d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/cleanupAttachments.js\":\"617011e7f8b2ccac\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/dataExtension.js\":\"50ccff79db838fc3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/downLane.js\":\"f1cdc817556c5b6e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/index.js\":\"b1d9b3163d6ae0f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/insertImageContribution.js\":\"3f2f04edcfe2dcd8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/laneArming.js\":\"bd74ecf47c16ddd6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/laneLock.js\":\"262c4ab9f8fed1a2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaBlock.js\":\"3ebc81d48e4bf7d8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaCapture.js\":\"1e940a2d2f43cf45\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaLanes.js\":\"90dbb899cd9f79e8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaViewers.js\":\"b92077b760bf1a13\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/mediaViewersFacet.js\":\"a801f81cbb2e35f0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/pasteCapture.js\":\"c9a8246022166e0f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/resolver.js\":\"e634e36f80f724ca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/retryUploadsAction.js\":\"bc17dbe646a65328\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/storagePaths.js\":\"5de38dd48a29b049\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadDrain.js\":\"89fb241617685908\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadLaneStatus.js\":\"fd34c5e679ec97c3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadReconcile.js\":\"4405f623dd8bc52e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadRecovery.js\":\"4284ccb72397bcd7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/uploadStore.js\":\"b1ba1e7494ee8dc2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/attachments/useAssetObjectUrl.js\":\"0817f2ef42c84232\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5db555ae67e951fa\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/BacklinksViewSection.js\":\"9187ae004083194e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/facet.js\":\"5bdadd43b6a26a16\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/index.js\":\"aad1c80643008205\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks-view/prop.js\":\"fb2b6bf7021ff5a4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/BacklinkFilters.js\":\"23c418891289cbd0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"028b1c02b5adc2e1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/BlockEntry.js\":\"1a5a5152e12e2bc7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/LinkedReferences.js\":\"5f8274bfede1c00a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"fa40bb614ed2cf87\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/dailyNoteDefaults.js\":\"690f5a5945f8daf4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/dataExtension.js\":\"0c5569fbb0d687fc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/edgeExclusions.js\":\"20f11c3f159aabfe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/filterProperty.js\":\"143e36c2e8f8722e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/index.js\":\"9da2b3329c0cadf3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"06267906911ab4c1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/applies.js\":\"e8c893000ed20df7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/countQuery.js\":\"89c471f8ea29fed7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/expansionStore.js\":\"5706492402d37316\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/index.js\":\"c5065dd9cde325a0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8a6a8f3d990a5358\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/presentationInvalidation.js\":\"3ab6baa70b5abe16\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/propertyEditorOverride.js\":\"3758edba3b14b403\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/propertyFilter.js\":\"a74022b9f9314a17\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/query.js\":\"f0a7be128d68a90e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/resolveFilter.js\":\"1945861e6ac2d1ef\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/sourceBatch.js\":\"67460bd8543ee604\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/sources.js\":\"e647729b35a8ec68\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/useBacklinks.js\":\"36b119f2fa7e447c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"aa6accff7a6e8a9e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/BirthdayCelebration.js\":\"e5611d1819fda0a9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/BirthdayOverlay.js\":\"750afca92dd69dd6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/gate.js\":\"e52d05cbb48d0a84\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/index.js\":\"92b34056898ce442\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/birthday/wolfTheme.js\":\"aa8d162caf6abec3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/BlockDragLayer.js\":\"d2dcf193e0c12cf3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/dragController.js\":\"b8f2dadfb96730bf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/dropTarget.js\":\"f67054e445bfb979\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/index.js\":\"2772ad0529f75d84\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-drag/projection.js\":\"0d73177bf2b78051\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-info/BlockMetaCard.js\":\"5681d1706f1e180a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-info/index.js\":\"442bf95fd7fdae87\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/AddTagDialog.js\":\"b5eeec308c80ffca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0663c2cb86f0d5b6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/TagNameIssueHint.js\":\"9b93515b7508ed8c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/addTagAction.js\":\"5c9ad2e32c57b3c3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/appendTag.js\":\"d08a11b9ed79bed5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/config.js\":\"f72c2f194a617a41\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/dataExtension.js\":\"7af7931a3eec5089\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/index.js\":\"d067235e0dde7d3d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/block-tagging/propertyEditorOverride.js\":\"706c12ef2b6f8bc2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f82a55707198e77e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f311f5f17cf26e12\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fcaad4326e9077d2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"31fb87165ec49420\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"fd51f5e04c014935\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/index.js\":\"eeae6dbfd32cf57d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7d7f636eb44d43db\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/CharacterCountItem.js\":\"dbc6fa7e3686a566\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/ProfilePropertyEditor.js\":\"cc81797d1bce73d3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/actions.js\":\"4b986677dac5fa38\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/blockType.js\":\"bbdb8c28c70aa03a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/charCount.js\":\"adf83ca1570daa37\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/dataExtension.js\":\"d2bc575933461e5e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/index.js\":\"b0783ede88f13f54\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/profiles.js\":\"5369d1d6a9021cff\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/properties.js\":\"90cde8165e8d39e7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/subtree.js\":\"6351381ff49f42f5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/character-counter/textCounts.js\":\"dc5d99cdd908e478\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/colemak-keybindings/index.js\":\"2c24bc978158d7a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/CommandPalette.js\":\"4b3aa90204271db3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/HeaderItem.js\":\"28a97a11f7a6d3ae\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/context.js\":\"e0dcefd47ceca924\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/index.js\":\"8641d7d784a09f47\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/selection.js\":\"c42c785094b9bc7d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/toggleStore.js\":\"c1dece710379dc62\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/command-palette/useCommandPaletteActions.js\":\"d7a0c966ef5350ae\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/ContributorBadges.js\":\"59a6ada10dc284fc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/ProfilePicture.js\":\"ff0b472959f5c405\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/author.js\":\"03a81b60067f6d7c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/codeMirrorExtensions.js\":\"075687428c280d90\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/dataExtension.js\":\"c801acdb36618c52\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/index.js\":\"8912a16460d7250d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/mentionAutocomplete.js\":\"1483068aca56b8e6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/processor.js\":\"66188b3ed0d4e914\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/profiles.js\":\"b3db1d0e319d252d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/queries.js\":\"70025d0d52c1a768\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/schema.js\":\"51b6344f8f15f744\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/contributors/useCommentAuthor.js\":\"a75943b7f2fe11f5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"bf75b6baceed3dd6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/followOrigin.js\":\"0430d6eba089b23d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/index.js\":\"6c80addbb8450083\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"badbf1908b4b4a30\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1d1d56fc93b485e6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/CalendarGrid.js\":\"13d1d660951242a2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DailyNotePicker.js\":\"649d7f51820e4837\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4afac81ac21421fc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DateNavDecorator.js\":\"0b7ac3e0194b6776\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DateScrubOverlay.js\":\"2ce53132c5274edc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DayPropertyControl.js\":\"57499850efd74e8b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/DayValueReferenceControl.js\":\"0f37ee1d52765427\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/HeaderItem.js\":\"af02555e0297490e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/ReschedulePicker.js\":\"5e0017efdd31a766\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ebf21fdfdb87f049\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/actions.js\":\"9f4596e9441cc5c6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/blockDateAdapter.js\":\"db0b106244feb74f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/calendar.js\":\"8b2a2651e214dc06\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dailyNotes.js\":\"2419f34247e60c91\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dataExtension.js\":\"d316edf1f609289d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubActions.js\":\"e076848c4ab81bc5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubGesture.js\":\"8b041d19720551ea\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubGestureActions.js\":\"df43d45f8d54a5db\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f41fc72177efeefc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dayProperty.js\":\"9748f4cdbcc22dd6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"67ee0ab97a9dc507\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/deletionGuard.js\":\"daca14f1f599a170\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/dueQuery.js\":\"0ba9caa8a4a4f585\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/index.js\":\"d4090a0f8202fcd8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/landing.js\":\"a78125f60b04cd1d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/localSchema.js\":\"de38d35cad1ca61e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/referenceDateAdapter.js\":\"033848faf1c187f5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/rescheduleAction.js\":\"7cda49d2b94f9aa4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/schema.js\":\"323eff0aea4db5c8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/spreadBlockDates.js\":\"8507a150033c6295\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/spreadDatesAction.js\":\"3cf9a66541a2b2c8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/today.js\":\"e85a36dc4a36e1c4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"1e88bc59a11dd368\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"a1645d2d677bf177\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/audit.js\":\"85ab4489fad74894\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/auditAction.js\":\"fbbcae91606fcbc9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/auditRanges.js\":\"74ddb0260ccec3bb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/diagnosticsSource.js\":\"473b15788b0e8df9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/divergenceScan.js\":\"0cb5cfc18fd22ca1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/index.js\":\"f3012f99580d8caf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0045c5d37932ef39\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/referencesMirror.js\":\"4c5f83cda5ea87c1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/rowJson.js\":\"05523b3df488659c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/schedule.js\":\"4ad983614ff9ef1c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/data-integrity/store.js\":\"35b1092125163d08\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-maintenance/action.js\":\"87b662bd47319ce4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-maintenance/index.js\":\"8cdb691d7e1d69e2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-maintenance/plugin.js\":\"ff034f539d22491e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"93baa7af5ce2cdd5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/actions.js\":\"afaed3cce6392076\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/changeMarker.js\":\"3d9ef26de7cd0546\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/diagnostics.js\":\"9594e7e250af48f9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/fileSystemAccess.js\":\"1ed69ba0ccacaebe\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/filenames.js\":\"ed1f20e048443289\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/index.js\":\"dd624512b908a4a5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/mirror.js\":\"4b083c3eb4b5e3b3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/runLock.js\":\"46e3af42efa42e9b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/runtimeHealth.js\":\"ebf027f959f30fe3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/schedule.js\":\"4d626914db5a709d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/db-mirror/store.js\":\"9f34ebdc9a812d64\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/default-themes/index.js\":\"7fb785c7166283d7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/default-themes/themes.js\":\"6c6b826af08421a8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/diagnostics/facet.js\":\"d6c1ecc1d857247b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/diagnostics/useDiagnostics.js\":\"76eeccb54b614bb6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/dismissals.js\":\"2aba4009565e361a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/index.js\":\"8b7c00587610a3d4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/status.js\":\"d6492153d013c17c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extension-prompts/store.js\":\"06d35398ce96c53a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2650fae681fb3e41\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/ExtensionsSettings.js\":\"62e532ced26bf1c0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/actions.js\":\"01ef65bef1cbd215\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/config.js\":\"dc34770f1c309236\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/dataExtension.js\":\"696e5c42e6dfa6c0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/effect.js\":\"89f3249cd76bacc9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/index.js\":\"8c81a86680d27b2e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/propertyEditorOverride.js\":\"56c65b8e5b5d047e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extensions-settings/useToggleTree.js\":\"bdabbd51192c9f52\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/ExtractTypeDialog.js\":\"9acf2a15b07a02b8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"f5ce46086d012d0e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/PropertyShapePicker.js\":\"f2a6604f6963dba4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/action.js\":\"297a0b4bbf68fb92\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/extract-type/index.js\":\"48b710b0ce37197f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/FindReplaceDialog.js\":\"726c457291c6ea7f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/HeaderItem.js\":\"328e6b97f78e56fb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/dataExtension.js\":\"86edd953a7dffa30\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/index.js\":\"8e9a3910b592dc2a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/search.js\":\"199461c92f3a35c5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/toggleStore.js\":\"19c5855088b547a8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/LocationPropertyEditor.js\":\"f5c0a4db120bfd62\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/MapView.js\":\"2d56a0096383ae54\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/blockTypes.js\":\"e2e708ab9e2135ea\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/codeMirrorExtensions.js\":\"9bd19c8fd214c8e4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/createOrFindPlace.js\":\"f6e0f9f5770c2bcb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/currentLocation.js\":\"8ab842818f5fe7ed\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/dataExtension.js\":\"cb7c2eeba471ed23\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/geoContentDecorator.js\":\"b7d5f9d4c134549f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/googlePlacesClient.js\":\"ab27fe9ddadb3905\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/index.js\":\"7cc1ec04b03e4862\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/locationsPage.js\":\"5c03f32b55194183\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/mapViewport.js\":\"f179fbc3f838228c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/pickCurrentLocation.js\":\"a7fa32e8a562ca99\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/placeAutocomplete.js\":\"12c2b74259afcbd3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/placeNameCollision.js\":\"1a8290025f72b63c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/properties.js\":\"0ca7f2d4fdedb1bc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/propertyEditorOverrides.js\":\"aed58739a051735c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/query.js\":\"974661e139bafa36\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/geo/usePlaceSearch.js\":\"cf159e42e2c9a7a6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c00800e45a160af7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4bfb3f6bf562ed78\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ee8f65fb892c5dda\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/config.js\":\"b4920ab3a21dfadc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/dataExtension.js\":\"c4dde538465aece8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/facet.js\":\"7b00fc749cc89b32\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/grouping.js\":\"9ff7e2661419465c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/index.js\":\"8aac018704c71d68\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1ae2c0aa088e49bb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/query.js\":\"2bec09ec5ddfb51d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/resolveConfig.js\":\"ea0c353fc25ca8c3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"b0c75f72a50f3efb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"991e9d7544287881\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/HtmlDocumentContent.js\":\"08cab4febb8ee8d7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/HtmlFrame.js\":\"09fae086a5862d0a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/actions.js\":\"bc186c78f040041f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/blockType.js\":\"28f0d00f3f378105\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/confirmRunScripts.js\":\"f74eb387301e3d87\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/dataExtension.js\":\"e3b664ae10aecfc4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/frameAnnotations.js\":\"9267b3dca150fc6c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/frameDocument.js\":\"e45beaffe96528a9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/frameTheme.js\":\"3da07f03272d96e9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/index.js\":\"d24288a60c485880\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/scriptConsent.js\":\"2c77b50f9c4d30ab\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/sourceMap.js\":\"76aa76b83a8afb24\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/html-document/useDocumentScripts.js\":\"a0aeba072eba1b57\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/index.js\":\"afeac19580269b4e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/record.js\":\"6a238884269a5401\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/recordStore.js\":\"bce5234387cd4c48\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/responsiveness.js\":\"e6e907a9bc474020\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/schedule.js\":\"80fa34cfb73cd10e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/interaction-metrics/sessionContext.js\":\"1c82ad573aa13ee3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"6e2e7da596bd2071\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"05ec8196c5f464ec\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/actions.js\":\"b1590c849dc325f3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/config.js\":\"9dc24eb948d3f729\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/dataExtension.js\":\"93ae0d0cd1794d44\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/effect.js\":\"45d12250e5b2659b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/index.js\":\"3697fc14813228bc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/keyCapture.js\":\"a903b909d71deb88\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/overrideStore.js\":\"2d6fecb6548c2407\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6bda6e051e2f9812\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/HeaderItem.js\":\"d17ed2f146551975\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/LeftSidebar.js\":\"046b09964b8464d2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/actions.js\":\"a94e7cef4c4e72a7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/facet.js\":\"9ff4d55353d2b673\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/index.js\":\"80429cd80088e0da\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/shortcuts.js\":\"563d1d02c7be2933\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/left-sidebar/toggleStore.js\":\"95b2caa15adcf3a8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/MergePicker.js\":\"0cb7d844e644e248\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/index.js\":\"e85e4757f3232db6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/mergeAction.js\":\"c12282737be4e3bc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/merge-blocks/strategy.js\":\"a743dbd10e8d1226\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/Button.js\":\"7290578607473a42\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"89baeb0cdcf20c8a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/defaultItems.js\":\"025622f19d6e49d1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/facet.js\":\"8a0564bd2bf22810\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-bottom-nav/index.js\":\"ea6fa1af6f81c246\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a7c3280b2a89129e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c769a31952e9616a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"bc04cd4204781163\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/facet.js\":\"cde18038aa857120\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/mobile-keyboard-toolbar/index.js\":\"926b40e156ef432a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/MoveDestinationPicker.js\":\"7cd980c6ccb9cc41\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0cdfcb4ed7df54f1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/contextMenuItem.js\":\"e12fde9c29f3bdbf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/index.js\":\"2da1e3ab2e51c529\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/moveAction.js\":\"ecb44201fd6879a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/moveBlocks.js\":\"5d2e148f93475244\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/move-blocks/selectionAfterMove.js\":\"61898ef224796c95\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/TutorialBanner.js\":\"fb24c95428f5ca77\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/action.js\":\"76e157354a3ac890\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/bannerDismissal.js\":\"561979fb7a89d313\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/documents/cheatSheet.js\":\"965a1efcba28e178\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/index.js\":\"353c987d9afe9779\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/keys.js\":\"14d617988d076808\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/landing.js\":\"a8344a5a8bdac71a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/outline.js\":\"1b3d7650d04dd354\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/onboarding/seed.js\":\"faad37779c155ad8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/PerfTrendDialog.js\":\"597c94b52bb706e5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/analyze.js\":\"efced68c9f97f2f9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/diagnosticsSource.js\":\"fad59995a0d60ced\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/index.js\":\"be119bbc54a995e8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/load.js\":\"6555b593efda9730\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/monitorRun.js\":\"722b742e3c742f73\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/schedule.js\":\"500d33e739ad3b3f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/series.js\":\"3f89bcdecc4e0158\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/store.js\":\"ae4fd5ccc5b2886f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/trendAction.js\":\"b244c8c0425cf1fc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/perf-monitor/verdict.js\":\"74230101d96366e4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/plain-outliner/clickToEditAction.js\":\"06cc44d26c2e6327\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/plain-outliner/index.js\":\"5490f510830dd1a7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/plain-outliner/interactions.js\":\"d4ba8270ce7cb77d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9519d494fb8c3202\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/MigrationGate.js\":\"b7aaeefcfbcc9224\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/MigrationGateDialog.js\":\"61409e27092eb270\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/action.js\":\"106ca8880f1574a3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/index.js\":\"d9db1ff8c735bf4f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/localRunMessage.js\":\"86228ff53f2f5d20\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/plugin.js\":\"25909ea52db880e8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/progressReport.js\":\"963bf6e8ea97daaf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/properties-migration/sweepProgress.js\":\"233bb2108d0f0320\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/FieldRowRenderer.js\":\"17697b9f6978b4db\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/ValueRowRenderer.js\":\"f3bf4c32c47ff156\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/actions.js\":\"aa8bedefa25f568b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/autocomplete.js\":\"c67aa990486ad06b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/fieldRow.js\":\"0e7eccf1cbba734e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/index.js\":\"aeab35c895c0f602\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/referenceWarning.js\":\"c379f5906eeb148a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/valueAutocomplete.js\":\"f15073d2ebd4b44b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/property-rows/valueSchema.js\":\"4c63a6fecf3684cc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/HeaderItem.js\":\"4abb8390a2b16065\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/QuickFind.js\":\"935b1e3265cb00bd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/index.js\":\"a51dee7c311d693f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/recents.js\":\"d52591e5e1b44bf1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/resultItems.js\":\"ae2e77c5d3822e53\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/selection.js\":\"241e0e037d4f9721\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/quick-find/toggleStore.js\":\"ebddee1b2b8ec052\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/HeaderItem.js\":\"1b68253ac052d872\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/RecentsPageBlockRenderer.js\":\"c978b3ed11590f61\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/grouping.js\":\"fa2d9d15006a1985\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/index.js\":\"483ca25d9551f305\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/recents/target.js\":\"f10881e3bec24292\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/codeMirrorExtensions.js\":\"d14cd571874d7450\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/contentPrefill.js\":\"e1a8d5c232511aa9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/dataExtension.js\":\"611db13989676173\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/index.js\":\"b31777deec579440\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"a986187bd8e129ca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/invalidation.js\":\"c7737da2c5a94d89\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/localSchema.js\":\"baedd54914624542\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/blockrefs/index.js\":\"2b9e14380bc6da59\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3e4170ecfbbbcd9e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/index.js\":\"4742ad7457cb31f4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/referenceNode.js\":\"65b40d6a8c3c089e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/remark-reference-occurrences.js\":\"9cc4eb513d2c2166\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f9f30dbb520b2478\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/index.js\":\"2c9bcedd1a06433e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"de5b90959b134e78\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7c0c41c7c1d9256d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/mergeRetargetProcessor.js\":\"9f9c8b3b03e8dc83\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/parseFence.js\":\"b5032d14f183ea4a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/referenceParser.js\":\"09416f8173e320d9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/referenceProjection.js\":\"0c07581a8ad1e2dc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/referencesProcessor.js\":\"b236a3fc7020b597\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/renameProcessor.js\":\"2ad304c4f6b85c8d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/references/spanReplacement.js\":\"86816c5507c75f5d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/htmlToOutline.js\":\"810e0670c9404586\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/index.js\":\"1a1b6d1d746e47c7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/normalizeClipboardDom.js\":\"25d5e74c57360c06\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/rich-paste/pasteDecision.js\":\"7af020658637ec8b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/action.js\":\"105bc871a957fcab\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/blockIds.js\":\"f8d56d954b813dc1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/content.js\":\"f5f5b429bce70791\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/effect.js\":\"1638ecdcd280ac12\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/ids.js\":\"85597f7910d60fcb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/import.js\":\"2381b966a0b9158c\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/index.js\":\"d80c30ac9389cbcd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/plan.js\":\"0461251c7b39aa6a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/plugin.js\":\"61f91bbc150fdd44\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/promotion.js\":\"26abbe083f92c6ad\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/properties.js\":\"b89d19de312bd565\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/references.js\":\"e42899ba2deb89cf\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/report.js\":\"be02e655d2f44f7b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/roamMemo.js\":\"af0183ed246f0de6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/runtime.js\":\"ada9719ab766358d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/schemaReconciliation.js\":\"6e50d6680df7be51\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/srsMarkers.js\":\"d2a1a02ae0c1db67\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/todo.js\":\"3dd93b220253ffb0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/typeCandidates.js\":\"23fa7398ba56ed46\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/roam-import/types.js\":\"4bc4bc85bc110875\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/search-health/index.js\":\"478e4bcac3759540\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/search-health/store.js\":\"e4a55d0b1dea1e11\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/HeaderItem.js\":\"5375caefb2df20f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7ea631801069f770\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/index.js\":\"132ce7cd63be4ca7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/model.js\":\"b017f5cac5b47b9e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/toggleStore.js\":\"7988d3f3118258c0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/shortcut-help/useKeyInspector.js\":\"9ba9e8433ec9ad85\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"5940bc8671f27ede\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/ShellDecorator.js\":\"f79a06dd4f934e5a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/actions.js\":\"89c79cd9c98cf4a0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8af1b24ad68951e1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/index.js\":\"d18c2be0084f5b6a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/shell.js\":\"6d78dbedefdd1f55\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/surface.js\":\"48fb71e0f69084ce\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/spatial-navigation/walker.js\":\"799a2586e07477f8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ac16e2b1b2cd4137\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/dataExtension.js\":\"e8909f26b3cc9ec0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/index.js\":\"eeaadf2ea86b3d11\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/indicator.js\":\"744b9de64c9706ba\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/moveSrsState.js\":\"64a5b4d0051d8cd4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"639f0af259cee97e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/scheduler.js\":\"5b30ef6b52121fdc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/schema.js\":\"a6f3ec0a18528579\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8887a10f1afa812e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/srsClipboard.js\":\"430e28a88ec1df06\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7c383cc9dda3da07\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/DailyNoteReviewHint.js\":\"4419d61d3b597450\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/DeckPicker.js\":\"532a31579984c719\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/ReviewControls.js\":\"5db38bb11dab7cc9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6b324333d13d18a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/ReviewSession.js\":\"4b5050ae5b1c2198\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/actions.js\":\"1e0fe79c0db83a48\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/archive.js\":\"da4d73dfb3c303ca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/dataExtension.js\":\"832916634a020d25\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/deck.js\":\"316dab5e91438887\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/dueQuery.js\":\"e7e2de44b36398a3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/gradeDecision.js\":\"a739dbfc8f6115f2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/index.js\":\"876403ef8fb5d945\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/keyHints.js\":\"023323e918b5bc75\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/reviewCardLayout.js\":\"daa7b8ab335b6a22\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/reviewProgress.js\":\"b104890353ca9393\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/schema.js\":\"fdd2277e262db979\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/srs-review/useDueCards.js\":\"91edcff4b77257a9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/startup-metrics/index.js\":\"ef4bdcc31352f481\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/startup-metrics/record.js\":\"6d3b8400550f7d07\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/storage-persistence/index.js\":\"6b98e00eab1ab50a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/storage-persistence/persistenceStatus.js\":\"e1d8f4157a5b71bd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/storage-persistence/requestAction.js\":\"c4fb7a28a3e6fd95\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/TypeChipsDecorator.js\":\"cde60dcb6a40ba46\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/codeMirrorExtensions.js\":\"54b2729b0c6b5341\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/index.js\":\"c957da1d08105d06\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/supertags/typeAutocomplete.js\":\"ad22e9faa4d1f7db\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e877be706d48eda9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/actions.js\":\"eff420e0dd736a17\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/anchor.js\":\"dc9de141cd0255d8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/events.js\":\"792292fe30c62e2e\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/gestureActions.js\":\"4df8cc524b41e816\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/index.js\":\"2a4fca6f0bf41d6b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"c0aae509d31c7935\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/sync-metrics/collect.js\":\"aa51eb361f2d58f8\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/sync-metrics/index.js\":\"dba2047fe6734cb4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/sync-metrics/record.js\":\"bd8be94559cf4653\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/RejectionDialog.js\":\"667263fd37a1a121\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/SystemStatusHeaderItem.js\":\"b604cfd4d9aa98a6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/index.js\":\"9f5c268eaac4af35\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/model.js\":\"7bf6afeb8666d0f4\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/queueCounts.js\":\"13eeb4a8c0d24453\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/rejectedHelpers.js\":\"e7c52de96d71d383\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/rematerializeAction.js\":\"c7b156fb3b3bbefd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/system-status/useHysteresis.js\":\"ad2e052438915fc5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/ColumnHeaders.js\":\"63abe5e496881d36\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/QueryUi.js\":\"57638ce009f2ffa6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/TableLayout.js\":\"404162a816caa3dd\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/actions.js\":\"9a66138bad72911d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/cellEdits.js\":\"708bfae9908342a1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/childrenViews.js\":\"54533a68f7ccb41f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/columns.js\":\"eab19c375ac8e017\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/controller.js\":\"f708a3a82aebbfc2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/convert.js\":\"2a8cafea17e9bacc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/dataExtension.js\":\"c7b89d317973cd31\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/index.js\":\"1b50e705199e5443\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/keys.js\":\"dd08fd0227303bf1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/model.js\":\"b526c7eef2a6f1ca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/QueryText.js\":\"63dd90c51a26fcac\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/backfill.js\":\"5ffad31ff1ef5882\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/completion.js\":\"a4674fea0d3588b3\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/format.js\":\"2cf66ef2652ff559\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/parse.js\":\"059caeaeec7f9b29\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/queryValue.js\":\"87f73b015a2a4977\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/registrations.js\":\"c6d9e1de761c5ee7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/query/source.js\":\"eab3d44d6ed09721\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/registry.js\":\"6cf7db3205ae889d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/rowGutter.js\":\"176297007eb8ee12\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/rowVerbs.js\":\"287ac6fc03e61c8d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/schema.js\":\"05264e8b4322d6ed\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/tables/sort.js\":\"c101fe05033780b5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/theme-toggle/effect.js\":\"5818f19f70a033c6\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/theme-toggle/index.js\":\"02580b8bf6b9e4b7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/theme-toggle/theme.js\":\"6e1c9d42087963e0\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/actions.js\":\"5d9b52cc75548d7d\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/dataExtension.js\":\"2b4015eaac6df02b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/index.js\":\"aec770d4f504ba51\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/todo/schema.js\":\"4b80670c932c1dc5\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4dfe95fe92add4e9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/actions.js\":\"0f22b6393deb5b28\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/defaultItems.js\":\"ca3ab766c1078b02\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/facet.js\":\"142db1ab28040f70\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/holdRecognizer.js\":\"db8430a6bb2c4ef9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/touch-selection/index.js\":\"6a1cd2f770bc5b67\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/update-indicator/UpdateIndicator.js\":\"aef8f28bba85e8cb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/update-indicator/index.js\":\"961c00eb21a8ac59\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/update-indicator/loadTimes.js\":\"502f1a6d127e49d1\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/VideoNotesRenderer.js\":\"0025caf52d77e64b\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/VideoPlayerRenderer.js\":\"f4c70b233bcc41bb\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/VideoTimeStamp.js\":\"5cade1c3bdb1209f\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/actions.js\":\"a3de2bcf4a8e4970\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/index.js\":\"355414a70b928fb9\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/markdown.js\":\"0f7fcdf5917e4907\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/notes.js\":\"5f97ed0b56bab5da\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/registry.js\":\"c01b0b77a872bc34\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/remark-timestamps.js\":\"3103455d21165e79\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/video-player/view.js\":\"52bcc42113aa8aca\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/LinkHints.js\":\"63541f6f3d9b93cc\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/index.js\":\"ac3a73797a70afb2\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/model.js\":\"6f27e4b99836337a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-link-hints/settings.js\":\"d4c7fdfcfd154ff7\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-normal-mode/actions.js\":\"52dc82c98706b312\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-normal-mode/index.js\":\"6461b8077ad98f3a\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/vim-normal-mode/interactions.js\":\"bf6c22a8165f97ff\",\"/knowledge-medium/pr-preview/pr-1916/src/plugins/workspace-header/index.js\":\"05b944ebf60a802d\",\"/knowledge-medium/pr-preview/pr-1916/src/registerServiceWorker.js\":\"85f80fe0a52bf725\",\"/knowledge-medium/pr-preview/pr-1916/src/requestPersistentStorage.js\":\"e98499cbbc42d657\",\"/knowledge-medium/pr-preview/pr-1916/src/services/authRequestDeadline.js\":\"a3df6c86c6cdfe32\",\"/knowledge-medium/pr-preview/pr-1916/src/services/authStorage.js\":\"87a2368cf9fab29e\",\"/knowledge-medium/pr-preview/pr-1916/src/services/powersync.js\":\"1ba4f669ab730c65\",\"/knowledge-medium/pr-preview/pr-1916/src/services/supabase.js\":\"7b955aeadfc3459a\",\"/knowledge-medium/pr-preview/pr-1916/src/services/uploadErrorClassifier.js\":\"bb578cd7ac95f74b\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/ActiveContexts.js\":\"7c7936b09c1a0740\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/HotkeyReconciler.js\":\"54862a2e63c799a7\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/WipeLocalDataDialog.js\":\"7d38d5240a7a9594\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/actionDispatch.js\":\"6d3414950a6944ec\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/actionRefItems.js\":\"4839a926753fe77a\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/applyKeybindingOverrides.js\":\"c7aca07220988b56\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/blockActions.js\":\"2841834ce70996b7\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/blockMergeGesture.js\":\"bb4d8c5e8fd2eb66\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/canonicalizeChord.js\":\"9f1dc0a76eab5b02\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/defaultContexts.js\":\"1a835bc97633e477\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/defaultShortcuts.js\":\"3730f3dd3c2d61f4\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/effectiveActions.js\":\"7d80a53a6a24ca7f\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/gestureAction.js\":\"f119c19d8427764e\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/gestureBinding.js\":\"c774405f1f0484f3\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/holdRegistry.js\":\"1b595f2ae6da3b5b\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/keybindingConflicts.js\":\"949ed406d45554fd\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/keybindingOverrides.js\":\"1cc4edafc3934c9a\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/pointerAction.js\":\"7d46eb796d3cef45\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/resolve.js\":\"c89daa8a7b0b3483\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/runAction.js\":\"5a159bd498d9b752\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/sequenceMatcher.js\":\"e85f6ccd61f3501c\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/types.js\":\"ba036f9420954d77\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/useActionContext.js\":\"e59a2c2734da70ef\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/useActionDiscovery.js\":\"2a936ebd3c173d8b\",\"/knowledge-medium/pr-preview/pr-1916/src/shortcuts/utils.js\":\"46af68c53cdfc579\",\"/knowledge-medium/pr-preview/pr-1916/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1916/src/sw/bootStore.js\":\"01da1e1368256d2e\",\"/knowledge-medium/pr-preview/pr-1916/src/sw/previewDatabases.js\":\"702fe6d4077b492d\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/byteTransform.js\":\"8dd5e89d5b095617\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/attachmentCleaner.js\":\"4f359b19673bdc96\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/attachmentParts.js\":\"601f7a41088d20ee\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/bundleParts.js\":\"de9671aa4cd16d62\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/bundleRecord.js\":\"965191cb108914e0\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/manifest.js\":\"41888615aacaf5d5\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/takeBundle.js\":\"e6e98d389f7a9add\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/bundle/verifyBundle.js\":\"23145bee55c36791\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/cleaningStage.js\":\"026d5b97b3aee9b5\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/conversionKey.js\":\"5c41baa8a89ac405\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/conversionServer.js\":\"620a270c789d6339\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/flip.js\":\"e9cd47df57ae8e7c\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/flipAttempts.js\":\"7d04569371b95aa2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/pages.js\":\"6df1388de7527ab1\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/preflight.js\":\"ed37077ba41c6501\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/reseal.js\":\"4f5190b26de99357\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/runConversion.js\":\"1931eeae1256f6f8\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/runLock.js\":\"c202ff6816dedc13\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/sealing.js\":\"fbd20030ff386a92\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/sealingStage.js\":\"a4b2369f2d9719a3\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/stage.js\":\"17b8d9b08f054575\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/conversion/verifyReseal.js\":\"1726402e2e0bf0ab\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/aad.js\":\"9ca29e6be7e1b831\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/aead.js\":\"c7a06de3651315f9\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/base32.js\":\"814a0f6ce3a7d6e8\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/base64url.js\":\"38738614611f7fab\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/binaryEnvelope.js\":\"3b01ff9d3b70b41f\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/byteAead.js\":\"10a3bd10698ace1a\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/canary.js\":\"1fbec2ff96392ef1\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/contentHash.js\":\"1cddd38d297f6605\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/contentKey.js\":\"1a2f38684610eea2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/derivedIdNamespace.js\":\"9e9ddb4df3c3401c\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/envelope.js\":\"90b004796d7dd137\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/hex.js\":\"86eb0b237c9cc4fb\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/sha256Hex.js\":\"e808f40c819e8bbe\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/crypto/workspaceKey.js\":\"672c6598135eb6f2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/conversionState.js\":\"71981438ab93ade7\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/createEncryptedWorkspace.js\":\"aba60614fe298d98\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/pastedKey.js\":\"4835ba16e40ec186\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b5050749d08319e2\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/flows/upgradeWorkspacePin.js\":\"1347370e6d8fa4c0\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/keyStore.js\":\"e885b9286be0cfed\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/mintWorkspaceKey.js\":\"d158bbfe843abe22\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/modePin.js\":\"60666cc931d398d0\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/openWorkspaceKeys.js\":\"f36020fc98980909\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/resolveWorkspaceEntry.js\":\"0a9874f69496224e\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/resolver.js\":\"a78175f9fadde296\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/keys/workspaceAccess.js\":\"d4619485175491c0\",\"/knowledge-medium/pr-preview/pr-1916/src/sync/transform.js\":\"6609dfc4350fa163\",\"/knowledge-medium/pr-preview/pr-1916/src/themeBootDefaults.js\":\"bd3c425ab9c0f8d0\",\"/knowledge-medium/pr-preview/pr-1916/src/types.js\":\"9545d06748aeb9d9\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/ClientLocalSettings.js\":\"6903a55501a3fe3e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/abortableSleep.js\":\"a4afd01729e665ef\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/array.js\":\"0c4c92b901a20cad\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/backlinkAutocomplete.js\":\"f80a7fe18cd1acfd\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/blockCrumbs.js\":\"22bf204e8ea75387\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/blockrefAutocomplete.js\":\"6bc54f0e5120b78f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/cadencedIdleJob.js\":\"a22a0d7698f046dd\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/callbackSet.js\":\"6c44bd52e0425274\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/clientId.js\":\"bce74e4d59285746\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/codemirror.js\":\"c48a1cfb4137c530\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/codemirrorCompletion.js\":\"9ea8c45747047763\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/copy.js\":\"c5b38532378b82a9\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dailyPage.js\":\"84bc859de8f4d1d8\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dbForensics.js\":\"9513a28fabdb0eac\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dbForensicsHooks.js\":\"9cef2edfe02aa2c8\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/deleteBlockThroughUi.js\":\"318956c0be5b5f3b\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dialogs.js\":\"85c498a3c32ab15b\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/dom.js\":\"fc66a70710cd032d\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/downloadBlob.js\":\"d8f235e1ea106efa\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/drawnWalk.js\":\"33bb5209ac7261fb\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/exportSqliteDb.js\":\"e1b1214d7d686adf\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/fileSystemAccess.js\":\"8422b909b22ff24e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/flipSlide.js\":\"b84cad2a18772cf0\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/fnv1a.js\":\"7a4a751c04683623\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/formatBytes.js\":\"663aa058b65c7dd3\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/fuzzyRank.js\":\"ce88cbcf98b92caa\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/idbKeyedStore.js\":\"3379e47c403f5265\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/idleCallbackPolyfill.js\":\"a5ace8b15ef2aee4\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/keyboardAwareScroll.js\":\"3744bfec674a75f4\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/keyboardViewport.js\":\"7ddb926f5968c602\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/lastWorkspace.js\":\"26d7a3aa6d486449\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/layoutColumns.js\":\"f28206e63c2aa943\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/layoutSessionDom.js\":\"71c93c5aa1faee42\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/layoutSessionId.js\":\"cebe0a374b6c9e11\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/linkClickGestures.js\":\"9b28650bffcca726\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/linkTargetAutocomplete.js\":\"6689116cd77bbb0a\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/localDbCorruption.js\":\"d62224e7483d375d\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/localDbRecovery.js\":\"dabcf5e85eaa0566\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/markdownParser.js\":\"78e9dea8cce09942\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/memoize.js\":\"e1e21ad94418d673\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/nameFieldCommit.js\":\"65c842385da0e86d\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/nameList.js\":\"1c5dbca5bf82e37a\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/navigation.js\":\"259d311d6128f2cf\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/omnilinerNamespace.js\":\"8efac3d59428c329\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/opfsPageScan.js\":\"33933b74598231c6\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelClearance.js\":\"82b2abb3eeb30a62\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelHistory.js\":\"c0e73bb1feed246f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelLanes.js\":\"fc950367caa7c6ec\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelLayoutProjection.js\":\"2cf905aa95fb17a1\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelScrollAnchor.js\":\"0c3a0d9da91ce9de\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/panelUrlFlags.js\":\"c234d00e43cc6988\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/platform.js\":\"6483af8978b3fdca\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/pluralize.js\":\"f6e541c7c052c7fb\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/propertyCreation.js\":\"051c131d9dca756f\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/propertyNavigation.js\":\"c6bd6375d947df86\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/propertyValueContext.js\":\"2fcab30ce562d742\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/react.js\":\"cf0beea2c99d3798\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/relativeDate.js\":\"5997ff83d7e245d8\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/relativeTime.js\":\"bd97d7e779ef8c83\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/renderScope.js\":\"39789e84d0e24f5c\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/resolvedThenable.js\":\"201af07918b888d4\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/routing.js\":\"abb5594de00d717a\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/safeMode.js\":\"604e4e6d267573a3\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/scheduleIdle.js\":\"28d647d5761db96e\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/screenWakeLock.js\":\"d794137d0feaa043\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/selection.js\":\"1d6edafa8f1419a1\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/softKeyboardGrab.js\":\"276e92362aeba6ad\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/startupTimeline.js\":\"a15323ab84ae8733\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/state.js\":\"26eeb3005e3bded1\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/string.js\":\"8d3d3b1aaa7a7cb0\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/surfaceZoom.js\":\"101d8f7f93a77dd3\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/time.js\":\"387fecce1b5094c6\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/toast.js\":\"720196d912d966cb\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/toggleStore.js\":\"04bbe8700c53e33d\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/untilStopped.js\":\"a7eaa6eb772e8fb3\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/userActivity.js\":\"6da9faacec66eb02\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/viewTransition.js\":\"1ecdf53383eedbc5\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/viewport.js\":\"6ce75a19db69c335\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/webLock.js\":\"5aa7a97eb7d543fa\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/workspaceRecovery.js\":\"b5b1a91a3bde5909\",\"/knowledge-medium/pr-preview/pr-1916/src/utils/workspaceSnapshotStore.js\":\"6edc7009fa048f7c\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-compiler-runtime.js\":\"845593e16368de5c\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-client.js\":\"89a53f6f1d4e5b7a\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-server-edge.js\":\"72a94946f02dde01\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-server.js\":\"6d7ae4182e2b7231\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-static-edge.js\":\"291c90efcb8be219\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-static.js\":\"f2e774a3169bd562\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom-test-utils.js\":\"654673d6263cd06a\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-dom.js\":\"31bf6e0ca72be79a\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react-jsx-runtime.js\":\"a72ce61cd42ca9be\",\"/knowledge-medium/pr-preview/pr-1916/src/vendor/react.js\":\"4ac07e2af7954543\",\"/knowledge-medium/pr-preview/pr-1916/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1916/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1916/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
