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
		buildId: "9d22d3b04d39-30fb74bc",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1917/\":\"19756aa797567dfb\",\"/knowledge-medium/pr-preview/pr-1917/index.html\":\"19756aa797567dfb\",\"/knowledge-medium/pr-preview/pr-1917/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1917/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1917/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1917/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1917/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1917/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1917/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1917/assets/FacadeVFS-B9nfXWOg.js\":\"c64fc7a34f681ce2\",\"/knowledge-medium/pr-preview/pr-1917/assets/OPFSCoopSyncVFS-Dcweldvi.js\":\"3ff8a8c898411be7\",\"/knowledge-medium/pr-preview/pr-1917/assets/OPFSWriteAheadVFS-bNDEm9p_.js\":\"50806b1056e7aaab\",\"/knowledge-medium/pr-preview/pr-1917/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1917/assets/wa-sqlite-D3F82G1s.js\":\"f6008f4dfe444641\",\"/knowledge-medium/pr-preview/pr-1917/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1917/assets/wa-sqlite-async-CXzck4fn.js\":\"b23b3bc495619e3b\",\"/knowledge-medium/pr-preview/pr-1917/assets/worker-DaCUotu5.js\":\"423f4eaef148955c\",\"/knowledge-medium/pr-preview/pr-1917/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1917/chunks/app-Zs_RNzkM.js\":\"2a14de3a3a976634\",\"/knowledge-medium/pr-preview/pr-1917/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1917/index.js\":\"96891970fcf4fddf\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1917/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1917/assets/AccessHandlePoolVFS-Dzdd2trl.js\":\"9d0139fa8e52c393\",\"/knowledge-medium/pr-preview/pr-1917/assets/IDBBatchAtomicVFS-CWYKqLDD.js\":\"f26aa3c8d209f580\",\"/knowledge-medium/pr-preview/pr-1917/assets/MemoryVFS-BacJErQC.js\":\"f032ded561f685dd\",\"/knowledge-medium/pr-preview/pr-1917/assets/mc-wa-sqlite-BcTC4LTa.js\":\"1eea8943b222a1d8\",\"/knowledge-medium/pr-preview/pr-1917/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1917/assets/mc-wa-sqlite-async-BHT0uMwl.js\":\"1405481ed46bcb9b\",\"/knowledge-medium/pr-preview/pr-1917/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1917/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1917/chunks/AccessHandlePoolVFS-CjErVNBB.js\":\"6a96af4a0db641bb\",\"/knowledge-medium/pr-preview/pr-1917/chunks/FacadeVFS-Bbd8kcza.js\":\"cd582ff83a573382\",\"/knowledge-medium/pr-preview/pr-1917/chunks/IDBBatchAtomicVFS-HH3ngWev.js\":\"423b14e6e315906a\",\"/knowledge-medium/pr-preview/pr-1917/chunks/MemoryVFS-CA7md1Nk.js\":\"a21c6008bdca04b9\",\"/knowledge-medium/pr-preview/pr-1917/chunks/OPFSCoopSyncVFS-DwAFeDTS.js\":\"0f3a68744be50553\",\"/knowledge-medium/pr-preview/pr-1917/chunks/OPFSWriteAheadVFS-BKqes8gY.js\":\"638854975e433e6a\",\"/knowledge-medium/pr-preview/pr-1917/chunks/Preview-DZJeeL09.js\":\"a168add724282f33\",\"/knowledge-medium/pr-preview/pr-1917/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1917/chunks/card-BGg2jA4z.js\":\"199705046fa8a01c\",\"/knowledge-medium/pr-preview/pr-1917/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1917/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1917/chunks/dist-BCMhCiYr.js\":\"5043b02792df1189\",\"/knowledge-medium/pr-preview/pr-1917/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1917/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1917/chunks/mc-wa-sqlite-SM9u8Myd.js\":\"14c954b0b7f49311\",\"/knowledge-medium/pr-preview/pr-1917/chunks/mc-wa-sqlite-async-QHZeIEmm.js\":\"d11330a8dedbd733\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-5r-rRaZg.js\":\"25aff7637c058207\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-B63TQ57A.js\":\"ca54e5de52175566\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-BfQKSyN0.js\":\"1762360558ed586f\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-C40_mySQ.js\":\"c676ff429275547f\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-CJeZFaQz.js\":\"8c4f4833213e32dd\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-CQaImMnd.js\":\"95c4583c9610b7b9\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-Ckag7QUb.js\":\"43bdde746a23951b\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-DSyqgOVY.js\":\"5b250dfe480eb562\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-dom-server-legacy.browser.production-BmPibfyx.js\":\"2f75efc8047911ed\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-dom-server.browser.production-RL2pCC3B.js\":\"16dbc58e15661575\",\"/knowledge-medium/pr-preview/pr-1917/chunks/react-dom-server.edge.production-CLINBn_O.js\":\"80977cecf915e05e\",\"/knowledge-medium/pr-preview/pr-1917/chunks/server.browser-DoFXoFHc.js\":\"0e8061a6c9593502\",\"/knowledge-medium/pr-preview/pr-1917/chunks/textarea-bJ94myV2.js\":\"e43452477385708b\",\"/knowledge-medium/pr-preview/pr-1917/chunks/ui-Cjg6H_rF.js\":\"6af2309b752b1984\",\"/knowledge-medium/pr-preview/pr-1917/chunks/wa-sqlite-D85mpAqg.js\":\"728fb5c686ba792e\",\"/knowledge-medium/pr-preview/pr-1917/chunks/wa-sqlite-async-BSvI3Tey.js\":\"69dd4f39c3c26afa\",\"/knowledge-medium/pr-preview/pr-1917/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1917/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1917/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1917/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1917/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1917/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1917/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1917/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1917/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1917/src/App.js\":\"5af8963afdd8af88\",\"/knowledge-medium/pr-preview/pr-1917/src/appUpdate.js\":\"c7759a04489d4a26\",\"/knowledge-medium/pr-preview/pr-1917/src/appVersion.js\":\"cb643d30dbe6c6b1\",\"/knowledge-medium/pr-preview/pr-1917/src/bootstrap/initialLayout.js\":\"29802b852dc0c856\",\"/knowledge-medium/pr-preview/pr-1917/src/bootstrap/openWorkspaceData.js\":\"74563ae86b925c8e\",\"/knowledge-medium/pr-preview/pr-1917/src/bootstrap/resolveWorkspace.js\":\"ae6d0af6dc3a076a\",\"/knowledge-medium/pr-preview/pr-1917/src/bootstrap/workspaceBootstrap.js\":\"ea0b9420681d9add\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockComponent.js\":\"512eb8f35ace6d5e\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockCrumbs.js\":\"a4a7800bdfa8d912\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockEditor.js\":\"6c9ab4f7c560ff74\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockLoadingPlaceholder.js\":\"f29575f081b5fd0e\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockProperties.js\":\"85483e2090db02fa\",\"/knowledge-medium/pr-preview/pr-1917/src/components/BlockSearchPicker.js\":\"ac3e5c7d35ba2610\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ConfirmBulkDeleteDialog.js\":\"df1c6dd423bcfb75\",\"/knowledge-medium/pr-preview/pr-1917/src/components/DividerHandle.js\":\"a45eca1565ed5934\",\"/knowledge-medium/pr-preview/pr-1917/src/components/DraftEditor.js\":\"26bf76458c091d90\",\"/knowledge-medium/pr-preview/pr-1917/src/components/GutterPill.js\":\"c216f98ca9bfe076\",\"/knowledge-medium/pr-preview/pr-1917/src/components/Header.js\":\"7961fc7f6b347258\",\"/knowledge-medium/pr-preview/pr-1917/src/components/LazyBlockComponent.js\":\"68ff82451eb68723\",\"/knowledge-medium/pr-preview/pr-1917/src/components/Login.js\":\"0898819b786bdce2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ZoomableSurface.js\":\"2b65065a5eef2a1a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/editModeKeepalive.js\":\"482194c5332eafe5\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a0d94063d6db6a2f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"88765ff556eff89e\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/RefPropertyEditor.js\":\"4578d80f84687623\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/RefTargetTypePicker.js\":\"60995a7cca42c2b6\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/SelectPropertyEditor.js\":\"7104b6870f2c9d35\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/TypesPropertyEditor.js\":\"d317143d9e638a68\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/defaults.js\":\"549c827d438760e3\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/kernelValuePresets.js\":\"26bcde8663744cfe\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/selectablePresets.js\":\"b628bd033c3cb77a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyEditors/typesPropertyUi.js\":\"c4c40d1c7d71119c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/AddPropertyForm.js\":\"93123c343d71d270\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/PropertyPicker.js\":\"0eeb7b49c22946d1\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/PropertyRow.js\":\"e299b3ec6898b5d1\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/Rows.js\":\"7d228a794560d56f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/actions.js\":\"6dea3cad96e7ede3\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/declarationOnly.js\":\"9dd62e0267b3e470\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/layout.js\":\"b6942293472351ef\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/model.js\":\"e259ab2e3ccf3a1a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/shapeUi.js\":\"bc0ebe49a877aafe\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/shapes.js\":\"6d824788fd9c10e4\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/usePropertyEditingActivation.js\":\"752e5d92c02ccf38\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanel/visibility.js\":\"a08949f083b54f4d\",\"/knowledge-medium/pr-preview/pr-1917/src/components/propertyPanelSections.js\":\"ded327b53f4b4e62\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/BlockEmbed.js\":\"2bf07eda0629d6d2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/BlockLink.js\":\"06ae535e2a360666\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/BlockRef.js\":\"d0bc8686c20a36b6\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/CompactReferenceLink.js\":\"f8384d721a7a0f30\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/ReferenceLink.js\":\"9ad7b18d6e1bba58\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/cycleGuard.js\":\"769ab22f3041e334\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/cycleGuardContext.js\":\"65557812ca728c36\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/linkInteraction.js\":\"6c6637a880739abe\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/referenceLayout.js\":\"3fef732cb1f3b4dc\",\"/knowledge-medium/pr-preview/pr-1917/src/components/references/useBlockRefAncestors.js\":\"58b959563c77a5bd\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BlockGutter.js\":\"d012e746bf134e5f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BlockInfoDialog.js\":\"2136d655123f3df2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BlockReadText.js\":\"dee16aa71c24266a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BlockTypeBlockRenderer.js\":\"8855c123ff819d3c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/BulletHoverCard.js\":\"1edc5652ec3d7177\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/CodeMirrorContentRenderer.js\":\"e24b9f30a528244f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"f3042ca889b38dbd\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/ColumnResizeHandles.js\":\"c08ca1efe87deb6f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e4d6935a823fca2d\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/DefaultBlockRenderer.js\":\"31c582a8de42cb4f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/LayoutRenderer.js\":\"c2758eb00aaed894\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/MarkdownContentRenderer.js\":\"188fe3a1ebcb422b\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/MissingDataRenderer.js\":\"642c9d31df988723\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/PanelRenderer.js\":\"1211d2254c581a2c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e67102b286a19372\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/TopLevelRenderer.js\":\"ef5821113189be1d\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/blockGutterMode.js\":\"e85194e11ea9f6ed\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/blockTitleText.js\":\"f5498bdd7dcabf11\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/fieldCreationKeydown.js\":\"e3f1532343798062\",\"/knowledge-medium/pr-preview/pr-1917/src/components/renderer/layoutRootContext.js\":\"d246718ea79ab698\",\"/knowledge-medium/pr-preview/pr-1917/src/components/typeChip/TypeChip.js\":\"17edf906fbfd5e39\",\"/knowledge-medium/pr-preview/pr-1917/src/components/typeChip/chipStyle.js\":\"eb1ea6ebbab56905\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/anchored-floating.js\":\"95ff1890a41c87a2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/button.js\":\"b5771f0591dea0c5\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/card.js\":\"f55c1e3447605a0a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/checkbox.js\":\"289b3e57b4466497\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/collapsible.js\":\"cc00dbc4874321c7\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/command.js\":\"e75246c970bd6cfa\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/context-menu.js\":\"f71e66c806bbd0a5\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/dialog.js\":\"d1d801de1c353dc3\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/dropdown-menu.js\":\"8602bc0bcfd6cc44\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/floating-listbox.js\":\"29a331c89eb51bf6\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/index.js\":\"adb5dfd0987bdd2f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/input.js\":\"89a59b58d4019cd2\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/kbd.js\":\"cb393e70e081b3f3\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/label.js\":\"8bbbe596fb3bcdfa\",\"/knowledge-medium/pr-preview/pr-1917/src/components/ui/textarea.js\":\"d5f5b71d567c5271\",\"/knowledge-medium/pr-preview/pr-1917/src/components/useEditModeYieldKeepalive.js\":\"83c195c951818aa0\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/BootFallback.js\":\"6ea25b1c9a2fc4b7\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/FocusedRowLazyMount.js\":\"33746308d952f8dc\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/LazyViewportMount.js\":\"2c0493f0f4c7bcc6\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/LocalDbCorruptionFallback.js\":\"73d317f77a5fe93d\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/error.js\":\"036b2f9f66390967\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/lazyMountRegistry.js\":\"80637e4451e9d77d\",\"/knowledge-medium/pr-preview/pr-1917/src/components/util/suspense.js\":\"f77a9d8048133f41\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/CreateWorkspaceDialog.js\":\"597c87061158b996\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/PendingInvitations.js\":\"6c470ea6d684a40f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/SyncProgress.js\":\"df4bf4cbc15f943f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/UnlockProgress.js\":\"494ea8d363cc428c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/WorkspaceKeyGate.js\":\"6e15d498864f222f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/WorkspaceSettingsDialog.js\":\"a2554ab39b2e9d6c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/WorkspaceSwitcher.js\":\"96cf9efd1e63b882\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/WorkspaceSyncGate.js\":\"5ff0cdff76531d8f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/ConversionFlow.js\":\"b7a180f06c0b30cd\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/ConversionFlowHost.js\":\"f296610e68b694d1\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/EncryptionSection.js\":\"25b927c4ca3c7def\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/attachmentPrompts.js\":\"fad8153f0286c88f\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/bundleFolderPrompts.js\":\"801bd20759ff9e8c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/conversionFlowDeps.js\":\"0f31d4845525befc\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/conversionFlowStore.js\":\"c832e80780521f5c\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/flowUi.js\":\"79f7865d50fc9026\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/conversion/useConversionRun.js\":\"a03267cf625a0cef\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/keyUi.js\":\"f9dc7bea6add953a\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/useCloseOnKeyLoss.js\":\"88fecf2e559a3025\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/useCloseOnServerE2ee.js\":\"d483c2460348939e\",\"/knowledge-medium/pr-preview/pr-1917/src/components/workspace/workspaceUnlocked.js\":\"da57c19c87193374\",\"/knowledge-medium/pr-preview/pr-1917/src/context/backgroundSubtree.js\":\"ef8e7459493c909d\",\"/knowledge-medium/pr-preview/pr-1917/src/context/block.js\":\"4e61ddf8ecbbea4a\",\"/knowledge-medium/pr-preview/pr-1917/src/context/layoutWsContext.js\":\"41bc8bbe003b791e\",\"/knowledge-medium/pr-preview/pr-1917/src/context/propertyDisplay.js\":\"8f956087ac814db9\",\"/knowledge-medium/pr-preview/pr-1917/src/context/repo.js\":\"54a6e7cc39b3dfa6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/aliasClaim.js\":\"ce04b0631b9c6e6c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/aliasSeatNamespace.js\":\"4e234aec35458852\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/blockData.js\":\"88be3e9cb6aad20d\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/blockType.js\":\"c56973019482f170\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/changeScope.js\":\"562e26b02e8d093b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/codecs.js\":\"e1af3f63fec96870\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/derivedData.js\":\"5cb2fa891977e6f9\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/errors.js\":\"37ee2499ddcca2e9\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/events.js\":\"d255db1500086050\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/handle.js\":\"b71356ca6937f350\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/index.js\":\"018333084a4eeb37\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/mutator.js\":\"2c67ec0340326f83\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/processor.js\":\"513033558dec3b97\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/propertySchema.js\":\"6e689d860d825231\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/query.js\":\"64c7e7898b687f90\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/sameTxProcessor.js\":\"9ae571f92a123f1d\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/schema.js\":\"b71356ca6937f350\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/tx.js\":\"b71356ca6937f350\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/typedBlockQuery.js\":\"a0c6249ceab5e052\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/user.js\":\"e8de1b85da7bd84f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/valuePresetCore.js\":\"d3e3be5e8ee18bd6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/api/valuePresets.js\":\"62b4f87d3874e0c5\",\"/knowledge-medium/pr-preview/pr-1917/src/data/attachmentCleanerIOVerb.js\":\"83e859eb13c4858d\",\"/knowledge-medium/pr-preview/pr-1917/src/data/block.js\":\"ff764e950929a5c6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockCache.js\":\"8ba2e4131297b76b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockId.js\":\"05d7d241908de18f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockLiveness.js\":\"c61c0f55029aa2d0\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockMerge.js\":\"00b51044ddf81a39\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockSchema.js\":\"bd43026d551828a2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockTypeLookup.js\":\"fcba304c8620fbb8\",\"/knowledge-medium/pr-preview/pr-1917/src/data/blockTypes.js\":\"e8e9fc4c2c917167\",\"/knowledge-medium/pr-preview/pr-1917/src/data/childrenView.js\":\"b3291e1b1c630812\",\"/knowledge-medium/pr-preview/pr-1917/src/data/clientContext.js\":\"37ff818a0c13abea\",\"/knowledge-medium/pr-preview/pr-1917/src/data/dbFileSiblings.js\":\"af9afe5aa8655989\",\"/knowledge-medium/pr-preview/pr-1917/src/data/definitionSeeds.js\":\"895ab741ed77bba6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/derivedIds.js\":\"17fa5b4bcc6e44a0\",\"/knowledge-medium/pr-preview/pr-1917/src/data/drawnSubtree.js\":\"4edff66a5fd2032a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/facetBridge.js\":\"4ab9e3537d7bc3b2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/facets.js\":\"c94d2080ea5964d6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/globalState.js\":\"fcbcff2d6403bdc3\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/aliasClaimRederiveProcessor.js\":\"94ac3918151649d8\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/ancestorBatch.js\":\"96690f2354f63b75\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/blockTypeTypeifyProcessor.js\":\"3470176faa9145b0\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/clientSchema.js\":\"7825a4e079aaa177\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/commitPipeline.js\":\"3ac48ee993356e9b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/devAssertions.js\":\"9a155053e2aa59c9\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/firstSync.js\":\"2cd6bc2120661e67\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/freshInitialLoad.js\":\"e941409c19a25a60\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/graphBackfillClaim.js\":\"d78ceb1ce7dee9cc\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/handleStore.js\":\"b9ac4eb059d368a2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/idleMarkerJobs.js\":\"c133f0c0b9657265\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/initialDownload.js\":\"45cd56221120446c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/initializeClientDatabase.js\":\"39062888e9b98a72\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/jsonCanonical.js\":\"d13d83fdcec65ed4\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/kernelInvalidation.js\":\"de8b7e4a7d5acf87\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/kernelProcessors.js\":\"8273742ef63e53fe\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/kernelQueries.js\":\"77d9fb01aaae16b5\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/mergeTypeMembershipProcessor.js\":\"d527eddd35ceb0a2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/normalizeReferencesProcessor.js\":\"31b1612bfa4f1041\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/poolInstrumentation.js\":\"748542743a94dca5\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/processorRunner.js\":\"d889288888a6f5d8\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyCellBackfill.js\":\"67d1ed7bbe2eaff2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyChildMint.js\":\"c9b12c7643d15520\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyChildrenProcessor.js\":\"eb210ab49a5e53cc\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyDefinitionChangeProcessor.js\":\"21115f4f48aa85db\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyDefinitionSynthesis.js\":\"ed15d094476722ce\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyKeyScan.js\":\"6cc651f54edfa455\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertySchemaResolution.js\":\"729507480aff09d2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/propertyValueEdits.js\":\"ec1ec8a6a2e99e16\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/raiseProtocol.js\":\"e4fe88d6b786b79a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/readBatch.js\":\"a32de98d364fefe2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/refProjection.js\":\"a5c0929cf731c329\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/referenceTargetLookups.js\":\"1c9d57563ec5c26e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/referenceTargetProcessor.js\":\"5a9f4a9c6abf747f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/replayMerge.js\":\"f82fc3c376c928f4\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/sqlBinds.js\":\"35562b1c40423ac3\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"55e7a43293c00361\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/arrivalProcessors.js\":\"3649f1529c4db8c7\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/invalidate.js\":\"f61d2b8a9af1883b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/materialize.js\":\"aa347ab704ae61fc\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/observer.js\":\"617bacfe27c2f1da\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/syncObserver/reconcile.js\":\"f7f41f89df2df017\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/timingMetrics.js\":\"1ecc2d5a1bded487\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/treeQueries.js\":\"1c15f2fa0348146c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/txEngine.js\":\"355b27072527e58a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/txSnapshots.js\":\"06a85757f8b92c04\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/typedBlockQuery.js\":\"3842e644f2bef02e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/internals/undoManager.js\":\"9862aa6879974edd\",\"/knowledge-medium/pr-preview/pr-1917/src/data/invalidation.js\":\"042e13000d8303ee\",\"/knowledge-medium/pr-preview/pr-1917/src/data/kernelDataExtension.js\":\"9ad2646992284155\",\"/knowledge-medium/pr-preview/pr-1917/src/data/kernelPage.js\":\"53ee298b0142a6a6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/kernelValuePresetCores.js\":\"9be315d01e969b19\",\"/knowledge-medium/pr-preview/pr-1917/src/data/localDbCorruptionSignal.js\":\"436a61660cd8163b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/localDbStorage.js\":\"8ebf903b4096eb28\",\"/knowledge-medium/pr-preview/pr-1917/src/data/localDbVfs.js\":\"56de97447a2d2492\",\"/knowledge-medium/pr-preview/pr-1917/src/data/localSchema.js\":\"0d99f2d75ae52229\",\"/knowledge-medium/pr-preview/pr-1917/src/data/maintenance.js\":\"13f4501637af6b20\",\"/knowledge-medium/pr-preview/pr-1917/src/data/mergeProperties.js\":\"7a58d78789b3bab8\",\"/knowledge-medium/pr-preview/pr-1917/src/data/metricsConsoleHook.js\":\"fbe2507c00edb7de\",\"/knowledge-medium/pr-preview/pr-1917/src/data/migrationsPage.js\":\"b2bc815bb8a13a72\",\"/knowledge-medium/pr-preview/pr-1917/src/data/mutators.js\":\"42a7354a11071d33\",\"/knowledge-medium/pr-preview/pr-1917/src/data/orderKey.js\":\"5c2f31e0632bf59c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/orderKeyPlacement.js\":\"26b3721c28881b60\",\"/knowledge-medium/pr-preview/pr-1917/src/data/outlineSurface.js\":\"6a0ef2febe478bc5\",\"/knowledge-medium/pr-preview/pr-1917/src/data/pendingEditorContent.js\":\"6da13b23a8aebedb\",\"/knowledge-medium/pr-preview/pr-1917/src/data/pendingUploadsSql.js\":\"6eac786d7dea30c5\",\"/knowledge-medium/pr-preview/pr-1917/src/data/pluginStateExtensions.js\":\"41d9785b6f7dabbf\",\"/knowledge-medium/pr-preview/pr-1917/src/data/powerSyncLogger.js\":\"eb3776b7d9dfd3cd\",\"/knowledge-medium/pr-preview/pr-1917/src/data/projectorRuntime.js\":\"d42a9a82d4f9ff61\",\"/knowledge-medium/pr-preview/pr-1917/src/data/properties.js\":\"22a0f5126b2e03c7\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertiesPage.js\":\"eda2d1073fd5c16c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyChildren.js\":\"3c19dc3180c840d8\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyDefinitionFanout.js\":\"248c08fe2042904c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyDefinitionMetadata.js\":\"3b3a9ee5e503f950\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyDefinitionRegistry.js\":\"496433287cde774c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyDisplayMode.js\":\"8cd701b284d00ccd\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertyRowCreation.js\":\"9706e565f3fe2aac\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertySchemaCreation.js\":\"5cad9482b1eadfb7\",\"/knowledge-medium/pr-preview/pr-1917/src/data/propertySeeds.js\":\"63dd774e69e9b6a3\",\"/knowledge-medium/pr-preview/pr-1917/src/data/recentsPage.js\":\"bdd1977a58b1ff6a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/refTargetComparableProperty.js\":\"b75e9d32df3582be\",\"/knowledge-medium/pr-preview/pr-1917/src/data/referenceBlock.js\":\"b1a097db0915d3c2\",\"/knowledge-medium/pr-preview/pr-1917/src/data/rejectedUploads.js\":\"8174f72548336e93\",\"/knowledge-medium/pr-preview/pr-1917/src/data/releasePowerSyncConnection.js\":\"52d1abb09b37f46d\",\"/knowledge-medium/pr-preview/pr-1917/src/data/repo.js\":\"e2ee9c339d37f656\",\"/knowledge-medium/pr-preview/pr-1917/src/data/repoProvider.js\":\"3c5825a49da60987\",\"/knowledge-medium/pr-preview/pr-1917/src/data/rowProperty.js\":\"dc2d3ab3d040c19e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/searchFilter.js\":\"59f74040f4d1eb31\",\"/knowledge-medium/pr-preview/pr-1917/src/data/seedIdentityLedger.js\":\"b26c9d14166a6c55\",\"/knowledge-medium/pr-preview/pr-1917/src/data/stateBlocks.js\":\"ed6d791a20549021\",\"/knowledge-medium/pr-preview/pr-1917/src/data/structuralEditPolicy.js\":\"cff9a5a54dea4fd5\",\"/knowledge-medium/pr-preview/pr-1917/src/data/structuralInsert.js\":\"002d5f15edd93a8c\",\"/knowledge-medium/pr-preview/pr-1917/src/data/subtreeDelete.js\":\"97e94a3362b18480\",\"/knowledge-medium/pr-preview/pr-1917/src/data/syncStreamLock.js\":\"c6f5ae2036b18e5a\",\"/knowledge-medium/pr-preview/pr-1917/src/data/syncedTableSqlRecognizer.js\":\"999d0dad7d4015fb\",\"/knowledge-medium/pr-preview/pr-1917/src/data/syncedTableWriteGuard.js\":\"01c9482c9a18bd47\",\"/knowledge-medium/pr-preview/pr-1917/src/data/targets.js\":\"e140c26f2fcf455e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeColors.js\":\"9dfca0b35b8cce5d\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeDefinitionMetadata.js\":\"54e80fb8efd81668\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeDefinitionRegistry.js\":\"97c5e9199ba18276\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeExtraction.js\":\"96367f439d312d32\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeInitialValues.js\":\"ea244d3676010841\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typePropertyGroups.js\":\"743f8b059ef5175b\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeSeeds.js\":\"00882ef738261bf6\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typeTagger.js\":\"4f0b85dff6483c92\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typedRecords.js\":\"c92c44d3d85ef17f\",\"/knowledge-medium/pr-preview/pr-1917/src/data/typesPage.js\":\"dd648a5e6b951a59\",\"/knowledge-medium/pr-preview/pr-1917/src/data/userPrefs.js\":\"d093bb3a93b30cab\",\"/knowledge-medium/pr-preview/pr-1917/src/data/userSchemasService.js\":\"22a22b88f2f93dee\",\"/knowledge-medium/pr-preview/pr-1917/src/data/userTypesService.js\":\"4ebc4e9e5c308d89\",\"/knowledge-medium/pr-preview/pr-1917/src/data/valuePresetRegistry.js\":\"5497a0a852889ba0\",\"/knowledge-medium/pr-preview/pr-1917/src/data/visibleChildren.js\":\"29130390ec93b28e\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaceConversion.js\":\"465dabca873e0387\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaceFirstSync.js\":\"230d2ffd944e59ba\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaceIdNamespace.js\":\"557949e8c804346d\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaceSchema.js\":\"9c3b52d5d0b38246\",\"/knowledge-medium/pr-preview/pr-1917/src/data/workspaces.js\":\"62086130ca092bde\",\"/knowledge-medium/pr-preview/pr-1917/src/data/writeAheadLog.js\":\"9535a711e1a951ba\",\"/knowledge-medium/pr-preview/pr-1917/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/BlockPasteShellDecorator.js\":\"e21a103fe9403a99\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/atTrigger.js\":\"27118e2164a3338e\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/autocomplete.js\":\"25255d4e6761738d\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/codeMirrorExtensions.js\":\"c40bbd1610296efb\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/contentFlush.js\":\"3757d5b776b42962\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/defaultInteractions.js\":\"a0a26bf90588d68c\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/editSettleSignal.js\":\"59af4f5109d9d2a9\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/insertImage.js\":\"c39160bb887051d3\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/referenceCompletionRange.js\":\"ad5277021b6f561f\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/referenceTargetTypes.js\":\"ace42e50192201b0\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/syntaxContext.js\":\"5ec43706da56c0a2\",\"/knowledge-medium/pr-preview/pr-1917/src/editor/triggerMatch.js\":\"361f503d7dea0ce7\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/AppRuntimeProvider.js\":\"a7e83d49b85057b8\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/BlockFocusShellDecorator.js\":\"f7793cd36a2dcb12\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/ExtensionRenderBoundary.js\":\"9bd331e0a6b0fb19\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/PanelContentRecovery.js\":\"d3fe5e2cd746cfcf\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/apiCatalog.js\":\"afbe2ffab4111efb\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/approveExtensionHere.js\":\"a25a1180bc6e82f3\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/armedCutAppMount.js\":\"86a29b763913927a\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/batchableKeyedStore.js\":\"ce2849cf52a2cc3d\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/blockInteraction.js\":\"80208de3530ea4e2\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/blockSelectionAction.js\":\"5fc43edb439ca9ea\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/compileExtensionModule.js\":\"ffba8546ae95206f\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/compiledModuleCache.js\":\"acbe28d031bc428e\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/continuousGestures.js\":\"f9c5be1055e123de\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/core.js\":\"978553f9981ccb01\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/defaultRenderers.js\":\"6e91c0c4e2847bf0\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/definitionFanoutAppMount.js\":\"6e409ab1e64bd2a0\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/dialogAppMount.js\":\"ce28cf06de9926a2\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/dynamicExtensionSeeds.js\":\"a5236068df0f476b\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/dynamicExtensions.js\":\"3a686b34bc057d01\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/exampleExtensions.js\":\"a5a4af0e8983f480\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionApprovalStatus.js\":\"3f31bb41d9a4f5fb\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionLoadErrorToast.js\":\"89c2fef2cb660a75\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionLoadErrors.js\":\"a0a4899de3565924\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionLookup.js\":\"7973014df46185fa\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionToggles.js\":\"652b6f5b18332253\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/extensionUtilitiesCss.js\":\"49b690b785451cc0\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/kernelPageDeletionGuard.js\":\"de119abb2978d579\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/liveRuntime.js\":\"823ea49ecd358ffc\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/openExtensionsSettings.js\":\"3d97c44425839991\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/overridesCache.js\":\"cf5d62429443b035\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/pluginIds.js\":\"d65d6a7b81a2617c\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/processorRejectionToast.js\":\"414ac47f13e8bef5\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/runtimeActions.js\":\"1c1a8880029e1c86\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/runtimeContext.js\":\"d20c3202b00f8766\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/staticAppExtensions.js\":\"d4c3d4a6de91cc2e\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/staticDataExtensions.js\":\"2dd598d553c58bcc\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/toastAppMount.js\":\"c768eda9b5ae4c51\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/useOverrides.js\":\"902cf4505212feac\",\"/knowledge-medium/pr-preview/pr-1917/src/extensions/useShortcutSurfaceActivations.js\":\"5a2df9011316a089\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/discoverToggleTree.js\":\"7b72fb8e3164e9b8\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/facet.js\":\"545a9b5cd6543688\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/resolveAppRuntime.js\":\"f65a2179cc25f5f3\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/runtimeEvents.js\":\"16c53bf42d62a3bb\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/togglable.js\":\"c25af7c3f48f5e9e\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/variantFacet.js\":\"f1d570d7019887ad\",\"/knowledge-medium/pr-preview/pr-1917/src/facets/verbFacet.js\":\"40076a26ddb45254\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/block.js\":\"8079b47e2d5f7031\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/focusedChild.js\":\"3769c7fe3d959fd3\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/propertySchemas.js\":\"15197b67dc071641\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/typeRegistry.js\":\"e09eb3ed72db782c\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useAncestorCrumbs.js\":\"34f6d9e0c32f3a96\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useAutocompleteListbox.js\":\"7c065485b42ead14\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useDebouncedSearch.js\":\"f0e3fd0ac8dc8d6c\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useDebouncedValue.js\":\"1a43652ac8b9c0dc\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useFacetValue.js\":\"d99bb37f63ff0218\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useIsFocalRender.js\":\"53ca6f3a6de70fa5\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useIsReadOnly.js\":\"56ab05132c2c21ac\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useMaterializeBacklog.js\":\"96affdfa8505c764\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useMinuteClock.js\":\"783c660fa2e0c1d8\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/usePanelLayoutProjection.js\":\"b8936459b177fa49\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/usePendingInvitations.js\":\"383366caeea0bd39\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useRendererRegistry.js\":\"d31682e42d56c1df\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useRetainedFieldRows.js\":\"c1ff0c59b6509a22\",\"/knowledge-medium/pr-preview/pr-1917/src/hooks/useWorkspaces.js\":\"76cb8e3353f5ef0c\",\"/knowledge-medium/pr-preview/pr-1917/src/lib/utils.js\":\"cbaabab62f977024\",\"/knowledge-medium/pr-preview/pr-1917/src/main.js\":\"f6797a2ee7c3d804\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/MarkdownImage.js\":\"918da0696a5c85ef\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/blockSeparators.js\":\"7f712937697bbac2\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/context.js\":\"5d8e0d0ef3e74ad8\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/defaultMarkdownExtension.js\":\"ebd0c09b89d1d21a\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/extensions.js\":\"e754f3be42429608\",\"/knowledge-medium/pr-preview/pr-1917/src/markdown/renderMarkdownHtml.js\":\"76b46d3516273e85\",\"/knowledge-medium/pr-preview/pr-1917/src/minimal-editor.js\":\"bc932124fae414a8\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/armedCut.js\":\"aa461c4cc79054fa\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/captureMediaVerb.js\":\"ce15b274670bba67\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/clipboard.js\":\"fbb249e42ea8da49\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/decision.js\":\"3d2f5de9b1e3df50\",\"/knowledge-medium/pr-preview/pr-1917/src/paste/operations.js\":\"6e5acd1152e81410\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/account-header/AccountHeaderItem.js\":\"9a934a28023ba14c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/account-header/index.js\":\"969c2ace7ac6b50e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5582471d58070ae8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/askAgent.js\":\"c8b466d697f7b752\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/askedStore.js\":\"85a7604717fe5df8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b52e3ce14e3c3b7f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/chipState.js\":\"1705bffa814e0047\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/dataExtension.js\":\"75379a5d8db6c153\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/index.js\":\"d220ee18dc1cdd00\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"161163d2c29f25a4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-dispatch-companion/schema.js\":\"685b9f2e56f6c2c1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/AgentTokensDialog.js\":\"ab9cd4e44273928c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2af884a0ec2538be\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/addMedia.js\":\"822da4862b944bd9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7cc911418ca347d5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/block.js\":\"fb6425bded35591a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/context.js\":\"fa315806d631773a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f7bb038780c881c6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/index.js\":\"e18a78c355a02060\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/outline.js\":\"843c4c0c2a22eb72\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/properties.js\":\"632538eac291d834\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/refs.js\":\"310567492617a53b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"fa6a2e0dcb733bfd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/search.js\":\"c0b63dc3e5996eec\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/shared.js\":\"7279de5fa393ac9f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"05a914edf601cdb3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentViews/text.js\":\"8417bc939ffbd6fe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/agentWrites.js\":\"782590abba92ecb0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/authoringCatalog.js\":\"fcda031227348476\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/blockRefTargets.js\":\"cc9d9d4fe1344f80\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/bridge.js\":\"5d2f92b1e0aba9bd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/bridgeLoop.js\":\"b3e9b240e7d3a872\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/changeHistory.js\":\"ea30e66a3f55b607\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/commands.js\":\"2de563bf92bb9097\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/commentsCommands.js\":\"f94cd881c3d35743\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/dataExtension.js\":\"56d7b1cce1e5d24c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/dataModelGuide.js\":\"ce793b8ffe7152e5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/dayPropertyInputs.js\":\"16e3ed716cf7e143\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/describeRuntime.js\":\"3648a367bb1f7b63\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/extensionLint.js\":\"af4c77cc90709a21\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/grainAudit.js\":\"a6f7fa932c7da2fa\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/healthCommand.js\":\"7179caa780240abc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/index.js\":\"72747e36307de782\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/presetIdentity.js\":\"a60b93d9e8c5146a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"330d2488d6954493\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/readMedia.js\":\"8a7eb33f3eab1d66\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/schema.js\":\"d9be34a344134a9d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/serialization.js\":\"6fafc2333f3ddf31\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/targets.js\":\"118ac6afba2aac24\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/tokens.js\":\"c432604c9175e4b5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/watchEvents.js\":\"6958e0ecdde30f74\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/workspaceGuard.js\":\"83a37690af7884a7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/agent-runtime/writeCommands.js\":\"e0a564959f2057ef\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/AliasCollisionToast.js\":\"9ce30f12e6d8c988\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/DuplicateNameBanner.js\":\"7d7a0b6ec2a26130\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/collisionMerge.js\":\"46a2beec124c9e6b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/dataExtension.js\":\"64b80c667d79b314\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/index.js\":\"af009659b0a5b15a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/mergeCollisionAction.js\":\"c64850893f15faa5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/pageStyling.js\":\"b205ac99c81b3275\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/rejectionToast.js\":\"3e7c2c6cc55336b8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/alias/syncProcessor.js\":\"76ed892a7fbc6f0f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/actions.js\":\"ca7123a5df1a023a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/addComment.js\":\"c913f5bcedca0dd7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/anchor.js\":\"f62b6897324827a0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/anchorState.js\":\"5b0cb4e84f4761cd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/commentLinks.js\":\"d3ff2aff02103e30\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/confirmThreadDeletion.js\":\"00c066d0a7c60b20\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/container.js\":\"d7de5f75e8f89510\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/dataExtension.js\":\"e5066cd99c32e9a8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/deleteComment.js\":\"146100236ff0aa53\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/highlights.js\":\"491b316b76f3eb55\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/index.js\":\"30222d3d6e653210\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/linkedCommentsPill.js\":\"5e7238e4c4afcc70\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/margin.js\":\"63a0d666a0c39c47\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/marginAnchorLinks.js\":\"67e9dfc5150870e6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/marginSchema.js\":\"95207d232caa2bbc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/newComment.js\":\"49c3ae1d0884f779\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/ownThreadPicker.js\":\"7ee07111cfdaf304\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/placement.js\":\"d7cfbcda4a65f222\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/queries.js\":\"77ab04b39d76388c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/quotePosition.js\":\"9438eb3ca2700c6c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/quotedIn.js\":\"48a805dd1a709f65\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/quotedRange.js\":\"48183b11caf12ec0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/rangeRefs.js\":\"8c4daf7ee48f6463\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/readHighlights.js\":\"5dd4619ee39c60f2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/readSelection.js\":\"d73d8421f0a36e4e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/readSelectionUi.js\":\"15840b95ebc3c823\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/reanchor.js\":\"f80135382372f7f1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/schema.js\":\"d4e91dd3bf272fe6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/scope.js\":\"4df8306dbcffa312\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/scopeThreads.js\":\"210caab8d959685d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/splitRetarget.js\":\"c4c9e5e0e396417c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/suggestionCard.js\":\"df77fdfc887f8cdc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/suggestions.js\":\"0c0224473ca7b1e9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/summaries.js\":\"89d3ae7dc9e39327\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/summaryBatch.js\":\"aac07c0bdde185fe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/surface.js\":\"cd8c34e2fb4c101c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/threadNavigation.js\":\"52dbeb46fcd23ed5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/threads.js\":\"4d8167d414f0ff64\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/ui.js\":\"cac0c93aa5cc42bd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/annotations/uiStore.js\":\"867176dc847bf7d7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/app-intents/appIntents.js\":\"6d6cb3526c2f9b56\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/app-intents/index.js\":\"b0cefc316e662afa\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/app-update-prompt/index.js\":\"30d5064745639c98\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/app-update-prompt/status.js\":\"66cc1eb06f6e0cd9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"cd809a53999487f5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/MediaBlockRenderer.js\":\"85aae97c576897f9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2718ddeba8e147cc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/MediaUploadReconciler.js\":\"7c0e978cb0f3e21d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/assetDownLane.js\":\"9e76f0cefe823569\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/assetResolver.js\":\"7ed88334937b995b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/assetUpload.js\":\"9acd9f2e543eb3d3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/attachmentCleanerIO.js\":\"b1e24414f7e31789\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f4a8ee9b8401843e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/blobStore.js\":\"a1f58f14887d7fb5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/browserMedia.js\":\"d22c597bb6c8df47\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/byteStore.js\":\"f472c548cf3da473\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/cleanerIO.js\":\"10b8a1e473a8b19f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/cleanupAttachments.js\":\"3a65dfd7f4659717\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/dataExtension.js\":\"621faa22154651ba\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/downLane.js\":\"9bb3b78aad6f04cf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/index.js\":\"074034029224c811\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/insertImageContribution.js\":\"f5371cfa04ebfe0c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/laneArming.js\":\"e1737cabb2d6820a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/laneLock.js\":\"2a654e5bbc39b10b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaBlock.js\":\"c8ee8c7bfa565936\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaCapture.js\":\"fb6276f0b38a3a2c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaLanes.js\":\"8ede934099877bac\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaViewers.js\":\"2dabfe66d9788abc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/mediaViewersFacet.js\":\"eab743f7e309eb58\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/pasteCapture.js\":\"02eb369b485f46ba\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/resolver.js\":\"1788ffc5e09d2342\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/retryUploadsAction.js\":\"02b5592a3c1d0c69\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/storagePaths.js\":\"6f52e20e5ddffe75\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadDrain.js\":\"854e818e67556a1b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadLaneStatus.js\":\"cd248d8ac122e284\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadReconcile.js\":\"838175388432befe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadRecovery.js\":\"ce0bee9df2d3aa4d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/uploadStore.js\":\"b4e1aae9626d9be9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/attachments/useAssetObjectUrl.js\":\"5140e1fa006036be\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"af9f1b348a47e1fa\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/BacklinksViewSection.js\":\"d8bcbd8263784421\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/facet.js\":\"43b51336d6ae83e4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/index.js\":\"8413881734296df9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks-view/prop.js\":\"69559b465c53a216\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/BacklinkFilters.js\":\"aaa4e3603850d74c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"151ab14eba061d21\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/BlockEntry.js\":\"ddca1826747d5934\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/LinkedReferences.js\":\"408a4594b3515b29\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"be5e05f62c5f0146\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/dailyNoteDefaults.js\":\"4b9b64745e4c65c0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/dataExtension.js\":\"bf6110d334a92fef\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/edgeExclusions.js\":\"00ba5176c4a052a9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/filterProperty.js\":\"fa04ba338b2b98b1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/index.js\":\"7f739577c1931046\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"2f2111f494a662b3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/applies.js\":\"7d1f8f190e81fb8d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/countQuery.js\":\"e0de510e31f4ca9e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9578afc8e2ee955a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/index.js\":\"d963217beb33b41b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"bdd70c1c98a53462\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/presentationInvalidation.js\":\"a9a844dd19cabfb5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/propertyEditorOverride.js\":\"7374f3833a89ac26\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/propertyFilter.js\":\"92a7f7952de23a90\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/query.js\":\"3e2e078aa5354581\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/resolveFilter.js\":\"11c8af2901604549\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/sourceBatch.js\":\"1dead00f00169ead\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/sources.js\":\"27e9a217a6e19337\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/useBacklinks.js\":\"49d00fdba24f0566\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"8fdc61f8508be196\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/BirthdayCelebration.js\":\"b6a31942165b3452\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/BirthdayOverlay.js\":\"a59f27701da9e7e3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/gate.js\":\"14521a07e2539a53\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/index.js\":\"9145937a2ecf2879\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/birthday/wolfTheme.js\":\"4ea31533ba6bb623\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/BlockDragLayer.js\":\"62b9313ef3223eec\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/dragController.js\":\"3cb8087c510c146d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/dropTarget.js\":\"340bedbbe2f236bd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/index.js\":\"039705dda856bfe1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-drag/projection.js\":\"72bfdd51ea3e1e10\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-info/BlockMetaCard.js\":\"2fb12c898f6f9f07\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-info/index.js\":\"55d4e1f095e0d174\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/AddTagDialog.js\":\"6955dbeaa5b0d468\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"693fc6425b1201ca\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/TagNameIssueHint.js\":\"0b5aee0b7e7cefab\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/addTagAction.js\":\"005e455f8728492b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/appendTag.js\":\"0194baa895367215\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/config.js\":\"3e39c7ad5a704273\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/dataExtension.js\":\"01af34bf2835b4b6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/index.js\":\"c50deea4e4b7c4c3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/block-tagging/propertyEditorOverride.js\":\"72a6e03ccfdc5aa4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/BreadcrumbList.js\":\"77ae3e290865d4e2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"1f4e0167a3fe668d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/Breadcrumbs.js\":\"238d550365982a42\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"c22364fa54930c3f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"aad0caaa669b3754\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/index.js\":\"61cfe4f436c98145\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"f99eaea3fa369372\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/CharacterCountItem.js\":\"c76d660364c27e4c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/ProfilePropertyEditor.js\":\"497ac36189a0e93a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/actions.js\":\"3f977c54233ef545\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/blockType.js\":\"6122427e74fb48b7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/charCount.js\":\"5799354bfbb82612\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/dataExtension.js\":\"8e3162d3048abb5b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/index.js\":\"8c2ea627d871bca4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/profiles.js\":\"bb3ce564cf82537a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/properties.js\":\"fb20deec701d3b0f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/subtree.js\":\"8146ed35ebfae03c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/character-counter/textCounts.js\":\"37c897fe2694947c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/colemak-keybindings/index.js\":\"214ee1094f74450d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/CommandPalette.js\":\"f76898b75a9ecfcb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/HeaderItem.js\":\"20a9cb2706e79ffe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/context.js\":\"d5ad0474441854d6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/index.js\":\"4e4004fa864cedba\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/selection.js\":\"21523049618d096b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/toggleStore.js\":\"b15d4a8f1039db43\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/command-palette/useCommandPaletteActions.js\":\"9159f58058c0524a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/ContributorBadges.js\":\"faa88cc0d394007b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/ProfilePicture.js\":\"335161e9afcf9a48\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/author.js\":\"fd76b5340203066d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/codeMirrorExtensions.js\":\"43fb983cc6d3746d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/dataExtension.js\":\"6a5424aa20527caf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/index.js\":\"72b86b663496e478\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/mentionAutocomplete.js\":\"31f31513eba02d5a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/processor.js\":\"e932b02dc00af4b3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/profiles.js\":\"cd3c9813d0b7a55d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/queries.js\":\"328184f55b60cd77\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/schema.js\":\"49cc12c11243ee48\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/contributors/useCommentAuthor.js\":\"1a694f081f1d5537\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ff516075afbeb63a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/followOrigin.js\":\"f1f6708118cadcef\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/index.js\":\"10a293ba61af1dc5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"8c314296eeaa895f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7bf7fbab8f749955\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/CalendarGrid.js\":\"10abe40152498906\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DailyNotePicker.js\":\"027ef877e8acf608\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"449ee40a80e17c3e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DateNavDecorator.js\":\"80d2e54935971f4c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DateScrubOverlay.js\":\"ca3664570d1cea9e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DayPropertyControl.js\":\"e55f19c06682f989\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/DayValueReferenceControl.js\":\"6024c3957e2a4739\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/HeaderItem.js\":\"c6825537d695814f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/ReschedulePicker.js\":\"e03ddf74be366f70\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ab9dcc31a8ab5962\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/actions.js\":\"4f13fe0037e4cf17\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/blockDateAdapter.js\":\"3262ad7351f6d4ae\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/calendar.js\":\"c0072022899356c1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dailyNotes.js\":\"3d00a05e20f40986\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dataExtension.js\":\"5079764d6ea867b8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dateScrubActions.js\":\"11d5b0c84403f49b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dateScrubGesture.js\":\"8e49033471193b03\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dateScrubGestureActions.js\":\"363e0b1ea83b0de8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dateScrubRecognizer.js\":\"38e0dab3a9211d18\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dayProperty.js\":\"37bb4e8283e2f4ee\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"f6e846aeedaa8aab\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/deletionGuard.js\":\"51ff6692e25e1b56\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/dueQuery.js\":\"2d1f17c0451a3312\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/index.js\":\"335311dee414849a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/landing.js\":\"bdee40f6490e008f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/localSchema.js\":\"1a05bfe2a7bc881e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/referenceDateAdapter.js\":\"156e3e77e0456f3b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/rescheduleAction.js\":\"3d76cfc447e8de24\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/schema.js\":\"c2e4ade433835fe6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/spreadBlockDates.js\":\"55a698ef83b2e827\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/spreadDatesAction.js\":\"e1eff5ce9f3f30fd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/today.js\":\"6417e41bb1aeb48f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"ddedcdd56064afa8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c246eb891de42e14\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/audit.js\":\"6ffa795f34afa029\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/auditAction.js\":\"04c438a63e55c841\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/auditRanges.js\":\"38234972d19bc87b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/diagnosticsSource.js\":\"1493cfbde4bfaaf8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/divergenceScan.js\":\"365722a96ac192fa\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/index.js\":\"4b8a7241df59db4b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/propertyChildrenChecks.js\":\"c3aae628d3a58875\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/referencesMirror.js\":\"979bd192428b34d5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/rowJson.js\":\"3276979d7f0087a4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/schedule.js\":\"fc3f8d41d1d32c5e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/data-integrity/store.js\":\"ba5235fd4ca4d91c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-maintenance/action.js\":\"3aafe631e9a1e441\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-maintenance/index.js\":\"de4ee09e790dcca9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-maintenance/plugin.js\":\"36bcf591bfcb4bee\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4308d5a39896560f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/actions.js\":\"73e4540ed9d8c9d9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/changeMarker.js\":\"a5ef98a7a541aa1c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/diagnostics.js\":\"7886fdc3dc6c461a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/fileSystemAccess.js\":\"7014784c26985f21\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/filenames.js\":\"f3fa727607c52762\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/index.js\":\"e05f7d6e13e10358\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/mirror.js\":\"e18a3118e0d47d89\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/runLock.js\":\"0ddf7b08cd818aeb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/runtimeHealth.js\":\"94826a3b6cee9a38\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/schedule.js\":\"fb8683eba3b8c4e1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/db-mirror/store.js\":\"da7537c698bc78fa\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/default-themes/index.js\":\"ba47a03781fe0724\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/default-themes/themes.js\":\"575af4e47b7c23a6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/diagnostics/facet.js\":\"c94816be039ae1fe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/diagnostics/useDiagnostics.js\":\"ad67055a525d14ca\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extension-prompts/dismissals.js\":\"b934b687f44743c7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extension-prompts/index.js\":\"481fefd751a71732\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extension-prompts/status.js\":\"92ff0086cb94104d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extension-prompts/store.js\":\"f1d989cfea3f5488\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7025ac9319b00406\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/ExtensionsSettings.js\":\"491f55c9212b3799\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/actions.js\":\"e22726805dcdee02\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/config.js\":\"be286d2c9ea2f0c4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/dataExtension.js\":\"e1f515bfbcaaea04\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/effect.js\":\"a0c496a650362f38\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/index.js\":\"ca4ce5f554912229\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/propertyEditorOverride.js\":\"794f62ce8c391f38\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extensions-settings/useToggleTree.js\":\"531512dbb8eaae23\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/ExtractTypeDialog.js\":\"09ee7bd8742baea6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"947c38d342d63aa3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/PropertyShapePicker.js\":\"74310dea7819dc99\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/action.js\":\"14ccfc3507fbe98d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/extract-type/index.js\":\"2f9e29aedc5f823a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/FindReplaceDialog.js\":\"7840e3cb984bd13a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/HeaderItem.js\":\"b9d86465cb9fca1e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/dataExtension.js\":\"f14ef2ca1992855a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/index.js\":\"5234ad2bd0c7e955\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/search.js\":\"bfade9e518a98026\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/toggleStore.js\":\"2cb8ab200bcd850d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/LocationPropertyEditor.js\":\"14cc1c9a32060595\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/MapView.js\":\"1f3d44aa26835650\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/blockTypes.js\":\"51306dee1337808b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/codeMirrorExtensions.js\":\"badca6bb2a21fdc6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/createOrFindPlace.js\":\"2261fca7819d8cf4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/currentLocation.js\":\"fb3111fe937fa3ed\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/dataExtension.js\":\"46d3355c299d1768\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/geoContentDecorator.js\":\"ff804461c06692c6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/googlePlacesClient.js\":\"8efe265688cbf32f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/index.js\":\"41d7687307fc3efd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/locationsPage.js\":\"8110679bcd0d766b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/mapViewport.js\":\"d62833462b06e22c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/pickCurrentLocation.js\":\"02be761d37f387fb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/placeAutocomplete.js\":\"45d2242426a9c36e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/placeNameCollision.js\":\"40379fec674ca380\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/properties.js\":\"7817ca778699f7cc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/propertyEditorOverrides.js\":\"173cf3293d95f624\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/query.js\":\"0ac5fa443d2eec39\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/geo/usePlaceSearch.js\":\"610d731064bbba6c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"92d49b177e405671\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cd3a6ac8102939f7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"fa3e6d6e87cd5314\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/config.js\":\"a57112a1d0e17639\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/dataExtension.js\":\"8d1d585e423928cc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/facet.js\":\"876ef0da1fa44048\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/grouping.js\":\"c8a1b19e008efb1f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/index.js\":\"446e88a2ce976358\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2770e2b0e3a0b72c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/query.js\":\"2db6130afb546057\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/resolveConfig.js\":\"cfc56148f530ecde\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"1f50be7e7fd14bb3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"69448bffc4bf391d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/HtmlDocumentContent.js\":\"429c8cc3e726e0e4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/HtmlFrame.js\":\"f9a5b3edbb5e67a3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/actions.js\":\"1cf3631640a9a87c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/blockType.js\":\"43cf97097add41c8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/confirmRunScripts.js\":\"9955f0769a57fe05\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/dataExtension.js\":\"61e13e494b21d144\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/frameAnnotations.js\":\"10e17b0cd803a4f2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/frameDocument.js\":\"f40056f8f9ce6b70\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/frameTheme.js\":\"6ef7d9fda1dec11b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/index.js\":\"925f6d099f69a0a9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/scriptConsent.js\":\"4327633c71d7fb5f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/sourceMap.js\":\"005f376f89d3f1df\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/html-document/useDocumentScripts.js\":\"8e9fa753ef6fa58e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/index.js\":\"32788cc4504cd77d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/record.js\":\"0b3d443a9b9f240a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/recordStore.js\":\"bd5240283fae4641\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/responsiveness.js\":\"babe0cf8f349913f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/schedule.js\":\"0b18fe9663150f3e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/interaction-metrics/sessionContext.js\":\"d3f9f5178f1879f2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"02116f6e654daabf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"f1f837e25cec6a75\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/actions.js\":\"c3d451f93d60e9a7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/config.js\":\"7cfa0bdfd07152c2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/dataExtension.js\":\"22f6320143fb579f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/effect.js\":\"35579c01c6d5237c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/index.js\":\"abc2cafe3725e4fa\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/keyCapture.js\":\"8a90456dde9519fc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/overrideStore.js\":\"c693eb219f503f95\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"987db0b9d7989847\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/HeaderItem.js\":\"c91dbef034e09956\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/LeftSidebar.js\":\"88c723b0c9b97252\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/actions.js\":\"41c52d23f96055c8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/facet.js\":\"bde7361d59010a08\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/index.js\":\"3f3a30dba600866e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/shortcuts.js\":\"0c97d29b23d42e76\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/left-sidebar/toggleStore.js\":\"50ed8d43edabe344\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/merge-blocks/MergePicker.js\":\"4f3c64700e02a204\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/merge-blocks/index.js\":\"9dc0afdafb326494\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/merge-blocks/mergeAction.js\":\"0170cd7ee54af078\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/merge-blocks/strategy.js\":\"4ef110e96ac8504a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/Button.js\":\"9d99569ef6af587d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a081bdeae842273c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/defaultItems.js\":\"a69bdd6d63fbb7c7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/facet.js\":\"5426b779ce58a618\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-bottom-nav/index.js\":\"4d13ffbaaad8ef7c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"74c2b195d66a7c10\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/actions.js\":\"438c4be9e4e24c86\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"580b7c7417b4a64b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/facet.js\":\"2a5cfbbe23a5f1f7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/mobile-keyboard-toolbar/index.js\":\"0f4c147b0529dc7a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f2918316592fe54d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/blockSubtreeMembership.js\":\"c05a0cdefb6d81a0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/contextMenuItem.js\":\"3daec03a3f8bc1c6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/index.js\":\"aba5200a0bb1b290\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/moveAction.js\":\"4e5141c6f238de08\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/moveBlocks.js\":\"05c2d99d6baecfb8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/move-blocks/selectionAfterMove.js\":\"9665e67f7ac96474\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/TutorialBanner.js\":\"2dd32b1a47628d8e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/action.js\":\"950e8af151e573b9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/bannerDismissal.js\":\"fb39de20b6167c1b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/documents/cheatSheet.js\":\"3ce1d8ade492a67c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/index.js\":\"20bd755827d4acfc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/keys.js\":\"d41685f80621c61f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/landing.js\":\"2630ec0540584923\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/outline.js\":\"34524537fdf76448\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/onboarding/seed.js\":\"0a3d1773651380f6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7f82ad92ceaaf151\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/analyze.js\":\"6e9a77eb684d34e5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/diagnosticsSource.js\":\"e61056a63d1ec5bd\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/index.js\":\"f6f06298a07b5c5e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/load.js\":\"5680ff4fe810900e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/monitorRun.js\":\"873278e81cfb7475\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/schedule.js\":\"1e62aec7de3dd98b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/series.js\":\"463f7eb0f4832da3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/store.js\":\"ed5bee005e6323a5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/trendAction.js\":\"b88fb1f55985f520\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/perf-monitor/verdict.js\":\"6fa686861b2d501a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/plain-outliner/clickToEditAction.js\":\"1fd03b3986931453\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/plain-outliner/index.js\":\"50bc48f10ecea94c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/plain-outliner/interactions.js\":\"97d678763afc692f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8829920790b3a459\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/MigrationGate.js\":\"775b09cd2de819bc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/MigrationGateDialog.js\":\"32f176ca69caa2f3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/action.js\":\"e9dfc2b541e79cb1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/index.js\":\"6b59af9dd83d7d3d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/localRunMessage.js\":\"dcf6a9fd2fe03649\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/plugin.js\":\"e0c8dbe6202ba8c0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/progressReport.js\":\"5423a5bfc9ff61b6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/properties-migration/sweepProgress.js\":\"63fded6391d57851\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/FieldRowRenderer.js\":\"76f0ddb7236592a2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/ValueRowRenderer.js\":\"7122baad6a0442d5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/actions.js\":\"ce383df7970a771c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/autocomplete.js\":\"470b11a5533ed2bb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/fieldRow.js\":\"c3209018f0f0146d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/index.js\":\"1f9ce83137c85642\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/referenceWarning.js\":\"a826ec27e820dfea\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/valueAutocomplete.js\":\"349b4815b267704e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/property-rows/valueSchema.js\":\"d20d9589db8a846f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/HeaderItem.js\":\"ce6aac285bd040c0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/QuickFind.js\":\"324c815109c0fe1f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/index.js\":\"409c6aad8074b46e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/recents.js\":\"d6a0e0124e45bf2e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/resultItems.js\":\"eb36adc19b9b098a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/selection.js\":\"b0f9066858436334\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/quick-find/toggleStore.js\":\"5b261a97fd3047cb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/HeaderItem.js\":\"cca627cadfaedd5a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/RecentsPageBlockRenderer.js\":\"dd053592551ebdf0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/grouping.js\":\"178fe9611243ec93\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/index.js\":\"151ef9badee0e068\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/recents/target.js\":\"d4f4cfad73e1729a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/codeMirrorExtensions.js\":\"ca05ccd7b5180e91\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/contentPrefill.js\":\"5e26c666bfa24032\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/dataExtension.js\":\"1cfcd00c1e4fde74\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/index.js\":\"0fbf5d45bc316585\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"cb3d2b4210d0e5da\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/invalidation.js\":\"19676bf77b5c3a78\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/localSchema.js\":\"062e9db5d9d4e6e9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/blockrefs/index.js\":\"171dc12cf75a72a4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"7117bca5c4bfc023\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/index.js\":\"9590a5126b3bd169\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/referenceNode.js\":\"d99e21c021b14138\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/remark-reference-occurrences.js\":\"532995a769c10196\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f775c440e15f15ea\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/wikilinks/index.js\":\"fd0ee5f1272bb9a5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"544336759c248056\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ae8a830189afb181\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/mergeRetargetProcessor.js\":\"d6a0996e62bfb891\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/parseFence.js\":\"94d0086e36cef874\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/referenceParser.js\":\"fadd102731ebc72c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/referenceProjection.js\":\"841e20765e1df5d0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/referencesProcessor.js\":\"4b83a4bed9b6c715\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/renameProcessor.js\":\"9b3fe8cc54ee2302\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/references/spanReplacement.js\":\"e6ad4eb8116982b0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/rich-paste/htmlToOutline.js\":\"0b8d4f63d2deabea\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/rich-paste/index.js\":\"629a0219570cf3b6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/rich-paste/normalizeClipboardDom.js\":\"04decbf22d146344\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/rich-paste/pasteDecision.js\":\"f25767bc89b87092\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/action.js\":\"94a98ff850bf9f00\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/blockIds.js\":\"8c11f305f0426e44\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/content.js\":\"59a31a6101a62efb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/effect.js\":\"4a0f5a6334f068dc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/ids.js\":\"d50d48ed70baf50f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/import.js\":\"d65c4d8c680a8cd8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/index.js\":\"775f95e9e6a7838c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/plan.js\":\"a653451c8832bce4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/plugin.js\":\"1b1cb5af8fd35083\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/promotion.js\":\"ab098956e0f2331e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/properties.js\":\"642c066a99465519\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/references.js\":\"fe5c5bbe6674100b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/report.js\":\"9b20beee2bc4b73b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/roamMemo.js\":\"7f8ad384caf08bd3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/runtime.js\":\"f173d2ff515c39c6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/schemaReconciliation.js\":\"4f5ad3578bcefe99\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/srsMarkers.js\":\"ecb0af1b03dfd15a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/todo.js\":\"de2ec06462092ab8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/typeCandidates.js\":\"d6f13df309647abf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/roam-import/types.js\":\"9a2965b23360db25\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/search-health/index.js\":\"17a01b9027d65278\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/search-health/store.js\":\"4dd5e2c16ec69ef2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/HeaderItem.js\":\"dae7dbcd3f962c57\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c06cf44293acf188\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/index.js\":\"138924a87ffd2ca4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/model.js\":\"68dee4348170e7b9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/toggleStore.js\":\"8b5f43589f6806a0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/shortcut-help/useKeyInspector.js\":\"f863ca5d8aec2125\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"ecbbd4dac3718f59\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/ShellDecorator.js\":\"725144c9f7ba560e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/actions.js\":\"58ab9d2a0e04c9a4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e7625c6be3a27f03\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/index.js\":\"db4a6b4a52c2e650\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/shell.js\":\"490d733fec9149f4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/surface.js\":\"6eb424d20e89d7cb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/spatial-navigation/walker.js\":\"a8f14c8067e44ed2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/RescheduleToast.js\":\"8d06b020c00e5353\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/dataExtension.js\":\"9dc4053c8621511a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/index.js\":\"467114304e4d3cf7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/indicator.js\":\"07c060cd99d3a536\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/moveSrsState.js\":\"922da03b738734d4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"7d46f22b1c5f9882\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/scheduler.js\":\"cc1ef7ea8264ac85\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/schema.js\":\"09c99a5de3fee2bf\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"43413b84f8b056b5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/srsClipboard.js\":\"4644c590a254f971\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b183e379db387fc5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/DailyNoteReviewHint.js\":\"12c879f0a474dc93\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/DeckPicker.js\":\"74962377bcc9525b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/ReviewControls.js\":\"64d7854eda7e97e2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b0e71d6b378f9557\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/ReviewSession.js\":\"a44f72be69c25eed\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/actions.js\":\"35ef7dbafa8f153b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/archive.js\":\"adbafc48f7448362\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/dataExtension.js\":\"96e33baa80d89b58\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/deck.js\":\"74d7627a551a917b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/dueQuery.js\":\"14c659c58e799aa7\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/gradeDecision.js\":\"9670a9bc1ea282a3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/index.js\":\"7d7e03f1573f9d6c\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/keyHints.js\":\"3097ec330417fadc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/reviewCardLayout.js\":\"0438d0211b857c04\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/reviewProgress.js\":\"02881cc418a9a5ef\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/schema.js\":\"50cda1c47c532ad3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/srs-review/useDueCards.js\":\"12eff7a64b751d73\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/startup-metrics/index.js\":\"822ca4ed054d32d6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/startup-metrics/record.js\":\"df104d69f84e0a98\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/storage-persistence/index.js\":\"f87d0393e0663f43\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/storage-persistence/persistenceStatus.js\":\"07d0a0f722356d86\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/storage-persistence/requestAction.js\":\"cfe77a3a46feb146\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/supertags/TypeChipsDecorator.js\":\"e9e054275a0f9492\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/supertags/codeMirrorExtensions.js\":\"85f74d576856f071\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/supertags/index.js\":\"dcb4ee308eb1b46b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/supertags/typeAutocomplete.js\":\"0d38c243ce024450\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"413eb05b8f152e27\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/actions.js\":\"5f9ff93f00a4bb73\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/anchor.js\":\"6445d3d3dba883ef\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/events.js\":\"0ebc768d8e5312b9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/gestureActions.js\":\"dbc00bd6acc4e4cb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/index.js\":\"c3353777341b52a4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"a05f6959f07517bb\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/sync-metrics/collect.js\":\"b017225fa2467ec4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/sync-metrics/index.js\":\"87a34f8f35f545b4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/sync-metrics/record.js\":\"5d9e724292eb9cd2\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/RejectionDialog.js\":\"5cc41ddab534b584\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/SystemStatusHeaderItem.js\":\"153c46a8d9237193\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/index.js\":\"88ac93613019890b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/model.js\":\"09555fb0d74b9548\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/queueCounts.js\":\"94eb2c7bbbb42811\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/rejectedHelpers.js\":\"a6f77ee61daa9429\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/rematerializeAction.js\":\"c240ffaddd77588d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/system-status/useHysteresis.js\":\"e961e7295db81634\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/ColumnHeaders.js\":\"2291cbb7086527e5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/QueryUi.js\":\"18051251554639b5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/TableLayout.js\":\"ed223e886e5596e8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/actions.js\":\"e3706cccbc9879b3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/cellEdits.js\":\"ea9f4a47f63f0900\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/childrenViews.js\":\"be324d9b78ac216d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/columns.js\":\"d573fbf0538d90ea\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/controller.js\":\"d4114b75eb9c9093\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/convert.js\":\"9fa9dfd8dc6e9164\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/dataExtension.js\":\"9801cd14c36f953f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/index.js\":\"94701295576cf528\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/keys.js\":\"60c457c5d6ddea81\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/model.js\":\"af33692f36c167ba\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/QueryText.js\":\"b3e6cb6fd1cc9b37\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/backfill.js\":\"ddcaeac0d35b7f58\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/completion.js\":\"6c788c3a5d5857c6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/format.js\":\"32401652418a552f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/parse.js\":\"cdc7325c4cca7211\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/queryValue.js\":\"e31d3d3fb9d802b4\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/registrations.js\":\"bf49c7d1c5ddc3c1\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/query/source.js\":\"20093fdce26d855d\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/registry.js\":\"2771e9c07799aeb9\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/rowGutter.js\":\"12a2336a05586be6\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/rowVerbs.js\":\"c5d5f1cebcec9b4b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/schema.js\":\"409ac5823ee8db69\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/tables/sort.js\":\"90defe4aaabfdd4f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/theme-toggle/effect.js\":\"2e7577fce133abf3\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/theme-toggle/index.js\":\"5dd8a0e85c548754\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/theme-toggle/theme.js\":\"043266f32d111c98\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/todo/actions.js\":\"2d76cc000943375a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/todo/dataExtension.js\":\"7daeca0e2ca84371\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/todo/index.js\":\"dffa6e42ea4baa79\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/todo/schema.js\":\"2f8c4b907df7862e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/TouchSelectionLayer.js\":\"4647e2cd2beec734\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/actions.js\":\"e9f2407c8fd24aa8\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/defaultItems.js\":\"84bc5865f2fa7284\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/facet.js\":\"3138d44305ed1d6e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/holdRecognizer.js\":\"56fe31290932cf64\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/touch-selection/index.js\":\"bcf0663a42ec61da\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/update-indicator/UpdateIndicator.js\":\"222d033d30735707\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/update-indicator/index.js\":\"9fc13919a30ce097\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/update-indicator/loadTimes.js\":\"95b4fd6e91a4a4aa\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/VideoNotesRenderer.js\":\"7ae4ec5b7a5589e5\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/VideoPlayerRenderer.js\":\"0eb51cfa7a34fb1e\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/VideoTimeStamp.js\":\"2b312b8ece2094ae\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/actions.js\":\"9f618f3f4820ab89\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/index.js\":\"7974813486b3bf6b\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/markdown.js\":\"79629f8200192136\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/notes.js\":\"f17f9d7b7f72a64f\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/registry.js\":\"1200df7dff238d4a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/remark-timestamps.js\":\"06e216e0b7c5f71a\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/video-player/view.js\":\"9dab12de79c22c03\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-link-hints/LinkHints.js\":\"1778f9d41a2d14ec\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-link-hints/index.js\":\"75d853abd5510cbc\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-link-hints/model.js\":\"6d7f2c81217a6e13\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-link-hints/settings.js\":\"983c62af571d88ff\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-normal-mode/actions.js\":\"22b3f45ebac74da0\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-normal-mode/index.js\":\"a031db89af4f7950\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/vim-normal-mode/interactions.js\":\"894cbfea41ec40fe\",\"/knowledge-medium/pr-preview/pr-1917/src/plugins/workspace-header/index.js\":\"d245e01eb5e90091\",\"/knowledge-medium/pr-preview/pr-1917/src/registerServiceWorker.js\":\"3098c84c8cf6461d\",\"/knowledge-medium/pr-preview/pr-1917/src/requestPersistentStorage.js\":\"2c14b3eb7125e768\",\"/knowledge-medium/pr-preview/pr-1917/src/services/authRequestDeadline.js\":\"390ff3edfb184165\",\"/knowledge-medium/pr-preview/pr-1917/src/services/authStorage.js\":\"d08b6eeaed13f076\",\"/knowledge-medium/pr-preview/pr-1917/src/services/powersync.js\":\"1501cacdabcbffa0\",\"/knowledge-medium/pr-preview/pr-1917/src/services/supabase.js\":\"8043a9b484b192a7\",\"/knowledge-medium/pr-preview/pr-1917/src/services/uploadErrorClassifier.js\":\"539e3ff85d26012a\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/ActiveContexts.js\":\"965806966a1d535a\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/HotkeyReconciler.js\":\"5aca04d60eac3731\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/WipeLocalDataDialog.js\":\"aa27caaeeb9ec70c\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/actionDispatch.js\":\"94eee11767882835\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/actionRefItems.js\":\"aa5bf8b4354f3d2f\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/applyKeybindingOverrides.js\":\"fadc1b1dbf44d716\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/blockActions.js\":\"d98562e932aa6661\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/blockMergeGesture.js\":\"5a8b5b480f008713\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/canonicalizeChord.js\":\"573fb0f7cd4d52f3\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/defaultContexts.js\":\"d8bce83dec56ef54\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/defaultShortcuts.js\":\"763b84868f92bc6c\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/effectiveActions.js\":\"dd3c58fad3e6885c\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/gestureAction.js\":\"a4b5a6dc46a243b9\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/gestureBinding.js\":\"19f2d5939a86403c\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/holdRegistry.js\":\"18e69681d006913c\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/keybindingConflicts.js\":\"ec389cf2949ae026\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/keybindingOverrides.js\":\"bb97c78acaf1a27c\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/pointerAction.js\":\"bc56f277f4d4579c\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/resolve.js\":\"6a86cd88036266b5\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/runAction.js\":\"71e5efe485450de8\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/sequenceMatcher.js\":\"eb2f0ceea5596f10\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/types.js\":\"f0cd3485d2294119\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/useActionContext.js\":\"e0798d5289f0d87d\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/useActionDiscovery.js\":\"c7629b9853705606\",\"/knowledge-medium/pr-preview/pr-1917/src/shortcuts/utils.js\":\"43de302c2194646d\",\"/knowledge-medium/pr-preview/pr-1917/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1917/src/sw/bootStore.js\":\"8d3a87259d249d6b\",\"/knowledge-medium/pr-preview/pr-1917/src/sw/previewDatabases.js\":\"428af26ca9ac2aba\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/byteTransform.js\":\"98c2b8c2766be1cb\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/attachmentCleaner.js\":\"7a3469f5ea86d720\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/attachmentParts.js\":\"59e5055087787d5c\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/bundleParts.js\":\"df6f58ccbf58d6c5\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/bundleRecord.js\":\"31dfb34cb5ae5273\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/manifest.js\":\"f442dd652672cdc8\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/takeBundle.js\":\"dc0c18a45aace0b8\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/bundle/verifyBundle.js\":\"1d0844585daeb9c3\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/cleaningStage.js\":\"324e71d6f1814be5\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/conversionKey.js\":\"4d29272ad2396096\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/conversionServer.js\":\"a2614772b03957f6\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/flip.js\":\"268c2bd32cda4803\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/flipAttempts.js\":\"09112681106c8593\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/pages.js\":\"73732cd9881eb6b3\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/preflight.js\":\"0251bf397d35a1f1\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/reseal.js\":\"172a6115c7f34cf5\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/runConversion.js\":\"eca61b4f72e38c7c\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/runLock.js\":\"e976b3b80122a170\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/sealing.js\":\"17d3b9fd10095ba9\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/sealingStage.js\":\"da65d7333ed16c35\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/stage.js\":\"9ee79eb61f69beb1\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/conversion/verifyReseal.js\":\"5fa711f79807f21a\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/aad.js\":\"d72a29812e7a2596\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/aead.js\":\"1eb8cec6683b2226\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/base32.js\":\"97c6f8f05878fcd1\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/base64url.js\":\"a41a282d47aa2791\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/binaryEnvelope.js\":\"2dfab2fc6c33332c\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/byteAead.js\":\"ccfd19132c21f458\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/canary.js\":\"deff0577ba4906f3\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/contentHash.js\":\"1634003554553113\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/contentKey.js\":\"0b050a9e24e801ae\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/derivedIdNamespace.js\":\"a3273f866134e741\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/envelope.js\":\"721377ba62f5e1dc\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/hex.js\":\"1426ae1dd225730a\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/sha256Hex.js\":\"88badf7c8e51c7cd\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/crypto/workspaceKey.js\":\"490670f28e922e13\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/conversionState.js\":\"3611817b502fb572\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/flows/createEncryptedWorkspace.js\":\"3a51c9ed160a2b5d\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/flows/pastedKey.js\":\"235765e1b44c9735\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"750547a975fb6cab\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/flows/upgradeWorkspacePin.js\":\"45a06bc865e16d0d\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/keyStore.js\":\"444da73aaa060cb7\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/mintWorkspaceKey.js\":\"8ee1659ca77b4ef9\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/modePin.js\":\"04b9aa817931a8fd\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/openWorkspaceKeys.js\":\"31cd05eca541a5a8\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/resolveWorkspaceEntry.js\":\"59904ee5227d5284\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/resolver.js\":\"7e542882b9226c16\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/keys/workspaceAccess.js\":\"a58679cc0cab0f8f\",\"/knowledge-medium/pr-preview/pr-1917/src/sync/transform.js\":\"07a6ca12196e7958\",\"/knowledge-medium/pr-preview/pr-1917/src/themeBootDefaults.js\":\"82fd7911e4b32c0f\",\"/knowledge-medium/pr-preview/pr-1917/src/types.js\":\"09b007ae90f54039\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/ClientLocalSettings.js\":\"f110fc2cfee2a851\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/abortableSleep.js\":\"7aaf3a72a988ad39\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/array.js\":\"3bd65dba5e250d04\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/backlinkAutocomplete.js\":\"3f8b5bf5d989b3a3\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/blockCrumbs.js\":\"3d96029c39fb93cb\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/blockrefAutocomplete.js\":\"11109953aa026402\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/cadencedIdleJob.js\":\"1752d186e0e59f3a\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/callbackSet.js\":\"eff790d83cb27cab\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/clientId.js\":\"bb6e8fba023642b5\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/codemirror.js\":\"ea450c86c30d879f\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/codemirrorCompletion.js\":\"57355bfd747cb182\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/copy.js\":\"3aa1188f77048907\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dailyPage.js\":\"05e72d0750290082\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dbForensics.js\":\"558d8cae91c44dd1\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dbForensicsHooks.js\":\"755c96e8e00bb96c\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/deleteBlockThroughUi.js\":\"40cab70384352b88\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dialogs.js\":\"84d61e55f89a2888\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/dom.js\":\"9f98dc3316052660\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/downloadBlob.js\":\"684629f36e2db6e6\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/drawnWalk.js\":\"de978ace17287d13\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/exportSqliteDb.js\":\"46c916938f33d431\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/fileSystemAccess.js\":\"355ab774d5d6e8a0\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/flipSlide.js\":\"226d38c0e82bca9f\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/fnv1a.js\":\"3d15c5569aadf572\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/formatBytes.js\":\"fab52e63cb81dcb9\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/fuzzyRank.js\":\"1447947c5de5f436\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/idbKeyedStore.js\":\"9f6f1184e49b4bf7\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/idleCallbackPolyfill.js\":\"80dcb234f0835b71\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/keyboardAwareScroll.js\":\"4c6bc93136ff000d\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/keyboardViewport.js\":\"a0ce117cf488fa00\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/lastWorkspace.js\":\"a6a70952d05b90e1\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/layoutColumns.js\":\"d8e589b342d5c7e9\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/layoutSessionDom.js\":\"7e96d07cb7c76278\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/layoutSessionId.js\":\"de62eeffaf11757d\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/linkClickGestures.js\":\"4f617ba33486b82d\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/linkTargetAutocomplete.js\":\"2261f8f7dbb9e01c\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/localDbCorruption.js\":\"c096d5db6dfff9a3\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/localDbRecovery.js\":\"89ea8d70c33ec631\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/markdownParser.js\":\"02ddc23f4630b10a\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/memoize.js\":\"b2853e65288ee56f\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/nameFieldCommit.js\":\"ae2c93e9f75cbba5\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/nameList.js\":\"61267d38fa30492b\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/navigation.js\":\"4d0c2c56bd9f2a81\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/omnilinerNamespace.js\":\"4e959ce28742d263\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/opfsPageScan.js\":\"80bebb0e5c5ef826\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelClearance.js\":\"374c046964217787\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelHistory.js\":\"b8fe94a20b0e6563\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelLanes.js\":\"818906bf71b1ce70\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelLayoutProjection.js\":\"dcb4ab6c8304e688\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelScrollAnchor.js\":\"2f790309884f7790\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/panelUrlFlags.js\":\"74b735e7d601855d\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/platform.js\":\"bc40558366087b0d\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/pluralize.js\":\"9b5c646b75b985ba\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/propertyCreation.js\":\"9398d0b2c70428e9\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/propertyNavigation.js\":\"63392ea4c2cfa41e\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/propertyValueContext.js\":\"54fd1179861b22b7\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/react.js\":\"c6fe34119274ae0a\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/relativeDate.js\":\"a106572c7d7f5610\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/relativeTime.js\":\"6d2036a163cb5c9f\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/renderScope.js\":\"1d90cce652564eb4\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/resolvedThenable.js\":\"ca7217e4b9278d6a\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/routing.js\":\"582c639169dff002\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/safeMode.js\":\"761b3378ab34ec13\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/scheduleIdle.js\":\"b4e4e0f691de1335\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/screenWakeLock.js\":\"6674c87a4503a297\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/selection.js\":\"af1d85b0a494a2cf\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/softKeyboardGrab.js\":\"b1c9884b077ea680\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/startupTimeline.js\":\"fbd80e23b59c04a3\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/state.js\":\"78ce43c0c42e7554\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/string.js\":\"50a2b8312e8034ff\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/surfaceZoom.js\":\"0da42ecf2896589e\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/time.js\":\"25120d4c84a24154\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/toast.js\":\"f0da46d1dc113eda\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/toggleStore.js\":\"a1acca80115dd392\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/untilStopped.js\":\"dae4d18607582259\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/userActivity.js\":\"22442d09e7883789\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/viewTransition.js\":\"3aff15d696f53cab\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/viewport.js\":\"c18f70afcecc4199\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/webLock.js\":\"879c5bae7d42fe68\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/workspaceRecovery.js\":\"46b8ef643ddb3afc\",\"/knowledge-medium/pr-preview/pr-1917/src/utils/workspaceSnapshotStore.js\":\"b07d08a833575970\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-compiler-runtime.js\":\"e859c3aaacad29a8\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-client.js\":\"f36a772e40cd5ca3\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-server-edge.js\":\"907e96ef4c476554\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-server.js\":\"d81d2d744cc78d07\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-static-edge.js\":\"5d84d299e8e99d30\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-static.js\":\"a020ee0238d3000c\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom-test-utils.js\":\"b6931b493bc1c2e9\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-dom.js\":\"af0236943b0c1973\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react-jsx-runtime.js\":\"283273d696e86b28\",\"/knowledge-medium/pr-preview/pr-1917/src/vendor/react.js\":\"b60276c093d8dc0c\",\"/knowledge-medium/pr-preview/pr-1917/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1917/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1917/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
