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
		buildId: "bc4fe4bdfb79-f6b0d7c0",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1918/\":\"ab86b1799100434b\",\"/knowledge-medium/pr-preview/pr-1918/index.html\":\"ab86b1799100434b\",\"/knowledge-medium/pr-preview/pr-1918/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1918/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1918/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1918/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1918/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1918/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1918/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1918/assets/FacadeVFS-BUXI3Zpz.js\":\"01af30673d79831f\",\"/knowledge-medium/pr-preview/pr-1918/assets/OPFSCoopSyncVFS-DkXYnxdl.js\":\"cb8147cdb48fe20d\",\"/knowledge-medium/pr-preview/pr-1918/assets/OPFSWriteAheadVFS-Ct6ns8BX.js\":\"106537438a4d5e7b\",\"/knowledge-medium/pr-preview/pr-1918/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1918/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1918/assets/wa-sqlite-async-DJi8E6Up.js\":\"33cf682bb8974965\",\"/knowledge-medium/pr-preview/pr-1918/assets/wa-sqlite-sXq6MLWS.js\":\"c215eccf328936ab\",\"/knowledge-medium/pr-preview/pr-1918/assets/worker-VBz4q1GU.js\":\"e40b61a94de16746\",\"/knowledge-medium/pr-preview/pr-1918/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1918/chunks/app-DAtLXYfI.js\":\"b588420c10cacb97\",\"/knowledge-medium/pr-preview/pr-1918/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1918/index.js\":\"e2217fc815cc9884\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1918/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1918/assets/AccessHandlePoolVFS-r99vPhbZ.js\":\"05b3d467fdda6485\",\"/knowledge-medium/pr-preview/pr-1918/assets/IDBBatchAtomicVFS-BnOBJhtN.js\":\"ce8b81390e5487d0\",\"/knowledge-medium/pr-preview/pr-1918/assets/MemoryVFS-BBTUT21d.js\":\"6174b5470443839c\",\"/knowledge-medium/pr-preview/pr-1918/assets/mc-wa-sqlite-BEogl883.js\":\"abe7a30ea9580067\",\"/knowledge-medium/pr-preview/pr-1918/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1918/assets/mc-wa-sqlite-async-CQ5ywbCE.js\":\"88c6e43b432ef9d0\",\"/knowledge-medium/pr-preview/pr-1918/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1918/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1918/chunks/AccessHandlePoolVFS-CMQQqh7l.js\":\"c0a80cee7bc5c39e\",\"/knowledge-medium/pr-preview/pr-1918/chunks/FacadeVFS-ClMXPcT5.js\":\"503a76cf4c008fe5\",\"/knowledge-medium/pr-preview/pr-1918/chunks/IDBBatchAtomicVFS-DjWXF3tq.js\":\"2fdaf07a28922725\",\"/knowledge-medium/pr-preview/pr-1918/chunks/MemoryVFS-C83dO5uH.js\":\"78742b9210afb95b\",\"/knowledge-medium/pr-preview/pr-1918/chunks/OPFSCoopSyncVFS-DKbBaDef.js\":\"63c45cf8bb875a4b\",\"/knowledge-medium/pr-preview/pr-1918/chunks/OPFSWriteAheadVFS-DnKyFPnJ.js\":\"3cc123caafd4c45d\",\"/knowledge-medium/pr-preview/pr-1918/chunks/Preview-_guE3YuW.js\":\"95b4f7c495d47e22\",\"/knowledge-medium/pr-preview/pr-1918/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1918/chunks/card-eot-5DXw.js\":\"166c2f9a04d03c10\",\"/knowledge-medium/pr-preview/pr-1918/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1918/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1918/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1918/chunks/dist-CMVrTUFI.js\":\"72c8f9c7ec032193\",\"/knowledge-medium/pr-preview/pr-1918/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1918/chunks/mc-wa-sqlite-CQj9-Pt9.js\":\"02e1736fd8b1d69e\",\"/knowledge-medium/pr-preview/pr-1918/chunks/mc-wa-sqlite-async-CjRyk8mF.js\":\"e10a5ff0df0e2bb6\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-B4Ejips3.js\":\"a67fb6d2ffa0d18e\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-B85khkke.js\":\"dc5834573265013f\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-BI8mjulL.js\":\"214be2b41a3ad0cd\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-CTLqOJ6m.js\":\"512e6a631c3332e8\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-D_uYaJ6d.js\":\"356a67295d4dc46a\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-UocqBsXa.js\":\"e5d4b48b9853d63f\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-_pTxasqG.js\":\"cb300de1c17669c9\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-dom-server-legacy.browser.production-DSTflhra.js\":\"ca906ea25c87f0cf\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-dom-server.browser.production-DPAgWqYN.js\":\"b58e6dc4ecd20688\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-dom-server.edge.production-yj9v7vp7.js\":\"4a68cc7e592d0703\",\"/knowledge-medium/pr-preview/pr-1918/chunks/react-qPjDuJQQ.js\":\"454e1f977d4b5001\",\"/knowledge-medium/pr-preview/pr-1918/chunks/server.browser-CO7my29L.js\":\"c13cde48b8808bbc\",\"/knowledge-medium/pr-preview/pr-1918/chunks/textarea-Csaa1cOB.js\":\"763a974ca0fa2c50\",\"/knowledge-medium/pr-preview/pr-1918/chunks/ui-99aureUV.js\":\"e56c9652a1c3164f\",\"/knowledge-medium/pr-preview/pr-1918/chunks/wa-sqlite-Cm99ApkZ.js\":\"7d486459ca1866c8\",\"/knowledge-medium/pr-preview/pr-1918/chunks/wa-sqlite-async-sSMjmsLj.js\":\"2c7dcb6f6c73403f\",\"/knowledge-medium/pr-preview/pr-1918/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1918/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1918/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1918/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1918/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1918/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1918/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1918/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1918/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1918/src/App.js\":\"803b00bf79524f8e\",\"/knowledge-medium/pr-preview/pr-1918/src/appUpdate.js\":\"8ef421f617c75f31\",\"/knowledge-medium/pr-preview/pr-1918/src/appVersion.js\":\"0ed433c0c3cc2b1d\",\"/knowledge-medium/pr-preview/pr-1918/src/bootstrap/initialLayout.js\":\"bc747a5511ae7bee\",\"/knowledge-medium/pr-preview/pr-1918/src/bootstrap/openWorkspaceData.js\":\"8a742781c33b4853\",\"/knowledge-medium/pr-preview/pr-1918/src/bootstrap/resolveWorkspace.js\":\"3d73ecafa05bb5be\",\"/knowledge-medium/pr-preview/pr-1918/src/bootstrap/workspaceBootstrap.js\":\"fbd7edf17f59e2eb\",\"/knowledge-medium/pr-preview/pr-1918/src/components/BlockComponent.js\":\"21dd4faa26e2f800\",\"/knowledge-medium/pr-preview/pr-1918/src/components/BlockCrumbs.js\":\"4ca56844394f5bde\",\"/knowledge-medium/pr-preview/pr-1918/src/components/BlockEditor.js\":\"4711c8f131f514b7\",\"/knowledge-medium/pr-preview/pr-1918/src/components/BlockLoadingPlaceholder.js\":\"329e514700f95062\",\"/knowledge-medium/pr-preview/pr-1918/src/components/BlockProperties.js\":\"ba42e97da645270c\",\"/knowledge-medium/pr-preview/pr-1918/src/components/BlockSearchPicker.js\":\"7836c8722741ef3f\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ConfirmBulkDeleteDialog.js\":\"f62cc6011f5c20fc\",\"/knowledge-medium/pr-preview/pr-1918/src/components/DividerHandle.js\":\"50f8239cf2431a1c\",\"/knowledge-medium/pr-preview/pr-1918/src/components/DraftEditor.js\":\"3203c63e38955082\",\"/knowledge-medium/pr-preview/pr-1918/src/components/GutterPill.js\":\"937fccccb8d47efc\",\"/knowledge-medium/pr-preview/pr-1918/src/components/Header.js\":\"d14a0586e4d0b27a\",\"/knowledge-medium/pr-preview/pr-1918/src/components/LazyBlockComponent.js\":\"db8109fdadd9e50b\",\"/knowledge-medium/pr-preview/pr-1918/src/components/Login.js\":\"b8a25e5a6f6fd613\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ZoomableSurface.js\":\"4e57b03d472ff494\",\"/knowledge-medium/pr-preview/pr-1918/src/components/editModeKeepalive.js\":\"322dd9b73fb80183\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyDisplay/PropertyDisplayScope.js\":\"d82ace5769391d7d\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"413e1173ba6f535c\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyEditors/RefPropertyEditor.js\":\"01e95898ad872a12\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyEditors/RefTargetTypePicker.js\":\"50e5475de66740ef\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyEditors/SelectPropertyEditor.js\":\"62945a31cebbb338\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyEditors/TypesPropertyEditor.js\":\"c11bda47b2cec603\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyEditors/defaults.js\":\"49abce62c31915f3\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyEditors/kernelValuePresets.js\":\"6d9874ad79a52637\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyEditors/selectablePresets.js\":\"4eb0d2aff95917a9\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyEditors/typesPropertyUi.js\":\"fcdd069ed0e82d08\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/AddPropertyForm.js\":\"c1c65a6455436b99\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/PropertyPicker.js\":\"ae27b74963b23385\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/PropertyRow.js\":\"76f3027cedc7225c\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/Rows.js\":\"47fa2846789a173d\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/actions.js\":\"46eba1b8cce05e0b\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/declarationOnly.js\":\"0951170358e26106\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/layout.js\":\"ffcfbbe89245b0ce\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/model.js\":\"f167b4f0a3c5556d\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/shapeUi.js\":\"befe5de2158e8c3a\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/shapes.js\":\"62311663bf28111b\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/usePropertyEditingActivation.js\":\"80b3182b366422ee\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanel/visibility.js\":\"dc0808ef8f075b7f\",\"/knowledge-medium/pr-preview/pr-1918/src/components/propertyPanelSections.js\":\"d66834727ebeed64\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/BlockEmbed.js\":\"ca65005ac4d338d1\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/BlockLink.js\":\"730c16344461f07e\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/BlockRef.js\":\"3adb2227f2f7ea31\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/CompactReferenceLink.js\":\"ec6ee03f7c797c3f\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/ReferenceLink.js\":\"7c9c85fb379d741f\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/cycleGuard.js\":\"add965101626e472\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/cycleGuardContext.js\":\"bee0f889ff100b79\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/linkInteraction.js\":\"148a04472374f28a\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/referenceLayout.js\":\"e6dd5eefa8f4235e\",\"/knowledge-medium/pr-preview/pr-1918/src/components/references/useBlockRefAncestors.js\":\"f4464ca1c373b60d\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/BlockGutter.js\":\"7cef0798531c78cc\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/BlockInfoDialog.js\":\"6c645145ee9f1b99\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/BlockReadText.js\":\"b840ce04c4f19ad3\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/BlockTypeBlockRenderer.js\":\"981b5089c85fe54d\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/BulletHoverCard.js\":\"d6f1dfbbf360faf0\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/CodeMirrorContentRenderer.js\":\"b3e0b8d55e050f1b\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6f9644693c7883bd\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/ColumnResizeHandles.js\":\"ec43762e443c2fb4\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5d4bf9550dbec08b\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/DefaultBlockRenderer.js\":\"121456b673c979e3\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/LayoutRenderer.js\":\"7b86df03de129d40\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/MarkdownContentRenderer.js\":\"6cefc38b1d27a11e\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/MissingDataRenderer.js\":\"b0a2a2ca05a900e8\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/PanelRenderer.js\":\"ee0f0ecd7dda26d4\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/PropertySchemaBlockRenderer.js\":\"79b3c734d410e7ec\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/TopLevelRenderer.js\":\"6735856099dbb1f6\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/blockGutterMode.js\":\"b0642cede00694d7\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/blockTitleText.js\":\"c7367604c9c3f433\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/fieldCreationKeydown.js\":\"98508bd390decd86\",\"/knowledge-medium/pr-preview/pr-1918/src/components/renderer/layoutRootContext.js\":\"9757d3b2e529289c\",\"/knowledge-medium/pr-preview/pr-1918/src/components/typeChip/TypeChip.js\":\"8a7f1188cb0cfa68\",\"/knowledge-medium/pr-preview/pr-1918/src/components/typeChip/chipStyle.js\":\"9a0c720e3250dbc7\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/anchored-floating.js\":\"eec99ff51cac078d\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/button.js\":\"084710002f67a0ae\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/card.js\":\"bbf45c5708937dec\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/checkbox.js\":\"0000d4b37ce56c88\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/collapsible.js\":\"1b58d4564c1227c5\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/command.js\":\"a1da40b30078cde1\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/context-menu.js\":\"8dbacb98e3f69214\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/dialog.js\":\"593f96b4bf0e3d06\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/dropdown-menu.js\":\"b31686cdd858e4e1\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/floating-listbox.js\":\"eaf7a53be4abe4fc\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/index.js\":\"4edcbb7975a9b337\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/input.js\":\"46767f80a2a5f50f\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/kbd.js\":\"358f4c93035181c8\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/label.js\":\"456f8e1a23bfa06d\",\"/knowledge-medium/pr-preview/pr-1918/src/components/ui/textarea.js\":\"e1a1c47b058c5589\",\"/knowledge-medium/pr-preview/pr-1918/src/components/useEditModeYieldKeepalive.js\":\"2a422d4a8cb96d7f\",\"/knowledge-medium/pr-preview/pr-1918/src/components/util/BootFallback.js\":\"2448b61282de791c\",\"/knowledge-medium/pr-preview/pr-1918/src/components/util/FocusedRowLazyMount.js\":\"21d5eb620c2a158a\",\"/knowledge-medium/pr-preview/pr-1918/src/components/util/LazyViewportMount.js\":\"877586220cb43b07\",\"/knowledge-medium/pr-preview/pr-1918/src/components/util/LocalDbCorruptionFallback.js\":\"4b29052bc7f7bb7f\",\"/knowledge-medium/pr-preview/pr-1918/src/components/util/error.js\":\"90ffe0c6315b85b0\",\"/knowledge-medium/pr-preview/pr-1918/src/components/util/lazyMountRegistry.js\":\"ef85ed0831878241\",\"/knowledge-medium/pr-preview/pr-1918/src/components/util/suspense.js\":\"2b21db8f3a838891\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/CreateWorkspaceDialog.js\":\"5629e11ce6f1eb67\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/PendingInvitations.js\":\"f72c70878eeaec0c\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/SyncProgress.js\":\"dc548453a5a91ad3\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/UnlockProgress.js\":\"b8d3c86e985b9c4c\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/WorkspaceKeyGate.js\":\"66727d33cd4a0021\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/WorkspaceSettingsDialog.js\":\"0eeed434891866ed\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/WorkspaceSwitcher.js\":\"8f47ecec548c9b47\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/WorkspaceSyncGate.js\":\"1fc491a029168acc\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/conversion/ConversionFlow.js\":\"43305bec06705e1c\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/conversion/ConversionFlowHost.js\":\"901e202692d7f77d\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/conversion/EncryptionSection.js\":\"967a9bacef29cd64\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/conversion/attachmentPrompts.js\":\"66df0c48d3235372\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6e4295a6674e437a\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/conversion/conversionFlowDeps.js\":\"86576616844f9005\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/conversion/conversionFlowStore.js\":\"aa9321a225de3522\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/conversion/flowUi.js\":\"35fb7c6b1bd521c6\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/conversion/useConversionRun.js\":\"7039b8cc50b7dbd8\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/keyUi.js\":\"11372fe13406b50b\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/useCloseOnKeyLoss.js\":\"4fdccdff6aaece67\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/useCloseOnServerE2ee.js\":\"6d49382ebe2cab6e\",\"/knowledge-medium/pr-preview/pr-1918/src/components/workspace/workspaceUnlocked.js\":\"13ddf072487be92a\",\"/knowledge-medium/pr-preview/pr-1918/src/context/backgroundSubtree.js\":\"1db88eb6f4d8974a\",\"/knowledge-medium/pr-preview/pr-1918/src/context/block.js\":\"96728b592f702eb8\",\"/knowledge-medium/pr-preview/pr-1918/src/context/layoutWsContext.js\":\"e28a9e10ed5eb90b\",\"/knowledge-medium/pr-preview/pr-1918/src/context/propertyDisplay.js\":\"c4b92366e7015cf3\",\"/knowledge-medium/pr-preview/pr-1918/src/context/repo.js\":\"410fba54d9f9183c\",\"/knowledge-medium/pr-preview/pr-1918/src/data/aliasClaim.js\":\"6a52e7ebb488c082\",\"/knowledge-medium/pr-preview/pr-1918/src/data/aliasSeatNamespace.js\":\"59778bef6384faf7\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/blockData.js\":\"7e695841274ebbd8\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/blockType.js\":\"d9e232e4bbf12743\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/changeScope.js\":\"c37400b2504ffb28\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/codecs.js\":\"3f92b307499d6a09\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/derivedData.js\":\"d351b4eea1d715a2\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/errors.js\":\"33a3bdc3babd3aff\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/events.js\":\"f2f8333ea8ad0635\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/handle.js\":\"acb2c5b888d97347\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/index.js\":\"ea958908a1dec14f\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/mutator.js\":\"d5a0fd90a98cfb6e\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/processor.js\":\"74d7e5e423eaaf9e\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/propertySchema.js\":\"23c7c181a58ef739\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/query.js\":\"2ac00931337b526a\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/sameTxProcessor.js\":\"7f5b1810d5058b28\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/schema.js\":\"acb2c5b888d97347\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/tx.js\":\"acb2c5b888d97347\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/typedBlockQuery.js\":\"0f6c05eb837dcc25\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/user.js\":\"ca9d7e597974dd7b\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/valuePresetCore.js\":\"bf60454f91f3145c\",\"/knowledge-medium/pr-preview/pr-1918/src/data/api/valuePresets.js\":\"fc8beb13a92e7ec4\",\"/knowledge-medium/pr-preview/pr-1918/src/data/attachmentCleanerIOVerb.js\":\"ec56660366a1890a\",\"/knowledge-medium/pr-preview/pr-1918/src/data/block.js\":\"386826255ca726d3\",\"/knowledge-medium/pr-preview/pr-1918/src/data/blockCache.js\":\"c07480e70889aa13\",\"/knowledge-medium/pr-preview/pr-1918/src/data/blockId.js\":\"a6d51a5739c47b75\",\"/knowledge-medium/pr-preview/pr-1918/src/data/blockLiveness.js\":\"d43aa202f82eee7c\",\"/knowledge-medium/pr-preview/pr-1918/src/data/blockMerge.js\":\"2734ef6a17debdd8\",\"/knowledge-medium/pr-preview/pr-1918/src/data/blockSchema.js\":\"09a414dbc4a5c4da\",\"/knowledge-medium/pr-preview/pr-1918/src/data/blockTypeLookup.js\":\"4af341717e547e18\",\"/knowledge-medium/pr-preview/pr-1918/src/data/blockTypes.js\":\"73dff54d6005b9ed\",\"/knowledge-medium/pr-preview/pr-1918/src/data/childrenView.js\":\"17829fb94ded2994\",\"/knowledge-medium/pr-preview/pr-1918/src/data/clientContext.js\":\"033f645713e6de2c\",\"/knowledge-medium/pr-preview/pr-1918/src/data/dbFileSiblings.js\":\"d350d7efcc4d6ef3\",\"/knowledge-medium/pr-preview/pr-1918/src/data/definitionSeeds.js\":\"4397f79b2cf9349a\",\"/knowledge-medium/pr-preview/pr-1918/src/data/derivedIds.js\":\"85eaf1f7631fe3ee\",\"/knowledge-medium/pr-preview/pr-1918/src/data/drawnSubtree.js\":\"1eb6271286aae430\",\"/knowledge-medium/pr-preview/pr-1918/src/data/facetBridge.js\":\"e6516c5fdd2df8f8\",\"/knowledge-medium/pr-preview/pr-1918/src/data/facets.js\":\"99788c1b33b0ec63\",\"/knowledge-medium/pr-preview/pr-1918/src/data/globalState.js\":\"7a40d623dafa124c\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/aliasClaimRederiveProcessor.js\":\"960c5585a506c4ca\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/ancestorBatch.js\":\"7fd33ccb6492a189\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/blockTypeTypeifyProcessor.js\":\"be71d2f5c7e90c13\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/clientSchema.js\":\"9d0858ff0dcc5ca9\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/commitPipeline.js\":\"89c60adc18e70c1d\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/devAssertions.js\":\"b98a938d8f9a856e\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/firstSync.js\":\"c32562701e940c9c\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/freshInitialLoad.js\":\"cb539794670cf056\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/graphBackfillClaim.js\":\"6f173c059feef1b1\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/handleStore.js\":\"68712e9ce09246d0\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/idleMarkerJobs.js\":\"d591dfb8581c42ef\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/initialDownload.js\":\"ca89986afbc88f43\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/initializeClientDatabase.js\":\"06b1891c9d4b5593\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/jsonCanonical.js\":\"8fe829c6bae2b403\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/kernelInvalidation.js\":\"d64c872591e43f02\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/kernelProcessors.js\":\"6519bde77fb947df\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/kernelQueries.js\":\"cb4907f9f1759420\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/mergeTypeMembershipProcessor.js\":\"f581b472dbfe9ef8\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/normalizeReferencesProcessor.js\":\"4669997159aca093\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/poolInstrumentation.js\":\"ae1ee150c371e753\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/processorRunner.js\":\"139d91aba7310c12\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/propertyCellBackfill.js\":\"f12e05ec11838211\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/propertyChildMint.js\":\"5ba84cf1b572da02\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/propertyChildrenProcessor.js\":\"cfea6943802fdf8d\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d3db70258d93f24f\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/propertyDefinitionSynthesis.js\":\"89d3f9c0b5072746\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/propertyKeyScan.js\":\"cd737c92319be35f\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/propertySchemaResolution.js\":\"540c9193eea7b4f6\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/propertyValueEdits.js\":\"5a7a90e2ceeb2e82\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/raiseProtocol.js\":\"baeab448a37bb5ac\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/readBatch.js\":\"24271b8f5d765776\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/refProjection.js\":\"a616800d1b158111\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/referenceTargetLookups.js\":\"b7246cd50fdcd215\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/referenceTargetProcessor.js\":\"2e1acc7ac3cf8e4f\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/replayMerge.js\":\"4c6fb285fa6fee69\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/sqlBinds.js\":\"317c677be9ac94d6\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"5adefde0f6165fff\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/syncObserver/arrivalProcessors.js\":\"9034ae28ddc0559d\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/syncObserver/invalidate.js\":\"c76513903432a6f7\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/syncObserver/materialize.js\":\"9a98f16dcd2bc413\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/syncObserver/observer.js\":\"6bfb7e6f195f7689\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/syncObserver/reconcile.js\":\"d4ba3eb5f59d01b4\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/timingMetrics.js\":\"d8ba51d1c5797026\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/treeQueries.js\":\"c0bd1920d95a9155\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/txEngine.js\":\"1c0130934aef67d8\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/txSnapshots.js\":\"fab20c237acec099\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/typedBlockQuery.js\":\"a92a36be1195d93a\",\"/knowledge-medium/pr-preview/pr-1918/src/data/internals/undoManager.js\":\"33f9c9d075ec1842\",\"/knowledge-medium/pr-preview/pr-1918/src/data/invalidation.js\":\"b9c90d2471814220\",\"/knowledge-medium/pr-preview/pr-1918/src/data/kernelDataExtension.js\":\"f43b3b2a297919aa\",\"/knowledge-medium/pr-preview/pr-1918/src/data/kernelPage.js\":\"95d5c69e0f87f258\",\"/knowledge-medium/pr-preview/pr-1918/src/data/kernelValuePresetCores.js\":\"2080b2e3ff45f4f4\",\"/knowledge-medium/pr-preview/pr-1918/src/data/localDbCorruptionSignal.js\":\"9ae7fd322a871751\",\"/knowledge-medium/pr-preview/pr-1918/src/data/localDbStorage.js\":\"d564b66f22e2d1c1\",\"/knowledge-medium/pr-preview/pr-1918/src/data/localDbVfs.js\":\"ff4861628ae02ae4\",\"/knowledge-medium/pr-preview/pr-1918/src/data/localSchema.js\":\"af0288024dc587e6\",\"/knowledge-medium/pr-preview/pr-1918/src/data/maintenance.js\":\"6c1c98f91ee00827\",\"/knowledge-medium/pr-preview/pr-1918/src/data/mergeProperties.js\":\"4079e5cee04a6618\",\"/knowledge-medium/pr-preview/pr-1918/src/data/metricsConsoleHook.js\":\"0495e97c97bc2a92\",\"/knowledge-medium/pr-preview/pr-1918/src/data/migrationsPage.js\":\"de037637268be794\",\"/knowledge-medium/pr-preview/pr-1918/src/data/mutators.js\":\"b7a136b75674e81a\",\"/knowledge-medium/pr-preview/pr-1918/src/data/orderKey.js\":\"49a077d5007d66aa\",\"/knowledge-medium/pr-preview/pr-1918/src/data/orderKeyPlacement.js\":\"3f410859b38555cb\",\"/knowledge-medium/pr-preview/pr-1918/src/data/outlineSurface.js\":\"d5c9a64657f1a56d\",\"/knowledge-medium/pr-preview/pr-1918/src/data/pendingEditorContent.js\":\"38110b275659b0f6\",\"/knowledge-medium/pr-preview/pr-1918/src/data/pendingUploadsSql.js\":\"9d567546723ea4d8\",\"/knowledge-medium/pr-preview/pr-1918/src/data/pluginStateExtensions.js\":\"ae79236807fb9042\",\"/knowledge-medium/pr-preview/pr-1918/src/data/powerSyncLogger.js\":\"618badde02d0e47a\",\"/knowledge-medium/pr-preview/pr-1918/src/data/projectorRuntime.js\":\"f743f447b0f963c3\",\"/knowledge-medium/pr-preview/pr-1918/src/data/properties.js\":\"16b7f8a377adafa4\",\"/knowledge-medium/pr-preview/pr-1918/src/data/propertiesPage.js\":\"18bfd7e798509907\",\"/knowledge-medium/pr-preview/pr-1918/src/data/propertyChildren.js\":\"21790a0c1f1f71a7\",\"/knowledge-medium/pr-preview/pr-1918/src/data/propertyDefinitionFanout.js\":\"938099cc760c1662\",\"/knowledge-medium/pr-preview/pr-1918/src/data/propertyDefinitionMetadata.js\":\"7e570a88dd44fe1d\",\"/knowledge-medium/pr-preview/pr-1918/src/data/propertyDefinitionRegistry.js\":\"6283ad0d79866958\",\"/knowledge-medium/pr-preview/pr-1918/src/data/propertyDisplayMode.js\":\"05836fa7573af365\",\"/knowledge-medium/pr-preview/pr-1918/src/data/propertyRowCreation.js\":\"99e727edd54e00b0\",\"/knowledge-medium/pr-preview/pr-1918/src/data/propertySchemaCreation.js\":\"eb34d259dcc219b5\",\"/knowledge-medium/pr-preview/pr-1918/src/data/propertySeeds.js\":\"9ca2b10f73482d09\",\"/knowledge-medium/pr-preview/pr-1918/src/data/recentsPage.js\":\"3d575bae9e14fbb8\",\"/knowledge-medium/pr-preview/pr-1918/src/data/refTargetComparableProperty.js\":\"848d4e562aca1712\",\"/knowledge-medium/pr-preview/pr-1918/src/data/referenceBlock.js\":\"1ba1042884d677b4\",\"/knowledge-medium/pr-preview/pr-1918/src/data/rejectedUploads.js\":\"5347236637084506\",\"/knowledge-medium/pr-preview/pr-1918/src/data/releasePowerSyncConnection.js\":\"a9554732b8978f88\",\"/knowledge-medium/pr-preview/pr-1918/src/data/repo.js\":\"c2c0bbf8bbd39d4d\",\"/knowledge-medium/pr-preview/pr-1918/src/data/repoProvider.js\":\"79208a5a3aec5aab\",\"/knowledge-medium/pr-preview/pr-1918/src/data/rowProperty.js\":\"9f77e2b11156c85a\",\"/knowledge-medium/pr-preview/pr-1918/src/data/searchFilter.js\":\"a5310f193ed00836\",\"/knowledge-medium/pr-preview/pr-1918/src/data/seedIdentityLedger.js\":\"00a54d81fdd92996\",\"/knowledge-medium/pr-preview/pr-1918/src/data/stateBlocks.js\":\"7bcfabe1fa1f7ddf\",\"/knowledge-medium/pr-preview/pr-1918/src/data/structuralEditPolicy.js\":\"daf7438d7c023230\",\"/knowledge-medium/pr-preview/pr-1918/src/data/structuralInsert.js\":\"3d3fc11ad9fb8d69\",\"/knowledge-medium/pr-preview/pr-1918/src/data/subtreeDelete.js\":\"dbd057eabbc7d143\",\"/knowledge-medium/pr-preview/pr-1918/src/data/syncStreamLock.js\":\"eca72da1089a2b6e\",\"/knowledge-medium/pr-preview/pr-1918/src/data/syncedTableSqlRecognizer.js\":\"71aa39af40184f20\",\"/knowledge-medium/pr-preview/pr-1918/src/data/syncedTableWriteGuard.js\":\"4b9cbdd1b84e7437\",\"/knowledge-medium/pr-preview/pr-1918/src/data/targets.js\":\"668c8d9fe5281cdf\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typeColors.js\":\"b4b084735b2ecca3\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typeDefinitionMetadata.js\":\"399e1d91e0d34be1\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typeDefinitionRegistry.js\":\"6e2a6cdc52731111\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typeExtraction.js\":\"84530a8d3ba2c677\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typeInitialValues.js\":\"a482dae05217b219\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typePropertyGroups.js\":\"7e5e458c86268d73\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typeSeeds.js\":\"5f68e9c7588425f4\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typeTagger.js\":\"c9d65fff6a88f22a\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typedRecords.js\":\"e633884e0892989f\",\"/knowledge-medium/pr-preview/pr-1918/src/data/typesPage.js\":\"85679a866eef6a7e\",\"/knowledge-medium/pr-preview/pr-1918/src/data/userPrefs.js\":\"5094372a3dc9a7d5\",\"/knowledge-medium/pr-preview/pr-1918/src/data/userSchemasService.js\":\"e3f903a9169f0e75\",\"/knowledge-medium/pr-preview/pr-1918/src/data/userTypesService.js\":\"ceb8c017a967899b\",\"/knowledge-medium/pr-preview/pr-1918/src/data/valuePresetRegistry.js\":\"452498afab32eb40\",\"/knowledge-medium/pr-preview/pr-1918/src/data/visibleChildren.js\":\"e54d31890b07bb4a\",\"/knowledge-medium/pr-preview/pr-1918/src/data/workspaceConversion.js\":\"7a2661d1f6c0d716\",\"/knowledge-medium/pr-preview/pr-1918/src/data/workspaceFirstSync.js\":\"f1ab279dc5380224\",\"/knowledge-medium/pr-preview/pr-1918/src/data/workspaceIdNamespace.js\":\"0b2dc8f005aed1be\",\"/knowledge-medium/pr-preview/pr-1918/src/data/workspaceSchema.js\":\"26d55906b1e93b5c\",\"/knowledge-medium/pr-preview/pr-1918/src/data/workspaces.js\":\"b9cb65cd5eb1e2b0\",\"/knowledge-medium/pr-preview/pr-1918/src/data/writeAheadLog.js\":\"889770881c9da250\",\"/knowledge-medium/pr-preview/pr-1918/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/BlockPasteShellDecorator.js\":\"e207d0a1b39d9c9b\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/atTrigger.js\":\"ef55ae6816cc8e90\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/autocomplete.js\":\"6df040ab4dc9df14\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/codeMirrorExtensions.js\":\"a312134c38a0f771\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/contentFlush.js\":\"47f505f1006a3e3f\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/defaultInteractions.js\":\"7aee1b162a2da5f3\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/editSettleSignal.js\":\"c6540d7d7bc0c552\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/insertImage.js\":\"9045b5889b9f9c3b\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/referenceCompletionRange.js\":\"d0e9830f7ed007e2\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/referenceTargetTypes.js\":\"3228faf652654ab5\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/syntaxContext.js\":\"737c717b6f639c48\",\"/knowledge-medium/pr-preview/pr-1918/src/editor/triggerMatch.js\":\"25506fb3c51e4b12\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/AppRuntimeProvider.js\":\"89798936bd636a88\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/BlockFocusShellDecorator.js\":\"b4b5d142b8ba2e9d\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/ExtensionRenderBoundary.js\":\"535b0d291c07e22f\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/PanelContentRecovery.js\":\"e06cb55d0daa3a80\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/apiCatalog.js\":\"067a00de394b5f7a\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/appRuntimeController.js\":\"6534b79ea255f7e1\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/approveExtensionHere.js\":\"c7cc5a2de56f3fb8\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/armedCutAppMount.js\":\"a0535fdc502f452a\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/batchableKeyedStore.js\":\"0bbf5a635acb24af\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/blockInteraction.js\":\"f1940c246c7be6dc\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/blockSelectionAction.js\":\"b819f2c2878741bc\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/compileExtensionModule.js\":\"c5d3c2a821c072be\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/compiledModuleCache.js\":\"3a62094002bd2c48\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/continuousGestures.js\":\"faa0fd50e6dc4c30\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/core.js\":\"eec73d0b55e28149\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/defaultRenderers.js\":\"1caa22b5f8cbeb60\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/definitionFanoutAppMount.js\":\"9dddcc8ad681a3cb\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/dialogAppMount.js\":\"922b44c988be7754\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/dynamicExtensionSeeds.js\":\"f697c20672583425\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/dynamicExtensions.js\":\"1801f1709b3769d6\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/exampleExtensions.js\":\"1929dd201340f75a\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/extensionApprovalStatus.js\":\"dad2b597cbf4bb0f\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/extensionLoadErrorToast.js\":\"1191defb107eb824\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/extensionLoadErrors.js\":\"13119715452e383a\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/extensionLookup.js\":\"3f85a7404024bbb3\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/extensionToggles.js\":\"8d19921ae5909404\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/extensionUtilitiesCss.js\":\"63bd8637355e0ad9\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/kernelPageDeletionGuard.js\":\"3c8eed8ebda3f3d1\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/liveRuntime.js\":\"4eebe8df5a369730\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/openExtensionsSettings.js\":\"3cd830b6c86cd505\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/overridesCache.js\":\"f0428aad8c75eab7\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/pluginIds.js\":\"7a3ac5e789084e57\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/processorRejectionToast.js\":\"8034f2a6e09c559c\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/runtimeActions.js\":\"23b53f4dd91dc32e\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/runtimeContext.js\":\"f286eefcc3e37c6a\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/staticAppExtensions.js\":\"1717e5f457bbe9b6\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/staticDataExtensions.js\":\"3f134e7bdb29cb01\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/toastAppMount.js\":\"04139864eec77b7d\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/useOverrides.js\":\"b53d6bc425ac9218\",\"/knowledge-medium/pr-preview/pr-1918/src/extensions/useShortcutSurfaceActivations.js\":\"9a4be2f2827b9b41\",\"/knowledge-medium/pr-preview/pr-1918/src/facets/discoverToggleTree.js\":\"63f81aaeab271da5\",\"/knowledge-medium/pr-preview/pr-1918/src/facets/facet.js\":\"ff9a447b3141d819\",\"/knowledge-medium/pr-preview/pr-1918/src/facets/resolveAppRuntime.js\":\"89006c51494dfb73\",\"/knowledge-medium/pr-preview/pr-1918/src/facets/runtimeEvents.js\":\"7334d9bbed176eb3\",\"/knowledge-medium/pr-preview/pr-1918/src/facets/togglable.js\":\"fddee1521d88ccdc\",\"/knowledge-medium/pr-preview/pr-1918/src/facets/variantFacet.js\":\"4cc9eca67957f830\",\"/knowledge-medium/pr-preview/pr-1918/src/facets/verbFacet.js\":\"b75fee1f4d99a01f\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/block.js\":\"eba3f43394f57fa9\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/focusedChild.js\":\"b0789d4250ef9f8f\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/propertySchemas.js\":\"29a5703cedfda2d3\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/typeRegistry.js\":\"9255a72c96a0e461\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useAncestorCrumbs.js\":\"05f0807b7f2fed53\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useAutocompleteListbox.js\":\"218b60414109f49d\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useDebouncedSearch.js\":\"1fad3c00b01888f8\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useDebouncedValue.js\":\"1c8f7ce444077d50\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useFacetValue.js\":\"e0f8f9570b98d530\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useIsFocalRender.js\":\"9913fdeab169e3bc\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useIsReadOnly.js\":\"85795ef3d737f538\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useMaterializeBacklog.js\":\"4921ddfc7fb99686\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useMinuteClock.js\":\"0907a63c1cf634ef\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/usePanelLayoutProjection.js\":\"c7062c936dd1286b\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/usePendingInvitations.js\":\"81d981458db07864\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useRendererRegistry.js\":\"cfd14fd5658d7dfb\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useRetainedFieldRows.js\":\"63ff6dbdb8df20a8\",\"/knowledge-medium/pr-preview/pr-1918/src/hooks/useWorkspaces.js\":\"1ac4ef2817ef1550\",\"/knowledge-medium/pr-preview/pr-1918/src/lib/utils.js\":\"fcdff8066924ce4a\",\"/knowledge-medium/pr-preview/pr-1918/src/main.js\":\"a83416022e607f86\",\"/knowledge-medium/pr-preview/pr-1918/src/markdown/MarkdownImage.js\":\"bf7a08233bb987aa\",\"/knowledge-medium/pr-preview/pr-1918/src/markdown/blockSeparators.js\":\"ce3a767f2478a94d\",\"/knowledge-medium/pr-preview/pr-1918/src/markdown/context.js\":\"e6f86233059fac08\",\"/knowledge-medium/pr-preview/pr-1918/src/markdown/defaultMarkdownExtension.js\":\"ef723086c5cb90c2\",\"/knowledge-medium/pr-preview/pr-1918/src/markdown/extensions.js\":\"f93561e33b1b2fce\",\"/knowledge-medium/pr-preview/pr-1918/src/markdown/renderMarkdownHtml.js\":\"acd688da682f615e\",\"/knowledge-medium/pr-preview/pr-1918/src/minimal-editor.js\":\"f6c93a50bc6e6d30\",\"/knowledge-medium/pr-preview/pr-1918/src/paste/armedCut.js\":\"5d9f38cf182739bf\",\"/knowledge-medium/pr-preview/pr-1918/src/paste/captureMediaVerb.js\":\"01b25fb4bae2c61b\",\"/knowledge-medium/pr-preview/pr-1918/src/paste/clipboard.js\":\"8f8016a348374c56\",\"/knowledge-medium/pr-preview/pr-1918/src/paste/decision.js\":\"64d514c9f739185f\",\"/knowledge-medium/pr-preview/pr-1918/src/paste/operations.js\":\"a522666efafe9bbc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/account-header/AccountHeaderItem.js\":\"e4e4372828089dac\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/account-header/index.js\":\"f5c6998959ce7666\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"10984cb34076e51e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-dispatch-companion/askAgent.js\":\"1426180656ffefbc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-dispatch-companion/askedStore.js\":\"bd6694fb77fe3621\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"7f3bcc5d8e1b3b52\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-dispatch-companion/chipState.js\":\"8891d0c2f0ab7a67\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-dispatch-companion/dataExtension.js\":\"70544612c3208757\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-dispatch-companion/index.js\":\"36911b3aedff0d0f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"f598ac00586fa234\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-dispatch-companion/schema.js\":\"579468bf7344a160\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/AgentTokensDialog.js\":\"caf17abc0dec6903\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/BridgePairingDialog.js\":\"33ca2268dfe92d5f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/addMedia.js\":\"0fc02be9809fe67a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/backlinks.js\":\"beaccb50430e880c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/block.js\":\"9ce0cb32ecd2d463\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/context.js\":\"b415d439cf59721b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f908ad60b2397515\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/index.js\":\"708e1df68707a746\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/outline.js\":\"68902d6a3312beae\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/properties.js\":\"3e6512775c0650ce\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/refs.js\":\"3e569dd29fba3fd4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"bef16c5aef195ebe\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/search.js\":\"bae712a23e4b557f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/shared.js\":\"676f9bbf14a62c5d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3f67282275487d79\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentViews/text.js\":\"4783afc5cff5987e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/agentWrites.js\":\"a54a77d1beb580fb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/authoringCatalog.js\":\"b25380086970d712\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/blockRefTargets.js\":\"2732f87dba02bccb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/bridge.js\":\"afdb5457123db290\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/bridgeLoop.js\":\"eca52634a425a8a3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/changeHistory.js\":\"296ae340990e04dc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/commands.js\":\"88219ca0c74fe6b6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/commentsCommands.js\":\"263c4c0d0983667c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/dataExtension.js\":\"cff0ffd5f0848f3c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/dataModelGuide.js\":\"59951bfdd869bdd3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/dayPropertyInputs.js\":\"6773e91159243aef\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/describeRuntime.js\":\"a3fc410fd88ec94c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/extensionLint.js\":\"368b8c43cdf83710\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/grainAudit.js\":\"d0244899a8cb3097\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/healthCommand.js\":\"ee6b058329d3a91b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/index.js\":\"a6c5f4c2f763601b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/presetIdentity.js\":\"2b2fe22a2b3f3f61\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b43a5205a35d72ef\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/readMedia.js\":\"876ee29de70903c9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/schema.js\":\"14e5610777b7962d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/serialization.js\":\"7ab92244aab1fa89\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/targets.js\":\"e53e2995bf8c0ddc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/tokens.js\":\"68c86c91a8f1685f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/watchEvents.js\":\"d7278c4a45bf19cb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/workspaceGuard.js\":\"a62c3e05871a8892\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/agent-runtime/writeCommands.js\":\"5bc3424e28d81639\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/alias/AliasCollisionToast.js\":\"575b0728e59b82d4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/alias/DuplicateNameBanner.js\":\"4f2d0aa8e114c55f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/alias/collisionMerge.js\":\"d333291db5d17b98\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/alias/dataExtension.js\":\"a70ec3fd0e80ed06\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/alias/index.js\":\"e06487ce25a0cfad\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/alias/mergeCollisionAction.js\":\"037671e807bcd4ed\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/alias/pageStyling.js\":\"c346aac1cf5ef51f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/alias/rejectionToast.js\":\"4f75410554c64748\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/alias/syncProcessor.js\":\"9c5449148c702c0d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/actions.js\":\"dec148c605e715eb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/addComment.js\":\"25891bca171f9e8c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/anchor.js\":\"6d76476bcc08d976\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/anchorState.js\":\"305b5c9342c77dc3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/commentLinks.js\":\"1b9e979b55477cc5\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/confirmThreadDeletion.js\":\"240f44c2a31ae886\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/container.js\":\"4a9c5eb2e555499c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/dataExtension.js\":\"ce2dda1d59038880\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/deleteComment.js\":\"088ba48f3b927aac\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/highlights.js\":\"4ad537b8786e08d0\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/index.js\":\"8518ca4751684aff\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/linkedCommentsPill.js\":\"505427949affe7e3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/margin.js\":\"b3ed96a11f1f2c28\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/marginAnchorLinks.js\":\"b2246947be80ac04\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/marginSchema.js\":\"a5d314056b314cae\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/newComment.js\":\"f65422ca0a1ee445\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/ownThreadPicker.js\":\"35436890039b683b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/placement.js\":\"026bf61bd5e745ab\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/queries.js\":\"1fa86d876f7595da\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/quotePosition.js\":\"f1ab5a23bbd23f9e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/quotedIn.js\":\"265fb595ac099f9c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/quotedRange.js\":\"24c12d1d9ceec22e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/rangeRefs.js\":\"93cc64fc9dbb7740\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/readHighlights.js\":\"485bf7f1de5a272b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/readSelection.js\":\"b435e00b2bfb8aec\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/readSelectionUi.js\":\"0ca928976518b740\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/reanchor.js\":\"5eb04663ebfd6647\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/schema.js\":\"e6761221f8fdc350\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/scope.js\":\"d4ab8212386aadd0\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/scopeThreads.js\":\"a7dc932bb568735b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/splitRetarget.js\":\"eef7693afd0f8627\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/suggestionCard.js\":\"81206bc4a3d7b3a2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/suggestions.js\":\"8b9cbc412bb8f9d4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/summaries.js\":\"e0869491661a2a47\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/summaryBatch.js\":\"37c256960e88a3c6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/surface.js\":\"d5ccb2718c8edf0b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/threadNavigation.js\":\"133ef91a35ea2765\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/threads.js\":\"ecb6c928a9d785cc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/ui.js\":\"27366abab4b2bcd8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/annotations/uiStore.js\":\"33214fb696cf8131\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/app-intents/appIntents.js\":\"3a93865b2dbe695c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/app-intents/index.js\":\"8b0d2bd8676141da\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/app-update-prompt/index.js\":\"2af26aae9bcddabc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/app-update-prompt/status.js\":\"0cd010d1f120914a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"7b697dec11291950\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/MediaBlockRenderer.js\":\"beb342f4e3072997\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/MediaDownLaneReplicator.js\":\"51e0eee3b0634b30\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/MediaUploadReconciler.js\":\"d5647edd0ac11fd6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/assetDownLane.js\":\"f6f4b85662679710\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/assetResolver.js\":\"7cd6520079acf8a1\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/assetUpload.js\":\"24f88fdf6e1809f8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/attachmentCleanerIO.js\":\"d4e704ee68be1220\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/audit/supabaseAuditIO.js\":\"973b523d4e911de8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/blobStore.js\":\"1f0de3b8b8952b78\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/browserMedia.js\":\"a02f3a24e8b64a41\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/byteStore.js\":\"342ce0e6824c08e8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/cleanerIO.js\":\"286d8ae29258eda2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/cleanupAttachments.js\":\"d0126fe1ae13d135\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/dataExtension.js\":\"ded77d1b61729e83\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/downLane.js\":\"8d91e6a3ee57ec7d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/index.js\":\"63968538feb4ca7d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/insertImageContribution.js\":\"49b6e56ae2e522f6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/laneArming.js\":\"6bdf9c3e9d472408\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/laneLock.js\":\"19a3064bf30cfa8d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/mediaBlock.js\":\"98e2b5964fbd9fab\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/mediaCapture.js\":\"c8d69b0a61f3eaa4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/mediaLanes.js\":\"c396ec99efcc1ddc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/mediaViewers.js\":\"741fdee5f5ed5953\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/mediaViewersFacet.js\":\"6833eb20bdd5b7ad\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/pasteCapture.js\":\"a7fbe84a89118117\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/resolver.js\":\"19295ff694afd0d6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/retryUploadsAction.js\":\"ec5dc9114a4b6afb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/storagePaths.js\":\"aeaf83b2011a2186\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/uploadDrain.js\":\"545be4ad40658905\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/uploadLaneStatus.js\":\"b57273c6613b5756\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/uploadReconcile.js\":\"07d87e469add844d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/uploadRecovery.js\":\"cc2f064619ed904e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/uploadStore.js\":\"8584ba933a00ac7a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/attachments/useAssetObjectUrl.js\":\"d5b6340f85e9d462\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"9f58a325bb58074b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks-view/BacklinksViewSection.js\":\"35b4a7d3a17546c6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks-view/facet.js\":\"34b27e8898bc63a4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks-view/index.js\":\"3e3adb29ca1c2e42\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks-view/prop.js\":\"3826040aa84de8b3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/BacklinkFilters.js\":\"2abba0b141c6a5a6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"bdbbe34273934ec9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/BlockEntry.js\":\"4deaa0c32e86f4c2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/LinkedReferences.js\":\"b0ad62aa2da6de3b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8036f5cfed28b397\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/dailyNoteDefaults.js\":\"62780c3d7190806a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/dataExtension.js\":\"229dd49d1650d413\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/edgeExclusions.js\":\"de0ab5bd8b2adaeb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/filterProperty.js\":\"53d3eec6a7a8c62e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/index.js\":\"debd644a19ac817e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0a7cc5a31ac643d5\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/inline-counts/applies.js\":\"e53ce8fe29871606\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/inline-counts/countQuery.js\":\"925a2a90a2942b84\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/inline-counts/expansionStore.js\":\"d967a119410ff995\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/inline-counts/index.js\":\"a3f85ad774d8a0ee\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"58eab8e1c9d9b296\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/presentationInvalidation.js\":\"786d87feeafff16d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/propertyEditorOverride.js\":\"d7f9cd964c2d9274\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/propertyFilter.js\":\"4907981ce1b17671\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/query.js\":\"25d04b0ce7b7df5c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/resolveFilter.js\":\"a8ff5a41e3274972\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/sourceBatch.js\":\"2664315464bcc482\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/sources.js\":\"ef67b66539c5bb61\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/useBacklinks.js\":\"08e53be8c90ab56a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"17ad77e11bc024a7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/birthday/BirthdayCelebration.js\":\"39cfc640fec5de4c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/birthday/BirthdayOverlay.js\":\"3eb362f2b7cd0fe7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/birthday/gate.js\":\"2811caac7739c5ac\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/birthday/index.js\":\"e8e53f8f97420dfa\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/birthday/wolfTheme.js\":\"549cd847352430a7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-drag/BlockDragLayer.js\":\"08853a4f191b6b09\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-drag/dragController.js\":\"6f64846bfaf34397\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-drag/dropTarget.js\":\"44912540db031144\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-drag/index.js\":\"3254281fc598d03c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-drag/projection.js\":\"2f60e01c344fad16\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-info/BlockMetaCard.js\":\"55446fdad0286cf9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-info/index.js\":\"0745a70752bd3546\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-tagging/AddTagDialog.js\":\"d11c534873b59e5e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"2e31cee6f2c890ee\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-tagging/TagNameIssueHint.js\":\"b22c43d10ebdc321\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-tagging/addTagAction.js\":\"895364314f96203a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-tagging/appendTag.js\":\"99f47a71b7b1b9e4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-tagging/config.js\":\"aa0526c46a7fa197\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-tagging/dataExtension.js\":\"e8be2c550be0b6d8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-tagging/index.js\":\"07a9e72cee0955ee\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/block-tagging/propertyEditorOverride.js\":\"3bb76f5c2a746310\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/breadcrumbs/BreadcrumbList.js\":\"14271a69ae844f8f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"8a16229a0823ed51\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1a3563d8d210646c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"185cf7fffd3bcc0e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0aa8d571b44339ac\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/breadcrumbs/index.js\":\"b7af15bbeda3daf3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"4825662ffd333717\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/CharacterCountItem.js\":\"24f8ed762560c127\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c49cd96f549df997\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/actions.js\":\"cb8eb0eec9cad3b8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/blockType.js\":\"4929b45ac8d6c3e6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/charCount.js\":\"ac0c2f02197e8a45\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/dataExtension.js\":\"fe5cefa51bb48c99\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/index.js\":\"73bc4177dfdb7b87\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/profiles.js\":\"8bec4e0527b57f27\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/properties.js\":\"bede529ae0aa2e28\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/subtree.js\":\"5f3db9e8606de14e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/character-counter/textCounts.js\":\"793ed1c7449b144d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/colemak-keybindings/index.js\":\"4e4491cddc3a5c0d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/command-palette/CommandPalette.js\":\"13cf8215d772feaf\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/command-palette/HeaderItem.js\":\"182b309bc12b2c27\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/command-palette/context.js\":\"293101a4b95d0487\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/command-palette/index.js\":\"8792211b4f127b97\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/command-palette/selection.js\":\"d5305ce90651b765\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/command-palette/toggleStore.js\":\"8a58b9fd1ae05eff\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/command-palette/useCommandPaletteActions.js\":\"a83909e79a1aca1d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/ContributorBadges.js\":\"712d162f99ec2e8e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/ProfilePicture.js\":\"efa60c774a3e1a7c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/author.js\":\"4db0ba132a137b8c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/codeMirrorExtensions.js\":\"08c5bbbfaf3b696b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/dataExtension.js\":\"c72de95692b7ad31\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/index.js\":\"9506b9e40d726dd8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/mentionAutocomplete.js\":\"a4ec9e40a615f464\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/processor.js\":\"75f8e2e88eefb7ef\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/profiles.js\":\"756dd3289ffb9b2e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/queries.js\":\"e0b070b4091999f5\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/schema.js\":\"2bd9429877f47eb7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/contributors/useCommentAuthor.js\":\"788fb5e7d43b830a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"379ca0e139fd8f09\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e467e88e77cdc95b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/cursor-follows-scroll/index.js\":\"93d789cddd61d027\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1aead99e59840aac\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0eefccfbb529b404\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/CalendarGrid.js\":\"79ab680b3ada0da9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/DailyNotePicker.js\":\"8437959794e8069d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"52d00cde0e46b301\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/DateNavDecorator.js\":\"baa18e3c57906135\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/DateScrubOverlay.js\":\"2061c4dfef4f5079\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/DayPropertyControl.js\":\"d891ffbf2157f590\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/DayValueReferenceControl.js\":\"e9f110b13177d129\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/HeaderItem.js\":\"eb4758b7e487434f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/ReschedulePicker.js\":\"d6b2171314ac4a49\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/SpreadDatesDialog.js\":\"d43d723ffbbe2e65\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/actions.js\":\"d95f635014cd760f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/blockDateAdapter.js\":\"319ca30ddf212f3b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/calendar.js\":\"f28e011f7fff6251\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/dailyNotes.js\":\"a6ad2e89a6032f2c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/dataExtension.js\":\"a2f127a4acd918e3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/dateScrubActions.js\":\"81bad25790b6e30e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/dateScrubGesture.js\":\"091ac30f90ba3863\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/dateScrubGestureActions.js\":\"7fa903394c333b48\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ccd5c971f5ccfde2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/dayProperty.js\":\"6abe8470c9f82a8d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"4420a5a71c668fb6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/deletionGuard.js\":\"222ac4d62d7953e8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/dueQuery.js\":\"c27a5c71a0650e21\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/index.js\":\"284d759efc42df03\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/landing.js\":\"a9d215bbc7932e4c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/localSchema.js\":\"9abe603a34eb9dbd\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/referenceDateAdapter.js\":\"954821025d82e72b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/rescheduleAction.js\":\"f44fb6959013ae9f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/schema.js\":\"316f2e135ccc13d2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/spreadBlockDates.js\":\"ee2bab4472ab6a40\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/spreadDatesAction.js\":\"b8fbe3080099a456\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/today.js\":\"975d53488735ffbf\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"4dfa5197f3fec422\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"9e0d5f8f6323b979\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/audit.js\":\"8a7867e09993ab76\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/auditAction.js\":\"04962ce6ce346fa5\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/auditRanges.js\":\"728375a3130e46f3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/diagnosticsSource.js\":\"1cb97cb170d7650b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/divergenceScan.js\":\"c355b4ca83476ec1\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/index.js\":\"398bc0e3ddbf68a9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/propertyChildrenChecks.js\":\"9c63d0a4daaab864\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/referencesMirror.js\":\"e486519557c213ea\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/rowJson.js\":\"63a676150cf2baa5\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/schedule.js\":\"f69a93bd3a8a7c78\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/data-integrity/store.js\":\"f99d59930706aa88\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-maintenance/action.js\":\"6c43c22b99e74fc2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-maintenance/index.js\":\"ff2f7e430327a717\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-maintenance/plugin.js\":\"a5f0d55757302914\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b768eb28137b5594\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/actions.js\":\"854a156af9c71ff8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/changeMarker.js\":\"9a03d8f825048880\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/diagnostics.js\":\"01fa79a66635b0c0\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/fileSystemAccess.js\":\"76657f3c1c8be3d7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/filenames.js\":\"cd2c140226d6374e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/index.js\":\"9e6110a60a23e2df\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/mirror.js\":\"9e0350ae63376631\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/runLock.js\":\"d9e729c8b42b233e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/runtimeHealth.js\":\"2e856a2d5fd50389\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/schedule.js\":\"451b2afd6c2b9578\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/db-mirror/store.js\":\"8faa5a400a8f0e9b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/default-themes/index.js\":\"7fd69d389db3b315\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/default-themes/themes.js\":\"f58be7ee601eae5c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/diagnostics/facet.js\":\"3ffe76b048142b1d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/diagnostics/useDiagnostics.js\":\"281aa07f666b8908\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extension-prompts/dismissals.js\":\"36b740ab6359ffc9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extension-prompts/index.js\":\"43d2f2a98ddeb7b8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extension-prompts/status.js\":\"ba17d1bfb5517245\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extension-prompts/store.js\":\"24189f1cda830034\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"8c53858982f92857\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b374ad547aa1734e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extensions-settings/actions.js\":\"74e72ea413cd1311\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extensions-settings/config.js\":\"0e9945951466865c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extensions-settings/dataExtension.js\":\"4761de4c8a0f0b0d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extensions-settings/effect.js\":\"6523ff60c5b343c3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extensions-settings/index.js\":\"27d437eaae184114\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extensions-settings/propertyEditorOverride.js\":\"971edd70bd1a7342\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extensions-settings/useToggleTree.js\":\"54a4e475bf1c6cbc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extract-type/ExtractTypeDialog.js\":\"fb8943577f2e4844\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"4e9091feaff7d517\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extract-type/PropertyShapePicker.js\":\"8b6e2a731f2ea8e2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extract-type/action.js\":\"331b765ab81e372a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/extract-type/index.js\":\"f07a41492fbee66b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/find-replace/FindReplaceDialog.js\":\"a289ec2eec474c20\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/find-replace/HeaderItem.js\":\"60844cf7b2083b53\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/find-replace/dataExtension.js\":\"d3994a39edd9c774\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/find-replace/index.js\":\"3972d0288bdee7d9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/find-replace/search.js\":\"50003d94effc97be\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/find-replace/toggleStore.js\":\"2623f3b2802fa886\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/LocationPropertyEditor.js\":\"5af7f9a890930554\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/MapView.js\":\"e8b6df45ba079f1f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/blockTypes.js\":\"dc8b7ab1ba1d264d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/codeMirrorExtensions.js\":\"df6e19128c2f5b07\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/createOrFindPlace.js\":\"db8ddd02dbadcb2c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/currentLocation.js\":\"0de4915b7795af86\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/dataExtension.js\":\"58360acdcb39c597\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/geoContentDecorator.js\":\"1bfc0a079d2fdf82\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/googlePlacesClient.js\":\"f560c786b1fd432a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/index.js\":\"fa1636f69c702bf8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/locationsPage.js\":\"e2ed8a0f0e79a6b7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/mapViewport.js\":\"3b3a2a094255e3be\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/pickCurrentLocation.js\":\"0b774290bd558b11\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/placeAutocomplete.js\":\"7d79f70595d2c4fc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/placeNameCollision.js\":\"960f33b84c2d6f9a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/properties.js\":\"38a3fe50644e7b25\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/propertyEditorOverrides.js\":\"a4ecd09eb8387fd9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/query.js\":\"010894d304bacf4a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/geo/usePlaceSearch.js\":\"89c38632aff47f4b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"1541f5c6efe74496\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7084b2974b20627c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"ad9bafba1b27a70b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/config.js\":\"e71adec16f4a8d21\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/dataExtension.js\":\"9788c70d2d318028\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/facet.js\":\"4548e0ca4d507487\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/grouping.js\":\"5f0212a8ef61294c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/index.js\":\"729588d0440429a1\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"fd21d7ca2d0afe89\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/query.js\":\"1cda05f14e17d46c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/resolveConfig.js\":\"4cd1683f07d60db2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"fa4afa99aa45dfbe\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"cfa6ffbafb364aae\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/HtmlDocumentContent.js\":\"477ca56a9988b207\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/HtmlFrame.js\":\"03a9003644d4f3f4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/actions.js\":\"06f6c4f01a42030f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/blockType.js\":\"6d59d56f706d8df0\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/confirmRunScripts.js\":\"3104d91945c07647\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/dataExtension.js\":\"755aabd7b036cf03\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/frameAnnotations.js\":\"03b6b7d45fb9035f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/frameDocument.js\":\"ff403d716f619f47\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/frameTheme.js\":\"f1ddc595baded41e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/index.js\":\"47dea6fcc2226605\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/scriptConsent.js\":\"103cb1774631dc4c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/sourceMap.js\":\"7a9f3e1b3a4bf4ee\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/html-document/useDocumentScripts.js\":\"b93ce020afd26afe\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/interaction-metrics/index.js\":\"c32b497ae64c34f4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/interaction-metrics/record.js\":\"af6181f1c005fa49\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/interaction-metrics/recordStore.js\":\"37ff06c2687bca90\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/interaction-metrics/responsiveness.js\":\"f68b1637ae279d49\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/interaction-metrics/schedule.js\":\"a7bb43bf383248b9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/interaction-metrics/sessionContext.js\":\"1408229c276927da\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"be1d0f985b770ff4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"77a8e5ee1b7b172b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/actions.js\":\"91a14fe084142cd9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/config.js\":\"a7ef1f6f72d13545\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/dataExtension.js\":\"0c0feb7590d101dd\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/effect.js\":\"55d39a530528b6a8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/index.js\":\"fb112d7ae3288e54\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/keyCapture.js\":\"a68031da7209ab98\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/overrideStore.js\":\"441939252a09749c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"330e7958fe42f79b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/left-sidebar/HeaderItem.js\":\"c114c0e3b2a5844a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/left-sidebar/LeftSidebar.js\":\"5f76c410053cdc58\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/left-sidebar/actions.js\":\"27f718692269faf9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/left-sidebar/facet.js\":\"a8fae498e821144e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/left-sidebar/index.js\":\"0708c605268389f1\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/left-sidebar/shortcuts.js\":\"aa151877555f24b6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/left-sidebar/toggleStore.js\":\"ba6612af2b7db84b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/merge-blocks/MergePicker.js\":\"0c1c823bdce24315\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/merge-blocks/index.js\":\"97fa18be7d0c2ef2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/merge-blocks/mergeAction.js\":\"18f5f0e1415ade9a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/merge-blocks/strategy.js\":\"9acbc7b55445415f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-bottom-nav/Button.js\":\"c06f929a3fcc3b5b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"322d3839e43447f3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-bottom-nav/defaultItems.js\":\"50714eccf592bf15\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-bottom-nav/facet.js\":\"f70ec8fc8a693671\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-bottom-nav/index.js\":\"394f9cbd9728b3a3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"d70eba2443d6f8a1\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0ba8dad04779c03b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"03fd68ca209a1991\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-keyboard-toolbar/facet.js\":\"c4ae770abd0bfae9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/mobile-keyboard-toolbar/index.js\":\"dcd8302ee29f9766\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/move-blocks/MoveDestinationPicker.js\":\"02c5d262cb4b3ec4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/move-blocks/blockSubtreeMembership.js\":\"842c3386f902bf6c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/move-blocks/contextMenuItem.js\":\"4d3f6f7c9f6be81d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/move-blocks/index.js\":\"fe6e2aab33006df1\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/move-blocks/moveAction.js\":\"a3ba85889d92f933\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/move-blocks/moveBlocks.js\":\"24578a9bb5519969\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/move-blocks/selectionAfterMove.js\":\"913008ff91812e23\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/onboarding/TutorialBanner.js\":\"a0f1895851bb7b19\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/onboarding/action.js\":\"8859e228646a5d11\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/onboarding/bannerDismissal.js\":\"0eae408e8e10f59a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/onboarding/documents/cheatSheet.js\":\"7bd1ac56c1d6d255\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/onboarding/index.js\":\"7291621152a75820\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/onboarding/keys.js\":\"2a116ba785298c71\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/onboarding/landing.js\":\"f82a0015ddb82d11\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/onboarding/outline.js\":\"a3165708af6b311b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/onboarding/seed.js\":\"8037244a8b7f7bee\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e62e06d34b542283\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/analyze.js\":\"52eedad2774f356b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/diagnosticsSource.js\":\"d529854940caabf9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/index.js\":\"fffbfb6c363a43fa\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/load.js\":\"4af77e4de7198dfc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/monitorRun.js\":\"2c202fd069f4f118\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/schedule.js\":\"37ad0026cbac17df\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/series.js\":\"084cf19497857e1b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/store.js\":\"a70a7ff05e0df309\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/trendAction.js\":\"9b5286f758e31f33\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/perf-monitor/verdict.js\":\"ba78be340371a1cd\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/plain-outliner/clickToEditAction.js\":\"02896fe65a761dbb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/plain-outliner/index.js\":\"ac2d75d84ca1af0c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/plain-outliner/interactions.js\":\"398717ca78931336\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"78b9aeabc6f4713d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/properties-migration/MigrationGate.js\":\"db167f0e9bac719c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/properties-migration/MigrationGateDialog.js\":\"7a14f5138e35816c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/properties-migration/action.js\":\"2af1e9103979d9df\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/properties-migration/index.js\":\"ae0cfa1914fab362\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/properties-migration/localRunMessage.js\":\"36852bbd058ffb4e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/properties-migration/plugin.js\":\"6a86f9a5529e9fe9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/properties-migration/progressReport.js\":\"078ec83060556f71\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/properties-migration/sweepProgress.js\":\"f8803f99353a4bb4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/property-rows/FieldRowRenderer.js\":\"dbe0b85b0a248c8f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/property-rows/ValueRowRenderer.js\":\"8ecdf482dedc7b85\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/property-rows/actions.js\":\"5153a8a1184e391c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/property-rows/autocomplete.js\":\"3615f6236cc57509\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/property-rows/fieldRow.js\":\"27463c4b0621908d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/property-rows/index.js\":\"187b6f788c3d3b33\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/property-rows/referenceWarning.js\":\"ac72844a620d98e0\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/property-rows/valueAutocomplete.js\":\"5decab7681538fee\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/property-rows/valueSchema.js\":\"cf902d4802918969\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/quick-find/HeaderItem.js\":\"665e26c06382a7df\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/quick-find/QuickFind.js\":\"21ad81f4be34d500\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/quick-find/index.js\":\"ca6739c5e8e336cd\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/quick-find/recents.js\":\"f9c905f73760560c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/quick-find/resultItems.js\":\"847d8357e99d7e04\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/quick-find/selection.js\":\"bd7fd5e464e85aec\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/quick-find/toggleStore.js\":\"7e8c6fd567d5874c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/recents/HeaderItem.js\":\"988bc74330262f09\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/recents/RecentsPageBlockRenderer.js\":\"594c2dd8ad931d36\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/recents/grouping.js\":\"06603b80472cf940\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/recents/index.js\":\"44bafdc0763b0bd6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/recents/target.js\":\"439e26b21c05e8bc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/codeMirrorExtensions.js\":\"9088cc01cedea73c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/contentPrefill.js\":\"cfbd0db6bc79fa1b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/dataExtension.js\":\"4b6b283487276661\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/index.js\":\"3d883bddf94589b2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e4da818fecd78179\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/invalidation.js\":\"8693693141b46ad3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/localSchema.js\":\"2db367d7908b27a8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/markdown/blockrefs/index.js\":\"a0e36600d622dc32\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"eea956fef8f32c9a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/markdown/index.js\":\"768724ca35921c81\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/markdown/referenceNode.js\":\"572a192d947a2e63\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0005c938d529f950\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"4a3d59a89d56c6b8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/markdown/wikilinks/index.js\":\"47a60cbf88f7ee8c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"94f058a9626dc827\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"c4f934295b212acc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/mergeRetargetProcessor.js\":\"b6b851be962820b4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/parseFence.js\":\"072ddaf752852a6b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/referenceParser.js\":\"0658721ed4e8e04f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/referenceProjection.js\":\"1f7944aad671dc66\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/referencesProcessor.js\":\"1c6fc380482bc9c1\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/renameProcessor.js\":\"12a35fb78beb1324\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/references/spanReplacement.js\":\"b8c8ee5e4b41020d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/rich-paste/htmlToOutline.js\":\"08c058bc709d7055\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/rich-paste/index.js\":\"90c346eb763b0107\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/rich-paste/normalizeClipboardDom.js\":\"6f8206dc5f8b7197\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/rich-paste/pasteDecision.js\":\"32911ab659784916\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/action.js\":\"deaf616c0b32b6ab\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/blockIds.js\":\"18beb481a6ae1e19\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/content.js\":\"4543465eb6813159\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/effect.js\":\"7da31ccc852532bc\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/ids.js\":\"786f00c6c07e5dff\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/import.js\":\"58fade1e73252d59\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/index.js\":\"0a9e5ede8508642f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/plan.js\":\"4ff2e50313583835\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/plugin.js\":\"0a03a77519d44d65\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/promotion.js\":\"564f948d66e9d483\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/properties.js\":\"8c0b65370e697723\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/references.js\":\"b4b1d65729402702\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/report.js\":\"017a1f16e98ba28a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/roamMemo.js\":\"49f89153eeeb1117\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/runtime.js\":\"12d8c273bc5e619c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/schemaReconciliation.js\":\"1b360c4bbad74d9c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/srsMarkers.js\":\"f47b39b2222590d9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/todo.js\":\"ba5331622973d664\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/typeCandidates.js\":\"556347b92d250e21\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/roam-import/types.js\":\"acdc6bb1eb8ca4cb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/search-health/index.js\":\"265e10c9ba24c290\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/search-health/store.js\":\"938ce3cc2d37c6c4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/shortcut-help/HeaderItem.js\":\"2bd5b1538f7a3879\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"500c4039d44e6a33\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/shortcut-help/index.js\":\"8cfac23cd785cd05\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/shortcut-help/model.js\":\"445e396b04341b5f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/shortcut-help/toggleStore.js\":\"d732963b302206ed\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/shortcut-help/useKeyInspector.js\":\"2d0e194f7dfe0560\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"308d84ab4feeb505\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/spatial-navigation/ShellDecorator.js\":\"43cc0070847f0cb7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/spatial-navigation/actions.js\":\"bc9dcd0a75fb5ffd\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/spatial-navigation/exclusionsFacet.js\":\"5820fc4a02b270cb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/spatial-navigation/index.js\":\"8b6a5b89365d2730\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/spatial-navigation/shell.js\":\"ef5b16419dbd750a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/spatial-navigation/surface.js\":\"7d324bc630ba3a18\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/spatial-navigation/walker.js\":\"0894e16aa9540a5a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/RescheduleToast.js\":\"d79605c39de4bb83\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/dataExtension.js\":\"751cd39abece8a61\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/index.js\":\"b05dbb2d2f9e1965\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/indicator.js\":\"ab8bf63b7d7c3e5f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/moveSrsState.js\":\"be26967a565389e0\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"3593bb81a84b94e2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/scheduler.js\":\"a05809d52e0cf3ae\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/schema.js\":\"d31439c4e1e5c671\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"3f5b98f5c489d8cb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/srsClipboard.js\":\"e5cd37ac8255cae9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f2821665f8cb1596\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/DailyNoteReviewHint.js\":\"bee7a6a0b4ed41a4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/DeckPicker.js\":\"92bc241a191ffcab\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/ReviewControls.js\":\"086cc8b31c05dd7d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b0be5f3cc0a476cb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/ReviewSession.js\":\"fd791c3bebfcc52d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/actions.js\":\"9fc3ecdaa382b20c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/archive.js\":\"4ab5c4be0a7d34e6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/dataExtension.js\":\"f51993ced39002e4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/deck.js\":\"f750d0e294a7f5de\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/dueQuery.js\":\"3b708d8f6440cf0b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/gradeDecision.js\":\"3155e3531a89dbe7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/index.js\":\"0021556c342017a1\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/keyHints.js\":\"b6abfce83a30d738\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/reviewCardLayout.js\":\"b93240eeb8d13fe7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/reviewProgress.js\":\"0597d721638b509e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/schema.js\":\"50e9b0aff8cb768a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/srs-review/useDueCards.js\":\"ac935c189ee3b446\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/startup-metrics/index.js\":\"475138245a16c712\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/startup-metrics/record.js\":\"9bd5fd681648d5d0\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/storage-persistence/index.js\":\"f9d3ec7e8a61c95a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/storage-persistence/persistenceStatus.js\":\"1e317f558e9d8131\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/storage-persistence/requestAction.js\":\"874fd774384355cd\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/supertags/TypeChipsDecorator.js\":\"88af82cb4eaa64b8\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/supertags/codeMirrorExtensions.js\":\"45060fc860c2e6c4\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/supertags/index.js\":\"b6ff6e1c75d35035\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/supertags/typeAutocomplete.js\":\"51bcf5dbf0840a28\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"dd6383654a38a903\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/swipe-quick-actions/actions.js\":\"26a5f181125a09f3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/swipe-quick-actions/anchor.js\":\"d1359bf5c92cc899\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/swipe-quick-actions/events.js\":\"7ef4826bca5e1979\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/swipe-quick-actions/gestureActions.js\":\"6c6f6ea95be8c42b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/swipe-quick-actions/index.js\":\"1d583257fe95bc05\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8a5591331d2e1ed2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/sync-metrics/collect.js\":\"0bf4d59f71c75415\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/sync-metrics/index.js\":\"6e3650a5865436b7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/sync-metrics/record.js\":\"541050335d273e49\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/system-status/RejectionDialog.js\":\"ef9557a7b3b87b19\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d637e8abe50726fb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/system-status/index.js\":\"10880369b451acae\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/system-status/model.js\":\"83a480dc4e2d63d5\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/system-status/queueCounts.js\":\"9ec9396e83a30929\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/system-status/rejectedHelpers.js\":\"dbf87d659a36e377\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/system-status/rematerializeAction.js\":\"b1f091fd830fb711\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/system-status/useHysteresis.js\":\"fc035521cb076849\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/ColumnHeaders.js\":\"1385a8db8f921dfb\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/QueryUi.js\":\"9757b1b9953ce0c6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/TableLayout.js\":\"cc5621a415a29e58\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/actions.js\":\"d00703f913bdaf1d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/cellEdits.js\":\"da37e45606bc0dea\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/childrenViews.js\":\"96b8352f0da0f94b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/columns.js\":\"dea2e468bfea6e59\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/controller.js\":\"4efbcde815254f5a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/convert.js\":\"8084853daeb02606\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/dataExtension.js\":\"7e50ac5887a981e6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/index.js\":\"7acc0ce35e10c328\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/keys.js\":\"07750bb77e5b6ef2\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/model.js\":\"6e51ab7e3c3d20d0\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/query/QueryText.js\":\"c634fe12afa05d84\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/query/backfill.js\":\"c682e6b92c0ad360\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/query/completion.js\":\"3780fcb18d3dff54\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/query/format.js\":\"d7fd0d5b5982a87b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/query/parse.js\":\"42a6870fe7d91173\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/query/queryValue.js\":\"d2be5e1fc2a89fc9\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/query/registrations.js\":\"6c7bc7010d34e9a5\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/query/source.js\":\"3a524542ad61b752\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/registry.js\":\"108103e063490902\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/rowGutter.js\":\"684f98f861d0b310\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/rowVerbs.js\":\"6deb4155dddb70b7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/schema.js\":\"0ba8ce89b343ca58\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/tables/sort.js\":\"0d3d287ed634a934\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/theme-toggle/effect.js\":\"71d54304c8e44247\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/theme-toggle/index.js\":\"64922c3511f18c67\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/theme-toggle/theme.js\":\"c8b6c9a688e058ea\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/todo/actions.js\":\"0512e453b093b1f5\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/todo/dataExtension.js\":\"af78671c30857b39\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/todo/index.js\":\"8f7d650fb3919d9d\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/todo/schema.js\":\"2bcb626217b480cf\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8bb65dd61f17a235\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/touch-selection/actions.js\":\"211ac16f4adaae89\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/touch-selection/defaultItems.js\":\"c8c9590eb9ba2f17\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/touch-selection/facet.js\":\"ed8d2fac66c46fce\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/touch-selection/holdRecognizer.js\":\"55e31425cf2d969c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/touch-selection/index.js\":\"6c7374a45bcc6d87\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/update-indicator/UpdateIndicator.js\":\"041dce6a15922b5c\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/update-indicator/index.js\":\"11e5ba700f929e79\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/update-indicator/loadTimes.js\":\"8941779ce299ed97\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/VideoNotesRenderer.js\":\"4d29ab7a5e37afe6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/VideoPlayerRenderer.js\":\"a8dd4c96c2b1cad7\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/VideoTimeStamp.js\":\"92a1b5970807eb93\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/actions.js\":\"28c5a10fac59878b\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/index.js\":\"5195e388cf2644fe\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/markdown.js\":\"2bf080b4f939d28a\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/notes.js\":\"efe50adfcc857c19\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/registry.js\":\"326ebd9f624d15c6\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/remark-timestamps.js\":\"115980751a6ccacf\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/video-player/view.js\":\"4c4184261cce34fa\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/vim-link-hints/LinkHints.js\":\"aff0962ce2dea588\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/vim-link-hints/index.js\":\"e42a0d4ff58f69d0\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/vim-link-hints/model.js\":\"8155e8230edf426e\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/vim-link-hints/settings.js\":\"6df33bb17eb4f612\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/vim-normal-mode/actions.js\":\"fd7fefbfbd08427f\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/vim-normal-mode/index.js\":\"6ba7ff787fd4c0d3\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/vim-normal-mode/interactions.js\":\"5f01301bcfae2b90\",\"/knowledge-medium/pr-preview/pr-1918/src/plugins/workspace-header/index.js\":\"3a4f3b3f0d67084e\",\"/knowledge-medium/pr-preview/pr-1918/src/registerServiceWorker.js\":\"29fb090c7eef01a3\",\"/knowledge-medium/pr-preview/pr-1918/src/requestPersistentStorage.js\":\"339d5a84cba59996\",\"/knowledge-medium/pr-preview/pr-1918/src/services/authRequestDeadline.js\":\"9ca0619525d30ceb\",\"/knowledge-medium/pr-preview/pr-1918/src/services/authStorage.js\":\"0db50058439ebb95\",\"/knowledge-medium/pr-preview/pr-1918/src/services/powersync.js\":\"776cf5e679f04090\",\"/knowledge-medium/pr-preview/pr-1918/src/services/supabase.js\":\"75a80327bd3c2668\",\"/knowledge-medium/pr-preview/pr-1918/src/services/uploadErrorClassifier.js\":\"7fd94e56e9e2804f\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/ActiveContexts.js\":\"090b82ec244407d9\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/HotkeyReconciler.js\":\"faca9eb5f2f34847\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/WipeLocalDataDialog.js\":\"2c2eb688c82421f9\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/actionDispatch.js\":\"e03dbc3de9c47a18\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/actionRefItems.js\":\"78a3aa8f5ac0863a\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/applyKeybindingOverrides.js\":\"9b82b87477c014a9\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/blockActions.js\":\"1d283e726afd70cf\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/blockMergeGesture.js\":\"3519b71055fa8db1\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/canonicalizeChord.js\":\"e597b905ad8db5e6\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/defaultContexts.js\":\"ac51ce8b044addfe\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/defaultShortcuts.js\":\"9e5a6163cdf0cd1a\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/effectiveActions.js\":\"06fcb5f6466afd67\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/gestureAction.js\":\"bfdaf2239a8e5d90\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/gestureBinding.js\":\"86358c276c44799e\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/holdRegistry.js\":\"40e163a4ae1c7c81\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/keybindingConflicts.js\":\"947b9d275231d194\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/keybindingOverrides.js\":\"1fa48e59fd39bedb\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/pointerAction.js\":\"860aa6c031d61579\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/resolve.js\":\"84612e7c05d70fdb\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/runAction.js\":\"1afecf74a94b4bca\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/sequenceMatcher.js\":\"9c74e38a3e01ca59\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/types.js\":\"dfbbf4e33dbccbbd\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/useActionContext.js\":\"142f2e39baf13971\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/useActionDiscovery.js\":\"359e7a9a0f0cae1b\",\"/knowledge-medium/pr-preview/pr-1918/src/shortcuts/utils.js\":\"deb3c357fa840cbd\",\"/knowledge-medium/pr-preview/pr-1918/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1918/src/sw/bootStore.js\":\"4ba24caf4c83a687\",\"/knowledge-medium/pr-preview/pr-1918/src/sw/previewDatabases.js\":\"06748f99b72be4ee\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/byteTransform.js\":\"e384ebbdd29ec061\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/attachmentCleaner.js\":\"9646965dc7ed7df8\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/bundle/attachmentParts.js\":\"8d8484cc5c3091fe\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/bundle/bundleParts.js\":\"6538942c39c73d26\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/bundle/bundleRecord.js\":\"0f0ddf9f5298810c\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/bundle/manifest.js\":\"defc0cd8a4e58164\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/bundle/takeBundle.js\":\"2856da37d87d8158\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/bundle/verifyBundle.js\":\"6381ef5432d3497a\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/cleaningStage.js\":\"6f210cb40478e72a\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/conversionKey.js\":\"c62dfa177beb60e4\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/conversionServer.js\":\"6f209029860b0966\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/flip.js\":\"bd7d8f34741b4cdc\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/flipAttempts.js\":\"351fd2cd6e7f1160\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/pages.js\":\"2c578255eb5aa1a6\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/preflight.js\":\"93bd44917f5ee455\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/reseal.js\":\"0cf9bd1fc9c0b857\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/runConversion.js\":\"085951a730a1d19e\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/runLock.js\":\"c4f5477b60fe1eea\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/sealing.js\":\"df8e2fdaa3f7e1d4\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/sealingStage.js\":\"7b1ae9c27d110bb0\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/stage.js\":\"7ebba0e86caeb7dc\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/conversion/verifyReseal.js\":\"3fe82d4ea210a612\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/aad.js\":\"3e97b1f9c2e0235f\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/aead.js\":\"e0642b5b0bae32ee\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/base32.js\":\"954810821f3d6a12\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/base64url.js\":\"c46492760694d8bf\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/binaryEnvelope.js\":\"d5cfea64307f13b9\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/byteAead.js\":\"d08733a03568c745\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/canary.js\":\"69f054ea6a8f6361\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/contentHash.js\":\"b13d697c6106fa8d\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/contentKey.js\":\"4aabddcd5888c3f5\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/derivedIdNamespace.js\":\"8c4bcea49a433ac1\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/envelope.js\":\"4097fdf9b91115b3\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/hex.js\":\"63657759f99dc6f5\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/sha256Hex.js\":\"f89fa4d6eade6254\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/crypto/workspaceKey.js\":\"79af7cbaaeac66af\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/conversionState.js\":\"9c5bc176f3d1bcb3\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/flows/createEncryptedWorkspace.js\":\"90e1f9bd8642595a\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/flows/pastedKey.js\":\"b6cc924f78c54d83\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e305d6370bd4ec77\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/flows/upgradeWorkspacePin.js\":\"747f112d3f79cbaa\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/keyStore.js\":\"7145d86510c0afc9\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/mintWorkspaceKey.js\":\"4c6211ee4755e82c\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/modePin.js\":\"8b3f51e08e2f5f95\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/openWorkspaceKeys.js\":\"1105f2d0c5497ecd\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/resolveWorkspaceEntry.js\":\"4ef132dad4c297bf\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/resolver.js\":\"e941a2c925c0b49b\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/keys/workspaceAccess.js\":\"d1ebde9c152ed680\",\"/knowledge-medium/pr-preview/pr-1918/src/sync/transform.js\":\"ed62f718d16b0e96\",\"/knowledge-medium/pr-preview/pr-1918/src/themeBootDefaults.js\":\"fe9db12b12b36d47\",\"/knowledge-medium/pr-preview/pr-1918/src/types.js\":\"0aba4ebb4e0ed164\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/ClientLocalSettings.js\":\"8ed70dfb019d0fd7\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/abortableSleep.js\":\"b57fb535f8d420ed\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/array.js\":\"b98dd591d2ba38e5\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/backlinkAutocomplete.js\":\"b0b454b135a157ee\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/blockCrumbs.js\":\"7c68e5da25300dd1\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/blockrefAutocomplete.js\":\"959290e6820fba9b\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/cadencedIdleJob.js\":\"3bbc7b2173e8b03b\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/callbackSet.js\":\"f7f9a9232b7e3ed0\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/clientId.js\":\"9746cd2402b5ceb0\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/codemirror.js\":\"59a52bbe79adce2b\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/codemirrorCompletion.js\":\"b021fd44c334b8f7\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/copy.js\":\"834cc034bb0c07ae\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/dailyPage.js\":\"069bf64409e6a62b\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/dbForensics.js\":\"8b339208a110f340\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/dbForensicsHooks.js\":\"4b6fcca30042d869\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/deleteBlockThroughUi.js\":\"1e2d349e8903782f\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/dialogs.js\":\"f57e1118da2ee1c9\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/dom.js\":\"e3963e398c7985c7\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/downloadBlob.js\":\"0d75eaa7c64054a7\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/drawnWalk.js\":\"163bfccd5ecf1e4c\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/exportSqliteDb.js\":\"9cd86b5117fd44ff\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/fileSystemAccess.js\":\"965ef6955e01ce7f\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/flipSlide.js\":\"d4f45bcd9457d0e6\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/fnv1a.js\":\"51072e6dba77f678\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/formatBytes.js\":\"8c2d867750cb2c81\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/fuzzyRank.js\":\"abd09aa2d94eb009\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/idbKeyedStore.js\":\"893aee7e8258afb4\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/idleCallbackPolyfill.js\":\"11a9da500f6a082b\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/keyboardAwareScroll.js\":\"8c00284292bf52d1\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/keyboardViewport.js\":\"d85e4b14db3790c4\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/lastWorkspace.js\":\"33c6cc54ee34f771\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/layoutColumns.js\":\"ea7c407a7c13cd7d\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/layoutSessionDom.js\":\"f64ffc9a0a5ed6d6\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/layoutSessionId.js\":\"12df670b308c6d72\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/linkClickGestures.js\":\"eead0b0b813bf884\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/linkTargetAutocomplete.js\":\"9301ccff0951be89\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/localDbCorruption.js\":\"d59d41744235fbea\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/localDbRecovery.js\":\"e183f3c591f9929d\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/markdownParser.js\":\"4156c1fa7d647ef8\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/memoize.js\":\"006335723a196a09\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/nameFieldCommit.js\":\"c20ffedcbfa2013c\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/nameList.js\":\"b3a6a9321895f6df\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/navigation.js\":\"0b0de29654214580\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/omnilinerNamespace.js\":\"46e46f21496fa610\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/opfsPageScan.js\":\"055310bc0aa64805\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/panelClearance.js\":\"bd895489b527ca7b\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/panelHistory.js\":\"fb1d8c119e036d96\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/panelLanes.js\":\"c18c0b7806de6608\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/panelLayoutProjection.js\":\"7a528d6aa579489d\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/panelScrollAnchor.js\":\"e3f033066018ef61\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/panelUrlFlags.js\":\"c704d3f6cc643854\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/platform.js\":\"e98f246597c638d5\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/pluralize.js\":\"53dfcc99af9417b6\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/propertyCreation.js\":\"ae6e8be6fc06f415\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/propertyNavigation.js\":\"724af7ccf6f82ac2\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/propertyValueContext.js\":\"fa7e22d332ee5f2b\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/react.js\":\"a70f96d6ab54df30\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/relativeDate.js\":\"a86bba5b328d616f\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/relativeTime.js\":\"b6bdbf798dff125c\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/renderScope.js\":\"fc9ba71a802b82a6\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/resolvedThenable.js\":\"5fa15c5af3153225\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/routing.js\":\"17be985c210cf72c\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/safeMode.js\":\"1dd8050ff3dbcb81\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/scheduleIdle.js\":\"892f004c85a89d07\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/screenWakeLock.js\":\"5733be3c0c565ab7\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/selection.js\":\"b78b7048a53df0f2\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/softKeyboardGrab.js\":\"82938f49b862fb2a\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/startupTimeline.js\":\"3649f6c693046c39\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/state.js\":\"d8a30ee08e08fcb4\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/string.js\":\"91698f8111b6e74e\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/surfaceZoom.js\":\"4ddc15c1e9cbae96\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/time.js\":\"3b823558143a8cd2\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/toast.js\":\"543330d284fb9310\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/toggleStore.js\":\"136321bba3036fd0\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/untilStopped.js\":\"4d7e1c6bb017a197\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/userActivity.js\":\"5b8d91d946801302\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/viewTransition.js\":\"6c37cdf0a763fde6\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/viewport.js\":\"6408cd63af0514a2\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/webLock.js\":\"a7b4a53c683d8f81\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/workspaceRecovery.js\":\"5d78d9b02978bd16\",\"/knowledge-medium/pr-preview/pr-1918/src/utils/workspaceSnapshotStore.js\":\"89db886c38d99554\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-compiler-runtime.js\":\"8def0d74ab240143\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-dom-client.js\":\"f8abd72a844e88a4\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-dom-server-edge.js\":\"d3a375926a4687ce\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-dom-server.js\":\"c9f8b55006e2e7b7\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-dom-static-edge.js\":\"2805771d1124a46e\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-dom-static.js\":\"67b772959f471f2d\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-dom-test-utils.js\":\"fdfdab4de180dc6a\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-dom.js\":\"ebf5f16149515203\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react-jsx-runtime.js\":\"165e7710fa841a35\",\"/knowledge-medium/pr-preview/pr-1918/src/vendor/react.js\":\"e24e9493d02f52eb\",\"/knowledge-medium/pr-preview/pr-1918/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1918/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1918/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
