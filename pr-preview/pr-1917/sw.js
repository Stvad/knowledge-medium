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
		buildId: "1da1328e938b-1f2313ce",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1917/\":\"1708bf8a58937254\",\"/knowledge-medium/pr-preview/pr-1917/index.html\":\"1708bf8a58937254\",\"/knowledge-medium/pr-preview/pr-1917/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1917/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1917/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1917/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1917/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1917/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1917/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1917/assets/FacadeVFS-B9nfXWOg.js\":\"c64fc7a34f681ce2\",\"/knowledge-medium/pr-preview/pr-1917/assets/OPFSCoopSyncVFS-Dcweldvi.js\":\"3ff8a8c898411be7\",\"/knowledge-medium/pr-preview/pr-1917/assets/OPFSWriteAheadVFS-bNDEm9p_.js\":\"50806b1056e7aaab\",\"/knowledge-medium/pr-preview/pr-1917/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1917/assets/wa-sqlite-D3F82G1s.js\":\"f6008f4dfe444641\",\"/knowledge-medium/pr-preview/pr-1917/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1917/assets/wa-sqlite-async-CXzck4fn.js\":\"b23b3bc495619e3b\",\"/knowledge-medium/pr-preview/pr-1917/assets/worker-DaCUotu5.js\":\"423f4eaef148955c\",\"/knowledge-medium/pr-preview/pr-1917/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1917/chunks/app-cHKmPhme.js\":\"082560984a11e204\",\"/knowledge-medium/pr-preview/pr-1917/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1917/index.js\":\"565d55fc66f04650\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1917/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1917/assets/AccessHandlePoolVFS-Dzdd2trl.js\":\"9d0139fa8e52c393\",\"/knowledge-medium/pr-preview/pr-1917/assets/IDBBatchAtomicVFS-CWYKqLDD.js\":\"f26aa3c8d209f580\",\"/knowledge-medium/pr-preview/pr-1917/assets/MemoryVFS-BacJErQC.js\":\"f032ded561f685dd\",\"/knowledge-medium/pr-preview/pr-1917/assets/mc-wa-sqlite-BcTC4LTa.js\":\"1eea8943b222a1d8\",\"/knowledge-medium/pr-preview/pr-1917/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1917/assets/mc-wa-sqlite-async-BHT0uMwl.js\":\"1405481ed46bcb9b\",\"/knowledge-medium/pr-preview/pr-1917/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1917/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1917/chunks/AccessHandlePoolVFS-C7tINv_x.js\":\"fe4bd5a041e4768e\",\"/knowledge-medium/pr-preview/pr-1917/chunks/FacadeVFS-BhHjAJMf.js\":\"54bfc81d50d4d297\",\"/knowledge-medium/pr-preview/pr-1917/chunks/IDBBatchAtomicVFS-CtMXHWCk.js\":\"7f0ba5b6dacc605b\",\"/knowledge-medium/pr-preview/pr-1917/chunks/MemoryVFS-Bp_RcqeV.js\":\"0e9d79d3a5904ccc\",\"/knowledge-medium/pr-preview/pr-1917/chunks/OPFSCoopSyncVFS-CvHtmP5V.js\":\"dcd83f847ed46514\",\"/knowledge-medium/pr-preview/pr-1917/chunks/OPFSWriteAheadVFS-DevFRugZ.js\":\"41b756c405921857\",\"/knowledge-medium/pr-preview/pr-1917/chunks/Preview-C9S8ZaHL.js\":\"26c750c18d68873d\",\"/knowledge-medium/pr-preview/pr-1917/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1917/chunks/card-D5IORfSP.js\":\"4142836e90b37a87\",\"/knowledge-medium/pr-preview/pr-1917/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1917/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1917/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1917/chunks/dist-wyMTnodd.js\":\"0fc703c0dcd82213\",\"/knowledge-medium/pr-preview/pr-1917/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1917/chunks/mc-wa-sqlite-SM9u8Myd.js\":\"14c954b0b7f49311\",\"/knowledge-medium/pr-preview/pr-1917/chunks/mc-wa-sqlite-async-QHZeIEmm.js\":\"d11330a8dedbd733\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-B8JqJgJI.js\":\"585a65e4d9796561\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-BPR0vf3Z.js\":\"8676a43226a9dfd2\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-BlBxnnj2.js\":\"6860b0fd397c2548\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-CwdL95Ly.js\":\"790d6d25306ea496\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-DPbzmjvm.js\":\"8ffbacacbef96406\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-DewT26YR.js\":\"23e524a666d7fcb1\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-DqXIuAbR.js\":\"e5471d67e85d9ece\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-OjZ4bYo5.js\":\"54842c7908355ec6\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-dom-server-legacy.browser.production-BCg0-AKE.js\":\"c68ce99b845e5fb2\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-dom-server.browser.production-DULcZoKL.js\":\"e9312f29fc3be9a2\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-dom-server.edge.production--_NLeZk2.js\":\"9700c8e9b8019e9d\",\"/knowledge-medium/pr-preview/pr-1917/chunks/server.browser-C--YI4o1.js\":\"5d9ee0e9240b98ef\",\"/knowledge-medium/pr-preview/pr-1917/chunks/textarea-B7-uj2Ba.js\":\"f079e05a9252fd8e\",\"/knowledge-medium/pr-preview/pr-1917/chunks/ui-FoHoBRp4.js\":\"57050f4ec95910da\",\"/knowledge-medium/pr-preview/pr-1917/chunks/wa-sqlite-D85mpAqg.js\":\"728fb5c686ba792e\",\"/knowledge-medium/pr-preview/pr-1917/chunks/wa-sqlite-async-BSvI3Tey.js\":\"69dd4f39c3c26afa\",\"/knowledge-medium/pr-preview/pr-1917/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1917/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1917/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1917/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1917/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1917/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1917/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1917/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1917/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1917/src/App.js\":\"2131420f07e1a3dc\",\"/knowledge-medium/pr-preview/pr-1917/src/appUpdate.js\":\"54cc083f02a58670\",\"/knowledge-medium/pr-preview/pr-1917/src/appVersion.js\":\"6e14038d88d5eaf4\",\"/knowledge-medium/pr-preview/pr-1917/src/bootstrap/initialLayout.js\":\"6307ddc4860bd257\",\"/knowledge-medium/pr-preview/pr-1917/src/bootstrap/openWorkspaceData.js\":\"2d6cc4427c3cdfc4\",\"/knowledge-medium/pr-preview/pr-1917/src/bootstrap/resolveWorkspace.js\":\"1fc7872018b9ce5f\",\"/knowledge-medium/pr-preview/pr-1917/src/bootstrap/workspaceBootstrap.js\":\"fd35e6f681261a2a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockComponent.js\":\"3afbbebea32aa0e9\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockCrumbs.js\":\"4cfb60d1490f4a8d\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockEditor.js\":\"b7dc5f06fbebbade\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockLoadingPlaceholder.js\":\"e369c81785a84b0f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockProperties.js\":\"5d159f95453221d0\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockSearchPicker.js\":\"4424ae1f12319c16\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ConfirmBulkDeleteDialog.js\":\"ed0c8cb11aa6bc39\",\"/knowledge-medium/pr-preview/pr-1917/src/components/DividerHandle.js\":\"c5cca73dbff4bd5f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/DraftEditor.js\":\"abd365a1e6a67dde\",\"/knowledge-medium/pr-preview/pr-1917/src/components/GutterPill.js\":\"b92f252e52d9c382\",\"/knowledge-medium/pr-preview/pr-1917/src/components/Header.js\":\"a26bf3751981603d\",\"/knowledge-medium/pr-preview/pr-1917/src/components/LazyBlockComponent.js\":\"860224f0460395d7\",\"/knowledge-medium/pr-preview/pr-1917/src/components/Login.js\":\"9175ccffffca97f4\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ZoomableSurface.js\":\"2bd4d8f824a353fd\",\"/knowledge-medium/pr-preview/pr-1917/src/components/editModeKeepalive.js\":\"5e0c7409189574b4\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyDisplay/PropertyDisplayScope.js\":\"453e50063445d847\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"83491dc8c1a63bdf\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/RefPropertyEditor.js\":\"494d4825f7e3850a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/RefTargetTypePicker.js\":\"1247debf2e087761\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/SelectPropertyEditor.js\":\"4afe26dbd829fd93\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/TypesPropertyEditor.js\":\"b9e25a2d3523d325\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/defaults.js\":\"b0fc4200c7a3c0ed\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/kernelValuePresets.js\":\"6e5c52c48b037047\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/selectablePresets.js\":\"1e1882e8aab94d41\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/typesPropertyUi.js\":\"d1d99faa10cc844e\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/AddPropertyForm.js\":\"4bc503ff4471df87\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/PropertyPicker.js\":\"71cdd93a16f31d24\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/PropertyRow.js\":\"9e88b6b0e28f3108\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/Rows.js\":\"d8999fc60e28b9fd\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/actions.js\":\"231da6081e27419f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/declarationOnly.js\":\"631fae7f6ae10da2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/layout.js\":\"afd58233b551a3dd\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/model.js\":\"77c28213e6fa5b82\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/shapeUi.js\":\"2c7b51863ab59d7f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/shapes.js\":\"40ec65e7a0977cc2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9df9fb0c030ad3c6\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/visibility.js\":\"46c35b72095d8ef8\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanelSections.js\":\"b527e95a63953de0\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/BlockEmbed.js\":\"01a854b1ae25c653\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/BlockLink.js\":\"d5f02b1598029c31\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/BlockRef.js\":\"fcb46b72ff74d9d2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/CompactReferenceLink.js\":\"60a6522a11136b5c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/ReferenceLink.js\":\"f8dd416f4f905352\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/cycleGuard.js\":\"a9455749498d93b8\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/cycleGuardContext.js\":\"b0d4ebe8c66b59db\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/linkInteraction.js\":\"96a12358374a6744\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/referenceLayout.js\":\"ca7b8160e9ad145c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/useBlockRefAncestors.js\":\"6218182404f414c7\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BlockGutter.js\":\"de271ffd3da093ea\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BlockInfoDialog.js\":\"754e20a9383d7d90\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BlockReadText.js\":\"66c18a4cd0f80708\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BlockTypeBlockRenderer.js\":\"bde9f6ef1da43501\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BulletHoverCard.js\":\"e27782b15c92d4ab\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/CodeMirrorContentRenderer.js\":\"d43dfc53af6b9481\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"074b06000e2c7207\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/ColumnResizeHandles.js\":\"1438ecdbcbffebf3\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"84b9593a58ca908f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/DefaultBlockRenderer.js\":\"a1b25bc85d1fc079\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/LayoutRenderer.js\":\"76da0b338579e659\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/MarkdownContentRenderer.js\":\"0ee017145a01f2be\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/MissingDataRenderer.js\":\"eec110eee9b75c42\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/PanelRenderer.js\":\"2d03a9f1dfc21f14\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/PropertySchemaBlockRenderer.js\":\"2e8a8a9a9dde048a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/TopLevelRenderer.js\":\"df8e38026c6e8efb\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/blockGutterMode.js\":\"6339ec0595fca2ec\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/blockTitleText.js\":\"9e0c41923004837b\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/fieldCreationKeydown.js\":\"8e86516700645db6\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/layoutRootContext.js\":\"6c83f01721e975b4\",\"/knowledge-medium/pr-preview/pr-1917/src/components/typeChip/TypeChip.js\":\"544167a05d9db44f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/typeChip/chipStyle.js\":\"9c26ed33f7693bf2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/anchored-floating.js\":\"c0e5fa3cd8cba0a8\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/button.js\":\"84d9ffa9e01bae25\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/card.js\":\"00b8c321ceeb2278\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/checkbox.js\":\"b5f6d437fcec0484\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/collapsible.js\":\"aa85947f0985109c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/command.js\":\"fe43dd6bc3ba2d1c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/context-menu.js\":\"0c6ab5861a09f617\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/dialog.js\":\"9b7a7e76ac21df6b\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/dropdown-menu.js\":\"62d273d952c0bbba\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/floating-listbox.js\":\"b55ba89ec6f62649\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/index.js\":\"f82306897eaa6365\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/input.js\":\"b118552e54f39a24\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/kbd.js\":\"497e31eb7113172d\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/label.js\":\"267addf30fc8b8fc\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/textarea.js\":\"87263585f2e9c1df\",\"/knowledge-medium/pr-preview/pr-1917/src/components/useEditModeYieldKeepalive.js\":\"c255a0c944cb21b2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/BootFallback.js\":\"7e136993dc8ffc52\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/FocusedRowLazyMount.js\":\"5d05b98df87422d0\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/LazyViewportMount.js\":\"eb0352d822b54cf3\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/LocalDbCorruptionFallback.js\":\"4bcdd0baec7d2d59\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/error.js\":\"e1bfcd3be3d1a9c3\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/lazyMountRegistry.js\":\"7e66d85a2aeb47e4\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/suspense.js\":\"9e3743e714542e0f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/CreateWorkspaceDialog.js\":\"aa8ee334d92c0203\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/PendingInvitations.js\":\"b8ddbb92f057b1be\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/SyncProgress.js\":\"79366c2ec2bf7272\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/UnlockProgress.js\":\"4b057729a3122b8c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/WorkspaceKeyGate.js\":\"8777b505333bc4e1\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/WorkspaceSettingsDialog.js\":\"daeef583dedffe85\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/WorkspaceSwitcher.js\":\"814af8db10dae5d5\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/WorkspaceSyncGate.js\":\"83d61b6a57f99acc\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/ConversionFlow.js\":\"14f7ce33b0579360\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/ConversionFlowHost.js\":\"7856d20c279c8ab5\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/EncryptionSection.js\":\"41c811ceaa9b7c3d\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/attachmentPrompts.js\":\"8aab6878a760e39f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/bundleFolderPrompts.js\":\"13e8c807ea0b301f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/conversionFlowDeps.js\":\"c5c207cebe5c78b0\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/conversionFlowStore.js\":\"dd5a69b4a2a4ec0a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/flowUi.js\":\"e489feb0c4d59e36\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/useConversionRun.js\":\"2a5cb945db5805ed\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/keyUi.js\":\"8e9a4a193563c7ec\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/useCloseOnKeyLoss.js\":\"38831fcd39c5625c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/useCloseOnServerE2ee.js\":\"2c37a0a999fcd996\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/workspaceUnlocked.js\":\"115d200f85fab46f\",\"/knowledge-medium/pr-preview/pr-1917/src/context/backgroundSubtree.js\":\"8a28f640aab49b14\",\"/knowledge-medium/pr-preview/pr-1917/src/context/block.js\":\"ca715c76b08a8f0a\",\"/knowledge-medium/pr-preview/pr-1917/src/context/layoutWsContext.js\":\"22226d8b70c2b457\",\"/knowledge-medium/pr-preview/pr-1917/src/context/propertyDisplay.js\":\"335080434bcdf20c\",\"/knowledge-medium/pr-preview/pr-1917/src/context/repo.js\":\"9d90c9537ed8cc78\",\"/knowledge-medium/pr-preview/pr-1917/src/data/aliasClaim.js\":\"c53ce1a8f5a81a57\",\"/knowledge-medium/pr-preview/pr-1917/src/data/aliasSeatNamespace.js\":\"e7b465b220603c7c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/blockData.js\":\"19c8e43821b76f8c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/blockType.js\":\"676ff524c23ec149\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/changeScope.js\":\"09af9e3786794f71\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/codecs.js\":\"dff7e72b67cb1e6e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/derivedData.js\":\"77ac3a3810607d4b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/errors.js\":\"b779c01707817d67\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/events.js\":\"31544f9599193167\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/handle.js\":\"935eeb144af7d5c7\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/index.js\":\"d413693bb2886e8e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/mutator.js\":\"91c9c275fc5f865f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/processor.js\":\"26ff0d0905a1d9fa\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/propertySchema.js\":\"8f013de899680a99\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/query.js\":\"fb3a0bf9856a0b2c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/sameTxProcessor.js\":\"c9898d906fe335a6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/schema.js\":\"935eeb144af7d5c7\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/tx.js\":\"935eeb144af7d5c7\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/typedBlockQuery.js\":\"b3553e471fed2df1\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/user.js\":\"beaced4e84544693\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/valuePresetCore.js\":\"eca55167daf142ff\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/valuePresets.js\":\"0b1322e690830a6e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/attachmentCleanerIOVerb.js\":\"cf975427595d9601\",\"/knowledge-medium/pr-preview/pr-1917/src/data/block.js\":\"8057d00074dd9bc6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockCache.js\":\"fadf1f1edaa255fe\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockId.js\":\"c4d09a1399d606f9\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockLiveness.js\":\"91b438b22a23364a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockMerge.js\":\"202533ee177d75b9\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockSchema.js\":\"eb8e02b790c91f55\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockTypeLookup.js\":\"ad9dbdc7ae2b7d7f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockTypes.js\":\"31577035398dac41\",\"/knowledge-medium/pr-preview/pr-1917/src/data/childrenView.js\":\"d0448bd0f6b891de\",\"/knowledge-medium/pr-preview/pr-1917/src/data/clientContext.js\":\"4510063016ee33f6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/dbFileSiblings.js\":\"acd0bc9f39e576a8\",\"/knowledge-medium/pr-preview/pr-1917/src/data/definitionSeeds.js\":\"e026b3b59dd1111e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/derivedIds.js\":\"9c0646284a4f07b5\",\"/knowledge-medium/pr-preview/pr-1917/src/data/drawnSubtree.js\":\"ff627b38551afb9e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/facetBridge.js\":\"10f21ed6dda6109e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/facets.js\":\"20cd467c4117f3cb\",\"/knowledge-medium/pr-preview/pr-1917/src/data/globalState.js\":\"8f860071c9c8df38\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/aliasClaimRederiveProcessor.js\":\"27da073a0d2c31e8\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/ancestorBatch.js\":\"48b6492db35c9e0f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/blockTypeTypeifyProcessor.js\":\"c17ca77b5ad0bdc8\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/clientSchema.js\":\"ce97db85e77c4be4\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/commitPipeline.js\":\"1f36e1ce91891154\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/devAssertions.js\":\"1a3f9b5f6221f6cb\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/firstSync.js\":\"e7dffdf4c4de5f7b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/freshInitialLoad.js\":\"19acb19e38c86252\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/graphBackfillClaim.js\":\"04e6472539df5c69\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/handleStore.js\":\"34d83800763d1332\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/idleMarkerJobs.js\":\"0291069b9ca3527c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/initialDownload.js\":\"fb09d75b960002c9\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/initializeClientDatabase.js\":\"c21968c41be1f2c4\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/jsonCanonical.js\":\"b8c74c76e0e7e01a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/kernelInvalidation.js\":\"5f96db025802b1d6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/kernelProcessors.js\":\"31542db043446e43\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/kernelQueries.js\":\"2060445ffe67aa95\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/mergeTypeMembershipProcessor.js\":\"b05147c14f615d96\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/normalizeReferencesProcessor.js\":\"fcb719d0d5db3ea0\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/poolInstrumentation.js\":\"0a2fc070e4ffff8a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/processorRunner.js\":\"99fe9345b95683b6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyCellBackfill.js\":\"7832b08b35b58f48\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyChildMint.js\":\"d34b501c778a9649\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyChildrenProcessor.js\":\"69bfeada0792914e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyDefinitionChangeProcessor.js\":\"6140861edee1e116\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyDefinitionSynthesis.js\":\"4379c91fd9eca137\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyKeyScan.js\":\"8172b484abbdcced\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertySchemaResolution.js\":\"1d5bca188e0ab5a1\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyValueEdits.js\":\"d331d86c74226964\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/raiseProtocol.js\":\"80d754a5873e5362\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/readBatch.js\":\"edcd925491b7b149\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/refProjection.js\":\"8dc06bf1cfefcc53\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/referenceTargetLookups.js\":\"c217dfd9c180953b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/referenceTargetProcessor.js\":\"ae6bebc21391d6a7\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/replayMerge.js\":\"08ad6d90a3c3634f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/sqlBinds.js\":\"5bda1fd273043549\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"07f40ba83e2fff12\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/arrivalProcessors.js\":\"616168f67611976f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/invalidate.js\":\"23bbbb22b1e210ba\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/materialize.js\":\"ab15313417452447\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/observer.js\":\"5c0a0e02b6d680a2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/reconcile.js\":\"76c4ca5e4f555df7\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/timingMetrics.js\":\"9fec138fb347f790\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/treeQueries.js\":\"df5f1fedd2ee0baa\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/txEngine.js\":\"b0472a2698ed39fa\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/txSnapshots.js\":\"a07d9d6fd79ea798\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/typedBlockQuery.js\":\"025de5527fb911f6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/undoManager.js\":\"601b6988386f1666\",\"/knowledge-medium/pr-preview/pr-1917/src/data/invalidation.js\":\"56bbc47892b7c517\",\"/knowledge-medium/pr-preview/pr-1917/src/data/kernelDataExtension.js\":\"6bc350932c2c984a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/kernelPage.js\":\"d9bda9db57c97178\",\"/knowledge-medium/pr-preview/pr-1917/src/data/kernelValuePresetCores.js\":\"8ca32f05aef8c31a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/localDbCorruptionSignal.js\":\"7925eeb432546873\",\"/knowledge-medium/pr-preview/pr-1917/src/data/localDbStorage.js\":\"ba49c74bde7391a7\",\"/knowledge-medium/pr-preview/pr-1917/src/data/localDbVfs.js\":\"0e1fb098271b0efb\",\"/knowledge-medium/pr-preview/pr-1917/src/data/localSchema.js\":\"15782af0d8c782f3\",\"/knowledge-medium/pr-preview/pr-1917/src/data/maintenance.js\":\"409464e77213c61b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/mergeProperties.js\":\"d6f91415cb20f6f9\",\"/knowledge-medium/pr-preview/pr-1917/src/data/metricsConsoleHook.js\":\"3c165ac44d668c2e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/migrationsPage.js\":\"abfc2f2fd25e237f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/mutators.js\":\"60b021abf9a3a47c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/orderKey.js\":\"9e718f9b4043ac70\",\"/knowledge-medium/pr-preview/pr-1917/src/data/orderKeyPlacement.js\":\"e40243a1fe8d8a41\",\"/knowledge-medium/pr-preview/pr-1917/src/data/outlineSurface.js\":\"1bec70c894c7c57e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/pendingEditorContent.js\":\"905cc6073626183d\",\"/knowledge-medium/pr-preview/pr-1917/src/data/pendingUploadsSql.js\":\"25feacf37796c943\",\"/knowledge-medium/pr-preview/pr-1917/src/data/pluginStateExtensions.js\":\"d1633ce2986620c2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/powerSyncLogger.js\":\"cfbe9ae0d7e1672e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/projectorRuntime.js\":\"d4a72ed46b28bed1\",\"/knowledge-medium/pr-preview/pr-1917/src/data/properties.js\":\"938a10815b49e2a3\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertiesPage.js\":\"cb1723a8283d7c94\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyChildren.js\":\"dc7b78482ba25c16\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyDefinitionFanout.js\":\"0f444533e35a5a84\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyDefinitionMetadata.js\":\"26d9b24418942458\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyDefinitionRegistry.js\":\"32db5eaa57f8d582\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyDisplayMode.js\":\"b2f439e798103ad3\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyRowCreation.js\":\"14253668341ab80b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertySchemaCreation.js\":\"fce7c9125b04449b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertySeeds.js\":\"72ceeb890bbd3e07\",\"/knowledge-medium/pr-preview/pr-1917/src/data/recentsPage.js\":\"43d4c3ca1055aa50\",\"/knowledge-medium/pr-preview/pr-1917/src/data/refTargetComparableProperty.js\":\"7bd593ea6bd2af78\",\"/knowledge-medium/pr-preview/pr-1917/src/data/referenceBlock.js\":\"225b65e19898cb8e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/rejectedUploads.js\":\"ff7d4bf83d541781\",\"/knowledge-medium/pr-preview/pr-1917/src/data/releasePowerSyncConnection.js\":\"12f088c350d3cfd9\",\"/knowledge-medium/pr-preview/pr-1917/src/data/repo.js\":\"9316a0f4e9050515\",\"/knowledge-medium/pr-preview/pr-1917/src/data/repoProvider.js\":\"2c99d398e8e8d34a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/rowProperty.js\":\"aa3cd4e6b41122bd\",\"/knowledge-medium/pr-preview/pr-1917/src/data/searchFilter.js\":\"4ded5580228affea\",\"/knowledge-medium/pr-preview/pr-1917/src/data/seedIdentityLedger.js\":\"a56820a67adfb9b2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/stateBlocks.js\":\"68242157586e77f6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/structuralEditPolicy.js\":\"eb03f6483a731a2d\",\"/knowledge-medium/pr-preview/pr-1917/src/data/structuralInsert.js\":\"a11ab28905b7abb2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/subtreeDelete.js\":\"fa8ad35b0384a2bc\",\"/knowledge-medium/pr-preview/pr-1917/src/data/syncStreamLock.js\":\"295e6d4b45cec99b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/syncedTableSqlRecognizer.js\":\"eb8e8854c71a8944\",\"/knowledge-medium/pr-preview/pr-1917/src/data/syncedTableWriteGuard.js\":\"b908be748ad93ce6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/targets.js\":\"ea806a79ba17e409\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeColors.js\":\"94c004768fb18fb2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeDefinitionMetadata.js\":\"3899e006d0dd0f35\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeDefinitionRegistry.js\":\"26d56cf3bb58b4a5\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeExtraction.js\":\"b6cae617fb1e304b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeInitialValues.js\":\"8fcfa2981275b46f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typePropertyGroups.js\":\"522eee7e3be4a87b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeSeeds.js\":\"1295c27fe21ab390\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeTagger.js\":\"cd818fadbf1f39e6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typedRecords.js\":\"b9a52580e76f60a3\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typesPage.js\":\"bf03984c710a040f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/userPrefs.js\":\"062f0ed1bec951ff\",\"/knowledge-medium/pr-preview/pr-1917/src/data/userSchemasService.js\":\"897a8407a92fb0ce\",\"/knowledge-medium/pr-preview/pr-1917/src/data/userTypesService.js\":\"a659097af21f23ee\",\"/knowledge-medium/pr-preview/pr-1917/src/data/valuePresetRegistry.js\":\"8e73a3f5abded391\",\"/knowledge-medium/pr-preview/pr-1917/src/data/visibleChildren.js\":\"914176f211b4e8c5\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaceConversion.js\":\"d5c8ee5a6d756b93\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaceFirstSync.js\":\"ca06a57f59855f37\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaceIdNamespace.js\":\"2af2bde606a5df8c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaceSchema.js\":\"bbfceddd88454831\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaces.js\":\"c7a7d1d6bcf6e383\",\"/knowledge-medium/pr-preview/pr-1917/src/data/writeAheadLog.js\":\"ce157c53ad59e77d\",\"/knowledge-medium/pr-preview/pr-1917/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/BlockPasteShellDecorator.js\":\"a1a14f49ced7ba91\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/atTrigger.js\":\"8e9d50540475d511\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/autocomplete.js\":\"c9ee0d0bc1e9330d\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/codeMirrorExtensions.js\":\"1e7bc712a72eb111\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/contentFlush.js\":\"e185d6cd6f7b66c3\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/defaultInteractions.js\":\"85659b0f662551e3\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/editSettleSignal.js\":\"bc62a15d3feeecc5\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/insertImage.js\":\"9985a811f994a842\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/referenceCompletionRange.js\":\"a66791ac5671d168\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/referenceTargetTypes.js\":\"221f266af0a3b5d9\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/syntaxContext.js\":\"c9a31f7cce154538\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/triggerMatch.js\":\"a4d5336f54e154a2\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/AppRuntimeProvider.js\":\"12ce9b3d2331dcc2\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/BlockFocusShellDecorator.js\":\"2a8a051d622660df\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/ExtensionRenderBoundary.js\":\"be4f9081bc98890d\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/PanelContentRecovery.js\":\"9d90d70be0348e44\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/apiCatalog.js\":\"48c4811694b6c823\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/approveExtensionHere.js\":\"49d6368f09aeb98e\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/armedCutAppMount.js\":\"a3af0cabc57693c8\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/batchableKeyedStore.js\":\"cb1328e4eec1ebb7\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/blockInteraction.js\":\"de3e092e915965fb\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/blockSelectionAction.js\":\"e33d1f8c0f0015bc\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/compileExtensionModule.js\":\"8eadaf93b6dddbd7\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/compiledModuleCache.js\":\"4cf256511040af23\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/continuousGestures.js\":\"2de26387f62d51d5\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/core.js\":\"5d5c278ed7083c26\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/defaultRenderers.js\":\"a8a744b322048b30\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/definitionFanoutAppMount.js\":\"50aae84ed72096dd\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/dialogAppMount.js\":\"f555d48b18456bd5\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/dynamicExtensionSeeds.js\":\"ac0a54a075e41fe4\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/dynamicExtensions.js\":\"6ff43b3e553dcc57\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/exampleExtensions.js\":\"5f37490dbfdf1c51\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionApprovalStatus.js\":\"f8e9f26c0fdef1b3\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionLoadErrorToast.js\":\"08e8e83e32ca5474\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionLoadErrors.js\":\"fa67e3a56da77144\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionLookup.js\":\"6a0de06a41fea65d\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionToggles.js\":\"e0aaf788c01237ad\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionUtilitiesCss.js\":\"4d05a29c8ecf703f\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/kernelPageDeletionGuard.js\":\"debf924064a48356\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/liveRuntime.js\":\"701ca3e8f62aa2e3\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/openExtensionsSettings.js\":\"ddbe2cfcba49b705\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/overridesCache.js\":\"eb1a6915d5c8fb93\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/pluginIds.js\":\"029579c4d136cb21\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/processorRejectionToast.js\":\"2d4f41d375b9eaee\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/runtimeActions.js\":\"1e428454287f3913\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/runtimeContext.js\":\"441001c3d72a5ed3\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/staticAppExtensions.js\":\"cd775853888c5440\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/staticDataExtensions.js\":\"f8149d61d9c501a4\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/toastAppMount.js\":\"c7fe6a03ca1aaa01\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/useOverrides.js\":\"65bd68001e04f485\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/useShortcutSurfaceActivations.js\":\"5d92762420a2c1c3\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/discoverToggleTree.js\":\"b10d5a6ec6cc4c54\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/facet.js\":\"e7837dcd3d97906e\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/resolveAppRuntime.js\":\"2a750e98b1da3fb7\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/runtimeEvents.js\":\"ce2e4a4864033dd9\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/togglable.js\":\"7f5a886f2fec1128\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/variantFacet.js\":\"18b594627d701eb4\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/verbFacet.js\":\"023a4432e0ad176e\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/block.js\":\"2d0742e5d16e370f\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/focusedChild.js\":\"60eca557742ce1e8\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/propertySchemas.js\":\"588105dc0691539e\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/typeRegistry.js\":\"9cc35d788f13ffe6\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useAncestorCrumbs.js\":\"213762315be7143a\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useAutocompleteListbox.js\":\"401013866056e1c7\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useDebouncedSearch.js\":\"ada37ca69fa705ff\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useDebouncedValue.js\":\"ae324a466f21e76e\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useFacetValue.js\":\"f1a300a7b09bfe8b\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useIsFocalRender.js\":\"dfb68c572bf7c430\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useIsReadOnly.js\":\"89a2ac695ffff62f\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useMaterializeBacklog.js\":\"cecdd361a1bac382\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useMinuteClock.js\":\"6fe69fb9b0c2edd7\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/usePanelLayoutProjection.js\":\"8942fa392e4f5803\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/usePendingInvitations.js\":\"48cd0db770ab2abd\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useRendererRegistry.js\":\"9d6ef906342d24ae\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useRetainedFieldRows.js\":\"03b59038e4507455\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useWorkspaces.js\":\"83117c65b4176951\",\"/knowledge-medium/pr-preview/pr-1917/src/lib/utils.js\":\"a4ca196c4390903f\",\"/knowledge-medium/pr-preview/pr-1917/src/main.js\":\"bf0a7aebfbeefe98\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/MarkdownImage.js\":\"b1091c87dec9a8e5\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/blockSeparators.js\":\"9f67c7e775adedca\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/context.js\":\"2e1ba897e80e9225\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/defaultMarkdownExtension.js\":\"ec659aeeef703ff1\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/extensions.js\":\"ad404e61e0e2f8e5\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/renderMarkdownHtml.js\":\"53c180900ade29c5\",\"/knowledge-medium/pr-preview/pr-1917/src/minimal-editor.js\":\"3af892427c736178\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/armedCut.js\":\"00b0450f39fa534e\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/captureMediaVerb.js\":\"2245f40a15e3e004\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/clipboard.js\":\"4c9f5c06620816fb\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/decision.js\":\"2f78fc2874a8b7f1\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/operations.js\":\"2fd913f095ad63a6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/account-header/AccountHeaderItem.js\":\"2afb2a9341c6ff6a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/account-header/index.js\":\"c165b998ab10a72c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"98fdebd44ac89033\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/askAgent.js\":\"6e139de68455aaef\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/askedStore.js\":\"5705f856b0f8b1c2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"31a64a57e7ef4957\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/chipState.js\":\"4d853c8492987e56\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/dataExtension.js\":\"a3796f8c35cdfc8b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/index.js\":\"78eec674be3ec2b8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9f061c7033ba5a5d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/schema.js\":\"129aae922b52b9d8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/AgentTokensDialog.js\":\"7a4b97382774c221\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a7f28484af175405\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/addMedia.js\":\"b5c4df36efe029cc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/backlinks.js\":\"12e13b6676bda2c9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/block.js\":\"fd5e1fc737e298a2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/context.js\":\"f720123102963a36\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/displayIds.js\":\"098043a58b539ad5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/index.js\":\"04bb58f57e84200f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/outline.js\":\"3ed3575cd288c2d6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/properties.js\":\"852371f74b67f52a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/refs.js\":\"f6e20b3e5c6cd234\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"8be6b286949f4813\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/search.js\":\"bb1a0bd8813edfd8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/shared.js\":\"d87c0cf8102453f9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"804eabc12b75e977\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/text.js\":\"c20b26cfa4ce4c98\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentWrites.js\":\"cd6aa56501a8caa2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/authoringCatalog.js\":\"ac066b952cab673a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/blockRefTargets.js\":\"9703bd66c4874258\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/bridge.js\":\"eff44459d011a3a2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/bridgeLoop.js\":\"6154427418493b9e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/changeHistory.js\":\"eab6138da85fdefb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/commands.js\":\"da3ac5f5e4cf16bf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/commentsCommands.js\":\"41b34d423f0c2c9a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/dataExtension.js\":\"56407962d5b26d82\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/dataModelGuide.js\":\"452f50aac1c01db7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/dayPropertyInputs.js\":\"58264da9777eca28\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/describeRuntime.js\":\"b72a114bf22e9b0c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/extensionLint.js\":\"1b1ac8e31c48ca78\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/grainAudit.js\":\"274a079111906441\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/healthCommand.js\":\"2024939e65cb17b9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/index.js\":\"974c27228fb7fb4a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/presetIdentity.js\":\"3eeb10d2243687bd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"2a5397daa102677b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/readMedia.js\":\"f722179b1eabf425\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/schema.js\":\"f79bbe39ef38fd4b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/serialization.js\":\"6c93ca8fd4b70509\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/targets.js\":\"9760f66b87eaacef\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/tokens.js\":\"891bedff1eeae2d3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/watchEvents.js\":\"eb19f82744ae897b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/workspaceGuard.js\":\"b672451412f42f07\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/writeCommands.js\":\"07024750ca321207\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/AliasCollisionToast.js\":\"19ee4ef51e22e641\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/DuplicateNameBanner.js\":\"694a09ec814bfd79\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/collisionMerge.js\":\"a1921033cbcb5078\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/dataExtension.js\":\"1afbf748c0d3ea69\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/index.js\":\"cd6b2e03eb274a84\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/mergeCollisionAction.js\":\"f87ab853d9481df3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/pageStyling.js\":\"0756957d7b3d7c0e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/rejectionToast.js\":\"a48901b1f03a836c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/syncProcessor.js\":\"ced2cd6884a77ac0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/actions.js\":\"86467c154a61848c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/addComment.js\":\"696e2adf78f1d628\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/anchor.js\":\"1f00840e5d770223\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/anchorState.js\":\"3214f4c99fe73e22\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/commentLinks.js\":\"437ff3b0d21a2b47\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/confirmThreadDeletion.js\":\"6b352e74cda2f81e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/container.js\":\"15ff5c3b5a1ac053\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/dataExtension.js\":\"d20b0c35e4adc87e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/deleteComment.js\":\"c77e316a5350869c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/highlights.js\":\"65a194dcf6d488a9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/index.js\":\"b48914e11bc8bd77\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/linkedCommentsPill.js\":\"1ba5d41a4bf70ec4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/margin.js\":\"0b10637e9d7d383a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/marginAnchorLinks.js\":\"890596398af0e2d7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/marginSchema.js\":\"8ad820c9f2be9dcd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/newComment.js\":\"847e4fa2f2370312\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/ownThreadPicker.js\":\"5022c6c73aff7be8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/placement.js\":\"688844a9ef7c65d4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/queries.js\":\"fd8c7c416f8ffb1f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/quotePosition.js\":\"9fd106a70aec290a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/quotedIn.js\":\"e6bce842592411c9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/quotedRange.js\":\"548668d5658fddf6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/rangeRefs.js\":\"ac4ce5a56e9e0837\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/readHighlights.js\":\"4e7aab49df5ee18d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/readSelection.js\":\"bde275678710a8c5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/readSelectionUi.js\":\"8b3b9e69a5d86d57\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/reanchor.js\":\"843d0fc4f50cb811\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/schema.js\":\"a65e58481aa7902a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/scope.js\":\"4e6b78afac3c03f4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/scopeThreads.js\":\"505a8ff981fa604b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/splitRetarget.js\":\"c86cf39bb2e71da1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/suggestionCard.js\":\"80e523e9fdb8db01\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/suggestions.js\":\"d295c7b59a7ba920\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/summaries.js\":\"dca398a944217888\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/summaryBatch.js\":\"56e0ff2b957c4d35\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/surface.js\":\"6c86789d03552f39\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/threadNavigation.js\":\"e11b26a3804311d8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/threads.js\":\"ecfbfe66e5476288\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/ui.js\":\"a8aab52476b2cf7b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/uiStore.js\":\"2d5a3bbc0df17203\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/app-intents/appIntents.js\":\"6f9a0be31f7b33a4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/app-intents/index.js\":\"716fd92f34a82de6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/app-update-prompt/index.js\":\"2ee2098aa4b0ffbe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/app-update-prompt/status.js\":\"3b96b59f6a2fd32e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"8440c810516e2357\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/MediaBlockRenderer.js\":\"e0657ab72ffe9a43\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/MediaDownLaneReplicator.js\":\"e54645b47b8c527b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/MediaUploadReconciler.js\":\"4ef403d75a731bba\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/assetDownLane.js\":\"d3e9ee6fe02d9216\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/assetResolver.js\":\"e6d65907044dd7a5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/assetUpload.js\":\"f9507914acc65471\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/attachmentCleanerIO.js\":\"716797e4a83ecc46\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0d9388fbca1f5dff\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/blobStore.js\":\"76994aa254ba3d0a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/browserMedia.js\":\"ec7897d2d4c9f8dc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/byteStore.js\":\"b45099fd461646ed\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/cleanerIO.js\":\"808214d7d6caf8ce\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/cleanupAttachments.js\":\"7d920f55429047e7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/dataExtension.js\":\"24a4c0f52fc8aad8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/downLane.js\":\"f90569ee1ee23f4e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/index.js\":\"a95141b8876a5913\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/insertImageContribution.js\":\"4ca430f5c3a3e37a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/laneArming.js\":\"5e3ffcdcb94e9249\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/laneLock.js\":\"ef7b38f0ad16d368\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaBlock.js\":\"1daf2596d2351751\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaCapture.js\":\"3b25316a561f0cd2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaLanes.js\":\"e9392a2bfb484128\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaViewers.js\":\"b1598a96f5df4602\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaViewersFacet.js\":\"c2ce89d32decd6aa\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/pasteCapture.js\":\"6471243bd5cb8fbf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/resolver.js\":\"938014f980a35d31\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/retryUploadsAction.js\":\"fc91b40f11d1e34b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/storagePaths.js\":\"4e6ac9f9c00c5844\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadDrain.js\":\"21733378545e35d1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadLaneStatus.js\":\"e028f3e2ce007069\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadReconcile.js\":\"49442c2e52eaee1a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadRecovery.js\":\"c2f829502a1da99c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadStore.js\":\"8266ca4ed7d7cad2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/useAssetObjectUrl.js\":\"c415b06e72e86bfe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"f6781c7e3f9c14b3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/BacklinksViewSection.js\":\"ffb312f317f63fe9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/facet.js\":\"7ccd4d4700269b54\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/index.js\":\"6fbb16980507a86e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/prop.js\":\"5ab9aae512bdff7e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/BacklinkFilters.js\":\"54c1125115ec3d5e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"52fa9872887aa4fd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/BlockEntry.js\":\"9e4472a53d4ba93d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/LinkedReferences.js\":\"1a281c2fc27765a6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"b1c73eb111b58479\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/dailyNoteDefaults.js\":\"386392e128a7baf4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/dataExtension.js\":\"578e5b8255b7a7f5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/edgeExclusions.js\":\"49900af78b3c4653\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/filterProperty.js\":\"f0ca0bc2c03da1fb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/index.js\":\"6abfd74ebaa8eab5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"66cdab859a589d9b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/applies.js\":\"5805bf9197da8f33\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/countQuery.js\":\"0d889d229611ddbc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/expansionStore.js\":\"8e8c5ef036031546\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/index.js\":\"a7f4e7f2fd194d28\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"f993e2e2217200c6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/presentationInvalidation.js\":\"71d36e7789a0af3e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/propertyEditorOverride.js\":\"c7b7c8f481bb6ffd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/propertyFilter.js\":\"61e6792ec21be4ff\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/query.js\":\"9e12313ad87f9a08\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/resolveFilter.js\":\"4efd559c920a3d89\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/sourceBatch.js\":\"cab9a71568a09c4e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/sources.js\":\"23ff874c6c9416d6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/useBacklinks.js\":\"857667360336b655\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"66ae9e0702f3c3d1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/BirthdayCelebration.js\":\"5afd85bf2d48e4db\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/BirthdayOverlay.js\":\"bbd38f6eb87029c0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/gate.js\":\"539e26175279d104\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/index.js\":\"787ae1eaba0aec84\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/wolfTheme.js\":\"304274f42fd8c7af\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/BlockDragLayer.js\":\"1e5b58208a675518\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/dragController.js\":\"488ce8b88da81107\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/dropTarget.js\":\"502155ac365de21b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/index.js\":\"58fea38eb486af0a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/projection.js\":\"4f3e9343e6b09bc2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-info/BlockMetaCard.js\":\"8c25d2171cc3e94a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-info/index.js\":\"9402e2c8fedc67b5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/AddTagDialog.js\":\"ef65d32119c4284f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"a2457f61d541462a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/TagNameIssueHint.js\":\"73ecae9f59b99212\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/addTagAction.js\":\"c2517564dcb90406\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/appendTag.js\":\"2ba979cb55dbf9d0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/config.js\":\"2b0d97d7c40f33fb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/dataExtension.js\":\"72c256554b506ced\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/index.js\":\"bc92fb38620e1737\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/propertyEditorOverride.js\":\"cdc48af2dc82987b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/BreadcrumbList.js\":\"b101ea8112bda8f3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"94cd8d61bb816b80\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e5b1aac1b3678bbd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"6495074084888891\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4196e328c25e5f08\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/index.js\":\"068c01afdec9470a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"86b2a604aa322e5e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/CharacterCountItem.js\":\"1f43a05681928509\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6e319f987d6db09a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/actions.js\":\"bce3757f716a788a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/blockType.js\":\"0a137550cf25eb4a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/charCount.js\":\"57c1f7e593987919\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/dataExtension.js\":\"0516fa5274cbeb10\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/index.js\":\"2a8e4b675f1d7fcc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/profiles.js\":\"d8a288725fe9e458\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/properties.js\":\"8487272b860812f1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/subtree.js\":\"684de8eb9499a9fe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/textCounts.js\":\"eb7fff3b2316a2c8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/colemak-keybindings/index.js\":\"a20bcce29dfd682d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/CommandPalette.js\":\"2b462d0c511d600a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/HeaderItem.js\":\"28bf3c9181e744d9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/context.js\":\"d4c914b36e882480\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/index.js\":\"17881054e908b602\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/selection.js\":\"cda2735e9d6a430a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/toggleStore.js\":\"c4faf40d2c746070\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/useCommandPaletteActions.js\":\"83cc1b65094e1390\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/ContributorBadges.js\":\"64bf066a7f938327\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/ProfilePicture.js\":\"f94bfa8b402ad61d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/author.js\":\"f6d49b9bf636cce2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/codeMirrorExtensions.js\":\"b893f48191f4b6dc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/dataExtension.js\":\"73fccbfe41d011db\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/index.js\":\"9aaa1cd2eaba808c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/mentionAutocomplete.js\":\"d7601dcad073499c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/processor.js\":\"cd04fa542231d49f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/profiles.js\":\"8336438fb7783336\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/queries.js\":\"7c6faf7695b5bfbf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/schema.js\":\"559b2e400ab07193\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/useCommentAuthor.js\":\"b35f613bb6bbe19e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"952e3052cbbaff8f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/followOrigin.js\":\"cf9cc48279189455\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/index.js\":\"501cf10565bbe58b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"5776f66d29f61e4b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"54fc877cf402b8fd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/CalendarGrid.js\":\"680db991d6106408\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DailyNotePicker.js\":\"03694caecdf11671\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7e0ae40c5839f36d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DateNavDecorator.js\":\"61e84267a69f1329\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DateScrubOverlay.js\":\"d803488e5ab554d1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DayPropertyControl.js\":\"bc74d8a1abd9589a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DayValueReferenceControl.js\":\"1fb6bd85ff0ac3f4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/HeaderItem.js\":\"183aba3bd0171f28\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/ReschedulePicker.js\":\"9dc6778c86e0de83\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/SpreadDatesDialog.js\":\"574054d00c86a935\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/actions.js\":\"570579fb2ff4445e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/blockDateAdapter.js\":\"2352c500d8691142\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/calendar.js\":\"c9320f1e4510d86e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dailyNotes.js\":\"73a2a98bb64d5154\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dataExtension.js\":\"255488192db0e53a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dateScrubActions.js\":\"c7855b3f51737ee0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dateScrubGesture.js\":\"9f219be0f5447053\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c7a261e2b129bdad\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dateScrubRecognizer.js\":\"de980ad87e2a61e5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dayProperty.js\":\"a0d718baf807cef0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"e3d4502f6a3fa1bd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/deletionGuard.js\":\"bc08ed0481224ad0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dueQuery.js\":\"deb2df5cc67a6d7b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/index.js\":\"8536b48a997c2b49\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/landing.js\":\"c1b746f6c08facf6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/localSchema.js\":\"d2bd4173938484f8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/referenceDateAdapter.js\":\"78a53219546addf6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/rescheduleAction.js\":\"cc0093b3f1785942\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/schema.js\":\"b4c76b2f4b2e413a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/spreadBlockDates.js\":\"8c42c1a045084726\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/spreadDatesAction.js\":\"e0491d7798ae665e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/today.js\":\"6dda599409c56710\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"4685e0f56b26dbf7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d0f6c2727d1d1de0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/audit.js\":\"bc6a3a9f12aaac14\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/auditAction.js\":\"ae0f4f0ccd6bfa68\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/auditRanges.js\":\"8177255546bac611\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/diagnosticsSource.js\":\"478d9f5114c65065\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/divergenceScan.js\":\"2a7afab497b5abc3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/index.js\":\"3015b9869ecc9e65\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c384c11348144a61\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/referencesMirror.js\":\"1dd661ba288eb5f0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/rowJson.js\":\"9ce7648cad76d960\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/schedule.js\":\"d075d534a742ad0d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/store.js\":\"104b916c88ce0a04\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-maintenance/action.js\":\"ae87a9b5eea441f9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-maintenance/index.js\":\"dc145e32e349e0b1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-maintenance/plugin.js\":\"3321885067aa67f7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"9042d58a4459b96c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/actions.js\":\"0a76dbf022ee7b52\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/changeMarker.js\":\"48417303d29be970\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/diagnostics.js\":\"ff378af08a02af48\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/fileSystemAccess.js\":\"824ca44b2f99827d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/filenames.js\":\"3287d6278dcbfc64\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/index.js\":\"c301d98c4e1a6a60\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/mirror.js\":\"21e646480522e17c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/runLock.js\":\"851122d818c2c30e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/runtimeHealth.js\":\"700c9ad38d4a4516\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/schedule.js\":\"3e3821a067e371bf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/store.js\":\"d39a3e2dc3e9c82a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/default-themes/index.js\":\"1dbe64673abdf2f8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/default-themes/themes.js\":\"a82057eff76cce66\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/diagnostics/facet.js\":\"5a50aa35405543dc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/diagnostics/useDiagnostics.js\":\"dfc1c267a4a8738a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extension-prompts/dismissals.js\":\"8fe314eef0bedb24\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extension-prompts/index.js\":\"9c31b14f33fa0769\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extension-prompts/status.js\":\"af1b5bce8f038805\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extension-prompts/store.js\":\"cfb6d3a9bf8b229a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"6d7d920897c5b220\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8e3f3507fe3a32b6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/actions.js\":\"2b7827dcaef60361\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/config.js\":\"3b5b53fab3ec4ff7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/dataExtension.js\":\"2c01bd53647655a4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/effect.js\":\"3c79084b34f1c563\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/index.js\":\"bb88c022e9dfffdb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/propertyEditorOverride.js\":\"2fa379ad30d64edc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/useToggleTree.js\":\"dfd84429b8af7677\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/ExtractTypeDialog.js\":\"8d1e519f1ed5d50f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4df607238957231d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/PropertyShapePicker.js\":\"fa0684000e4163d6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/action.js\":\"cd81aefbe92a6558\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/index.js\":\"e05c61579fb84e69\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/FindReplaceDialog.js\":\"9272bf5d07385f34\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/HeaderItem.js\":\"7f69beeb96ecfb27\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/dataExtension.js\":\"7cc4e7005cb62669\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/index.js\":\"c774316875462ee9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/search.js\":\"eb7aaeefe401197f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/toggleStore.js\":\"c71960b55b7128b9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/LocationPropertyEditor.js\":\"8208d3e4ea1e77c4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/MapView.js\":\"0740a440d4c552d6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/blockTypes.js\":\"04ddbb137ab60f72\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/codeMirrorExtensions.js\":\"26e88786716a5ea2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/createOrFindPlace.js\":\"8170c01cd83cf13e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/currentLocation.js\":\"1868c4f98c0228a6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/dataExtension.js\":\"6805f9f9bf28095b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/geoContentDecorator.js\":\"174366d601f242bf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/googlePlacesClient.js\":\"7db096c642bedb18\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/index.js\":\"77dd3b234f078181\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/locationsPage.js\":\"180b82dbd5e99860\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/mapViewport.js\":\"3f3caebcf4241678\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/pickCurrentLocation.js\":\"bcd558333af1f8e4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/placeAutocomplete.js\":\"b046deba482094b6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/placeNameCollision.js\":\"17ce08b578e3c029\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/properties.js\":\"7689e2235d5ea72f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/propertyEditorOverrides.js\":\"d037e1465cd29367\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/query.js\":\"62dfcafac839d8f9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/usePlaceSearch.js\":\"b6af18db7d7602e1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d0d8ece1a483397c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"de521ef06a073ebd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"3c0b9a92190d92a6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/config.js\":\"ab7dd9ac458339ac\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/dataExtension.js\":\"52cd19d152057e0b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/facet.js\":\"2b7d30ae920b91d6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/grouping.js\":\"b4c7bfd7e0b7528c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/index.js\":\"75ad48b24381d79c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"5894b52ae5759ce4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/query.js\":\"f21f25b835cd1099\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/resolveConfig.js\":\"b0ed506b991ae185\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"bbab978a4a482ac7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"cfe9e10259e6fab3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/HtmlDocumentContent.js\":\"c2cba7bf40998357\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/HtmlFrame.js\":\"e094b5dc7e404108\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/actions.js\":\"8acae88e7124732a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/blockType.js\":\"26a0f8e3cecd7eb3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/confirmRunScripts.js\":\"3c0e84da2b7f67a5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/dataExtension.js\":\"071c7229f4ee819a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/frameAnnotations.js\":\"b8597f9d77364e08\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/frameDocument.js\":\"fd78211d282b513e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/frameTheme.js\":\"991dd5321219e902\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/index.js\":\"449cdd2bde596985\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/scriptConsent.js\":\"5097eeb6c5819d85\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/sourceMap.js\":\"03c29d55d9ef20fe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/useDocumentScripts.js\":\"1bf4c5c7200a3d0a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/index.js\":\"ba47a717bad4babc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/record.js\":\"142eebe2a4672d5d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/recordStore.js\":\"e26542933833d1a3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/responsiveness.js\":\"c2c1db8ae976dfcf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/schedule.js\":\"1e59293ace6b2879\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/sessionContext.js\":\"723aa496e24c1e5b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"637964e5ebac6106\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"357db395e3611f2b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/actions.js\":\"c8794723b3c3b054\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/config.js\":\"b624c895de84d88e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/dataExtension.js\":\"621a30ff1bd99248\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/effect.js\":\"82dc897c61d36ec9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/index.js\":\"ac9d0bbd5b479467\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/keyCapture.js\":\"30ba398c932edec4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/overrideStore.js\":\"a1eb04c4949b2b92\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"d3ac5b58d64ec279\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/HeaderItem.js\":\"c02183fe12c231b8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/LeftSidebar.js\":\"299cbfa8fa449a01\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/actions.js\":\"5b66e680194ae1a8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/facet.js\":\"b7a975c995f05d2b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/index.js\":\"2502237c0ecad943\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/shortcuts.js\":\"6e20171d963c110c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/toggleStore.js\":\"6c979decac54842a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/merge-blocks/MergePicker.js\":\"541676341a27180a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/merge-blocks/index.js\":\"7dc33f104c98a4fe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/merge-blocks/mergeAction.js\":\"183bf37c590b545b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/merge-blocks/strategy.js\":\"fc6992d19f5622a4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/Button.js\":\"7fe1a6872cf9b4f0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"1d645c25b9c20dbe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0f2f26ed1b80e5a2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/facet.js\":\"0833afed4d08b247\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/index.js\":\"ceba3d024fa38bc5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"fc30b1faae79e70e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/actions.js\":\"43127d301d9d589b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b203cdd4d8a5ab0e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/facet.js\":\"6e156a9d22053a87\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/index.js\":\"4cfdc343ad6855cd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/MoveDestinationPicker.js\":\"85bffab9d0e512af\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b5b283ca6777e158\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/contextMenuItem.js\":\"83d5440bbd6ed188\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/index.js\":\"0122ae5309430299\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/moveAction.js\":\"0c99194d647165d4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/moveBlocks.js\":\"7eea0f31f5734952\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/selectionAfterMove.js\":\"48b26f9302d18f6a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/TutorialBanner.js\":\"df0a9833f31b1a48\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/action.js\":\"639526410187556c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/bannerDismissal.js\":\"93f21d75eac3c986\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/documents/cheatSheet.js\":\"6e3e1e9cf8c556b9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/index.js\":\"cbf0b4efd6dcc278\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/keys.js\":\"df1a44591ec46b8b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/landing.js\":\"ad475d0c623d8699\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/outline.js\":\"f9f95f09a64bf799\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/seed.js\":\"f8f0ceb39f235c47\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/PerfTrendDialog.js\":\"5bcb5cc72667e9df\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/analyze.js\":\"3e18b9e81cac603f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/diagnosticsSource.js\":\"81a415f12f3a7e99\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/index.js\":\"d383ee492ec2b23f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/load.js\":\"3c04ca61b6402ec6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/monitorRun.js\":\"aa61090aa9ff5ab6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/schedule.js\":\"aed790ee2382e34f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/series.js\":\"70da7cb81efe13e8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/store.js\":\"dcfc6018ae36c9b9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/trendAction.js\":\"02d180dbdf8718d5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/verdict.js\":\"17d187366795826e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/plain-outliner/clickToEditAction.js\":\"40a7f37b2eb8cd92\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/plain-outliner/index.js\":\"dc2f764ee2a753d7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/plain-outliner/interactions.js\":\"3b3b90bf713a9249\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"1f5657074c610694\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/MigrationGate.js\":\"6b01bd8513e85f52\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/MigrationGateDialog.js\":\"ec7280d08dc499b0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/action.js\":\"5f44ea8c54e17d2b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/index.js\":\"2f163717026b3467\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/localRunMessage.js\":\"a3334da8e50111c0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/plugin.js\":\"ed66d3d32d215d50\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/progressReport.js\":\"398005fa44d02f70\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/sweepProgress.js\":\"de9a8d10209fc1a2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/FieldRowRenderer.js\":\"e93fe75eb38e2419\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/ValueRowRenderer.js\":\"eafb115955c888a9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/actions.js\":\"1224940ec1778b74\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/autocomplete.js\":\"0515cf317361e474\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/fieldRow.js\":\"16e29e21cf728efb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/index.js\":\"f7a53aad8b11ab22\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/referenceWarning.js\":\"89d94e8d7c446c51\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/valueAutocomplete.js\":\"4a07f98c762501fb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/valueSchema.js\":\"45838a771f4f52fd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/HeaderItem.js\":\"3cb085f5239ec25e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/QuickFind.js\":\"6d1ee63d7abf4a63\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/index.js\":\"f78c1220fda6f63a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/recents.js\":\"8929f40ed3487c3c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/resultItems.js\":\"5c022a673e583d09\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/selection.js\":\"752a141be583dc4b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/toggleStore.js\":\"be684c635f78bf3c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/HeaderItem.js\":\"de69ee65c977b286\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b7f0d30bc0509ea8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/grouping.js\":\"5b3fec9efe8e1902\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/index.js\":\"fbd3db7086a82eec\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/target.js\":\"8b014b7ab3472bb3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/codeMirrorExtensions.js\":\"84020beaa1bbb391\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/contentPrefill.js\":\"4018b7593b808101\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/dataExtension.js\":\"77976a06b043e03d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/index.js\":\"266c6e97f213e392\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"ad7059e3d1011e52\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/invalidation.js\":\"2cf8137c16300dff\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/localSchema.js\":\"5235d69ceab95ac9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/blockrefs/index.js\":\"4bed3a401688f698\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0271bb6e32517b68\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/index.js\":\"3304555cf33fa3c8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/referenceNode.js\":\"f0cc267bd98b1d6d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/remark-reference-occurrences.js\":\"d78011d8a5cafafd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"ea69862302751528\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/wikilinks/index.js\":\"642e71f82abe0732\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fb849a7b03472ea0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"cea6a88d04121273\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/mergeRetargetProcessor.js\":\"19295bcd70282af1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/parseFence.js\":\"bf40017f2d277fea\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/referenceParser.js\":\"605fd22575554468\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/referenceProjection.js\":\"ee50290987fa3406\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/referencesProcessor.js\":\"07a52d5ab1544095\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/renameProcessor.js\":\"7ccf614bef7a9310\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/spanReplacement.js\":\"3920c7cdab51d895\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/rich-paste/htmlToOutline.js\":\"0b1e21deba648c9e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/rich-paste/index.js\":\"65807433fc6176c3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f45e53ef91406692\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/rich-paste/pasteDecision.js\":\"afa4df64f3a37b50\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/action.js\":\"acbdbad35fc9ebc5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/blockIds.js\":\"c554f60c25568334\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/content.js\":\"49d963f6060e35c8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/effect.js\":\"9d224aa543d0e698\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/ids.js\":\"54210d1b6efcc12e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/import.js\":\"0bdfa698dc0d440e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/index.js\":\"724d4022209da861\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/plan.js\":\"97456e3588099e42\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/plugin.js\":\"380e950457233773\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/promotion.js\":\"c01d698518de2e5b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/properties.js\":\"84ff4507cbd967c1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/references.js\":\"cc94a8a9523ee046\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/report.js\":\"d1626fe550c440b4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/roamMemo.js\":\"b53c242090d6efb2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/runtime.js\":\"ab1894308b5e0fb2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/schemaReconciliation.js\":\"8685b81ca6e3e8ab\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/srsMarkers.js\":\"deb76541e6470cad\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/todo.js\":\"0bfa06e5d3821b52\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/typeCandidates.js\":\"aba9fb172ca5d607\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/types.js\":\"eff936cf9f31247c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/search-health/index.js\":\"3779d5d9e0d6e753\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/search-health/store.js\":\"6547897f7511c754\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/HeaderItem.js\":\"4f02c7e9478bb4f7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"baaa0f776eae87b5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/index.js\":\"7c8d106db5611b02\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/model.js\":\"dc98d784438abdca\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/toggleStore.js\":\"eea165ba45202a94\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/useKeyInspector.js\":\"048f061dc021661e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"4cf8552868f3e7de\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/ShellDecorator.js\":\"d40589fa42bc0595\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/actions.js\":\"29b2aab6e66a796d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d3f2b68cb19ffd91\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/index.js\":\"1816b530c687b519\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/shell.js\":\"a3071faa30f734b6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/surface.js\":\"1403ec01b56837dd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/walker.js\":\"74bcde78168481a7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1b16f536ca11618d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/dataExtension.js\":\"bcc6011fe2f41058\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/index.js\":\"c54b375a51647f95\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/indicator.js\":\"d5ba0466e9c80be8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/moveSrsState.js\":\"e63a4695caf6b79a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bf90ee23b9b639cd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/scheduler.js\":\"b8c6c76402c0c900\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/schema.js\":\"e8a73941b231edb5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"350b5a9f76f22afd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/srsClipboard.js\":\"10580a7b054454e0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"427dee08a95e67d0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/DailyNoteReviewHint.js\":\"1251d1fb6abdddb0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/DeckPicker.js\":\"efd3547d1e6978e6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/ReviewControls.js\":\"d30de703f764bfe2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/ReviewDeckRenderer.js\":\"c5b4dc48208fdb16\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/ReviewSession.js\":\"68c8fe3c1ddc3e58\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/actions.js\":\"95d8ed0effdfe17d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/archive.js\":\"71edefbb81aac884\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/dataExtension.js\":\"d23563d83f6f2cba\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/deck.js\":\"77e4d7cb65b528fd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/dueQuery.js\":\"d38b6a73f8fe35c8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/gradeDecision.js\":\"ad38a48340bc1058\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/index.js\":\"e692fd9451ef622b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/keyHints.js\":\"c80d410032fe5b2d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/reviewCardLayout.js\":\"64c505ef8ed5379b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/reviewProgress.js\":\"01042a01aae7d7ba\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/schema.js\":\"df4eb6cb095c4652\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/useDueCards.js\":\"a4c0760348f88208\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/startup-metrics/index.js\":\"2e77a1c40019fc13\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/startup-metrics/record.js\":\"93db58007f1b3727\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/storage-persistence/index.js\":\"14e9660b6fc446ae\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/storage-persistence/persistenceStatus.js\":\"3e9a5fb6be9cfe90\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/storage-persistence/requestAction.js\":\"84b48d11e2b5ff07\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/supertags/TypeChipsDecorator.js\":\"4bbbfa5256785603\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/supertags/codeMirrorExtensions.js\":\"3fa600901126c12c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/supertags/index.js\":\"0d69e7a9069e3101\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/supertags/typeAutocomplete.js\":\"53ad36ad20b75f09\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"5965b483dd241a9c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/actions.js\":\"b84be47953c49245\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/anchor.js\":\"5085125c6e5c730d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/events.js\":\"da940234a361e83b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/gestureActions.js\":\"3dd62c42b470099e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/index.js\":\"1f885ba3a59a765c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"eafb28c1a16fe6e7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/sync-metrics/collect.js\":\"e1e72d17b83c8081\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/sync-metrics/index.js\":\"c7db58781abe7887\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/sync-metrics/record.js\":\"3771c815a9faac40\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/RejectionDialog.js\":\"2984ee30760a8280\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/SystemStatusHeaderItem.js\":\"60498693fcbcf2b5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/index.js\":\"07522e649fdb215c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/model.js\":\"a48b080bd8ab027b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/queueCounts.js\":\"c1b95fb42977f598\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/rejectedHelpers.js\":\"a673873ac5729cd3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/rematerializeAction.js\":\"0187fd3708813c8b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/useHysteresis.js\":\"c47c9227054a450f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/ColumnHeaders.js\":\"e7e76726ee7998ea\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/QueryUi.js\":\"273e9d99054f969a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/TableLayout.js\":\"2cbb34260dc84495\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/actions.js\":\"d99c2ddca4b85929\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/cellEdits.js\":\"b156e0db56947e54\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/childrenViews.js\":\"0d91285666e13e34\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/columns.js\":\"a3427733d3bd325c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/controller.js\":\"f992f01e1025a10b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/convert.js\":\"314cd7a56fab7d4e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/dataExtension.js\":\"7795beb50a420645\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/index.js\":\"617e28efd5d6bcfc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/keys.js\":\"33820d3adc377624\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/model.js\":\"6ae8afd6e5c3d8e0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/QueryText.js\":\"f5399b32b7447ac2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/backfill.js\":\"fecad33e95fe7217\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/completion.js\":\"e8add3393a82a628\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/format.js\":\"a2eed2d1441e97e6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/parse.js\":\"52bca4c29f2f9f14\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/queryValue.js\":\"43b265d07017dc00\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/registrations.js\":\"3d69350aab3f169e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/source.js\":\"c5deb88269d6106a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/registry.js\":\"61a5fabcca8c52ac\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/rowGutter.js\":\"acfddbd9558b1961\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/rowVerbs.js\":\"2d5aa4425d8ac3d2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/schema.js\":\"f3918902b7ef4553\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/sort.js\":\"0fe92c3d440778ab\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/theme-toggle/effect.js\":\"9af3855d157fc9be\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/theme-toggle/index.js\":\"f075e8047cebd539\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/theme-toggle/theme.js\":\"54fefa42ecb447b3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/todo/actions.js\":\"c06c9e964cc658ab\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/todo/dataExtension.js\":\"d875fe65bb7a5978\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/todo/index.js\":\"822addb95142b85b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/todo/schema.js\":\"14045396f9c15837\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/TouchSelectionLayer.js\":\"7d70c5eacc27294b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/actions.js\":\"474ca95a9c8a055b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/defaultItems.js\":\"444d77e4ff42c6e9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/facet.js\":\"e31adbbe1eafac48\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/holdRecognizer.js\":\"40b7192f6247f53c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/index.js\":\"8039a0b0973e6a1a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/update-indicator/UpdateIndicator.js\":\"a1c7148c5776dc7f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/update-indicator/index.js\":\"a8f2b6ce34644df2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/update-indicator/loadTimes.js\":\"243ab395ca6ebd52\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/VideoNotesRenderer.js\":\"ca304dd0df2832dc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/VideoPlayerRenderer.js\":\"a0502763c856bab4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/VideoTimeStamp.js\":\"e506f06cd60267c8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/actions.js\":\"c9ac362b3478a8d3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/index.js\":\"dab4008a70d6e8e5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/markdown.js\":\"6813d9093cdef10a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/notes.js\":\"72e17a50749d6b26\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/registry.js\":\"c3e5758804cba36f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/remark-timestamps.js\":\"7e6234d6c5bf1556\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/view.js\":\"58fae3fdaeb0257a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-link-hints/LinkHints.js\":\"0983a1388f6a0400\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-link-hints/index.js\":\"f6cdac93f53da7c3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-link-hints/model.js\":\"79ffd1cb65d38a08\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-link-hints/settings.js\":\"96b2cf8b53273e41\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-normal-mode/actions.js\":\"8e183d4930e3c6cc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-normal-mode/index.js\":\"98f745426bc3383a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-normal-mode/interactions.js\":\"9785f5a224283e48\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/workspace-header/index.js\":\"5260163349caabcb\",\"/knowledge-medium/pr-preview/pr-1917/src/registerServiceWorker.js\":\"e812154baf3a30d0\",\"/knowledge-medium/pr-preview/pr-1917/src/requestPersistentStorage.js\":\"847a5e612647a45f\",\"/knowledge-medium/pr-preview/pr-1917/src/services/authRequestDeadline.js\":\"568ab73c58db3072\",\"/knowledge-medium/pr-preview/pr-1917/src/services/authStorage.js\":\"806a532d98ba6491\",\"/knowledge-medium/pr-preview/pr-1917/src/services/powersync.js\":\"d1f9f7bf94e9f04a\",\"/knowledge-medium/pr-preview/pr-1917/src/services/supabase.js\":\"7973d1aaba493024\",\"/knowledge-medium/pr-preview/pr-1917/src/services/uploadErrorClassifier.js\":\"a8da0199d9f0fd14\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/ActiveContexts.js\":\"9bdee21ab90c49d3\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/HotkeyReconciler.js\":\"9022572703274c31\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/WipeLocalDataDialog.js\":\"55129cd106c2432e\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/actionDispatch.js\":\"a0f635f583e3f70d\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/actionRefItems.js\":\"9bebf207cc40dfb7\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/applyKeybindingOverrides.js\":\"533314083bda069e\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/blockActions.js\":\"5502e7c11a78d6fb\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/blockMergeGesture.js\":\"f9a38b0b438b806f\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/canonicalizeChord.js\":\"b7702d758973d745\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/defaultContexts.js\":\"1e2db743322b4044\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/defaultShortcuts.js\":\"90b1223bbb9e03a4\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/effectiveActions.js\":\"b9cd40edb6ba10fe\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/gestureAction.js\":\"d2f5bcef3b3a5601\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/gestureBinding.js\":\"afd0413b64ffa1f3\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/holdRegistry.js\":\"8e35ebecf922ebca\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/keybindingConflicts.js\":\"7a686f015650e277\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/keybindingOverrides.js\":\"f8260b6a008f57b2\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/pointerAction.js\":\"ac3fa9fb8dd32494\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/resolve.js\":\"149b327cd8a3d04a\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/runAction.js\":\"6dc10dba7b3c1f38\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/sequenceMatcher.js\":\"7c7cf9d20d9d87a8\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/types.js\":\"d9b25ac9fa6e1a22\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/useActionContext.js\":\"a4ad3b3ddc5fe6ec\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/useActionDiscovery.js\":\"0065ec6e41aff0af\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/utils.js\":\"5ab2ff66ce2da776\",\"/knowledge-medium/pr-preview/pr-1917/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1917/src/sw/bootStore.js\":\"71dda100655fe5ac\",\"/knowledge-medium/pr-preview/pr-1917/src/sw/previewDatabases.js\":\"c232e200a4bbc41c\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/byteTransform.js\":\"662d70b1e5ae4d01\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/attachmentCleaner.js\":\"056b010f6b443dda\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/attachmentParts.js\":\"e1e18744fcab0310\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/bundleParts.js\":\"b6be5b9d2e613505\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/bundleRecord.js\":\"476ef4faa3ac53ae\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/manifest.js\":\"01dcced564660cb2\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/takeBundle.js\":\"b685c1105ccfcd04\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/verifyBundle.js\":\"edc83d44c4c07a09\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/cleaningStage.js\":\"f85ce2f4bc0bd091\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/conversionKey.js\":\"12e2c92d01c31e8e\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/conversionServer.js\":\"e877137dd0594c9a\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/flip.js\":\"ae8395921124e034\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/flipAttempts.js\":\"7b8c553706d83720\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/pages.js\":\"08892e5d0917a465\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/preflight.js\":\"c22474bf86996e26\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/reseal.js\":\"ee1d2148440ce9fb\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/runConversion.js\":\"d71591043ca429e8\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/runLock.js\":\"fe98e54d0b6a79ef\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/sealing.js\":\"cba1f7c9a223d2e7\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/sealingStage.js\":\"8dc05f1c1ae9efe7\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/stage.js\":\"a971352596266767\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/verifyReseal.js\":\"efc872b3135e778f\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/aad.js\":\"1011e0dabf03807f\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/aead.js\":\"49588add9aa149cf\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/base32.js\":\"ca1335a41442a9df\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/base64url.js\":\"9d3d18dc1ba58771\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/binaryEnvelope.js\":\"f6e3663c720920cf\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/byteAead.js\":\"922c5e4923c2a5bc\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/canary.js\":\"1af6428a9ca306f7\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/contentHash.js\":\"841a460567e51d13\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/contentKey.js\":\"d5bb344e73e0ee51\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/derivedIdNamespace.js\":\"6f25b06741fcb358\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/envelope.js\":\"3cbe881abb8768ee\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/hex.js\":\"739df785a64170b2\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/sha256Hex.js\":\"fd290caf0dd114c3\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/workspaceKey.js\":\"cec702782ecee6ca\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/conversionState.js\":\"24361565d7689c80\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/flows/createEncryptedWorkspace.js\":\"d2aeed8b12fe7c21\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/flows/pastedKey.js\":\"8a22f400eb96efec\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"27636abbd24377d2\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/flows/upgradeWorkspacePin.js\":\"103166250f2dbe61\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/keyStore.js\":\"a5b1e3fd12e6c731\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/mintWorkspaceKey.js\":\"eeb6cd5aa697b964\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/modePin.js\":\"cd42bd05c6ea8ec4\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/openWorkspaceKeys.js\":\"9944dd0245b6ee0e\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/resolveWorkspaceEntry.js\":\"4dad56d9f3a98c5f\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/resolver.js\":\"4f31d54d37921f14\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/workspaceAccess.js\":\"533531fa00bc3a63\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/transform.js\":\"38a5e048043d3016\",\"/knowledge-medium/pr-preview/pr-1917/src/themeBootDefaults.js\":\"9748079ac113a567\",\"/knowledge-medium/pr-preview/pr-1917/src/types.js\":\"7df36cac66ca4e4d\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/ClientLocalSettings.js\":\"36f4c738e62d0bae\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/abortableSleep.js\":\"835a851e20354797\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/array.js\":\"6732aba1fca75f64\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/backlinkAutocomplete.js\":\"2ad46813f0b9f1f5\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/blockCrumbs.js\":\"0af19c01c48464ff\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/blockrefAutocomplete.js\":\"3902f84852f53743\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/cadencedIdleJob.js\":\"60620bbb62cc13b4\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/callbackSet.js\":\"f8767c92c1bf91b7\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/clientId.js\":\"1f0836a630958b23\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/codemirror.js\":\"f1a9f80b0c4e4bea\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/codemirrorCompletion.js\":\"2771ceb60836c22a\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/copy.js\":\"c7a1a90486707f0f\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dailyPage.js\":\"82b6fc977c0ec2e8\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dbForensics.js\":\"6a702ae852807d9d\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dbForensicsHooks.js\":\"a4818d63c1c02276\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/deleteBlockThroughUi.js\":\"6a9c59e5c73162cc\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dialogs.js\":\"88c5154681675a55\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dom.js\":\"0be06b9bb44a3b59\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/downloadBlob.js\":\"cce975116cc33f33\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/drawnWalk.js\":\"4b552e84b2230510\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/exportSqliteDb.js\":\"9693a2cfe035418a\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/fileSystemAccess.js\":\"c6a384dd3f85a03d\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/flipSlide.js\":\"4307d6017fe122b5\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/fnv1a.js\":\"435f307a40021918\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/formatBytes.js\":\"1e7d88b3ce2359c0\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/fuzzyRank.js\":\"5a655b799e4b0c9e\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/idbKeyedStore.js\":\"a4f59360791d50e8\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/idleCallbackPolyfill.js\":\"03a03125a52440aa\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/keyboardAwareScroll.js\":\"b7f8736b1afd4744\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/keyboardViewport.js\":\"8a735fe140b491df\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/lastWorkspace.js\":\"4b6472c1472e1539\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/layoutColumns.js\":\"87e54a02877f7a29\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/layoutSessionDom.js\":\"3d23dc18413706e8\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/layoutSessionId.js\":\"ba4daebc29b5d77e\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/linkClickGestures.js\":\"8f56416729da42fd\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/linkTargetAutocomplete.js\":\"c9a578c520bba6b1\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/localDbCorruption.js\":\"76162528b850713e\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/localDbRecovery.js\":\"5f6cc14b37ea9da1\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/markdownParser.js\":\"1e7cc31b11845461\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/memoize.js\":\"2201080699f95062\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/nameFieldCommit.js\":\"3caf8be0d5a0014f\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/nameList.js\":\"1444851c9a30ef40\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/navigation.js\":\"e8a2ff5226e494b2\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/omnilinerNamespace.js\":\"231d939f44dfb3de\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/opfsPageScan.js\":\"f83297c9c4f666dc\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelClearance.js\":\"199fa33a7abe5fae\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelHistory.js\":\"bfc6dcc87c496d54\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelLanes.js\":\"e3f08c8f9f570938\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelLayoutProjection.js\":\"715e739aa765e7be\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelScrollAnchor.js\":\"32bb6e64951c0127\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelUrlFlags.js\":\"b0a2bac56e198f54\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/platform.js\":\"0d20e1f364869900\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/pluralize.js\":\"3bd2ad89828f3b21\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/propertyCreation.js\":\"05610a62d37cad24\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/propertyNavigation.js\":\"20d926df390d615d\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/propertyValueContext.js\":\"83fec02524ad97d8\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/react.js\":\"ea3b8d5128279bb1\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/relativeDate.js\":\"f731d7db92e95a0f\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/relativeTime.js\":\"9258dae79f52753c\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/renderScope.js\":\"8a235d0a8e4987f1\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/resolvedThenable.js\":\"65b6f8b45f1d6669\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/routing.js\":\"1f4a22db851232a1\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/safeMode.js\":\"cedf1f6dc2db4994\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/scheduleIdle.js\":\"53a913554fdba646\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/screenWakeLock.js\":\"8b9bc4cd736460ca\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/selection.js\":\"079c6687f4ff02c5\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/softKeyboardGrab.js\":\"9b61a9423709b302\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/startupTimeline.js\":\"3aea57a9c37ef6de\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/state.js\":\"eddb1d9638207767\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/string.js\":\"36f65260b9217aa4\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/surfaceZoom.js\":\"e8f63a4bf2ff8224\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/time.js\":\"3219af5934e221cd\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/toast.js\":\"a76576c364152fce\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/toggleStore.js\":\"47a6eb802c6d17f5\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/untilStopped.js\":\"5bbbf1dcbf70fb4e\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/userActivity.js\":\"22380b55306cc3d7\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/viewTransition.js\":\"7441673cca9d6e18\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/viewport.js\":\"35e2173488f12918\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/webLock.js\":\"d706334bfa407808\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/workspaceRecovery.js\":\"caa698f66330ac31\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/workspaceSnapshotStore.js\":\"3c9a72485aef4a7f\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-compiler-runtime.js\":\"4c3b4aaacd266f8e\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-client.js\":\"dc07e8723edcf04b\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-server-edge.js\":\"ab5c344dca6b3e84\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-server.js\":\"f74d1905ea72d3df\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-static-edge.js\":\"760de9c56e4cfc74\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-static.js\":\"0ce54d2a414be82a\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-test-utils.js\":\"44651f09fe659b30\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom.js\":\"f200208236bcf667\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-jsx-runtime.js\":\"024cd44119563995\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react.js\":\"98c419995437ed58\",\"/knowledge-medium/pr-preview/pr-1917/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1917/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1917/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
