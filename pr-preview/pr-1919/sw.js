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
		buildId: "52b9f4e57bbd-dc1e0ab6",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/\":\"27945f2f51fa00e3\",\"/knowledge-medium/pr-preview/pr-1919/index.html\":\"27945f2f51fa00e3\",\"/knowledge-medium/pr-preview/pr-1919/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1919/assets/FacadeVFS-B6uLEty6.js\":\"7aa41e036a00e54b\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSCoopSyncVFS-BlTQX9s3.js\":\"ffc531704362af47\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSWriteAheadVFS-DsJdPs12.js\":\"3fd95c23c610ef98\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-DlROgey1.js\":\"6939b26e849b016a\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-lncq_ybC.js\":\"f7158d941bcb478b\",\"/knowledge-medium/pr-preview/pr-1919/assets/worker-fGhfelCd.js\":\"9944ebf8edc89357\",\"/knowledge-medium/pr-preview/pr-1919/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1919/chunks/app-CMvWWKPp.js\":\"cd30d021ba6a19b7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1919/index.js\":\"da593828dd15de8e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1919/assets/AccessHandlePoolVFS-BoGPYxRf.js\":\"74f37af66f9474f7\",\"/knowledge-medium/pr-preview/pr-1919/assets/IDBBatchAtomicVFS-B8u5ZU6X.js\":\"20b6f1e29b5b097a\",\"/knowledge-medium/pr-preview/pr-1919/assets/MemoryVFS-DNXLA_-D.js\":\"9cc0d305448017b6\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-U-fIfgwd.js\":\"7a17c6f49a224a15\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-C3avf6-K.js\":\"a60cd44b1039984d\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1919/chunks/AccessHandlePoolVFS-Dp79UhSs.js\":\"6722446c321c27dc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/FacadeVFS-BqgIDRfO.js\":\"29c33021f7985536\",\"/knowledge-medium/pr-preview/pr-1919/chunks/IDBBatchAtomicVFS-D6_ihFMU.js\":\"4701d6f2b89ea89a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/MemoryVFS-CqwV4aoq.js\":\"a4b3f5a50f033c9c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSCoopSyncVFS-Bl5031d2.js\":\"106bcf9724863072\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSWriteAheadVFS-DTWEhXiB.js\":\"ad5bbd6fdcb1f1a8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/Preview-Ckledtb5.js\":\"48947d03260174b7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/card-CfLRA7ZT.js\":\"144e2f7e09eba92e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BRFICZs7.js\":\"03a2555d7c82fa34\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/freezeExtensionImports-BoYiadOd.js\":\"b84279bcc951d025\",\"/knowledge-medium/pr-preview/pr-1919/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1919/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-BKvlS76w.js\":\"a6f1a6c1d089a1c7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-async-B6EbCSq7.js\":\"663bca6c76ee6da8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CCNyidQ_.js\":\"491aff62786f2e00\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CayX0bt0.js\":\"4332c0e1b6df810c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DeSXTPXS.js\":\"4d379cb41d36e77e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Dt0hUVho.js\":\"97d9e1fd73a22b5a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-QAHChCQp.js\":\"cb6b09b05e85d236\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-YbHFAZPu.js\":\"f0f66a827aa37bb8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-ac6AjZRP.js\":\"23833ec511bb4940\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server-legacy.browser.production-uYSbeLDO.js\":\"3e85e3dc38797b27\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.browser.production-DHqVnm1Y.js\":\"c2c73e7161218c15\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.edge.production-BxAX4z2_.js\":\"4f4dc458175c77e7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-qIp-MkuC.js\":\"ec471db6acabc326\",\"/knowledge-medium/pr-preview/pr-1919/chunks/server.browser-atrX-wWl.js\":\"20927e2a2e91b68a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/textarea-CBJW589y.js\":\"76856172d6285f92\",\"/knowledge-medium/pr-preview/pr-1919/chunks/ui-CG1C1lmg.js\":\"87796eb079a1eaa4\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-DiMwuaFR.js\":\"dc46ccc9a5bb52b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-async-DAMXKp9v.js\":\"fe5b0a07c6c5a12a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1919/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/src/App.js\":\"7873ef7fa4a1b8cc\",\"/knowledge-medium/pr-preview/pr-1919/src/appUpdate.js\":\"2db0bcc7400b120e\",\"/knowledge-medium/pr-preview/pr-1919/src/appVersion.js\":\"062113c5eac7c3a8\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/initialLayout.js\":\"adb019751283fdad\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/openWorkspaceData.js\":\"220d9524a0f3096d\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/resolveWorkspace.js\":\"7a19b8cd7374dcd8\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/workspaceBootstrap.js\":\"fb4d678792e60f3e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockComponent.js\":\"311e22801bac5ebb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockCrumbs.js\":\"1427a86492db1754\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockEditor.js\":\"671a3534e1c2261c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockLoadingPlaceholder.js\":\"cba75e38f05718ce\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockProperties.js\":\"5efc9e4a75c7ab8d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockSearchPicker.js\":\"a78b74b2dad8cad3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ConfirmBulkDeleteDialog.js\":\"17b8b9368d7f77c5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DividerHandle.js\":\"59721824b98f2fe8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DraftEditor.js\":\"9a01ce56df72b592\",\"/knowledge-medium/pr-preview/pr-1919/src/components/GutterPill.js\":\"53fcf806ac07df64\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Header.js\":\"0b64afbbc69bcaa3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/LazyBlockComponent.js\":\"81dcb8d776b2e771\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Login.js\":\"250d616332aaf80e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ZoomableSurface.js\":\"3984a9efc769b0a6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/editModeKeepalive.js\":\"190427975a6a5f5c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyDisplay/PropertyDisplayScope.js\":\"7eb3e1f7c86b14db\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"cfda8f36774dc20c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefPropertyEditor.js\":\"25a232c93ffd7cdf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefTargetTypePicker.js\":\"06d2e15046f78a24\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/SelectPropertyEditor.js\":\"8ea4040feaaee2b6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/TypesPropertyEditor.js\":\"e631cc0da59e9f4f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/defaults.js\":\"600dcbc99863987a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/kernelValuePresets.js\":\"dd1fcac277233cf8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/selectablePresets.js\":\"53656f7e47f13130\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/typesPropertyUi.js\":\"7b8c35bdf41036e5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/AddPropertyForm.js\":\"024d963ddad142d2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyPicker.js\":\"21c8a7273af4111a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyRow.js\":\"83c0d0d5ca2f9e47\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/Rows.js\":\"344579a5f7e5006d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/actions.js\":\"561723d32da97cae\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/declarationOnly.js\":\"602d707bef3e3d7b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/layout.js\":\"dd2fb514f0e7e47e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/model.js\":\"53e3a8cf4e550b8e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapeUi.js\":\"85ad6b84999c6fba\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapes.js\":\"cca7e04239d75663\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c0314b5c12713e63\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/visibility.js\":\"69ec94178d671aa9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanelSections.js\":\"9cdbaebf41bfcbe1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockEmbed.js\":\"a321a3ca7c92a754\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockLink.js\":\"06ddda0268d82f8d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockRef.js\":\"3dbc08d3b3b2b845\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/CompactReferenceLink.js\":\"973a1ed4969c092c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/ReferenceLink.js\":\"0f5e0c6716116c1c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuard.js\":\"23519b1890515527\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuardContext.js\":\"f0ff37af2d128755\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/linkInteraction.js\":\"ce23c35ff40164f6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/referenceLayout.js\":\"24157c791ad8a15e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/useBlockRefAncestors.js\":\"bc11e0e1cfab3d22\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockGutter.js\":\"f0e3969dd803b4ac\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockInfoDialog.js\":\"ed7a293407fddeab\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockReadText.js\":\"e94a197282283c7f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockTypeBlockRenderer.js\":\"3a90326d78ed5a47\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BulletHoverCard.js\":\"2eb54dbcc9b0764f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorContentRenderer.js\":\"fda7ba647523208f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"91ebf301d0bd9118\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ColumnResizeHandles.js\":\"6477991daf787127\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"5706da5a48f7bf65\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/DefaultBlockRenderer.js\":\"98b09bcbc1847663\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/LayoutRenderer.js\":\"a7e848f7a6080006\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MarkdownContentRenderer.js\":\"bfc5183610e937ca\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MissingDataRenderer.js\":\"d8763cf0a0720fd8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PanelRenderer.js\":\"c68fc125d5d77a13\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PropertySchemaBlockRenderer.js\":\"883395d01dbe63d3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/TopLevelRenderer.js\":\"997636a453244472\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockGutterMode.js\":\"c2ba277ecd21b22a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockTitleText.js\":\"a01d5e186c983a06\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/fieldCreationKeydown.js\":\"62253d17c18b5bea\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/layoutRootContext.js\":\"80d7b87b09e4850e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/TypeChip.js\":\"9eb7aef29c8d54bd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/chipStyle.js\":\"06a21a738bdd19a8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/anchored-floating.js\":\"edbd577fa0b8cdf4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/button.js\":\"188e729159895c9b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/card.js\":\"583a902f0878c990\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/checkbox.js\":\"5f9068b2e8cebfd0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/collapsible.js\":\"f410b649029b1482\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/command.js\":\"acdd33c3d74197ec\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/context-menu.js\":\"dac30bfd33e0fec5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dialog.js\":\"d05396c419802354\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dropdown-menu.js\":\"f8609a2e4b9fb231\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/floating-listbox.js\":\"6c6f6f7c314db34b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/index.js\":\"01f4490104a3ed4a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/input.js\":\"d87adb971eebb0c2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/kbd.js\":\"eb4b9bcaf2fc5086\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/label.js\":\"d1bdd9f82f62c65a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/textarea.js\":\"10a262d65d7b6a08\",\"/knowledge-medium/pr-preview/pr-1919/src/components/useEditModeYieldKeepalive.js\":\"a50dc4537529a089\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/BootFallback.js\":\"994090b422eb53a0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/FocusedRowLazyMount.js\":\"f2e7c29c6d6efe50\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LazyViewportMount.js\":\"91069837c0fe7d7a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LocalDbCorruptionFallback.js\":\"47017c9a082421a6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/error.js\":\"1377b84eb6707bb6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/lazyMountRegistry.js\":\"81ea52d4e89535a0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/suspense.js\":\"a419c7a226db4e86\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/CreateWorkspaceDialog.js\":\"14da433ba8d9c82c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/PendingInvitations.js\":\"321bb69829558c12\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/SyncProgress.js\":\"4a76db79e85d4e0a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/UnlockProgress.js\":\"b3889afe1dae13ab\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceKeyGate.js\":\"3132b5a7bfc88677\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSettingsDialog.js\":\"057031cfced7c997\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSwitcher.js\":\"5e00991e1c6b8ced\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSyncGate.js\":\"7e56d4a2d13c208e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlow.js\":\"78024aba7788947e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlowHost.js\":\"44a24cc58042781a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/EncryptionSection.js\":\"1da02854e141df26\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/attachmentPrompts.js\":\"e6f1cbc0982fdbed\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/bundleFolderPrompts.js\":\"1e2bc96e10801ba0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowDeps.js\":\"174825460d62aa44\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowStore.js\":\"55a4adf4bfa0f9c6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/flowUi.js\":\"c97515f3a6a00619\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/useConversionRun.js\":\"7031008c517bb8d7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/keyUi.js\":\"89518fab46b3a63e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnKeyLoss.js\":\"fa01e257777014c0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnServerE2ee.js\":\"07d7630638737870\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/workspaceUnlocked.js\":\"1ccd778e5ba439af\",\"/knowledge-medium/pr-preview/pr-1919/src/context/backgroundSubtree.js\":\"053df4317706d501\",\"/knowledge-medium/pr-preview/pr-1919/src/context/block.js\":\"3afef3281dbdbd17\",\"/knowledge-medium/pr-preview/pr-1919/src/context/layoutWsContext.js\":\"dbea814703d8997e\",\"/knowledge-medium/pr-preview/pr-1919/src/context/propertyDisplay.js\":\"cc33fb1537a25286\",\"/knowledge-medium/pr-preview/pr-1919/src/context/repo.js\":\"42418a1f1f9b3d8b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasClaim.js\":\"037a35b0910ee760\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasSeatNamespace.js\":\"429c710cbec70ee3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockData.js\":\"57b4ed6d4f1cfa77\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockType.js\":\"80dfe4a7348acc0e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/changeScope.js\":\"343704d3913bac18\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/codecs.js\":\"8f3ee89dfa1870d3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/derivedData.js\":\"9ae0047816145c47\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/errors.js\":\"70d3917012538181\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/events.js\":\"ee9bf56dcbeab211\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/handle.js\":\"5056442fa85353b7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/index.js\":\"a1d4a5e0bbba8101\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/mutator.js\":\"68259b0c8096cee1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/processor.js\":\"4bf88494530d70a8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/propertySchema.js\":\"dc4d8df14591c6fc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/query.js\":\"57c7aeca1b94d3e9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/sameTxProcessor.js\":\"31123ec0d9b53433\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/schema.js\":\"5056442fa85353b7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/tx.js\":\"5056442fa85353b7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/typedBlockQuery.js\":\"731633814051c9f5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/user.js\":\"81c1193a27c85930\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresetCore.js\":\"c84b1b005159ee75\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresets.js\":\"1013c91e5007be65\",\"/knowledge-medium/pr-preview/pr-1919/src/data/attachmentCleanerIOVerb.js\":\"5c8283bfc360c2a6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/block.js\":\"47ee58aa050d04b3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockCache.js\":\"f36f447b3ff275ce\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockId.js\":\"ac1d50a4bd5a3530\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockLiveness.js\":\"7582bb501345f32c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockMerge.js\":\"85023f8726319df5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockSchema.js\":\"7b996df4d4f437e2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypeLookup.js\":\"8f96c025942d97ae\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypes.js\":\"e1662daf6a1a93c7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/childrenView.js\":\"a7269222d8f3f9d0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/clientContext.js\":\"6267c18143e82e67\",\"/knowledge-medium/pr-preview/pr-1919/src/data/dbFileSiblings.js\":\"02e170c58e2aeea4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/definitionSeeds.js\":\"35f0eaf688a01287\",\"/knowledge-medium/pr-preview/pr-1919/src/data/derivedIds.js\":\"60b14506989a92a9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/drawnSubtree.js\":\"f2ab471694f8bd0c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facetBridge.js\":\"966499705bbe2e22\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facets.js\":\"6c8d90f2fac0e2cd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/globalState.js\":\"598158ab5af5e6ce\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/aliasClaimRederiveProcessor.js\":\"9f62c4828581a68d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/ancestorBatch.js\":\"7d765da0ed7705dd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/blockTypeTypeifyProcessor.js\":\"1b67c369928ff0c2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/clientSchema.js\":\"5bd0a5c34cba5382\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/commitPipeline.js\":\"961a290aa761f556\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/devAssertions.js\":\"f8f16a08514c9acf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/firstSync.js\":\"4fc017cccfddd46e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/freshInitialLoad.js\":\"83da9989359dc57c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/graphBackfillClaim.js\":\"b957a98b848a72a4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/handleStore.js\":\"5ee01008e033b757\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/idleMarkerJobs.js\":\"66a0b806e93b8713\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initialDownload.js\":\"bd9659fc45d6131d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initializeClientDatabase.js\":\"068e4c9aa919111f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/jsonCanonical.js\":\"0cc388a806a7ff13\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelInvalidation.js\":\"51c837f237120d7c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelProcessors.js\":\"a3636e93f8945c7e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelQueries.js\":\"4e50a230ef85e63e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/mergeTypeMembershipProcessor.js\":\"1824a1f00c7112b2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/normalizeReferencesProcessor.js\":\"a2a0a7b588ec0d87\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/poolInstrumentation.js\":\"b27e1a52ddcd9a0b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/processorRunner.js\":\"32d7caeaec85f34f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyCellBackfill.js\":\"c88d110bd1814a50\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildMint.js\":\"1725c32e9f5eed39\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildrenProcessor.js\":\"65c431d1827fe569\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionChangeProcessor.js\":\"1808d62f26b42e6d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionSynthesis.js\":\"fa5c5ad940618466\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyKeyScan.js\":\"009dfefea969d5c3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertySchemaResolution.js\":\"98046c2fc6258944\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyValueEdits.js\":\"ad4c0f65c8b37a47\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/raiseProtocol.js\":\"e20de2a82deae1e4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/readBatch.js\":\"cff5e2fadfa99513\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/refProjection.js\":\"eb091414ed899ea3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetLookups.js\":\"72eb35ce9d4063b6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetProcessor.js\":\"829605a5b3913f6f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/replayMerge.js\":\"3ecc60c9a2cc5b29\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/sqlBinds.js\":\"fed29e2fdc39c875\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"c05c9a44ccf0473a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/arrivalProcessors.js\":\"a4830cc2592f8688\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/invalidate.js\":\"87977e5ab4f2cbda\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/materialize.js\":\"323c868eba779b35\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/observer.js\":\"da34940342046534\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/reconcile.js\":\"b61f4dc7118dbd76\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/timingMetrics.js\":\"3987d0a565219193\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/treeQueries.js\":\"0283495470b79e76\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txEngine.js\":\"f165178e12af6126\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txSnapshots.js\":\"e38d74766373b17e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/typedBlockQuery.js\":\"2bd6fdc0e0ae8ea0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/undoManager.js\":\"c50c08353eb4e683\",\"/knowledge-medium/pr-preview/pr-1919/src/data/invalidation.js\":\"d8ae94fe943732c9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelDataExtension.js\":\"dc1e90faa228da30\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelPage.js\":\"7f6839baf141010d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelValuePresetCores.js\":\"b97c62131d03283c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbCorruptionSignal.js\":\"841e9ab82d351c7a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbStorage.js\":\"e9e4ca3aa300d39a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbVfs.js\":\"7a9306fd669bd3c3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localSchema.js\":\"c0b92b672b550a74\",\"/knowledge-medium/pr-preview/pr-1919/src/data/maintenance.js\":\"8b460936a00cebbd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mergeProperties.js\":\"7a7d1baa64028751\",\"/knowledge-medium/pr-preview/pr-1919/src/data/metricsConsoleHook.js\":\"0863bfcd03449805\",\"/knowledge-medium/pr-preview/pr-1919/src/data/migrationsPage.js\":\"ab48fb518ab0026c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mutators.js\":\"4ad8c66a6f916389\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKey.js\":\"558708e835502dd5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKeyPlacement.js\":\"90ddb606f3d35c52\",\"/knowledge-medium/pr-preview/pr-1919/src/data/outlineSurface.js\":\"2028e9fc5b3a17a3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingEditorContent.js\":\"51a4d5c230e8e8a5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingUploadsSql.js\":\"82566e3d915ef438\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pluginStateExtensions.js\":\"a9acb9753dddf66c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/powerSyncLogger.js\":\"b5cd7de99b49761b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/projectorRuntime.js\":\"9b3d80f38820ace8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/properties.js\":\"59a79b73b07b45bf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertiesPage.js\":\"2fcf6cee4f921a2f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyChildren.js\":\"0419d25405d994e1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionFanout.js\":\"98e9f2e6e9cd19e1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionMetadata.js\":\"93382f3b8be0bb77\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionRegistry.js\":\"af8f2eb64ac464d7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDisplayMode.js\":\"5088f22b43ecb827\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyRowCreation.js\":\"4d1e351d338b59e6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySchemaCreation.js\":\"9a6ee3a91186ac7b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySeeds.js\":\"59efeb5d06cb92de\",\"/knowledge-medium/pr-preview/pr-1919/src/data/recentsPage.js\":\"0744cba8519f758a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/refTargetComparableProperty.js\":\"cf5a5304ff56180a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/referenceBlock.js\":\"2a562381175e5906\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rejectedUploads.js\":\"b49ece6dde292414\",\"/knowledge-medium/pr-preview/pr-1919/src/data/releasePowerSyncConnection.js\":\"7b7d91dca5954742\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repo.js\":\"ba8fef8c1294498a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repoProvider.js\":\"745a768478761510\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rowProperty.js\":\"e08d89d926172520\",\"/knowledge-medium/pr-preview/pr-1919/src/data/searchFilter.js\":\"880455a5b3ee5595\",\"/knowledge-medium/pr-preview/pr-1919/src/data/seedIdentityLedger.js\":\"88f22882f6a73e76\",\"/knowledge-medium/pr-preview/pr-1919/src/data/stateBlocks.js\":\"1d887374e7ee8706\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralEditPolicy.js\":\"49aa2ede4e4c4d31\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralInsert.js\":\"c286921615d765b0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/subtreeDelete.js\":\"3537a688d1ce38f4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncStreamLock.js\":\"f576b9d339195129\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableSqlRecognizer.js\":\"b25ae27fbde8584f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableWriteGuard.js\":\"095a3b5b402a7693\",\"/knowledge-medium/pr-preview/pr-1919/src/data/targets.js\":\"49300deade0a16e6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeColors.js\":\"1fa117cae6a721b5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionMetadata.js\":\"db2f5c7d518fa80b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionRegistry.js\":\"6d9562cfc98837a0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeExtraction.js\":\"174ff2d6e8033101\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeInitialValues.js\":\"a841c6e65257ebaa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typePropertyGroups.js\":\"343cb66ee9e57324\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeSeeds.js\":\"0a873892280b9d4a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeTagger.js\":\"77a3d2fff0a2ec81\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typedRecords.js\":\"bf704fd1522e0382\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typesPage.js\":\"e627a2f59380aec3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userPrefs.js\":\"d5873e36bd126f6e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userSchemasService.js\":\"28dfc7562c90aaca\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userTypesService.js\":\"3bdcb6d9d723b30d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/valuePresetRegistry.js\":\"0f5d295e85a600bd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/visibleChildren.js\":\"6dbf5997b27ba1e9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceConversion.js\":\"383d876c71438079\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceFirstSync.js\":\"07b924f8328c8a02\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceIdNamespace.js\":\"30b2d161529e7807\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceSchema.js\":\"247ebc3aacb09bed\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaces.js\":\"df4fbc846a25bd12\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadLog.js\":\"6d65af37a95d264c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/BlockPasteShellDecorator.js\":\"e649e5a0b97a1a72\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/atTrigger.js\":\"dd3949b5b11743fb\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/autocomplete.js\":\"497af29ff0d8f20b\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/codeMirrorExtensions.js\":\"0ad575ec9b963917\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/contentFlush.js\":\"20ae8ae2d8b65cde\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/defaultInteractions.js\":\"b20a002cf27df87b\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/editSettleSignal.js\":\"437e74e38d610078\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/insertImage.js\":\"7c44fff172bb3130\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceCompletionRange.js\":\"59061964ea2ecfdf\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceTargetTypes.js\":\"764944d10154ee20\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/syntaxContext.js\":\"eabc0fb73df9fc35\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/triggerMatch.js\":\"afc9176487538182\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/AppRuntimeProvider.js\":\"db59795fc3cab2f4\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/BlockFocusShellDecorator.js\":\"0fe0a397f47fa8de\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/ExtensionRenderBoundary.js\":\"c7b751640edeb78b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/PanelContentRecovery.js\":\"4ba6bc1d209d06cc\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/apiCatalog.js\":\"ef5781f63b1a0190\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/appRuntimeController.js\":\"ff0d408ed17545c7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/approveExtensionHere.js\":\"b31d5095adb3a85a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/armedCutAppMount.js\":\"03e03e3d275065f7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/batchableKeyedStore.js\":\"32c9c8f54e0c7a5e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockInteraction.js\":\"83b22e8649dac0ca\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockSelectionAction.js\":\"92157f85fe9bfaef\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compileExtensionModule.js\":\"7b2323dec41fe806\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compiledModuleCache.js\":\"5237fea61e9cf5fc\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/continuousGestures.js\":\"5b4de2fd8eda7b56\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/core.js\":\"65f298cbe0532b4b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/defaultRenderers.js\":\"f5e7485b3205fe41\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/definitionFanoutAppMount.js\":\"7a9d010877081785\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dialogAppMount.js\":\"3c6915a6192f0ecb\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensionSeeds.js\":\"7a1e4e0f849a1e0b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensions.js\":\"52ccc242a6bb3f23\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/exampleExtensions.js\":\"8811c038c0ff2bb0\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionApprovalStatus.js\":\"1e8e14fd1319596c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionImportPolicy.js\":\"c543b81a07e597da\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrorToast.js\":\"1f1fea73b5b386ee\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrors.js\":\"f558597e2428c507\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLookup.js\":\"70fd32374ab60114\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionToggles.js\":\"9dcf65d7a485f265\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionUtilitiesCss.js\":\"58b38709dc5ff838\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/kernelPageDeletionGuard.js\":\"267c24b41d31497e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/liveRuntime.js\":\"b32ed4e496e96878\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/normalizeExtensionSource.js\":\"2087951259d481a2\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/openExtensionsSettings.js\":\"73c9bfdcc693d138\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/overridesCache.js\":\"d28fb2e8c9e92fe9\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/pluginIds.js\":\"46ae63d302455ab1\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/processorRejectionToast.js\":\"24a754630e3531d5\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeActions.js\":\"ff1e4fd93370813c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeContext.js\":\"f94d39995bb27433\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticAppExtensions.js\":\"342b3e193daae849\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticDataExtensions.js\":\"8dd2ae53902292f3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/toastAppMount.js\":\"fac7e537d392c7c0\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/transpileExtension.js\":\"67ef77873a023f12\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useOverrides.js\":\"4a27c94d3baa0a08\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useShortcutSurfaceActivations.js\":\"951323d30476343f\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/discoverToggleTree.js\":\"e4b096dbde46c809\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/facet.js\":\"1f4d680d689e6ba8\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/resolveAppRuntime.js\":\"2f2195c42cb52f35\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/runtimeEvents.js\":\"9284b119814a2b18\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/togglable.js\":\"3ec6ba3ffbadfdf6\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/variantFacet.js\":\"8e6a4825f9852b9e\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/verbFacet.js\":\"d21ed76f32db5f43\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/block.js\":\"77eb8a05fa254bba\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/focusedChild.js\":\"fe988f65b61df29c\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/propertySchemas.js\":\"5af698ff6485b6d4\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/typeRegistry.js\":\"082cdf76bbe4353e\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAncestorCrumbs.js\":\"988b4214a8270900\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAutocompleteListbox.js\":\"5a02be80d861d294\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedSearch.js\":\"7b254d8a8f1ec084\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedValue.js\":\"602df80acbee27d3\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useFacetValue.js\":\"1708741c615352bb\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsFocalRender.js\":\"ad4f4820000101c0\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsReadOnly.js\":\"7f0193ed3cf07f29\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMaterializeBacklog.js\":\"4a062bb9d60f3bc1\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMinuteClock.js\":\"507b3844b52b430d\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePanelLayoutProjection.js\":\"84cbc5cc01736735\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePendingInvitations.js\":\"777b772b0d04ad44\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRendererRegistry.js\":\"5de915f947c08b8e\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRetainedFieldRows.js\":\"5c7ddfd0bb92cf27\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useWorkspaces.js\":\"25b653107a839dbd\",\"/knowledge-medium/pr-preview/pr-1919/src/lib/utils.js\":\"167f9560a50c579b\",\"/knowledge-medium/pr-preview/pr-1919/src/main.js\":\"85e935e4685fdca1\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/MarkdownImage.js\":\"d76c63a246e9998a\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/blockSeparators.js\":\"719b758eeb392c36\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/context.js\":\"d3e8803dcb177f1c\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/defaultMarkdownExtension.js\":\"2c5aae6c8b260b92\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/extensions.js\":\"5552ccc74aa68cf4\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/renderMarkdownHtml.js\":\"fc8abd251dff5ca0\",\"/knowledge-medium/pr-preview/pr-1919/src/minimal-editor.js\":\"6563be55c42c33ac\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/armedCut.js\":\"94c64de226570c13\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/captureMediaVerb.js\":\"3379ce1f15c3c26b\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/clipboard.js\":\"7fd4ef982c7e051d\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/decision.js\":\"cad50b28a2550e9b\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/operations.js\":\"3c324eaa0e723e3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/AccountHeaderItem.js\":\"7ebdf8d757b56b8b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/index.js\":\"d028cd6d7dcf936f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"5b28e0c07a47c6ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askAgent.js\":\"91ee66e95f6bc1f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askedStore.js\":\"5d61be9689fefc23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"12bb647769d66436\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/chipState.js\":\"713f9c8ef66a1abf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/dataExtension.js\":\"c678cc33ceb0c1ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/index.js\":\"c271f936bab4a876\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"21067c747bca87fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/schema.js\":\"c885b1b319f9b6a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/AgentTokensDialog.js\":\"bf2b1ce8aa9b9014\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5149315f231c3663\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/addMedia.js\":\"e82090818e07c69c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/backlinks.js\":\"7e3c9815044c4816\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/block.js\":\"66b4a43e3216d20a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/context.js\":\"9645a144975087fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/displayIds.js\":\"a7a2933b80b6f186\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/index.js\":\"8edaaedf7edec530\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/outline.js\":\"7934b22a2e2576a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/properties.js\":\"db6e633fadedd803\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/refs.js\":\"a66b5dee513dd744\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"037785026bf3a3c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/search.js\":\"aa3bfed60bc4949c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/shared.js\":\"f77a848162c2319b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"674cdff74eba6fe8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/text.js\":\"74971bc1e3d913d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentWrites.js\":\"e7b7d4e8a890cea7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/authoringCatalog.js\":\"1a4a6352ec1c728f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/blockRefTargets.js\":\"7b9ead53f275f8d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridge.js\":\"ec53ef7f37c28842\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridgeLoop.js\":\"d1846d35d36f29fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/changeHistory.js\":\"5c807a3c3f5a33ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commands.js\":\"0716d01c62faa5fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commentsCommands.js\":\"ac9a82d4b1603ed3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataExtension.js\":\"8fa125bdeb3a577b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataModelGuide.js\":\"1695478b780741d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dayPropertyInputs.js\":\"d00b7adb5ac98d11\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/describeRuntime.js\":\"1854bf896bfcbe0b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/extensionLint.js\":\"08ead8eaa434a687\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/grainAudit.js\":\"632db2477a1321ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/healthCommand.js\":\"e09d70648e559bfb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/index.js\":\"5414cbf523aaba6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/presetIdentity.js\":\"e2499e72843a0499\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b7d620e9082c7e0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/readMedia.js\":\"feaea15a584a41b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/schema.js\":\"09209e1176e457ff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/serialization.js\":\"7992723c6150e5c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/targets.js\":\"e830e346649c7c63\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/tokens.js\":\"563729baf1602863\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/watchEvents.js\":\"34a6f0a88e6015fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/workspaceGuard.js\":\"51eae1bcd1cbb437\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/writeCommands.js\":\"98f775f8363ca6ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/AliasCollisionToast.js\":\"18b309db68feb8d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/DuplicateNameBanner.js\":\"3c920424a7e80c97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/collisionMerge.js\":\"9cbf34293f49703d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/dataExtension.js\":\"f2301f1153ac5b02\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/index.js\":\"29ea1b0d81547cf8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/mergeCollisionAction.js\":\"b00a99071a284fcb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/pageStyling.js\":\"355080279bbf16b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/rejectionToast.js\":\"f3698c25d4715c73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/syncProcessor.js\":\"868f1b038c504c77\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/actions.js\":\"a61c9efd720dd3db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/addComment.js\":\"6b8274ce032a1a08\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchor.js\":\"90d4f8dc4250b099\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchorState.js\":\"f86b06883cf2611a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/commentLinks.js\":\"f79efd4ef504bb0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/confirmThreadDeletion.js\":\"7c18799647c748a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/container.js\":\"16e98a3add391484\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/dataExtension.js\":\"acac3f01cb0bf619\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/deleteComment.js\":\"a109dc2e18a7a9fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/highlights.js\":\"6ba3a3992989c493\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/index.js\":\"f0468e6b8ae8bf32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/linkedCommentsPill.js\":\"7b8b3e55c86058c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/margin.js\":\"fcd0f08e969b8a2b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginAnchorLinks.js\":\"e9af4758b13b3b1c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginSchema.js\":\"c90682fb2816f275\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/newComment.js\":\"1ebf90ca990fe2be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ownThreadPicker.js\":\"71d1ef5275c904f6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/placement.js\":\"0d14cc4b94cf21c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/queries.js\":\"f5f65dcf8a723584\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotePosition.js\":\"3eeca1d890f55e78\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedIn.js\":\"82dfb461fa033c7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedRange.js\":\"66666192f9fae347\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/rangeRefs.js\":\"47f2a2c8f22a6106\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readHighlights.js\":\"ce8aad972503bb39\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelection.js\":\"44a9b1809b7f6e60\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelectionUi.js\":\"a1dd302bea5d5c19\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/reanchor.js\":\"13d58bb28688edfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/schema.js\":\"d3792388084c21aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scope.js\":\"14dd8ecd7ecb3e05\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scopeThreads.js\":\"adf3cc1923e6efb1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/splitRetarget.js\":\"278bff0238c2d39b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestionCard.js\":\"3fef2408d4dc56e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestions.js\":\"a1f35d7cb2cec038\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaries.js\":\"7ae8e429f630ac62\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaryBatch.js\":\"933e28487cd053f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/surface.js\":\"412cb9a7895ca473\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threadNavigation.js\":\"6ac4ee17dced3919\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threads.js\":\"81442949d153007a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ui.js\":\"ef971c214b47075e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/uiStore.js\":\"353eb977ecea9da5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/appIntents.js\":\"171ab9476a805255\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/index.js\":\"c68dc6a6f7d21c4c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/index.js\":\"0cd533a03a863c8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/status.js\":\"31b3728450f970d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"07cef2ea5f0f225c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaBlockRenderer.js\":\"5b045e101b52791e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaDownLaneReplicator.js\":\"871d1fb363bcd062\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaUploadReconciler.js\":\"f56d312a0536731e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetDownLane.js\":\"09fcda785facd0c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetResolver.js\":\"933285dfebb77196\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetUpload.js\":\"e26d49d43355a324\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/attachmentCleanerIO.js\":\"8916210d937ebc6e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/supabaseAuditIO.js\":\"07ac9e537dcd3909\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/blobStore.js\":\"ee24242ca12cb9ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/browserMedia.js\":\"f2cd799582538dcd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/byteStore.js\":\"9567ad62d862475a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanerIO.js\":\"9e1c938c92c28607\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanupAttachments.js\":\"95e7ddcd73b10c58\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/dataExtension.js\":\"c87d0e3c16c80bc6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/downLane.js\":\"9bef59e4534bff0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/index.js\":\"e6999ec581c42254\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/insertImageContribution.js\":\"8d445e56d7e4256e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneArming.js\":\"3dc7255c17861556\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneLock.js\":\"73fc0b956635a49e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaBlock.js\":\"486e23c16654da9a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaCapture.js\":\"41aa07b346dc7077\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaLanes.js\":\"a281fa44d816175d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewers.js\":\"f941e5f93bae7aef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewersFacet.js\":\"b35575dcd4ec31a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/pasteCapture.js\":\"f3bab05f7f18dd3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/resolver.js\":\"727480710ba71d86\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/retryUploadsAction.js\":\"f51bc58cca0d2858\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/storagePaths.js\":\"482d73d95901c0c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadDrain.js\":\"c49e6636667f8a86\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadLaneStatus.js\":\"3684fa682bd3946f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadReconcile.js\":\"b9c92fd6d111070a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadRecovery.js\":\"286065740d59353c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadStore.js\":\"56c25545eeb0783f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/useAssetObjectUrl.js\":\"49b3e8894152fa54\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"74151d80f85387bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksViewSection.js\":\"0da45f2f7f517a8b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/facet.js\":\"13c74e49125d6230\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/index.js\":\"de374c6d11e6469d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/prop.js\":\"f16407fbddfa5455\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinkFilters.js\":\"65b1e12cfa3bf701\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d5afed54f1edf01c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BlockEntry.js\":\"fde71d268a743e5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/LinkedReferences.js\":\"31beaed371e31022\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"262a93c868af4b6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dailyNoteDefaults.js\":\"b61c4538d89ed4f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dataExtension.js\":\"dfb30b916262f8fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/edgeExclusions.js\":\"306e5fdf6b9d2d38\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/filterProperty.js\":\"ec19bc42bb1f50fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/index.js\":\"be15c4a5b96923df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"818b9b3517ae83b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/applies.js\":\"05f55e860fcfe8f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/countQuery.js\":\"d6bb3da54a6a8847\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f042b419daf41ac6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/index.js\":\"a188908728ec6b8e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8951de7f7d7c5ff8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/presentationInvalidation.js\":\"c7bc48714ff969f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyEditorOverride.js\":\"85a5203b0d9005d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyFilter.js\":\"695b84daf3d1c5e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/query.js\":\"565afafc96f75c50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/resolveFilter.js\":\"5e82d3e87c0f7aea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sourceBatch.js\":\"7fb4d079a956c022\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sources.js\":\"8216425f717a48d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useBacklinks.js\":\"3944bc0a5e55e607\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"5f505d44287875af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayCelebration.js\":\"6826991b0c643f72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayOverlay.js\":\"cb827fe19f71272b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/gate.js\":\"06837e09b166d0e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/index.js\":\"ad513c40d538005d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/wolfTheme.js\":\"da9669e9c8b9a41a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/BlockDragLayer.js\":\"a954590b4a301437\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dragController.js\":\"72bfabeb353dea08\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dropTarget.js\":\"090a4c2fd179593c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/index.js\":\"129c66d67f7112d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/projection.js\":\"ddfde19a426b2544\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/BlockMetaCard.js\":\"d8cd331018d97e24\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/index.js\":\"a10491f86f4a9867\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/AddTagDialog.js\":\"c8c15b9374436db9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"eadd362cc9d97178\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/TagNameIssueHint.js\":\"17a75673e0ad3737\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/addTagAction.js\":\"44bb17f81cbc5183\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/appendTag.js\":\"9c2a392a08372269\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/config.js\":\"14eda247bd5230ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/dataExtension.js\":\"0c132eb789522ab3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/index.js\":\"08135e80d6ea9ff9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/propertyEditorOverride.js\":\"301b3f6133352eeb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6680abf1b55ef901\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"67557cd779486222\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/Breadcrumbs.js\":\"0a75df5ebce01ad9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"7939b0f8da16e7b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"7318050e6c11233d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/index.js\":\"c0164ba8aef5d409\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"cf8e2d70d19cf5b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/CharacterCountItem.js\":\"d0f3bcd622fc7180\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/ProfilePropertyEditor.js\":\"0ee8e3c84d144e17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/actions.js\":\"4918016613ed91d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/blockType.js\":\"1b8e2b1ea54158d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/charCount.js\":\"908c93b9a96f6bf1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/dataExtension.js\":\"3a4569bfa90524b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/index.js\":\"5010094e0e0934c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/profiles.js\":\"58f71a580036badf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/properties.js\":\"92d766d59f187f1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/subtree.js\":\"714acf20f5f806d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/textCounts.js\":\"98e39952d96d0ced\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/colemak-keybindings/index.js\":\"0e734dec520e759d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/CommandPalette.js\":\"3967cf1457517502\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/HeaderItem.js\":\"2025cc13ff142aea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/context.js\":\"478a279052eb246c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/index.js\":\"53322520722bea41\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/selection.js\":\"f8a68a47146dc18d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/toggleStore.js\":\"6034ef9a1cdc9c1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/useCommandPaletteActions.js\":\"12afd5c33c4606be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ContributorBadges.js\":\"0f0cc08680a72843\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ProfilePicture.js\":\"494660f990b523a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/author.js\":\"48d19849e6720980\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/codeMirrorExtensions.js\":\"707f6aa8ba512387\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/dataExtension.js\":\"464dd9e4253e9cd4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/index.js\":\"842d4c9acc79016e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/mentionAutocomplete.js\":\"0cdfdb57178ad5a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/processor.js\":\"98cbf1deccef40f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/profiles.js\":\"123ecda19ecd318d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/queries.js\":\"e1f8a3e6fba954bc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/schema.js\":\"322adfe52b92eae7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/useCommentAuthor.js\":\"349df0ae36c9bab3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"d6cdadd5ec45ae1e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ea3db1e3ee20b027\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/index.js\":\"74632b500f2e61a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"cf48ca12288af201\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"0e1769eb41eef043\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/CalendarGrid.js\":\"1a6ca4304a585397\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DailyNotePicker.js\":\"d67024f781b5f2aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"6d1ddfd6143363fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateNavDecorator.js\":\"3e94fa5ad9671129\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateScrubOverlay.js\":\"c40ffb52d5f65c5a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayPropertyControl.js\":\"ea2058f06b71b942\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayValueReferenceControl.js\":\"a66d81923a83075a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/HeaderItem.js\":\"38045f78be69adc8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/ReschedulePicker.js\":\"3e7816456cba69d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/SpreadDatesDialog.js\":\"4ed04f6bfdd765b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/actions.js\":\"d466fafbe5fa56eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/blockDateAdapter.js\":\"506f8bcd9bc94d27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/calendar.js\":\"df0a81cddeb18522\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dailyNotes.js\":\"7661bf9251eb2ab1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dataExtension.js\":\"241c2847cef7ac7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubActions.js\":\"7a3462682fd067a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGesture.js\":\"25e1224dfab92d93\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f764c0856d022736\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubRecognizer.js\":\"9cb6bdf218e7040b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayProperty.js\":\"478a4a7ebb720f3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"4e72b9d596e0d7fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/deletionGuard.js\":\"e3255c634f28df06\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dueQuery.js\":\"b442f3336890126c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/index.js\":\"402cc8c2699d7c16\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/landing.js\":\"6c6d93e89599a66f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/localSchema.js\":\"e9b06ce30ee710fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/referenceDateAdapter.js\":\"505f1f97a64cb658\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/rescheduleAction.js\":\"d81befab335577f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/schema.js\":\"274c0a0d7a9bef98\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadBlockDates.js\":\"8b14d2b7988807cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadDatesAction.js\":\"e014e1c2e881b7c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/today.js\":\"6508f438d144e5d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"739f5c768d9fc0bc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"795eab7a4eb39519\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/audit.js\":\"62da51e060726d01\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditAction.js\":\"e4b442cdc190456c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditRanges.js\":\"f2b3f5dc222571dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/diagnosticsSource.js\":\"15d172c3a17f19d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/divergenceScan.js\":\"9cafdead7a5b4c59\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/index.js\":\"56acb7668a489bb5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/propertyChildrenChecks.js\":\"566589ab3e287e39\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/referencesMirror.js\":\"3a478ba18ac94088\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/rowJson.js\":\"c65c6a36a35ff1ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/schedule.js\":\"04f7060dcf3bffe0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/store.js\":\"47f04bafbd9df916\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/action.js\":\"ebbdb7f7d9b2fd17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/index.js\":\"0d7360e0c28302f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/plugin.js\":\"111464b44b65fe33\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"cd4dc039c8b82e59\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/actions.js\":\"4bf0ddc07c444b35\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/changeMarker.js\":\"2b01331e4d75d67d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/diagnostics.js\":\"843fd7c139202b39\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/fileSystemAccess.js\":\"f99b9fb34bec03d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/filenames.js\":\"022941b4125953a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/index.js\":\"21405844bb3aba9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/mirror.js\":\"d3fbb881f471c044\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runLock.js\":\"b8d18d730af08070\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runtimeHealth.js\":\"fb44a4a6044fdbb9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/schedule.js\":\"cd4f6702dea7bfc1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/store.js\":\"2f9d391f67df3c8e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/index.js\":\"3832cdaf96d7238b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/themes.js\":\"bead26d0b9ca1603\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/facet.js\":\"fb244f19221c1de3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/useDiagnostics.js\":\"bc1b07efd4ddd353\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/dismissals.js\":\"f3907d9ba688f791\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/index.js\":\"8d2bba2e1bf5be9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/status.js\":\"54232aaf3b6df6b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/store.js\":\"74baf70ac6794533\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"568970a3491713ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsSettings.js\":\"2c6ab3426ac5d47e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/actions.js\":\"bd64f74f60c72579\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/config.js\":\"780c3dad03c536d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/dataExtension.js\":\"d65cbc8dfc226a17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/effect.js\":\"3d8c3a8f1876f39c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/index.js\":\"f0ebf27b91dcf691\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/propertyEditorOverride.js\":\"cd502129f857d7af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/useToggleTree.js\":\"b59b36b23015d7c0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/ExtractTypeDialog.js\":\"480b71a632b340f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"46c1f61b6ab86e1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/PropertyShapePicker.js\":\"2a310f53341e7866\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/action.js\":\"4033a9146a6c88f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/index.js\":\"bdeb687ccc2f66f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/FindReplaceDialog.js\":\"514e26461391a62a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/HeaderItem.js\":\"54dbfcefe8e242ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/dataExtension.js\":\"326eec4bf4bd7bfd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/index.js\":\"c6e78ce2c8ddc03f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/search.js\":\"5b67fbe3f1f4f3c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/toggleStore.js\":\"95087c57e9e7a1e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/LocationPropertyEditor.js\":\"ddaa824c4c31bdbe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/MapView.js\":\"18302332656f1d3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/blockTypes.js\":\"42800aebbc97a783\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/codeMirrorExtensions.js\":\"eb5d3564a439d0eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/createOrFindPlace.js\":\"cf15e93240b3db9a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/currentLocation.js\":\"7363b60efbcdb22b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/dataExtension.js\":\"bcad9b358ab6131b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/geoContentDecorator.js\":\"36fdcaa21a523b0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/googlePlacesClient.js\":\"b9f144a8b9fd7cf6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/index.js\":\"92055138a8ba1000\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/locationsPage.js\":\"b8c1338241934afb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/mapViewport.js\":\"7a84bccd990df282\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/pickCurrentLocation.js\":\"6513ea2615e2cd4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeAutocomplete.js\":\"9a9c652ae7f650ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeNameCollision.js\":\"41288b59ac08aa41\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/properties.js\":\"77f8f4d0fabe539e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/propertyEditorOverrides.js\":\"8f440fafa672b2b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/query.js\":\"7eed299257d44045\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/usePlaceSearch.js\":\"cfa0f16641feb5e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"abbc7eda5a27a3bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c1af84f165cb9857\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"759a630f4719cd24\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/config.js\":\"720d3b45660ebbda\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/dataExtension.js\":\"bd22a7b9ae28af94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/facet.js\":\"6d848eb8ea98f196\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/grouping.js\":\"c99f58ffd9edcd27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/index.js\":\"71321c5eee8c9d18\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"1fcda31ea73269f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/query.js\":\"effffa06fd015b85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/resolveConfig.js\":\"142c5adf4c6bc538\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"006b6da3b5c08d70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"3fdd98753da5d2da\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlDocumentContent.js\":\"027394abfd610dcf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlFrame.js\":\"02f3f5da5a51a121\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/actions.js\":\"7ccabc9e32ce0379\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/blockType.js\":\"36471b267ccdf876\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/confirmRunScripts.js\":\"6366f721f35e8a32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/dataExtension.js\":\"b68283421ff87906\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameAnnotations.js\":\"69d6935cef16dded\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameDocument.js\":\"3a86b5be995ae5ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameTheme.js\":\"5b5e61a2f64367f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/index.js\":\"3abf2505f3756084\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/scriptConsent.js\":\"a17bb087cb6006a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/sourceMap.js\":\"94538fa0d03709be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/useDocumentScripts.js\":\"da4bebc24509fba5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/index.js\":\"b7198cbdec724ba0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/record.js\":\"3146519e3c90d5f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/recordStore.js\":\"dbb1aea0959eac07\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/responsiveness.js\":\"a5b36a330571d782\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/schedule.js\":\"b2dc158b484293b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/sessionContext.js\":\"999dd6fc9c2b7372\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"aed5dde1bfaf4b1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"ecbbd50b0fdeb672\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/actions.js\":\"cc282a8c7db8db57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/config.js\":\"5337f0af3d19c7e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/dataExtension.js\":\"d330ed85d2e409d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/effect.js\":\"6aab1731e03794d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/index.js\":\"bda4020096228fe1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/keyCapture.js\":\"187e6b72d8279fd3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/overrideStore.js\":\"d7d58cf013a7ee36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6b279d6ba2ab37ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/HeaderItem.js\":\"7531ffb91ad4f107\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/LeftSidebar.js\":\"32deee1a926525ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/actions.js\":\"4f4bf4954d3b3493\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/facet.js\":\"e9d71a9bcddd5e3e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/index.js\":\"44f79cb3719f28e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/shortcuts.js\":\"ed161e82932dea49\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/toggleStore.js\":\"32a431d59678b856\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/MergePicker.js\":\"1e49b18c53e40fa4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/index.js\":\"54b720bfe4fe38eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/mergeAction.js\":\"edb5626d20af827f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/strategy.js\":\"869d320ef9db5204\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/Button.js\":\"bcb390f9985cae5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"917fc04ba2142c94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/defaultItems.js\":\"604db1e94d12c5bc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/facet.js\":\"21e4d76de08c1c57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/index.js\":\"9a6d190e4cae4301\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c148bd17f6ea252a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/actions.js\":\"542ae4780be28291\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"42aba70d8ec06408\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/facet.js\":\"ae53644f614a5803\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/index.js\":\"5f59a08859f2974c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/MoveDestinationPicker.js\":\"22aa927a83aacbe3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/blockSubtreeMembership.js\":\"922551eab61bc78e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/contextMenuItem.js\":\"2cb03e166433f5f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/index.js\":\"e8b2b5a739b05647\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveAction.js\":\"5d473789a0c39c08\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveBlocks.js\":\"a29ff48e66213be3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/selectionAfterMove.js\":\"07731a2d40699a06\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/TutorialBanner.js\":\"6bb5b4fe7df74f61\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/action.js\":\"475fc83f62d3fbb6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/bannerDismissal.js\":\"dd0dfd10f3938e94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/documents/cheatSheet.js\":\"9a572e8509078733\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/index.js\":\"33e6eb9c072e3d1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/keys.js\":\"d5d73a51bbd2ea18\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/landing.js\":\"90968565712607c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/outline.js\":\"98a0b0b7a5fd893a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/seed.js\":\"d427e6cc76301bc5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/PerfTrendDialog.js\":\"e9bd28ab1b8283f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/analyze.js\":\"50bbdb9a1ea62832\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/diagnosticsSource.js\":\"30e1cbdef1ec979a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/index.js\":\"9ecc32080882fccd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/load.js\":\"20324c725cd2b11f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/monitorRun.js\":\"ef8e0d94dac5bac8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/schedule.js\":\"5e37d5b278f41c34\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/series.js\":\"e8d7a8267140e261\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/store.js\":\"2521f8c5123e1dd7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/trendAction.js\":\"92afc7f144215ce2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/verdict.js\":\"d62713e1f32be294\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/clickToEditAction.js\":\"e331be8cea2f9114\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/index.js\":\"3f8f9f2cecc153c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/interactions.js\":\"ac848ee5243090ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"a274d0cbe6abb635\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGate.js\":\"2084660db9815829\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGateDialog.js\":\"ccad8cf5ef8d374e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/action.js\":\"6c7470a41f46ff7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/index.js\":\"c0f9051a1a888832\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/localRunMessage.js\":\"9850046c76b6cc22\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/plugin.js\":\"aef0184588a3b9db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/progressReport.js\":\"5c65bda2e648024f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/sweepProgress.js\":\"4186ef64c9354988\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/FieldRowRenderer.js\":\"a5a1822513b155f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/ValueRowRenderer.js\":\"2ffa39ec542fa34a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/actions.js\":\"e7210872755eca86\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/autocomplete.js\":\"64a340b6d4741c85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/fieldRow.js\":\"b2ef8ada9efd14fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/index.js\":\"160a11a217038cf6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/referenceWarning.js\":\"63a515b09b50c282\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueAutocomplete.js\":\"c55c659d46e88d74\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueSchema.js\":\"8b754669268a621d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/HeaderItem.js\":\"64a8450adc8e4939\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/QuickFind.js\":\"99bf5d37978efc13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/index.js\":\"5844faaef3600f94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/recents.js\":\"af18154ac24ecbcb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/resultItems.js\":\"a5ee01aaf054bcb8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/selection.js\":\"479721cefbb2f618\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/toggleStore.js\":\"1bceccd9c568de07\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/HeaderItem.js\":\"46051a1bc75034fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/RecentsPageBlockRenderer.js\":\"9a005614c8827b18\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/grouping.js\":\"4adb0fbbe616598d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/index.js\":\"397e65fa56c166d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/target.js\":\"a5d1784d45faf715\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/codeMirrorExtensions.js\":\"4d300cc2dbfaa564\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/contentPrefill.js\":\"580fae94d4007cd0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/dataExtension.js\":\"117ef2e4042c0036\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/index.js\":\"bf98b9661c324a69\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"1a4e449084cb57a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/invalidation.js\":\"3805e80d16cdefbd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/localSchema.js\":\"647c5e57c1cafcb7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/index.js\":\"9832314e19de4fc7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"cc01533ed31a653d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/index.js\":\"d12074415e786c11\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/referenceNode.js\":\"77e1c932030f6333\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/remark-reference-occurrences.js\":\"901547047cbab1b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"fbd68b32f9e1cf42\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/index.js\":\"2a6512e9b512e16d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"87f661757faad246\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"59295475c8313631\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/mergeRetargetProcessor.js\":\"8f40cea7445067a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/parseFence.js\":\"bfc8db6d13f6eda8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceParser.js\":\"1978b1d38616bb73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceProjection.js\":\"a3c0fc80b7f86bdc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referencesProcessor.js\":\"e46d13c43a8bd755\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/renameProcessor.js\":\"b77eb7e252be15cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/spanReplacement.js\":\"22834e3f56bea63c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/htmlToOutline.js\":\"9d71f0aff8d8a5b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/index.js\":\"8001dd31f9af6d52\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2a5d0b1169a1d439\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/pasteDecision.js\":\"6038e8161267b862\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/action.js\":\"db6bf8b54ab90a00\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/blockIds.js\":\"5164376d50a8d70f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/content.js\":\"ec05c4abdd3249fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/effect.js\":\"10f5ea0b441594a9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/ids.js\":\"683ae8d0f3d39e81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/import.js\":\"4d0ce4875016d553\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/index.js\":\"02ec4a906fad5c45\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plan.js\":\"46b9a0988cb68eca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plugin.js\":\"e4900c5769dab113\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/promotion.js\":\"e73cc4e8ebd2092c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/properties.js\":\"9b673dc4b78b5e57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/references.js\":\"2f37ff03d314425f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/report.js\":\"7f2342fb16d86b69\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/roamMemo.js\":\"be66db835bfcf895\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/runtime.js\":\"c121e34de5b95191\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/schemaReconciliation.js\":\"c2ff14e677beca9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/srsMarkers.js\":\"8bae06a66ce35af1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/todo.js\":\"16ecdb7de3244fb5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/typeCandidates.js\":\"f582c37c14d99435\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/types.js\":\"42162d7ebc577c8b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/index.js\":\"a67fd46e307a9eaa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/store.js\":\"14e2a54624c92c15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/HeaderItem.js\":\"64ca17a705f14af6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"ad1ad5d282e9306e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/index.js\":\"a20879450b8f6ea3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/model.js\":\"c61235c429f62e22\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/toggleStore.js\":\"c72195d12ecfd745\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/useKeyInspector.js\":\"a3159bbe631fc115\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"17b1936c93b76f53\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/ShellDecorator.js\":\"dbbc7d6ade4d03ff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/actions.js\":\"ca31b5bd57741bb5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/exclusionsFacet.js\":\"01d75834f47ef17e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/index.js\":\"eac2239136d59ebe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/shell.js\":\"333d2cbcbfcbc5d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/surface.js\":\"c0890264004b9776\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/walker.js\":\"e80516bf80c6818f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/RescheduleToast.js\":\"f9f5e24d22374c8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/dataExtension.js\":\"65e91e417e8d9e80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/index.js\":\"be916cb09e2fbe23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/indicator.js\":\"bc4d2600301ee0f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/moveSrsState.js\":\"623847d618b55468\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"5ca4a6294a6961ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/scheduler.js\":\"e211956e735607d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/schema.js\":\"119f25e637315b19\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"91169c56480d8d91\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsClipboard.js\":\"a67815bd90f0c799\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2e22310b2691ef83\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DailyNoteReviewHint.js\":\"ac2c42cb6d532181\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DeckPicker.js\":\"d8ecdeb40907c266\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewControls.js\":\"c4bbda6bcc49ac44\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewDeckRenderer.js\":\"16a228eefb6b02fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewSession.js\":\"382a7e229b57c832\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/actions.js\":\"85bc4f94a39ec82d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/archive.js\":\"9a33f769f844fdb2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dataExtension.js\":\"d3f2444bb0c130b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/deck.js\":\"0125c33926075c02\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dueQuery.js\":\"e92b2aaaa0406bfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/gradeDecision.js\":\"86db96da2d8d815d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/index.js\":\"502c9a6ee65fb209\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/keyHints.js\":\"061ad88b8e20e9c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewCardLayout.js\":\"66ab4f0a88e792c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewProgress.js\":\"5d6deb265e6df1f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/schema.js\":\"5290f000620a5420\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/useDueCards.js\":\"3ccb4bf5e8a1d346\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/index.js\":\"f8999848117017ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/record.js\":\"8d074864defa8b5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/index.js\":\"92fd8b68e77ff5ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/persistenceStatus.js\":\"8f111ce0b62684b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/requestAction.js\":\"71940db2d28c4fd5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/TypeChipsDecorator.js\":\"063a3d17c7b34fb5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/codeMirrorExtensions.js\":\"ecfbad71ab533953\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/index.js\":\"713b096968ccc257\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/typeAutocomplete.js\":\"f69a8836f85f29c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"72c57cb2bedebf4e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/actions.js\":\"efff283cbc2b877d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/anchor.js\":\"deacfa68c68fe8eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/events.js\":\"4d25483c15d70add\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/gestureActions.js\":\"e3e2ef81be932f0f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/index.js\":\"b4c0bab650fc65c6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f0febed9ed82ea00\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/collect.js\":\"3b0919e36353153d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/index.js\":\"b57bce9a8060b07c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/record.js\":\"b4023a4141e8a02e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/RejectionDialog.js\":\"9289faf53599e666\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/SystemStatusHeaderItem.js\":\"8a5027e7c79391f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/index.js\":\"7ecbe13826e8f02a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/model.js\":\"41da06fc43056a88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/queueCounts.js\":\"001eaca0eed09e7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rejectedHelpers.js\":\"d66434aabf9f69f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rematerializeAction.js\":\"ac915c34a928944d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/useHysteresis.js\":\"c821be266de80202\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/ColumnHeaders.js\":\"1bcaf705a7e3e9ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/QueryUi.js\":\"f954694f56de6e71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/TableLayout.js\":\"bda25a9cf95ec183\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/actions.js\":\"0054d29a2a2c873b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/cellEdits.js\":\"784b4765caf8761d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/childrenViews.js\":\"49c563030f4b0f28\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/columns.js\":\"2562cec6b4a19244\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/controller.js\":\"2361c3484bdd1111\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/convert.js\":\"31342a92984ffe21\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/dataExtension.js\":\"27e037188af16d75\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/index.js\":\"26953e76efea01e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/keys.js\":\"cb585ae8ef4432fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/model.js\":\"e74533c5d80f47fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/QueryText.js\":\"a373b35cdbe9d790\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/backfill.js\":\"add5262d04be035f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/completion.js\":\"b46412cf55ac6ea9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/format.js\":\"3d73e9611e6ffb8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/parse.js\":\"50137877a598c127\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/queryValue.js\":\"17bf8c1c9296dba5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/registrations.js\":\"d6f6b896243cf933\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/source.js\":\"eb4e061212a2fe4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/registry.js\":\"44f458a2a2a911b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowGutter.js\":\"74b9bb7a9dd4f2e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowVerbs.js\":\"f0b1b0e07a3a5a17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/schema.js\":\"6b967d2b52294641\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/sort.js\":\"cb5d45fb9a26022b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/effect.js\":\"c753e4fe9aa09986\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/index.js\":\"e770b4929e331375\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/theme.js\":\"b55beb59bcd65c88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/actions.js\":\"5c2324315448ed79\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/dataExtension.js\":\"f539ef35fc301019\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/index.js\":\"f3899bb2838c3c67\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/schema.js\":\"8c0c640b5bed573b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/TouchSelectionLayer.js\":\"adb06ac2fc154352\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/actions.js\":\"00ee6cbc9f859ca4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/defaultItems.js\":\"bbe3cf3b407a254c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/facet.js\":\"d12371d5a4d499e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/holdRecognizer.js\":\"76a0350e659aaeab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/index.js\":\"7c52e6b306c2d2a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/UpdateIndicator.js\":\"4bf5ee7ef4a05297\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/index.js\":\"227a2a0613312b25\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/loadTimes.js\":\"b28010df99bbde71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoNotesRenderer.js\":\"b84fb71f5107ffb4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoPlayerRenderer.js\":\"df7233dc8b08f868\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoTimeStamp.js\":\"9b5fb05ebc38e41a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/actions.js\":\"44d2c6e4553f168f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/index.js\":\"5f29c918bac99b0f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/markdown.js\":\"daa7f418d3193691\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/notes.js\":\"546de9cd360ffbc1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/registry.js\":\"18080eacb1757884\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/remark-timestamps.js\":\"2b26834025974288\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/view.js\":\"92f621e8e8ea5c71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/LinkHints.js\":\"4614dc87e38d5cf1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/index.js\":\"e2a2f8e59d4d1ff2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/model.js\":\"f73bc5b06c4e3545\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/settings.js\":\"fcd253c658d89c41\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/actions.js\":\"a48f08caa65973b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/index.js\":\"b642f21450c56f64\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/interactions.js\":\"93f0c14d7babc75c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/workspace-header/index.js\":\"bf0fcb3525fbc9ec\",\"/knowledge-medium/pr-preview/pr-1919/src/registerServiceWorker.js\":\"2de75b330f32d823\",\"/knowledge-medium/pr-preview/pr-1919/src/requestPersistentStorage.js\":\"cba207a16e627039\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authRequestDeadline.js\":\"18da7cb449c8e436\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authStorage.js\":\"5c4a2fae93975689\",\"/knowledge-medium/pr-preview/pr-1919/src/services/powersync.js\":\"72df961d02a09590\",\"/knowledge-medium/pr-preview/pr-1919/src/services/supabase.js\":\"759660347b81a65c\",\"/knowledge-medium/pr-preview/pr-1919/src/services/uploadErrorClassifier.js\":\"fb25478e43344385\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/ActiveContexts.js\":\"b1712911f35a582d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/HotkeyReconciler.js\":\"fe6a3bddad7e5b78\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/WipeLocalDataDialog.js\":\"6db55785e9de890c\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionDispatch.js\":\"329a6a4ef3ae960d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionRefItems.js\":\"f857a08a6db52246\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/applyKeybindingOverrides.js\":\"c3bba88bde473817\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockActions.js\":\"197776b838c0302c\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockMergeGesture.js\":\"b9a656d5a4be5d02\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/canonicalizeChord.js\":\"121b58d1f95e0572\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultContexts.js\":\"ebde71e785d09ba4\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultShortcuts.js\":\"74dd2fa76f73d814\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/effectiveActions.js\":\"ee585342f84db13c\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureAction.js\":\"8908344ba90c37f4\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureBinding.js\":\"4e9834117024c4ae\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/holdRegistry.js\":\"0ce85b3d345dd562\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingConflicts.js\":\"22bf09153d410b5f\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingOverrides.js\":\"14691967fb749a33\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/pointerAction.js\":\"7492fb49f060f444\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/resolve.js\":\"1fc5667877ab7b0e\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/runAction.js\":\"cc204689a3d37061\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/sequenceMatcher.js\":\"6faa91bc5bb52fe9\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/types.js\":\"283a724a4f06c2d9\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionContext.js\":\"e4af44f0d478dc1a\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionDiscovery.js\":\"8486c6fe3aeb4cc9\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/utils.js\":\"465250af0340d6c3\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/bootStore.js\":\"836806e810790de0\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/previewDatabases.js\":\"162d94a6bca3b5ef\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/byteTransform.js\":\"945c1890d9327b7b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/attachmentCleaner.js\":\"856d6b8abb699d18\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/attachmentParts.js\":\"9bc6cb83d90e912c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleParts.js\":\"f40b5cedec7bbe75\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleRecord.js\":\"68bb04a13dbfe7dd\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/manifest.js\":\"612fb47f2373a28f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/takeBundle.js\":\"8038d096ade0a706\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/verifyBundle.js\":\"4f98050526e4ec30\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/cleaningStage.js\":\"f3bec7b52229e548\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionKey.js\":\"d5d5c862948c959d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionServer.js\":\"71f9e172b2ae8053\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flip.js\":\"a20858d683fad3c5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flipAttempts.js\":\"ad62751b3604d509\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/pages.js\":\"18604be1a55b1a25\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/preflight.js\":\"597f6ed75c8475a8\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/reseal.js\":\"1381347551c52d8b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runConversion.js\":\"0401b821be8c0dbb\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runLock.js\":\"b2f4ae5edba85fdc\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealing.js\":\"b14fc15bef5a16d4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealingStage.js\":\"2aeef5b8596ef96d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/stage.js\":\"406786e4fb012a89\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/verifyReseal.js\":\"abba60fd27f7d674\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aad.js\":\"30c6ced2f3bb7f57\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aead.js\":\"7bc0b12d634dbc28\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base32.js\":\"0e73e8457891fae7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base64url.js\":\"c69d744f57a5a560\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/binaryEnvelope.js\":\"23c55482fcb177a1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/byteAead.js\":\"7526314f6ed36c5c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/canary.js\":\"85b043a80c4ccfb9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentHash.js\":\"fc4fb28d057836fe\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentKey.js\":\"38b0b7e60a5e8b3d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/derivedIdNamespace.js\":\"54d6e0eeba4921d6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/envelope.js\":\"dfbaecc828fdd500\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/hex.js\":\"627f09bf9335823d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/sha256Hex.js\":\"bc1671dddaadaf1a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/workspaceKey.js\":\"d8da6393f51e0f7c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/conversionState.js\":\"52d325020b47caf3\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/createEncryptedWorkspace.js\":\"52c07936498bccc1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/pastedKey.js\":\"621b7c7359758b5a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"967d45d9756c3980\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/upgradeWorkspacePin.js\":\"457f512280a93973\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/keyStore.js\":\"b8c12b7ffeb32f0a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/mintWorkspaceKey.js\":\"486d2613556ad323\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/modePin.js\":\"39386b6aefb3baec\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/openWorkspaceKeys.js\":\"63627d397a4f2889\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolveWorkspaceEntry.js\":\"d1aed6159327bb16\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolver.js\":\"44bff97691ec3459\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/workspaceAccess.js\":\"79468a5fc4b977f9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/transform.js\":\"aba5103be922754d\",\"/knowledge-medium/pr-preview/pr-1919/src/themeBootDefaults.js\":\"c90990e104a2016b\",\"/knowledge-medium/pr-preview/pr-1919/src/types.js\":\"fd9026e94792960e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/ClientLocalSettings.js\":\"84622a0225610cf8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/abortableSleep.js\":\"de969f2aed9859ce\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/array.js\":\"87ce05143016cc33\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/backlinkAutocomplete.js\":\"fb4da22e3f07a87e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockCrumbs.js\":\"b813330f934b5fef\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockrefAutocomplete.js\":\"5a8d315e40e072be\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/cadencedIdleJob.js\":\"b0af4b2f9adec2b6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/callbackSet.js\":\"09288a3d4796fb78\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/clientId.js\":\"131542cb473f3d12\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirror.js\":\"b83376ab1b8acaa3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirrorCompletion.js\":\"5353490899ee65d1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/copy.js\":\"3c2e748240c2671f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dailyPage.js\":\"8cd2279ed664d9dc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensics.js\":\"eb2467dc16a01ef9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensicsHooks.js\":\"f4c33a7f65748c15\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/deleteBlockThroughUi.js\":\"2dab161b2fd20916\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dialogs.js\":\"af09333a4ab73bd4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dom.js\":\"192153f6f564704a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/downloadBlob.js\":\"e6a1ace89a090334\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/drawnWalk.js\":\"23b438a3c13c8ced\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/exportSqliteDb.js\":\"8ce0c7659af871ef\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fileSystemAccess.js\":\"062864e9a86bfadd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/flipSlide.js\":\"e98b0e3876b407c8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fnv1a.js\":\"5544c871fc075ae9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/formatBytes.js\":\"a0b3a729348d56b7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fuzzyRank.js\":\"79028b949310e9df\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idbKeyedStore.js\":\"3d76d723d4ae5ea6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idleCallbackPolyfill.js\":\"cae398f9d615fb21\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardAwareScroll.js\":\"f6ef9a077fbf12c4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardViewport.js\":\"310a4e98e703b095\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/lastWorkspace.js\":\"c586a794d4fb86cd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutColumns.js\":\"d65e451dc6ca0bfe\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionDom.js\":\"9795807472022eb7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionId.js\":\"6c4fc087d938ba75\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkClickGestures.js\":\"caeecb70b51c2f6c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkTargetAutocomplete.js\":\"89e3bd2a1183b441\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbCorruption.js\":\"d91eff931929f0fc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbRecovery.js\":\"f65776e7e3ebb2f2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/markdownParser.js\":\"4ba99427a9fa0af6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/memoize.js\":\"fc83d60cfed5861d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameFieldCommit.js\":\"c1e99ee02d40a279\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameList.js\":\"342642089120a0e5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/navigation.js\":\"f3020eaf5aa9db02\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/omnilinerNamespace.js\":\"c34fb963a6a60d63\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/opfsPageScan.js\":\"c09b418efc1d5c13\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelClearance.js\":\"1bf73e0d327c1821\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelHistory.js\":\"91e61defca8ac9f1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLanes.js\":\"f17b6431f3440a62\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLayoutProjection.js\":\"e2b92be07bbfa0ae\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelScrollAnchor.js\":\"7383332110839b75\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelUrlFlags.js\":\"68b813d39cfb50e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/platform.js\":\"653afedceb19491d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/pluralize.js\":\"cbff113cbc03210a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyCreation.js\":\"f8e6c40929380f33\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyNavigation.js\":\"7c33d1435da8074e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyValueContext.js\":\"45eb3a0c538bdd52\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/react.js\":\"a83320301194c5b3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeDate.js\":\"6d4cb01089c5a396\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeTime.js\":\"6560b09301295704\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/renderScope.js\":\"8c899923ae1a0888\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/resolvedThenable.js\":\"dc322b97d1389548\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/routing.js\":\"43f2d408a1de42cb\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/safeMode.js\":\"18cb1cd0b97c3f2d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/scheduleIdle.js\":\"2473645f857f9e9d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/screenWakeLock.js\":\"a07367c8fe904bdc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/selection.js\":\"a5f91b1fdc00f2c0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/softKeyboardGrab.js\":\"b747299b8dd2788e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/startupTimeline.js\":\"a314bf9990e80c8d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/state.js\":\"cc7a651ef5adad2b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/string.js\":\"22c429d1ce2548ae\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/surfaceZoom.js\":\"f18e9be6afeec239\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/time.js\":\"3fd5d9682475a403\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toast.js\":\"87f1e80aad4cd037\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toggleStore.js\":\"a0ae30cd7616447c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/untilStopped.js\":\"345f23e0cc7e6c29\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/userActivity.js\":\"f040470e10ddf4a4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewTransition.js\":\"84b6edeea377d44a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewport.js\":\"dbfe699efcbb6a07\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/webLock.js\":\"e4fd8cf640c0b35d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceRecovery.js\":\"906c0d64ee97ac65\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceSnapshotStore.js\":\"911365460d8b7cec\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-compiler-runtime.js\":\"1cfdd182418c642f\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-client.js\":\"275b2a0f35ac19a7\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server-edge.js\":\"7e09e3644ca70104\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server.js\":\"38be3975bcdde1e8\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static-edge.js\":\"746697d1f9fcc0ac\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static.js\":\"54fa99e1c81a8549\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-test-utils.js\":\"c112480ad68147fa\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom.js\":\"1b96ab6b9dcbd2c9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-runtime.js\":\"568baf2f85841f09\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react.js\":\"3dcc9f9e2d1bbb5f\",\"/knowledge-medium/pr-preview/pr-1919/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
