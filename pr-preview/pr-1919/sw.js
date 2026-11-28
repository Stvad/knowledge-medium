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
		buildId: "6a7c11f03270-5511ce9a",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/\":\"1ad7c7e463a09b64\",\"/knowledge-medium/pr-preview/pr-1919/index.html\":\"1ad7c7e463a09b64\",\"/knowledge-medium/pr-preview/pr-1919/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1919/assets/FacadeVFS-B6uLEty6.js\":\"7aa41e036a00e54b\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSCoopSyncVFS-BlTQX9s3.js\":\"ffc531704362af47\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSWriteAheadVFS-DsJdPs12.js\":\"3fd95c23c610ef98\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-DlROgey1.js\":\"6939b26e849b016a\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-lncq_ybC.js\":\"f7158d941bcb478b\",\"/knowledge-medium/pr-preview/pr-1919/assets/worker-fGhfelCd.js\":\"9944ebf8edc89357\",\"/knowledge-medium/pr-preview/pr-1919/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1919/chunks/app-CZ61ffg-.js\":\"e7a3fd994be254cd\",\"/knowledge-medium/pr-preview/pr-1919/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1919/index.js\":\"37171e83d72c0e78\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1919/assets/AccessHandlePoolVFS-BoGPYxRf.js\":\"74f37af66f9474f7\",\"/knowledge-medium/pr-preview/pr-1919/assets/IDBBatchAtomicVFS-B8u5ZU6X.js\":\"20b6f1e29b5b097a\",\"/knowledge-medium/pr-preview/pr-1919/assets/MemoryVFS-DNXLA_-D.js\":\"9cc0d305448017b6\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-U-fIfgwd.js\":\"7a17c6f49a224a15\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-C3avf6-K.js\":\"a60cd44b1039984d\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1919/chunks/AccessHandlePoolVFS-B_ysF1_l.js\":\"52d33798fcc6b6da\",\"/knowledge-medium/pr-preview/pr-1919/chunks/FacadeVFS-l3sVKCW4.js\":\"6d5dd0bbeb311fe1\",\"/knowledge-medium/pr-preview/pr-1919/chunks/IDBBatchAtomicVFS-DkOBwsqZ.js\":\"121a3d052d841152\",\"/knowledge-medium/pr-preview/pr-1919/chunks/MemoryVFS-C4ud7cj-.js\":\"dc952c1613d1b9e2\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSCoopSyncVFS-aL80P2ci.js\":\"381eea41d4e64fa9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSWriteAheadVFS-V5InhlNU.js\":\"4d0ae8c9b098059b\",\"/knowledge-medium/pr-preview/pr-1919/chunks/Preview-UcNw_jxr.js\":\"dfa9e637d69ffd46\",\"/knowledge-medium/pr-preview/pr-1919/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/card-Co53Ctz0.js\":\"9cfde29b54094073\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-C8i4BDfD.js\":\"cf1fd5317577a47e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/freezeExtensionImports-RPwHaIdV.js\":\"ade871c7b4bd5be7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1919/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-BKvlS76w.js\":\"a6f1a6c1d089a1c7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-async-B6EbCSq7.js\":\"663bca6c76ee6da8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-BG-L67AO.js\":\"232536deeb56e996\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Bwl6PvxV.js\":\"79f56d93934fad0b\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-C1KpaLgB.js\":\"d9f6f2590bea61ce\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CA-t5EJx.js\":\"7f9e4c671345ad5b\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CMWgcGaU.js\":\"c639f5f2b740773e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Ctcb6r_z.js\":\"bc4c12ac9e524517\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DaPVhqRO.js\":\"21c621734c2755c0\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DcD2lyvP.js\":\"857e5e381f6f574f\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server-legacy.browser.production-CweVtfA8.js\":\"81b8215662277085\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.browser.production-BrSkShtN.js\":\"8c9f0609a6949612\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.edge.production-D4tun15V.js\":\"7d25c8794388b295\",\"/knowledge-medium/pr-preview/pr-1919/chunks/server.browser-DvCKvCt1.js\":\"0f18466c29d5b2e7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/textarea-DeNo92zi.js\":\"386c4e0e9bc5d5fc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/ui-PNKaA7d9.js\":\"bff6b0a9e61aed36\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-DiMwuaFR.js\":\"dc46ccc9a5bb52b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-async-DAMXKp9v.js\":\"fe5b0a07c6c5a12a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1919/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/src/App.js\":\"0f7a078a51c4187c\",\"/knowledge-medium/pr-preview/pr-1919/src/appUpdate.js\":\"64d350ddc4fac6ca\",\"/knowledge-medium/pr-preview/pr-1919/src/appVersion.js\":\"9f647368bde83992\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/initialLayout.js\":\"be154261f0949f2d\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/openWorkspaceData.js\":\"577d71d0e699d35c\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/resolveWorkspace.js\":\"07eb39957fb42987\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/workspaceBootstrap.js\":\"a46fcc60372e3dbc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockComponent.js\":\"c529742496789284\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockCrumbs.js\":\"fd66c28349a25f9b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockEditor.js\":\"b522aadf1b11fd7d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockLoadingPlaceholder.js\":\"5c22f3cf88847c04\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockProperties.js\":\"6637801bb7e495a5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockSearchPicker.js\":\"e6f9d8e606d8071b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ConfirmBulkDeleteDialog.js\":\"f98653358c9f8f33\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DividerHandle.js\":\"34fb965ff03ff05b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DraftEditor.js\":\"095047be9a49f4a8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/GutterPill.js\":\"725a1989d8d78e07\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Header.js\":\"25e8f509102d33d1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/LazyBlockComponent.js\":\"104b08e875f46ab6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Login.js\":\"4e9c09ca0ef8e8fe\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ZoomableSurface.js\":\"76fdeb47dc97513f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/editModeKeepalive.js\":\"8255c540af56bf6f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyDisplay/PropertyDisplayScope.js\":\"94dd1a11ffeeb3d5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"d0e144eb689172b1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefPropertyEditor.js\":\"4a1c96910ac90cc2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefTargetTypePicker.js\":\"842a79dd9e3d3dd1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/SelectPropertyEditor.js\":\"b7f288210cf66d5b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/TypesPropertyEditor.js\":\"cec984df0392f6a8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/defaults.js\":\"8900f8ded8ca72e7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/kernelValuePresets.js\":\"df139dec1fd60d32\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/selectablePresets.js\":\"953391094ef1139d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/typesPropertyUi.js\":\"9b528996f31a10ae\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/AddPropertyForm.js\":\"0a249c0d5b80d1c2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyPicker.js\":\"5a711e524a4eccbe\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyRow.js\":\"33ed88385c053192\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/Rows.js\":\"c416f496d7147aaf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/actions.js\":\"5b0ca820415cdc0b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/declarationOnly.js\":\"317ce00331103907\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/layout.js\":\"9fb59fc7b2dec491\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/model.js\":\"aee09af4498d11c3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapeUi.js\":\"04dbac544d8ab62d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapes.js\":\"a876cf38c10efa4c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/usePropertyEditingActivation.js\":\"505cb722d0ae3fad\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/visibility.js\":\"e153ee065c0b1086\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanelSections.js\":\"9ffd4c7b75e4219b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockEmbed.js\":\"5fc40ea104a1e4e1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockLink.js\":\"01fa40751cc6a672\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockRef.js\":\"0c58358f34f73539\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/CompactReferenceLink.js\":\"77b6775b55ca79c6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/ReferenceLink.js\":\"7e88b6073c2834fa\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuard.js\":\"e04680cfae5d39e1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuardContext.js\":\"51398984a425b03b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/linkInteraction.js\":\"c01ae2df8ff43dce\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/referenceLayout.js\":\"82d025c06737a5d4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/useBlockRefAncestors.js\":\"43cd78cd0e0272d8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockGutter.js\":\"5c8c485e3832cd77\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockInfoDialog.js\":\"467defc5b4e43952\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockReadText.js\":\"e948534bfd22622e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockTypeBlockRenderer.js\":\"a52c644838aa402f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BulletHoverCard.js\":\"a19f61765127eb6f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorContentRenderer.js\":\"16d92e17114b6140\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"4a25866258a6f9e5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ColumnResizeHandles.js\":\"7c8e9e8078d582ac\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f08f357979207dae\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/DefaultBlockRenderer.js\":\"67753515bff21d4c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/LayoutRenderer.js\":\"ffcbe81384dabe7d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MarkdownContentRenderer.js\":\"eb65636d3fba1165\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MissingDataRenderer.js\":\"e6d7a8519f91b51c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PanelRenderer.js\":\"08815933439a18df\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PropertySchemaBlockRenderer.js\":\"252bd12c775a651a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/TopLevelRenderer.js\":\"294ba6154ff148e2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockGutterMode.js\":\"d8078f5761016c43\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockTitleText.js\":\"201d04878d57ef4e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/fieldCreationKeydown.js\":\"b12ddac47ecf51b2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/layoutRootContext.js\":\"aa616eae9d47eb3f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/TypeChip.js\":\"40f525be389cd1a5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/chipStyle.js\":\"90e4d246bee98b77\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/anchored-floating.js\":\"f61f921984fb360d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/button.js\":\"5fec9fb41ed9a624\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/card.js\":\"33f86a5d2c4e8c79\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/checkbox.js\":\"195d44de1f8c90f0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/collapsible.js\":\"0431275c219b7a0c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/command.js\":\"17a00ddc8891a576\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/context-menu.js\":\"3aa262c595bc061e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dialog.js\":\"3738edc0c8d2fc34\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dropdown-menu.js\":\"178703985704c143\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/floating-listbox.js\":\"3dd9c2f7c3d4db0d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/index.js\":\"8b0b3c97195dd52c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/input.js\":\"885462be9652c228\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/kbd.js\":\"cbe9efd8e042a374\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/label.js\":\"62bcc4667076e73e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/textarea.js\":\"7e0047e82f9db3d5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/useEditModeYieldKeepalive.js\":\"a2ae7ef6f5593894\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/BootFallback.js\":\"d5e435e716056c57\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/FocusedRowLazyMount.js\":\"6419ea3071fc4f6e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LazyViewportMount.js\":\"29841b1f4dda5e4d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LocalDbCorruptionFallback.js\":\"3f1aa3920abf29b2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/error.js\":\"9a7f8ef5265d9690\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/lazyMountRegistry.js\":\"b9c37c07c28e1082\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/suspense.js\":\"de676b630c2c8546\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/CreateWorkspaceDialog.js\":\"cb70ad29c7f3d4af\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/PendingInvitations.js\":\"028499e4a34fa107\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/SyncProgress.js\":\"d08ee537cc545ca4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/UnlockProgress.js\":\"b384146739985ae2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceKeyGate.js\":\"7c21e62fdeb49050\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSettingsDialog.js\":\"4edfb08fb0576f61\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSwitcher.js\":\"4a116e193bb60323\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSyncGate.js\":\"98bc6c2fc13430f5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlow.js\":\"dd3c1f9520ffe655\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlowHost.js\":\"3b98371a26703588\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/EncryptionSection.js\":\"6f08b6be5ef2234c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/attachmentPrompts.js\":\"830f69d23ea88c27\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/bundleFolderPrompts.js\":\"88e641903793601c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowDeps.js\":\"80f3b3e16037efac\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowStore.js\":\"400d89c20d28947d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/flowUi.js\":\"cb9912cfae2b06b2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/useConversionRun.js\":\"f58f1df9a49b6f04\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/keyUi.js\":\"7287fdfaa374a00b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnKeyLoss.js\":\"066972c5a8f1b496\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnServerE2ee.js\":\"091f2608a58fac21\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/workspaceUnlocked.js\":\"ce146ea3458d133a\",\"/knowledge-medium/pr-preview/pr-1919/src/context/backgroundSubtree.js\":\"42cd30560d364b56\",\"/knowledge-medium/pr-preview/pr-1919/src/context/block.js\":\"4ebbc9bfde71d66d\",\"/knowledge-medium/pr-preview/pr-1919/src/context/layoutWsContext.js\":\"ce7589c037f0a3c4\",\"/knowledge-medium/pr-preview/pr-1919/src/context/propertyDisplay.js\":\"d9e77630f4abf112\",\"/knowledge-medium/pr-preview/pr-1919/src/context/repo.js\":\"ee9da75ac5d4db95\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasClaim.js\":\"ddd25b1b80f8a038\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasSeatNamespace.js\":\"01c67b56eda1f5e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockData.js\":\"aa9bf5adf3f2b6a0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockType.js\":\"f98eea5208b33034\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/changeScope.js\":\"4b33171c53d8225d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/codecs.js\":\"74ed33bb279604a6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/derivedData.js\":\"d7c7dc59d7313854\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/errors.js\":\"b370f843f3c30d63\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/events.js\":\"8ef66414f1925ca3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/handle.js\":\"0d6626b27fd60415\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/index.js\":\"37013b1346647301\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/mutator.js\":\"89cb7058af8d51ef\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/processor.js\":\"39567fd8cefc8f40\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/propertySchema.js\":\"90e4c9476a3de7da\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/query.js\":\"6208107f6b15ea7e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/sameTxProcessor.js\":\"d975aff25730e624\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/schema.js\":\"0d6626b27fd60415\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/tx.js\":\"0d6626b27fd60415\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/typedBlockQuery.js\":\"8c6238a4e13fd102\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/user.js\":\"dfe69e7a5a31203b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresetCore.js\":\"3f9af3aeabcf0e34\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresets.js\":\"fabb528831e9faa4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/attachmentCleanerIOVerb.js\":\"14032de0a12bc0f1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/block.js\":\"a3c1e5341e18f722\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockCache.js\":\"8030d0dc4e5a8c3d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockId.js\":\"7587c8f2da8a46e4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockLiveness.js\":\"ca3d33df381b6706\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockMerge.js\":\"bde10dce9689ef36\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockSchema.js\":\"bc0e5871ce18da4c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypeLookup.js\":\"42639886131a19f9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypes.js\":\"ce63c951b57e67df\",\"/knowledge-medium/pr-preview/pr-1919/src/data/childrenView.js\":\"74e9bfd38e07de5c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/clientContext.js\":\"e86af02de862f03e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/dbFileSiblings.js\":\"797608f63bf27cda\",\"/knowledge-medium/pr-preview/pr-1919/src/data/definitionSeeds.js\":\"29ed20e08dedfb37\",\"/knowledge-medium/pr-preview/pr-1919/src/data/derivedIds.js\":\"bc2c9f366d2aea96\",\"/knowledge-medium/pr-preview/pr-1919/src/data/drawnSubtree.js\":\"c08146bc9ec26079\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facetBridge.js\":\"10fae739b7a313bc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facets.js\":\"608d57efcc1755de\",\"/knowledge-medium/pr-preview/pr-1919/src/data/globalState.js\":\"9c360323c79432fb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/aliasClaimRederiveProcessor.js\":\"950b47b8859a40c8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/ancestorBatch.js\":\"15d228cc3e1e6fa0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/blockTypeTypeifyProcessor.js\":\"9535eed31ea95f59\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/clientSchema.js\":\"ef11434ca8e5030b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/commitPipeline.js\":\"056bde870c6e7998\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/devAssertions.js\":\"1c3482cb2a9bd15a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/firstSync.js\":\"a513616e4494fd80\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/freshInitialLoad.js\":\"4610fe004fffd8f2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/graphBackfillClaim.js\":\"36e52506628b702b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/handleStore.js\":\"48a8293d6fd79931\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/idleMarkerJobs.js\":\"0be6cf276e498560\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initialDownload.js\":\"526eeb7e34f1db23\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initializeClientDatabase.js\":\"1716ecd59d342f32\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/jsonCanonical.js\":\"516632404d093d63\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelInvalidation.js\":\"cf0b3a75009bf3ac\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelProcessors.js\":\"723be4c1f616a884\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelQueries.js\":\"13f9ec0386448277\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/mergeTypeMembershipProcessor.js\":\"18bfd24069ba3823\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/normalizeReferencesProcessor.js\":\"7437780335cde62c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/poolInstrumentation.js\":\"ba2dfc30cc71508e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/processorRunner.js\":\"6eee60602796229e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyCellBackfill.js\":\"238d902e98d172d5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildMint.js\":\"a580ab58c00f691b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildrenProcessor.js\":\"49505548ee16d39d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b6939f18ef220432\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionSynthesis.js\":\"88883a3471d85f23\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyKeyScan.js\":\"6f2252a76af06aa8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertySchemaResolution.js\":\"89252e34abf1ca64\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyValueEdits.js\":\"d1c2d8ad608ca7fb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/raiseProtocol.js\":\"d74316b772c620cf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/readBatch.js\":\"bd65190ed3bade54\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/refProjection.js\":\"23f58e8f007024c6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetLookups.js\":\"60a36c2faa414af0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetProcessor.js\":\"e72b91d2690c4218\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/replayMerge.js\":\"80d506fa20dbebab\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/sqlBinds.js\":\"2d4199ac528248a6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"527d72c69172e609\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/arrivalProcessors.js\":\"2585c17f11f2e143\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/invalidate.js\":\"23a36ab5bafaa3f3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/materialize.js\":\"ec22b363a1d7d28a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/observer.js\":\"d318d546752bf9f6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/reconcile.js\":\"f0ad88d804f80109\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/timingMetrics.js\":\"2e57f9095c56af7c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/treeQueries.js\":\"7f8b9602023766d8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txEngine.js\":\"482e1a59d7b85a13\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txSnapshots.js\":\"444dd99416ffe884\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/typedBlockQuery.js\":\"20847564f8ecf1f6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/undoManager.js\":\"3bdfa590ebb1d45f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/invalidation.js\":\"115412510ee9673a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelDataExtension.js\":\"79449d1fad8ac2c8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelPage.js\":\"80d911645d9766a4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelValuePresetCores.js\":\"ec2cd6f19b818bb3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbCorruptionSignal.js\":\"e2cab243e7c7c880\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbStorage.js\":\"71fe6e9fa3d8b2dc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbVfs.js\":\"8dd48858f0c062ca\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localSchema.js\":\"0307626f4dcec6ed\",\"/knowledge-medium/pr-preview/pr-1919/src/data/maintenance.js\":\"7bbf15a3c4079a42\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mergeProperties.js\":\"5834bd9ae677c1bb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/metricsConsoleHook.js\":\"d703ef63c2e8839b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/migrationsPage.js\":\"bb270febb85f6104\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mutators.js\":\"e87f93a88bbdc9c9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKey.js\":\"5824b7e0aeca366b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKeyPlacement.js\":\"887f66f40d017a06\",\"/knowledge-medium/pr-preview/pr-1919/src/data/outlineSurface.js\":\"252c9ad65aa6bc20\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingEditorContent.js\":\"03227145d733b881\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingUploadsSql.js\":\"25569e22588f4673\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pluginStateExtensions.js\":\"a496eebe53f6a70c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/powerSyncLogger.js\":\"ba3801a75d38c61b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/projectorRuntime.js\":\"6c0219994ebfe7c5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/properties.js\":\"99cd15fe44a76cbc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertiesPage.js\":\"cb2ec246d5c4145c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyChildren.js\":\"f3b51b41477cb8aa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionFanout.js\":\"ca4a8b18b86b82d0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionMetadata.js\":\"29d68420942ecf08\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionRegistry.js\":\"d340234bc694e24e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDisplayMode.js\":\"75cf1f327739c85d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyRowCreation.js\":\"cf697c2c12358865\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySchemaCreation.js\":\"4a167f47cc07423a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySeeds.js\":\"f092923dbb10d7be\",\"/knowledge-medium/pr-preview/pr-1919/src/data/recentsPage.js\":\"4d8561ec012cb912\",\"/knowledge-medium/pr-preview/pr-1919/src/data/refTargetComparableProperty.js\":\"0991fdaa979e7312\",\"/knowledge-medium/pr-preview/pr-1919/src/data/referenceBlock.js\":\"27d4d09e5a0d0229\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rejectedUploads.js\":\"681b11b12107d02b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/releasePowerSyncConnection.js\":\"981556f1ff047010\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repo.js\":\"c89c4600f67cbf42\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repoProvider.js\":\"e1e8dabcf72fa1c0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rowProperty.js\":\"d5c91c2e03cd98e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/searchFilter.js\":\"56d5c4182dd2f9f0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/seedIdentityLedger.js\":\"a1072f7b8a36f9f0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/stateBlocks.js\":\"3517e64a256c4e01\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralEditPolicy.js\":\"31ca495eadb75c34\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralInsert.js\":\"15517de67fb5c343\",\"/knowledge-medium/pr-preview/pr-1919/src/data/subtreeDelete.js\":\"a2ef644a2f9b9ddb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncStreamLock.js\":\"2a4ec817d56bdb65\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableSqlRecognizer.js\":\"e3921b53e6e9940f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableWriteGuard.js\":\"7041005e28239e60\",\"/knowledge-medium/pr-preview/pr-1919/src/data/targets.js\":\"cfca0d9b6f04b323\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeColors.js\":\"70715583b69d8108\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionMetadata.js\":\"7d05b8711ebf4371\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionRegistry.js\":\"b1b2495af76ae66e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeExtraction.js\":\"cf76dc9543851ef6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeInitialValues.js\":\"3c852edc3618a9e6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typePropertyGroups.js\":\"023863778360c8fc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeSeeds.js\":\"67de5a56cefa45f6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeTagger.js\":\"9f2d150e83545c05\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typedRecords.js\":\"1b2f178c48fc2829\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typesPage.js\":\"138acb6f1ba93c08\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userPrefs.js\":\"9a2e20a43af31d23\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userSchemasService.js\":\"dafcfd8cd7c21f11\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userTypesService.js\":\"6015e9e1fa8c2e41\",\"/knowledge-medium/pr-preview/pr-1919/src/data/valuePresetRegistry.js\":\"397bc10e1b22b1a4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/visibleChildren.js\":\"9ad1e6171aa25d5e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceConversion.js\":\"03ec13389246e2ce\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceFirstSync.js\":\"0f451223dc2dc7f1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceIdNamespace.js\":\"bc974e8a09caf6f4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceSchema.js\":\"6a2f86cf568bf7f2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaces.js\":\"c1dcfefda5fdce32\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadLog.js\":\"b42a7b47f2c0f7cd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/BlockPasteShellDecorator.js\":\"f08dbb6fe3f2e173\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/atTrigger.js\":\"3574defe1fdc8962\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/autocomplete.js\":\"e1c900a82239e4bd\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/codeMirrorExtensions.js\":\"7120ee8000c6f2ea\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/contentFlush.js\":\"0054ab36c90b09ec\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/defaultInteractions.js\":\"ce3fbb903565aebd\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/editSettleSignal.js\":\"9127e5e30a3296f5\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/insertImage.js\":\"03be29d06bf6d1f0\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceCompletionRange.js\":\"80fb20e59be9d929\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceTargetTypes.js\":\"b017819fa81ad3c5\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/syntaxContext.js\":\"2046d6e73fd05543\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/triggerMatch.js\":\"e22e2131cb51a587\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/AppRuntimeProvider.js\":\"53645d54006bf085\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/BlockFocusShellDecorator.js\":\"c7f000cc1370f47c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/ExtensionRenderBoundary.js\":\"337cb42049268432\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/PanelContentRecovery.js\":\"d219d51a6ff0a0ad\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/apiCatalog.js\":\"001729ca325893ae\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/appRuntimeController.js\":\"bc6868df1f8ff662\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/approveExtensionHere.js\":\"e62e319dd64f5fcf\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/armedCutAppMount.js\":\"5d586943a3ca5cab\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/batchableKeyedStore.js\":\"09c87f55d6f1f0c1\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockInteraction.js\":\"18a14768a52dc1c3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockSelectionAction.js\":\"fdfa158d9e282874\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compileExtensionModule.js\":\"c286248162bdf4d6\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compiledModuleCache.js\":\"144ca371b8b92cdd\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/continuousGestures.js\":\"46e82a61d11616d3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/core.js\":\"d136309978baaf72\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/defaultRenderers.js\":\"ab1d925355120131\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/definitionFanoutAppMount.js\":\"aed2f4623355ca09\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dialogAppMount.js\":\"ba04874ace7ca315\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensionSeeds.js\":\"2a021f2eb89ad6c2\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensions.js\":\"1bfd1b1bf7c2c706\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/exampleExtensions.js\":\"5249637cac1ff693\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionApprovalStatus.js\":\"74e42a1cd1563477\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionImportPolicy.js\":\"237f05d9a3a2b06c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrorToast.js\":\"d7b7fe36e41bb0ff\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrors.js\":\"56e03dcf40c79018\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLookup.js\":\"f48b39d1639e7193\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionToggles.js\":\"24bf5da43373beba\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionUtilitiesCss.js\":\"0903143e1f7412ef\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/kernelPageDeletionGuard.js\":\"feddd95f48188e99\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/liveRuntime.js\":\"4d084e8ddf12aa24\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/normalizeExtensionSource.js\":\"0a629f7c2be7dba7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/openExtensionsSettings.js\":\"13712d35c9d6c13f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/overridesCache.js\":\"62e3f860cc6664de\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/pluginIds.js\":\"fd584dca3c05ee51\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/processorRejectionToast.js\":\"1732b1eb324a23ba\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeActions.js\":\"d16f16ca84631591\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeContext.js\":\"dcbdbce5b7933b65\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticAppExtensions.js\":\"be6b8e3f87da9a8c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticDataExtensions.js\":\"394362391e8297bb\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/toastAppMount.js\":\"6be0b7c505c80b20\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/transpileExtension.js\":\"284c03f3bdd405db\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useOverrides.js\":\"89f6037fa304735a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useShortcutSurfaceActivations.js\":\"88c0b84e83a5500c\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/discoverToggleTree.js\":\"c744ca89541d265e\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/facet.js\":\"fed396375a3ac260\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/resolveAppRuntime.js\":\"bc38f85590c101cf\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/runtimeEvents.js\":\"df599639f0e8869d\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/togglable.js\":\"1d0b80d4604db4d1\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/variantFacet.js\":\"69e9eaf053dbe40f\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/verbFacet.js\":\"d2fca25b85b3db3c\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/block.js\":\"b8e81fc73b592bcb\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/focusedChild.js\":\"a520b64fbe9d2e45\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/propertySchemas.js\":\"2944713427d7aa07\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/typeRegistry.js\":\"64af3ca647e63585\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAncestorCrumbs.js\":\"5fa2eb28e4c33d6c\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAutocompleteListbox.js\":\"071c44a80d64f947\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedSearch.js\":\"bd8f048c37e12ae1\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedValue.js\":\"5f8d57df4cc83493\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useFacetValue.js\":\"87f0bc7d87454d1b\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsFocalRender.js\":\"0769cc90fe80c7c0\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsReadOnly.js\":\"68cc82e683c17e42\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMaterializeBacklog.js\":\"4e41b416dcde0cca\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMinuteClock.js\":\"d23b81935af26a7f\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePanelLayoutProjection.js\":\"89521da8e85347f5\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePendingInvitations.js\":\"caec8bf1b7a911bd\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRendererRegistry.js\":\"d8f1e33140a5d2cb\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRetainedFieldRows.js\":\"b5d24ad1017c6817\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useWorkspaces.js\":\"4364cd11313e0787\",\"/knowledge-medium/pr-preview/pr-1919/src/lib/utils.js\":\"4e81706fca7f5f9f\",\"/knowledge-medium/pr-preview/pr-1919/src/main.js\":\"4f585fcf08bb3d4b\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/MarkdownImage.js\":\"1478cebbced467c9\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/blockSeparators.js\":\"02f72f5058fead7b\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/context.js\":\"f92f7e9f58e88e1e\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/defaultMarkdownExtension.js\":\"ceec953d052f5f22\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/extensions.js\":\"c88013393e260a66\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/renderMarkdownHtml.js\":\"474860359213b942\",\"/knowledge-medium/pr-preview/pr-1919/src/minimal-editor.js\":\"496011e8453ea72a\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/armedCut.js\":\"0ff1668b8ef1ee93\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/captureMediaVerb.js\":\"8e5772bebf5d87c8\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/clipboard.js\":\"24586ceeae1b6966\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/decision.js\":\"cd056e88d0498090\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/operations.js\":\"4d81781c7086ac57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/AccountHeaderItem.js\":\"2c2fab681d3dc830\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/index.js\":\"3f6778b6e7840fa7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"75ed39fcb5b15054\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askAgent.js\":\"1b3aab1bb66ee187\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askedStore.js\":\"edfa4f1492acd8b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"776f63bbdbc4d4d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/chipState.js\":\"19d5a912134d35bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/dataExtension.js\":\"ec357051a14d15ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/index.js\":\"6d97e9a1355f1ca9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"237ea5259b625db6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/schema.js\":\"9f72901820fa467e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/AgentTokensDialog.js\":\"791a118d14dfb6ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/BridgePairingDialog.js\":\"13f7311b5de7769b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/addMedia.js\":\"88595a90e53c2807\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/backlinks.js\":\"9d01045f9cc40f72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/block.js\":\"f4e6a4a9b20b29f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/context.js\":\"4e94417212573555\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/displayIds.js\":\"db756ab778520582\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/index.js\":\"b52e7af965e467a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/outline.js\":\"fa3956cf3ef8cdce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/properties.js\":\"e375a524e889d99f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/refs.js\":\"fb19ca0bccd05b46\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3a8c8d0d910b696b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/search.js\":\"56e7f953b9cfd57a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/shared.js\":\"cfb3d8d64c3cef77\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"454bd8dd52208a94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/text.js\":\"d545c7fec26e17d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentWrites.js\":\"3b453e6624398b5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/authoringCatalog.js\":\"fc2ee47fd1a8e012\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/blockRefTargets.js\":\"6b9742cd5e93a064\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridge.js\":\"a14365b1735d180e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridgeLoop.js\":\"ebab062bbe6c03fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/changeHistory.js\":\"b360fcd16e9ba6a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commands.js\":\"f02125e0bde4953d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commentsCommands.js\":\"6cacef7ff5b76950\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataExtension.js\":\"5bc05717713a4881\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataModelGuide.js\":\"1448fda4d1d73cc5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dayPropertyInputs.js\":\"1225822ed1930afc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/describeRuntime.js\":\"4cca1d26dac5054a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/extensionLint.js\":\"19e4e7d17fa7f37e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/grainAudit.js\":\"b51667d70da92b38\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/healthCommand.js\":\"889a280ce60262e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/index.js\":\"9fbdb58a3999e812\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/presetIdentity.js\":\"82ea108ee6123657\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d8fc7c7f4be1ed97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/readMedia.js\":\"20b1f794837d0412\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/schema.js\":\"95f037dfb28a2cb5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/serialization.js\":\"c5b32da7461e154b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/targets.js\":\"014dacbf43374924\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/tokens.js\":\"1148eb39ee6a3873\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/watchEvents.js\":\"3274e8dd637c85f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/workspaceGuard.js\":\"41a34295ac0afa9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/writeCommands.js\":\"8d225e94dee5ced2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/AliasCollisionToast.js\":\"b6ef072a105f2f49\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/DuplicateNameBanner.js\":\"4767880dc9e2b9d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/collisionMerge.js\":\"48ec9fff367841e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/dataExtension.js\":\"3c2ec5ead66ff75c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/index.js\":\"f2d329013a626a3e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/mergeCollisionAction.js\":\"75c0e803883af3dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/pageStyling.js\":\"dde751e1a8d62b22\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/rejectionToast.js\":\"71786233c43f5127\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/syncProcessor.js\":\"b50428aa1e1c4baa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/actions.js\":\"ed2b9941d669d471\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/addComment.js\":\"a835e2b96ff83b45\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchor.js\":\"4ac5402c1d6a662b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchorState.js\":\"88222100a0046171\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/commentLinks.js\":\"cf487eb0e43b0c9d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/confirmThreadDeletion.js\":\"49dea88d956474af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/container.js\":\"5edb1897e671d5d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/dataExtension.js\":\"17461944626d03a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/deleteComment.js\":\"6da8e026862ca80a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/highlights.js\":\"a2737ac3f7675c7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/index.js\":\"157efe3daeaad696\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/linkedCommentsPill.js\":\"a3c4035335500ad9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/margin.js\":\"0ea7374a3c9914d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginAnchorLinks.js\":\"21cefed0d570fa47\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginSchema.js\":\"fedfc08f4a61cc83\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/newComment.js\":\"1a199cbc7e581f27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ownThreadPicker.js\":\"32fa26ad9ab5981e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/placement.js\":\"37924267cbd5bae8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/queries.js\":\"47f6b57a36630386\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotePosition.js\":\"14d720c99f4f2e90\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedIn.js\":\"92e7e2648616dfdc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedRange.js\":\"272edf4f07806d36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/rangeRefs.js\":\"fdcd290ccfff6191\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readHighlights.js\":\"e9820d84ca7ea8d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelection.js\":\"bba1fbbfece6a840\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelectionUi.js\":\"12f4d3a46180f18c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/reanchor.js\":\"0fb3bc5d8cf781de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/schema.js\":\"768dca990b849bc7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scope.js\":\"88a2b8355bce8fd5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scopeThreads.js\":\"1b52ac99beb2d951\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/splitRetarget.js\":\"f99adc567880b9eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestionCard.js\":\"4fda9d0e8ef89037\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestions.js\":\"62e555b45cec989d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaries.js\":\"8a007e8afae72390\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaryBatch.js\":\"12801beaab09d4b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/surface.js\":\"1b5e1b0b865b67de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threadNavigation.js\":\"2d72e3b670a94aad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threads.js\":\"acd0bc6782d83659\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ui.js\":\"56ecb62e21f06ce3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/uiStore.js\":\"15eeaa5aaebfeaa6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/appIntents.js\":\"fbb57773267a5173\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/index.js\":\"de7438e34529fa29\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/index.js\":\"722be0d17d682ca6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/status.js\":\"53cbeeca5a9063cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"b1ffb4e96da39ae5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaBlockRenderer.js\":\"6a5d8072f9b0550a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2ee6956a5fec10f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaUploadReconciler.js\":\"13844dcf21c289e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetDownLane.js\":\"cf34bfba22c32fdc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetResolver.js\":\"0bc1516ecbd9b659\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetUpload.js\":\"b67727122d55f266\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/attachmentCleanerIO.js\":\"e4c0615863f4b2ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/supabaseAuditIO.js\":\"cf9a2a409615a30f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/blobStore.js\":\"7f37f340ef61be5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/browserMedia.js\":\"4d620c66b10a9473\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/byteStore.js\":\"ff540d07f24fcacb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanerIO.js\":\"14e4ff8992b9c719\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanupAttachments.js\":\"6f8c09de23f33a2c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/dataExtension.js\":\"ebcda6e537206fb5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/downLane.js\":\"13ad708948c00b7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/index.js\":\"286166be403346ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/insertImageContribution.js\":\"a47ff4ecd8f07d0a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneArming.js\":\"6395485fcdc651a9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneLock.js\":\"263af4a2c13270af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaBlock.js\":\"af92a237b62e7f4e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaCapture.js\":\"3ba119f07d082003\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaLanes.js\":\"50f915ced996c045\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewers.js\":\"8781d8991a228f90\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewersFacet.js\":\"52a7f8c9adf98d29\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/pasteCapture.js\":\"5d9bda0ae976a140\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/resolver.js\":\"2d57b6fe43604a4f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/retryUploadsAction.js\":\"eb92bdc7853ba2e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/storagePaths.js\":\"2d77259b2655931f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadDrain.js\":\"ed0910e1d6556a80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadLaneStatus.js\":\"b8ff0c5f8c33323e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadReconcile.js\":\"cc7bd4cd8522ec70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadRecovery.js\":\"a4f6090ca12ef1ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadStore.js\":\"c4f065d3d44f136f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/useAssetObjectUrl.js\":\"a583be79fa836d31\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ec0fa99cd2b442b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c03ee6e14321f524\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/facet.js\":\"087a3440fd35be62\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/index.js\":\"ff1167f6f85ba937\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/prop.js\":\"58474cde75f9c0a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinkFilters.js\":\"146a5331fca65645\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9be81a2bdb4dd5a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BlockEntry.js\":\"469bb91350bca2be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/LinkedReferences.js\":\"9a358a993e4cdc54\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"d49f74aea8e3ea20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dailyNoteDefaults.js\":\"c265daceed5bb1af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dataExtension.js\":\"8c9506f566812f8e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/edgeExclusions.js\":\"72095a348c873eef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/filterProperty.js\":\"9afa1f22b05267bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/index.js\":\"69d5a295081dd9f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"6967d4f7be83e1ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/applies.js\":\"d9bb765a53e33574\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/countQuery.js\":\"87bb97a7397e6b36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/expansionStore.js\":\"068bb490724bc32e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/index.js\":\"9616224ba48cbe19\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"8c3947d38525d781\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/presentationInvalidation.js\":\"47ac43d96546b95a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyEditorOverride.js\":\"b8c09a83bb6611b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyFilter.js\":\"2ef902a53a16c5e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/query.js\":\"a5b5e2e26c000193\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/resolveFilter.js\":\"c53caeeffe0e9781\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sourceBatch.js\":\"3bc25157de9e4bb4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sources.js\":\"d062dcf98bc350b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useBacklinks.js\":\"bc9fba7ee570657a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"68a6cc80b7732737\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayCelebration.js\":\"b25f65a16a9ab25d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayOverlay.js\":\"fe38538285903caf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/gate.js\":\"470b7b589db5e675\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/index.js\":\"8fa718074cd1a055\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/wolfTheme.js\":\"5dac3f0845576cea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/BlockDragLayer.js\":\"53862cdc400db4fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dragController.js\":\"8aff99dc9da0d57f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dropTarget.js\":\"a6a901a2e892ca73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/index.js\":\"e44d1a139b14ac66\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/projection.js\":\"6b22dd5b07a33e07\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/BlockMetaCard.js\":\"71e1298478af7f6c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/index.js\":\"81479ff3c3f9ad71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/AddTagDialog.js\":\"21743dc2a0c294d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"25e1610d866da923\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/TagNameIssueHint.js\":\"6de85f81868412f6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/addTagAction.js\":\"5f668525d9c1afdd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/appendTag.js\":\"bc45a99d7634f336\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/config.js\":\"669038758558678d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/dataExtension.js\":\"2b3d04168851a1f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/index.js\":\"ae1d7cf1d8275bf3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/propertyEditorOverride.js\":\"118a90732796877b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8f2e78cdfb13593c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"c657573138b4d915\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/Breadcrumbs.js\":\"3eca20cb52374e95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"01f8844c1754068b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"eb1314f12d373306\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/index.js\":\"7d3dae1762e990ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"ed4bcfcba0762565\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/CharacterCountItem.js\":\"121adda2834612cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/ProfilePropertyEditor.js\":\"4f7764ef845f20fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/actions.js\":\"07ff6250a8bf6d03\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/blockType.js\":\"a6dcb1eef3c23ccb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/charCount.js\":\"c38e1e182aabe17e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/dataExtension.js\":\"3bd088f67fabfc2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/index.js\":\"fa1423a97bd0b2aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/profiles.js\":\"faaa6da545951845\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/properties.js\":\"faa0d694bba69343\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/subtree.js\":\"fbcfa26af4af06c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/textCounts.js\":\"987448934074f1bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/colemak-keybindings/index.js\":\"e30fcfcaaa8ab28b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/CommandPalette.js\":\"5f920bd0bf5bc927\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/HeaderItem.js\":\"3219905a3d1d1a17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/context.js\":\"45a096f07911273d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/index.js\":\"3cb4c97101f835bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/selection.js\":\"d75ed4994dbdb708\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/toggleStore.js\":\"c1454c40b2069069\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/useCommandPaletteActions.js\":\"5ddd6b819c68440f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ContributorBadges.js\":\"4acd356b1eb1abce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ProfilePicture.js\":\"11c491bb48d9fc98\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/author.js\":\"119c14af908896b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/codeMirrorExtensions.js\":\"22c211c456636527\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/dataExtension.js\":\"3eee916bad9f0629\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/index.js\":\"b47ab1a8d28e2555\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/mentionAutocomplete.js\":\"95a086bfd00fb181\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/processor.js\":\"8ba493bbee53bb6e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/profiles.js\":\"d3c2ffda8d097490\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/queries.js\":\"d97af3d5a25bcd64\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/schema.js\":\"93b95e11dd8bfa05\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/useCommentAuthor.js\":\"3b373b255ab3e9f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"57ada8162e59825a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/followOrigin.js\":\"7b8d894414085027\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/index.js\":\"da4fb21d7f93ecbf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e34ecab4152b9a79\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"e64cc24554f35845\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/CalendarGrid.js\":\"47cc0ae498229531\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DailyNotePicker.js\":\"c288708ec8fa5c20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"e1ccc1de8c66497e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateNavDecorator.js\":\"0589312bf0176910\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateScrubOverlay.js\":\"cc224179729d1cc9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayPropertyControl.js\":\"18d589c80a4583b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayValueReferenceControl.js\":\"aa037005c782def9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/HeaderItem.js\":\"63109c17b9de038c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/ReschedulePicker.js\":\"333c4e9d1c1645d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/SpreadDatesDialog.js\":\"0898892bfcd4129a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/actions.js\":\"52969ddee1b1d45d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/blockDateAdapter.js\":\"84a8f3f7e946fe24\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/calendar.js\":\"82582e8578e62ded\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dailyNotes.js\":\"75bc3fe991246f5c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dataExtension.js\":\"2bf10b1c88a79281\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubActions.js\":\"7469a8993d719979\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGesture.js\":\"4cc7550104e2b463\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGestureActions.js\":\"adb63140b131c86d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubRecognizer.js\":\"84fd55ed8c7e3df0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayProperty.js\":\"35174995ab9e7105\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"6384b614924ab3fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/deletionGuard.js\":\"60621f8365b56197\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dueQuery.js\":\"7a2e5850e4163d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/index.js\":\"4faa39a9f9b79c8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/landing.js\":\"164bb27071512e51\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/localSchema.js\":\"a203c7e2f6617d03\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/referenceDateAdapter.js\":\"cfcf45c4ea74a159\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/rescheduleAction.js\":\"80754f90e33f4c3b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/schema.js\":\"cffda7284547b534\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadBlockDates.js\":\"2d16e21695fb5860\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadDatesAction.js\":\"315845747887953e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/today.js\":\"b0a138c38d2d88f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"1792020fb379573d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ce130b9c48c30529\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/audit.js\":\"293d35970aa17311\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditAction.js\":\"19256896b504cb77\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditRanges.js\":\"ca7026ccc9a3d8e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/diagnosticsSource.js\":\"cae1a95695ab2977\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/divergenceScan.js\":\"7208278beabedc0f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/index.js\":\"ba0e5441ac660b85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/propertyChildrenChecks.js\":\"a67062204044fcde\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/referencesMirror.js\":\"cc93d3e28cd2db7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/rowJson.js\":\"49c15ab1f6022a14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/schedule.js\":\"d0a5e39f285804a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/store.js\":\"3ed04487695c79f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/action.js\":\"7b9e0402937592d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/index.js\":\"3b35ee89a5534573\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/plugin.js\":\"9e0344504b1c7bd1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b55e3d65030d18a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/actions.js\":\"d8934e8098c6936d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/changeMarker.js\":\"4804c5a41250505e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/diagnostics.js\":\"9845782cd1515b65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/fileSystemAccess.js\":\"d839ad159a60c4e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/filenames.js\":\"9b84946e88990b11\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/index.js\":\"12e2d5ed67fdfc37\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/mirror.js\":\"432793bb1f395541\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runLock.js\":\"3d951ed59a31bb7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runtimeHealth.js\":\"6bf369a8dd3d0968\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/schedule.js\":\"b9efdce29b6a7d02\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/store.js\":\"2cb30840ef982ef4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/index.js\":\"8294f30a0f3dc635\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/themes.js\":\"e0cd5d38c7578d0f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/facet.js\":\"2a05f1ebff84d850\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/useDiagnostics.js\":\"225ea4a01c9d60ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/dismissals.js\":\"f4d76d8d6239777e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/index.js\":\"673938a56a001efc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/status.js\":\"1429742510894214\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/store.js\":\"202c7a4b29826b94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"04f176a8aaace4cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsSettings.js\":\"8eb640f9a0b927f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/actions.js\":\"a282cdb3eba7f48b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/config.js\":\"4c68b773d100a69b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/dataExtension.js\":\"94eb0fd80596de13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/effect.js\":\"06d4e96aa56cb1ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/index.js\":\"f198cb5eee0047d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/propertyEditorOverride.js\":\"867a99c002348575\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/useToggleTree.js\":\"aa833bd3649c21e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/ExtractTypeDialog.js\":\"11c563e72c87a820\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"6f4e590b80fde89f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/PropertyShapePicker.js\":\"1405c34c5b457312\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/action.js\":\"d28bcb8c10702b6c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/index.js\":\"db76f711983aa430\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/FindReplaceDialog.js\":\"6c465e1da2219ee9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/HeaderItem.js\":\"b82e664df7460dfe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/dataExtension.js\":\"82ea5502ba4fb728\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/index.js\":\"3253fbfc2836953c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/search.js\":\"b5fc0a9aeec0c038\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/toggleStore.js\":\"5dbed8c1a38a476a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/LocationPropertyEditor.js\":\"4b0b4ed10ed5c377\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/MapView.js\":\"07aa14dadce4b1fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/blockTypes.js\":\"e501712e1f70c5fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/codeMirrorExtensions.js\":\"18d81df9c58bbf6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/createOrFindPlace.js\":\"1da7847296f76f3c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/currentLocation.js\":\"64e79ac051d343e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/dataExtension.js\":\"40da41a850f18f85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/geoContentDecorator.js\":\"cf194cd2cd75b6a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/googlePlacesClient.js\":\"b6dc0f08de259704\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/index.js\":\"52e63e4752203a43\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/locationsPage.js\":\"d6c474e6cb249e53\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/mapViewport.js\":\"423dd387b307057a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/pickCurrentLocation.js\":\"9bbd28e7e24f3628\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeAutocomplete.js\":\"977edbfff4e020e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeNameCollision.js\":\"0ffb2fb47b6f2032\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/properties.js\":\"c05f5b0c6d83fd71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/propertyEditorOverrides.js\":\"7e22320db5f3dd62\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/query.js\":\"1f51cb46f050951a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/usePlaceSearch.js\":\"40c119cbd3b4f699\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"7899708c1c80ef45\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ca3cc44b7181c3a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1839816e254d6e10\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/config.js\":\"87b232d1945befa4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/dataExtension.js\":\"13f4f0c0d8447c3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/facet.js\":\"e9bb78c4c2261e2c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/grouping.js\":\"b7bd48e9d8ce8771\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/index.js\":\"1e5f44ba6b01ab1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"11b0daccb3aab8e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/query.js\":\"dac705881d6057fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/resolveConfig.js\":\"938f60451d346870\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c8167912e4decadd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"96a85074871fcde2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlDocumentContent.js\":\"49f1f3a7b23d1219\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlFrame.js\":\"93ac20886fb815d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/actions.js\":\"4c12e47ee31460b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/blockType.js\":\"e3cccb43b263264a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/confirmRunScripts.js\":\"c19b87c7f14e3457\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/dataExtension.js\":\"9f269e90dd64b467\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameAnnotations.js\":\"7982313c293dc157\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameDocument.js\":\"b10f7ff2dff1dc2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameTheme.js\":\"b85ca424410c4296\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/index.js\":\"e331affe6ec79a34\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/scriptConsent.js\":\"bc410d5a3350de28\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/sourceMap.js\":\"0f59580df9e1f220\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/useDocumentScripts.js\":\"644eadfe6520fa08\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/index.js\":\"3c0f2b2acb71affa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/record.js\":\"24383520da49dbe8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/recordStore.js\":\"361129d1140846f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/responsiveness.js\":\"7891866149fa8e13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/schedule.js\":\"efd66178482cab1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/sessionContext.js\":\"0db60283c6cd73eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"11fb0c2b9da5a87b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6991d791cbe86866\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/actions.js\":\"811616d92475088a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/config.js\":\"93168d72f9d94bd2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/dataExtension.js\":\"e9f0019ab326cc2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/effect.js\":\"b026c5bec0dd4745\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/index.js\":\"dd4ad676b22d7e4e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/keyCapture.js\":\"2581d2a83f9e935d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/overrideStore.js\":\"9ba0f1990f78c943\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"fe3ba3c9771f3154\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/HeaderItem.js\":\"6360df35517e8144\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/LeftSidebar.js\":\"e15135df6f0985dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/actions.js\":\"77b89a4218041e86\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/facet.js\":\"8a657d3a32b94c80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/index.js\":\"f2ec5b2d296bd4c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/shortcuts.js\":\"dff7ff55273148a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/toggleStore.js\":\"35d80d0324ef69ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/MergePicker.js\":\"952581e4a5e85515\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/index.js\":\"50767f18ed2ee4c0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/mergeAction.js\":\"785034dfd6f76d82\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/strategy.js\":\"8412971e547d798e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/Button.js\":\"b0a10747f227ba2d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"3d5b8aa033695fa3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e26ad65e0fc4879f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/facet.js\":\"e9012f9e55eec45e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/index.js\":\"e4dd6c253ecfffeb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"8e69753e21041766\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/actions.js\":\"363a133dccc7e4b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"7359c0bde05ef65c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/facet.js\":\"578520aa931e92a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/index.js\":\"4c5da85f7752f227\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/MoveDestinationPicker.js\":\"0a6515ed5600324c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0b6afa29f35aab37\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/contextMenuItem.js\":\"990ba8bf7ce3f7ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/index.js\":\"a8dcdefe60866e6e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveAction.js\":\"3cdc0d028aed3fb2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveBlocks.js\":\"dbcdb04e05e0ac41\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/selectionAfterMove.js\":\"e34db06d793fb162\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/TutorialBanner.js\":\"90085b44d91acfdf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/action.js\":\"6e2602cc5da2a4eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/bannerDismissal.js\":\"2d719e6a381ebf23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/documents/cheatSheet.js\":\"e16ff6dd7876256b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/index.js\":\"4d70cd6ea81e523c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/keys.js\":\"05b51a37d2b21e87\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/landing.js\":\"05261d9b7b815b40\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/outline.js\":\"7802c980b67f1aca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/seed.js\":\"9f0e069240365e50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/PerfTrendDialog.js\":\"741e4bcbc57d30da\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/analyze.js\":\"5e7c9a34e39334be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/diagnosticsSource.js\":\"7686e43bb387c293\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/index.js\":\"e0e07bd9d8f39ac5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/load.js\":\"9ef10ce104ff8a7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/monitorRun.js\":\"c8632cb7e21a9792\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/schedule.js\":\"9cd248c70ab87932\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/series.js\":\"5e7d32167ed691fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/store.js\":\"c4c3cb383f5703cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/trendAction.js\":\"75a2c1d71d3bb402\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/verdict.js\":\"ae9923a2d9363fb4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/clickToEditAction.js\":\"d5536a29433e6fc2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/index.js\":\"30eb6b77fafbdb89\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/interactions.js\":\"c8f69e0dd9e4d14b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"56a5729bf7978544\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGate.js\":\"5c81a0834de09a86\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGateDialog.js\":\"c629aea8b981ee9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/action.js\":\"6a282d638d9c73b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/index.js\":\"3dbf384bc87d8da6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/localRunMessage.js\":\"fa441781d0ac51a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/plugin.js\":\"688704b17bca2052\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/progressReport.js\":\"80d68f617e6009e8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/sweepProgress.js\":\"f6ca9ae520d6a2a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/FieldRowRenderer.js\":\"c232c0034f85d2db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/ValueRowRenderer.js\":\"b4640346bb9d0716\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/actions.js\":\"2285688753cd5f73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/autocomplete.js\":\"588d453096840afb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/fieldRow.js\":\"4b0d4a4a21dd729c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/index.js\":\"85c2f9347f60d27b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/referenceWarning.js\":\"c2bbfc8da3422e79\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueAutocomplete.js\":\"7634c18f64494401\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueSchema.js\":\"ff3433e4ec502370\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/HeaderItem.js\":\"fe82360400a20d9f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/QuickFind.js\":\"6b1bb07ccbdc2f85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/index.js\":\"1918ba2733bc9e19\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/recents.js\":\"9c5f274b1c78404c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/resultItems.js\":\"4822a318052656cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/selection.js\":\"973ecb009d6fc048\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/toggleStore.js\":\"844b151018680c49\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/HeaderItem.js\":\"1ab156ed9144ec11\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/RecentsPageBlockRenderer.js\":\"0fa46c34404db227\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/grouping.js\":\"ee3b989adbb03c7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/index.js\":\"49c017e07947af3b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/target.js\":\"d31d9272e53b5879\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/codeMirrorExtensions.js\":\"c3affd4f3c8e7ce1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/contentPrefill.js\":\"336ec94c23b92348\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/dataExtension.js\":\"b59568b91c5a3f16\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/index.js\":\"b986996184ba0fcb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"80fa8465404c0c34\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/invalidation.js\":\"97dfc5b30ecd8c0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/localSchema.js\":\"7fd51d95ed47efeb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/index.js\":\"dec35b4bf343f7bc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b91200e5ec895d57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/index.js\":\"e9f15775b17ebe72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/referenceNode.js\":\"bd6119002f2013af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b8123ecb6c792d16\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d18dbc5792b8eb25\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/index.js\":\"81dd5d46f67a6eab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5b42a669ad4dace5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3cf2c69c18479d7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/mergeRetargetProcessor.js\":\"188c62ea94fce304\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/parseFence.js\":\"4da6eb3fdcfe70c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceParser.js\":\"848fd9c75e76163c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceProjection.js\":\"895b5cde84349988\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referencesProcessor.js\":\"2e1ae4f96f87f472\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/renameProcessor.js\":\"71e1dcdaa7188fd0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/spanReplacement.js\":\"082f50a58b2d60f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/htmlToOutline.js\":\"8870fc2977dc707f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/index.js\":\"07ac360eb81e35db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/normalizeClipboardDom.js\":\"4b43b3ef5d84ba72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/pasteDecision.js\":\"f87880de58041dd9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/action.js\":\"a358c3ebb04bb4de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/blockIds.js\":\"fa94e9da12f06556\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/content.js\":\"d55e9b877af68505\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/effect.js\":\"992e6984c8ec992f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/ids.js\":\"59feef03e4f1e869\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/import.js\":\"1014bb6f4db8d635\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/index.js\":\"b3b1762eaeccec35\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plan.js\":\"db70e74122aa2ce7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plugin.js\":\"8a13215719722091\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/promotion.js\":\"be0755cb6f5c3263\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/properties.js\":\"cb51f2679263d9d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/references.js\":\"c91996f0d8f45392\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/report.js\":\"768022f436da1a76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/roamMemo.js\":\"c495526141b8cb58\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/runtime.js\":\"900d10fce2d6d747\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/schemaReconciliation.js\":\"353bfc15294c9e41\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/srsMarkers.js\":\"b1a3b472943bb3a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/todo.js\":\"981dd06cad839549\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/typeCandidates.js\":\"aff47e5595d989f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/types.js\":\"cc6ec72f8108392b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/index.js\":\"9354c6c71d31e418\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/store.js\":\"763764ba705e6c3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/HeaderItem.js\":\"399b9e259b008e89\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"d1f39e25a4dc3ef4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/index.js\":\"07a182196f520376\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/model.js\":\"bdada0088d48f071\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/toggleStore.js\":\"17800877abff57f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/useKeyInspector.js\":\"c5092aece2a45cf9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"2333ccf36f70287d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/ShellDecorator.js\":\"b0af3b80a428c4cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/actions.js\":\"f2d5678bf5b28ca2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/exclusionsFacet.js\":\"9d3b3e417054cb66\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/index.js\":\"59daccf8d6c26a21\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/shell.js\":\"0964c43a923b9697\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/surface.js\":\"4920a65bb031acf2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/walker.js\":\"04f6b60fc7726310\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/RescheduleToast.js\":\"eae212772e66ba7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/dataExtension.js\":\"8a706c4243271671\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/index.js\":\"a91d389873035702\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/indicator.js\":\"20e72b5a0007106a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/moveSrsState.js\":\"e643ed042849a308\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"6ead70eaac2cda47\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/scheduler.js\":\"632741c8fd46b97f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/schema.js\":\"824a7087cf93805f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2c04c4eb058276cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsClipboard.js\":\"02212d6f402576a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"83e6611ccbc7e4a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DailyNoteReviewHint.js\":\"223de7f96bc9e5a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DeckPicker.js\":\"d7b7694a6b021fbe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewControls.js\":\"7c922fa07b54387a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewDeckRenderer.js\":\"b41a9e0e276df661\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewSession.js\":\"09e5626616a8d14d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/actions.js\":\"92cb0782f18f2f11\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/archive.js\":\"51e2f2affccc6ce8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dataExtension.js\":\"ac881d42b68dd20d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/deck.js\":\"321fa0b0619f3470\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dueQuery.js\":\"cfeb3e66962e55d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/gradeDecision.js\":\"036f7a8be56fc58f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/index.js\":\"1fd7131eb341b93a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/keyHints.js\":\"72faf7414403193f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewCardLayout.js\":\"83bf12e7294c3f24\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewProgress.js\":\"c4e48925e24cb463\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/schema.js\":\"0ab4de1db2ce240a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/useDueCards.js\":\"3aa22e4ab2f06a0b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/index.js\":\"4bf34a0c13f783f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/record.js\":\"ab8a8cac5ae17124\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/index.js\":\"15388c726c947dca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/persistenceStatus.js\":\"52c491fea79fed89\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/requestAction.js\":\"bdb950f5f3f7df47\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/TypeChipsDecorator.js\":\"ba2bce1b5693e1c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/codeMirrorExtensions.js\":\"5fec81be7ebe89e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/index.js\":\"704084f8ba771178\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/typeAutocomplete.js\":\"069f1316aacc8ccb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f2823addaf0ee79b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/actions.js\":\"56279b84a1d45354\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/anchor.js\":\"3c732c6530a65e2b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/events.js\":\"d1e8893e3d2ae346\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/gestureActions.js\":\"dd71591f683d8fda\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/index.js\":\"68683605a90d5d54\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"91c3187151aa5615\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/collect.js\":\"2b1ff3d921936c94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/index.js\":\"0ce3183fe7e34d63\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/record.js\":\"0928e13d78b79306\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/RejectionDialog.js\":\"b4bb6a2db0c62099\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e6cc49c2caca8ac3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/index.js\":\"77ef196b8c8b4814\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/model.js\":\"4c7c72895f3a6512\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/queueCounts.js\":\"8a425bc2c654f1b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rejectedHelpers.js\":\"c8b850cd1d74e6ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rematerializeAction.js\":\"9a06c05532e7051a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/useHysteresis.js\":\"439e470272141ed7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/ColumnHeaders.js\":\"2c30be1e236433c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/QueryUi.js\":\"c15dd9e7a4176df8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/TableLayout.js\":\"8e400649418728b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/actions.js\":\"2473d0e7eef3997f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/cellEdits.js\":\"da45a572fb2502f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/childrenViews.js\":\"042a5efc3793393f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/columns.js\":\"510468ee799c7a13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/controller.js\":\"d6ec0d1cb0f2f8ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/convert.js\":\"2c9e2fac26122b7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/dataExtension.js\":\"7bc20aa24db71512\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/index.js\":\"bfb08073e11f6fb1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/keys.js\":\"0a4fdae9daad4026\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/model.js\":\"f89ccda2222ef0b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/QueryText.js\":\"4c085fc325c7339b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/backfill.js\":\"e3392ec7a03c404c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/completion.js\":\"130a196cea1048ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/format.js\":\"bbdb433c7d605554\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/parse.js\":\"2274313ff61a1103\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/queryValue.js\":\"1386c93fbfb03b7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/registrations.js\":\"e85e523a8e5764ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/source.js\":\"abff3ad6375882ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/registry.js\":\"b5426f6dde9e3cf9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowGutter.js\":\"b775f2570c85051e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowVerbs.js\":\"05f6b4bd1473a739\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/schema.js\":\"7d854a874b409dcf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/sort.js\":\"4680eafe0e2b87ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/effect.js\":\"3fd00bbe4f9b6a37\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/index.js\":\"8fc2bfcbb2d95bf6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/theme.js\":\"3630577497e3cd70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/actions.js\":\"e613c9329cef41b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/dataExtension.js\":\"449f0b77054d0046\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/index.js\":\"e7d82f92d693a835\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/schema.js\":\"66cd8f00acee2864\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/TouchSelectionLayer.js\":\"5d717eaf9ff625dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/actions.js\":\"91a26acfe0dfc9ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/defaultItems.js\":\"54935a96115756fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/facet.js\":\"9c01c8fcbac6efb7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/holdRecognizer.js\":\"7c750301efe42d24\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/index.js\":\"38b9b7ebc5f6e725\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/UpdateIndicator.js\":\"ca62ac62714e874a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/index.js\":\"666a15b8d7adda84\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/loadTimes.js\":\"2d34c254ce295a8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoNotesRenderer.js\":\"491c42312917d973\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoPlayerRenderer.js\":\"0f268f9f0c2d4693\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoTimeStamp.js\":\"b57600eeab593e18\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/actions.js\":\"b2bdb7cefb4cf9e8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/index.js\":\"7cbf06334897c3de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/markdown.js\":\"213134a49db607d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/notes.js\":\"187e1725594715f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/registry.js\":\"54c23a78505f8ec0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/remark-timestamps.js\":\"084fc9d5676161e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/view.js\":\"1244aecbd619969c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/LinkHints.js\":\"7ad141e64e6b24a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/index.js\":\"b064da01aa456752\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/model.js\":\"91e8cc7daf3b9381\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/settings.js\":\"9d8067116b17dfab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/actions.js\":\"9b01bac2aa48ac5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/index.js\":\"f497c6b1260fbe95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/interactions.js\":\"5236ed95a3898822\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/workspace-header/index.js\":\"33b29fb405fb6f83\",\"/knowledge-medium/pr-preview/pr-1919/src/registerServiceWorker.js\":\"6e1b7cf9834a888c\",\"/knowledge-medium/pr-preview/pr-1919/src/requestPersistentStorage.js\":\"8077450ff11fb35c\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authRequestDeadline.js\":\"8d25228657432733\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authStorage.js\":\"d9d3fe326ab97e9e\",\"/knowledge-medium/pr-preview/pr-1919/src/services/powersync.js\":\"b030ae555d96c9ee\",\"/knowledge-medium/pr-preview/pr-1919/src/services/supabase.js\":\"5ef10c1549302e8c\",\"/knowledge-medium/pr-preview/pr-1919/src/services/uploadErrorClassifier.js\":\"92327786bc351f19\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/ActiveContexts.js\":\"38e01049d62595e5\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/HotkeyReconciler.js\":\"6c8415dad83200f7\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/WipeLocalDataDialog.js\":\"22dfd5b819912119\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionDispatch.js\":\"cf9d8d26c5d29681\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionRefItems.js\":\"9abb548c1f6f7594\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/applyKeybindingOverrides.js\":\"c8e080a606e8b707\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockActions.js\":\"32cb9652fabe3049\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockMergeGesture.js\":\"92ae96506a882478\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/canonicalizeChord.js\":\"ab82fcf2d34a808b\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultContexts.js\":\"e201a5304c61458c\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultShortcuts.js\":\"232e8e43c61ac880\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/effectiveActions.js\":\"5b68fba8df3015dd\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureAction.js\":\"7cd9705d86e8f051\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureBinding.js\":\"f22dbe983070cd25\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/holdRegistry.js\":\"77bca4f48ae7a776\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingConflicts.js\":\"fda1aecc5d586037\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingOverrides.js\":\"0754a8b4efaa71b5\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/pointerAction.js\":\"dcde07878faba1eb\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/resolve.js\":\"e05b9c4c3f350cd9\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/runAction.js\":\"75c71ed19fa4e7a7\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/sequenceMatcher.js\":\"8091d606feae6048\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/types.js\":\"66b7cb581970672f\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionContext.js\":\"1b968ecde4cdc930\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionDiscovery.js\":\"982324da019efed3\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/utils.js\":\"aaa9f1358eb20b4e\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/bootStore.js\":\"095352eb144e098c\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/previewDatabases.js\":\"2c5e223b8993c746\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/byteTransform.js\":\"c7853d82f81b320f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/attachmentCleaner.js\":\"99e5efab5b4ec366\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/attachmentParts.js\":\"c18e50de372cb376\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleParts.js\":\"7880484827e6d7c7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleRecord.js\":\"e176428f7f71240d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/manifest.js\":\"52a34ae42e7cfd55\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/takeBundle.js\":\"2486cd23e65efd24\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/verifyBundle.js\":\"2b42c3e871d423d9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/cleaningStage.js\":\"273731746574a273\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionKey.js\":\"6b382b8f92a37d1e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionServer.js\":\"b3b728f60e7f600b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flip.js\":\"046ad77ecc4751e7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flipAttempts.js\":\"d6659105222d03d4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/pages.js\":\"741049fd1141de00\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/preflight.js\":\"419d4c76d83a89d1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/reseal.js\":\"cb1a1c579a0c2ba1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runConversion.js\":\"18a2f99c82d0869c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runLock.js\":\"d1e6eb77fc8696aa\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealing.js\":\"6519148e1d8e80f5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealingStage.js\":\"5d330f82b8b2c3e4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/stage.js\":\"013342c504ad2f92\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/verifyReseal.js\":\"bb14797bd7d61524\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aad.js\":\"b22b2c8ed5c4bd45\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aead.js\":\"369dd27bbede018b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base32.js\":\"ebc2e08876a2f301\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base64url.js\":\"fd4997ee0e88ff1a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/binaryEnvelope.js\":\"e6bd9bdc7b7ecd21\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/byteAead.js\":\"2695e91478db3c44\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/canary.js\":\"b12c0f5d75a4caa9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentHash.js\":\"25b7d27e2d615b29\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentKey.js\":\"88c487671199bcd7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/derivedIdNamespace.js\":\"640a9347556b5fbe\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/envelope.js\":\"82af636f42371b11\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/hex.js\":\"f620f394d1b3dc08\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/sha256Hex.js\":\"11817e81fdd0c06e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/workspaceKey.js\":\"08920997fc1cc449\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/conversionState.js\":\"f8ee8bc1d43db4e6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/createEncryptedWorkspace.js\":\"7161c95c82c2a022\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/pastedKey.js\":\"2b8c4fa8369961ac\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"56490c11975dc8ff\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/upgradeWorkspacePin.js\":\"371ecad3c6dbadd0\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/keyStore.js\":\"1826fa6bac046675\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/mintWorkspaceKey.js\":\"3c91c555d74b2dfe\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/modePin.js\":\"ced5e362ce3abe93\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/openWorkspaceKeys.js\":\"6c73b83b76ff1889\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolveWorkspaceEntry.js\":\"092a41586a666736\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolver.js\":\"09baa567cd4b78d2\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/workspaceAccess.js\":\"f23009b6998bf452\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/transform.js\":\"bf5f290be6324c4a\",\"/knowledge-medium/pr-preview/pr-1919/src/themeBootDefaults.js\":\"689b906ff39f8f3b\",\"/knowledge-medium/pr-preview/pr-1919/src/types.js\":\"e6c3e9314a597dc5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/ClientLocalSettings.js\":\"b65bc82835477549\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/abortableSleep.js\":\"0febf04f05e8ee42\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/array.js\":\"ede0d002fd7b36b0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/backlinkAutocomplete.js\":\"795dba1f3ad924be\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockCrumbs.js\":\"99441a2b1df1779a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockrefAutocomplete.js\":\"4c7ad60441b3f134\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/cadencedIdleJob.js\":\"328c56017b971993\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/callbackSet.js\":\"5d986b5f1310e18c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/clientId.js\":\"318987b5efd32c24\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirror.js\":\"ea32300f29108c0b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirrorCompletion.js\":\"83fdae59f3409b24\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/copy.js\":\"85bba10118ef3d0d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dailyPage.js\":\"f67a7a927549c289\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensics.js\":\"7188648c68fa4cab\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensicsHooks.js\":\"c64d6890e3bac3d7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/deleteBlockThroughUi.js\":\"453757b4d64b6f3f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dialogs.js\":\"8de87429aa6e8251\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dom.js\":\"3bafb79459000a0d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/downloadBlob.js\":\"21ee59e8e83bf6ce\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/drawnWalk.js\":\"d6fc939837363723\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/exportSqliteDb.js\":\"41c4bf4f791bda1a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fileSystemAccess.js\":\"ce901848eef5071b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/flipSlide.js\":\"49a2143a17291248\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fnv1a.js\":\"623e94fb6a3de33a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/formatBytes.js\":\"c209b85d24921eb9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fuzzyRank.js\":\"74b1f9ebca09e3c6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idbKeyedStore.js\":\"69480aa65d9abaae\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idleCallbackPolyfill.js\":\"ff9605bb1d1544e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardAwareScroll.js\":\"eab447bf221a7710\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardViewport.js\":\"0f2b29697102f436\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/lastWorkspace.js\":\"f19c23b00582f62e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutColumns.js\":\"dc9bd71974bf889f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionDom.js\":\"e1ac46fcab21cefc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionId.js\":\"6352a1b13af2f676\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkClickGestures.js\":\"2d4a105102332f27\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkTargetAutocomplete.js\":\"6713166d7b674fd9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbCorruption.js\":\"352f53087b84c16b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbRecovery.js\":\"7b0e03c72e8b57a2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/markdownParser.js\":\"28f46b7f445c19ec\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/memoize.js\":\"ac0da91e8ad409f5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameFieldCommit.js\":\"a89ae328a0dcac17\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameList.js\":\"ae071678e8f1c415\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/navigation.js\":\"d226db1bf7bcfde2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/omnilinerNamespace.js\":\"048f94698b95bc11\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/opfsPageScan.js\":\"458765ead20b6e86\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelClearance.js\":\"68e3882f7de43ddb\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelHistory.js\":\"70ab01d36a33c803\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLanes.js\":\"1fd7d66f236b872f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLayoutProjection.js\":\"9d7b08e64828e11d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelScrollAnchor.js\":\"747a9b450bcc459a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelUrlFlags.js\":\"26ced29a23c84eec\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/platform.js\":\"716458aa420eede7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/pluralize.js\":\"3635070ad44ec771\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyCreation.js\":\"68806457b21b2ed0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyNavigation.js\":\"e29e75de3c8679f0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyValueContext.js\":\"8e8fcfc60f687677\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/react.js\":\"69c36bb4099bb0f8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeDate.js\":\"9a77774935b833bd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeTime.js\":\"d647f39f0c0c98a3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/renderScope.js\":\"720ef0e3742007f6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/resolvedThenable.js\":\"1c1f1f3a648f1bc7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/routing.js\":\"19deda051bea0eb8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/safeMode.js\":\"6c725be6d47020b8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/scheduleIdle.js\":\"f7aae8ff4bdf520f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/screenWakeLock.js\":\"6affbb55a2ebdd89\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/selection.js\":\"006aea8eeeb32131\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/softKeyboardGrab.js\":\"82e45afaa8f785ee\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/startupTimeline.js\":\"59ccfb58c7f3dbbd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/state.js\":\"f741e3ebb954f097\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/string.js\":\"086d9255833b0241\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/surfaceZoom.js\":\"d5a20ee710801c8c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/time.js\":\"01bebdabd36b7569\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toast.js\":\"caffc4e8bd1fa3e4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toggleStore.js\":\"2845cc742dc67686\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/untilStopped.js\":\"4950cb44eab5e85d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/userActivity.js\":\"e43e154212de5f56\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewTransition.js\":\"1fe156031d832256\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewport.js\":\"a881ee7cae004867\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/webLock.js\":\"73d1795071acd36b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceRecovery.js\":\"fb8f80464bc3fac0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceSnapshotStore.js\":\"3ef7b73486f6ebe8\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-compiler-runtime.js\":\"49d95e617db8d9ef\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-client.js\":\"48d464d3e2650793\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server-edge.js\":\"410fe15c660d02da\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server.js\":\"118b041450ab68b7\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static-edge.js\":\"4e4e6b87f5af597d\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static.js\":\"1765ee6a48ed6d86\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-test-utils.js\":\"28667ba9f754fb1a\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom.js\":\"6f46317022166f22\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-runtime.js\":\"788a7e25526b270b\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react.js\":\"6f33e75cee6987bd\",\"/knowledge-medium/pr-preview/pr-1919/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
