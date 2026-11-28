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
		buildId: "0fedc1ac2855-d19ff962",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/\":\"2370a4f72434e1b3\",\"/knowledge-medium/pr-preview/pr-1919/index.html\":\"2370a4f72434e1b3\",\"/knowledge-medium/pr-preview/pr-1919/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1919/assets/FacadeVFS-B6uLEty6.js\":\"7aa41e036a00e54b\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSCoopSyncVFS-BlTQX9s3.js\":\"ffc531704362af47\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSWriteAheadVFS-DsJdPs12.js\":\"3fd95c23c610ef98\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-DlROgey1.js\":\"6939b26e849b016a\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-lncq_ybC.js\":\"f7158d941bcb478b\",\"/knowledge-medium/pr-preview/pr-1919/assets/worker-fGhfelCd.js\":\"9944ebf8edc89357\",\"/knowledge-medium/pr-preview/pr-1919/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1919/chunks/app-BuyVLDrZ.js\":\"4a0a38dbc631d5d7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1919/index.js\":\"185597608e6588b2\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1919/assets/AccessHandlePoolVFS-BoGPYxRf.js\":\"74f37af66f9474f7\",\"/knowledge-medium/pr-preview/pr-1919/assets/IDBBatchAtomicVFS-B8u5ZU6X.js\":\"20b6f1e29b5b097a\",\"/knowledge-medium/pr-preview/pr-1919/assets/MemoryVFS-DNXLA_-D.js\":\"9cc0d305448017b6\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-U-fIfgwd.js\":\"7a17c6f49a224a15\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-C3avf6-K.js\":\"a60cd44b1039984d\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1919/chunks/AccessHandlePoolVFS-ChTQHfWP.js\":\"4ff2a782f01c09ec\",\"/knowledge-medium/pr-preview/pr-1919/chunks/FacadeVFS-D8QXKfcj.js\":\"f30bc0b2f8ceecff\",\"/knowledge-medium/pr-preview/pr-1919/chunks/IDBBatchAtomicVFS-Cac-P6Fj.js\":\"463bb4d82e2e5f98\",\"/knowledge-medium/pr-preview/pr-1919/chunks/MemoryVFS-CZiY_7AF.js\":\"ed4935d2250616e8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSCoopSyncVFS-COXkTIKa.js\":\"9a4ea73d4047fded\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSWriteAheadVFS-D1ICW3kE.js\":\"4bbfbb02c06d3d61\",\"/knowledge-medium/pr-preview/pr-1919/chunks/Preview-DxVUgY2q.js\":\"b07c1e4540f60b2a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/card-DtT2YdNI.js\":\"004d30aa1149cd2a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-DEpdU_II.js\":\"8c5d564fab82d5f3\",\"/knowledge-medium/pr-preview/pr-1919/chunks/freezeExtensionImports-OvuxXVtH.js\":\"18f64fc7fa0898d3\",\"/knowledge-medium/pr-preview/pr-1919/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1919/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-BKvlS76w.js\":\"a6f1a6c1d089a1c7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-async-B6EbCSq7.js\":\"663bca6c76ee6da8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-BTT63cdM.js\":\"2920d5e6cf41ebbf\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Bv1ds3I5.js\":\"89bcad06a88f46bd\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-D2M4Kwd0.js\":\"4746fb5187d9f94d\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DtSXjHIO.js\":\"b0a7f0edb9089586\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Epxcz8sP.js\":\"d87db4bbbc615e6b\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server-legacy.browser.production-D3anOgRq.js\":\"be067f94f61fead3\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.browser.production-CScoGsUk.js\":\"f1c760ef782b90ab\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.edge.production-ckvy5Lrk.js\":\"7c7639a87a7de92f\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-lCIkHrCg.js\":\"ba0c6215f7559282\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-ueuCHWd-.js\":\"e10f9397792132a3\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-wg_LHU47.js\":\"2acf724ffb3e9ffb\",\"/knowledge-medium/pr-preview/pr-1919/chunks/server.browser-CeaQEnGa.js\":\"61a90f3a0b629279\",\"/knowledge-medium/pr-preview/pr-1919/chunks/textarea-BHC6eBlu.js\":\"257a57203780364a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/ui-CNGxvJBw.js\":\"7e9c6974dde47397\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-DiMwuaFR.js\":\"dc46ccc9a5bb52b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-async-DAMXKp9v.js\":\"fe5b0a07c6c5a12a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1919/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/src/App.js\":\"5bec131a8f5bd8e4\",\"/knowledge-medium/pr-preview/pr-1919/src/appUpdate.js\":\"2dd1a67eeda7d55c\",\"/knowledge-medium/pr-preview/pr-1919/src/appVersion.js\":\"c469dc02cae89905\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/initialLayout.js\":\"b04ac9dddf369129\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/openWorkspaceData.js\":\"fb8fe1acf65461e9\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/resolveWorkspace.js\":\"9b4134f9f67db114\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/workspaceBootstrap.js\":\"ba3c579cb6f32324\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockComponent.js\":\"76856d613c0bfbe6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockCrumbs.js\":\"0cbcd36fb095d151\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockEditor.js\":\"ed0af2b60344dfcb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockLoadingPlaceholder.js\":\"f07d1df8e930aa25\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockProperties.js\":\"0fb4d5aef1a4c561\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockSearchPicker.js\":\"13b7216e4c959df6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ConfirmBulkDeleteDialog.js\":\"34ffb68cbdcac69d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DividerHandle.js\":\"6d6f96aee01804a7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DraftEditor.js\":\"d1bc9d4dee1cf1ac\",\"/knowledge-medium/pr-preview/pr-1919/src/components/GutterPill.js\":\"ee53cfade62288ed\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Header.js\":\"7dd305ae73bc3854\",\"/knowledge-medium/pr-preview/pr-1919/src/components/LazyBlockComponent.js\":\"47cdabac32ebf49b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Login.js\":\"9fa116950a7983fe\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ZoomableSurface.js\":\"086427111869d0b0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/editModeKeepalive.js\":\"49b9b8d3a3b94640\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyDisplay/PropertyDisplayScope.js\":\"4e8ca5ac50482fcb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"52e723b1f14ae83c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefPropertyEditor.js\":\"e47f77cb73bbcabf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefTargetTypePicker.js\":\"705ff572cc647e08\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/SelectPropertyEditor.js\":\"fee0e7b9d79c02fc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/TypesPropertyEditor.js\":\"940aa81d95980bdb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/defaults.js\":\"49bf7151ae6f2d19\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/kernelValuePresets.js\":\"56cd3fd80605b393\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/selectablePresets.js\":\"96d25206fe26294d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/typesPropertyUi.js\":\"1361d69171699bfa\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/AddPropertyForm.js\":\"1c5ce25ea33260cf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyPicker.js\":\"3f83d5a9ff027b0e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyRow.js\":\"6633f1f184b956fd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/Rows.js\":\"7a028a1b8601f7e0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/actions.js\":\"bf94fcdc7d4f0365\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/declarationOnly.js\":\"6965546dd368dfcd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/layout.js\":\"01d8bf7ed1ed36cc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/model.js\":\"3726f151075600d2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapeUi.js\":\"09b1f72d7602090c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapes.js\":\"e85f46b7f969d050\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/usePropertyEditingActivation.js\":\"337bd477e290aac0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/visibility.js\":\"983d07479769dd6b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanelSections.js\":\"5bdc89552d0241d1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockEmbed.js\":\"d01c81757da59240\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockLink.js\":\"4e6b4c436ca91083\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockRef.js\":\"79238f5fc26e6576\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/CompactReferenceLink.js\":\"9c6d4ce0be3e5eb3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/ReferenceLink.js\":\"f90bd5f74446ee20\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuard.js\":\"c41b1d4c2123e1df\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuardContext.js\":\"da89066f1cb3df56\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/linkInteraction.js\":\"c6d03ff5fb66101d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/referenceLayout.js\":\"414da97e72b9c59e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/useBlockRefAncestors.js\":\"e1cbf7186f5f31ce\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockGutter.js\":\"c69efd7fb9f989dc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockInfoDialog.js\":\"1576a39df172989b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockReadText.js\":\"309a8638418d66f7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockTypeBlockRenderer.js\":\"06cf7941b34ac9d1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BulletHoverCard.js\":\"e99ffe581b12c155\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorContentRenderer.js\":\"18b8627fe550eb94\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"e78d43810470f39d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ColumnResizeHandles.js\":\"dc5cc8943a7ceac8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"043ebedea39cedd0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/DefaultBlockRenderer.js\":\"b95119cc4decfa90\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/LayoutRenderer.js\":\"93e3be4f7abb4620\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MarkdownContentRenderer.js\":\"92f5e7221ea7b3dc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MissingDataRenderer.js\":\"c6bdfa2d678dbfee\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PanelRenderer.js\":\"b0a47187f0adafc0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ba915ec082c45c54\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/TopLevelRenderer.js\":\"a934bf37a2fe61a5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockGutterMode.js\":\"e7d0700ba711d2d8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockTitleText.js\":\"b33f6d375c01ef2c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/fieldCreationKeydown.js\":\"412a381c4ab95e08\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/layoutRootContext.js\":\"c454dc4f76ffc1d2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/TypeChip.js\":\"d6524dc20defe0b7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/chipStyle.js\":\"26f3125b2c28e184\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/anchored-floating.js\":\"a6d047ee88d371a1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/button.js\":\"6114c8325fda3422\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/card.js\":\"2787745d9266b48a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/checkbox.js\":\"e859a7dfd4137856\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/collapsible.js\":\"6291b006e71b8828\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/command.js\":\"32d59830ee2071e6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/context-menu.js\":\"9a6899d8880561e1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dialog.js\":\"38920e2f8595e16f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dropdown-menu.js\":\"d6ce73919ac9b73c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/floating-listbox.js\":\"d927486713d7245e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/index.js\":\"688042315d9bb97e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/input.js\":\"cfb3d98c00d61d2a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/kbd.js\":\"c17d069912cbf168\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/label.js\":\"5a6fc4888dc76d90\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/textarea.js\":\"46a3528c2e3cf03f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/useEditModeYieldKeepalive.js\":\"773335edea237a83\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/BootFallback.js\":\"e2d5ceba1485d0f4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/FocusedRowLazyMount.js\":\"4faa74c05691c83e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LazyViewportMount.js\":\"3989f57e6a5df4c5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LocalDbCorruptionFallback.js\":\"22535d0742490448\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/error.js\":\"bda7e6a76f8b781c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/lazyMountRegistry.js\":\"c284458bc7bf48d3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/suspense.js\":\"ae9913f2c2ac0993\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/CreateWorkspaceDialog.js\":\"439df4a44e15350b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/PendingInvitations.js\":\"86c336befdef4f5b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/SyncProgress.js\":\"6793f46da9e20884\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/UnlockProgress.js\":\"2d4fb896003f747f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceKeyGate.js\":\"83134e89a8b46cb1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSettingsDialog.js\":\"2dfc86745ad4c525\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSwitcher.js\":\"da11b41359dfa60c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSyncGate.js\":\"478c8e157e6b4594\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlow.js\":\"8021caec3bbd74af\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlowHost.js\":\"32b0fcc9bc7f4336\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/EncryptionSection.js\":\"7fc7cd3c825d3d8f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/attachmentPrompts.js\":\"fdf90806db686ddd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/bundleFolderPrompts.js\":\"e637e69c7e806d78\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowDeps.js\":\"48ef9ad4d172d3f9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowStore.js\":\"73332a41ee444797\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/flowUi.js\":\"921ca3243dba053f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/useConversionRun.js\":\"9f77b0608b768272\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/keyUi.js\":\"d122d8e52a1fba8d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnKeyLoss.js\":\"d3724d184e747994\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnServerE2ee.js\":\"306eebc154ff036b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/workspaceUnlocked.js\":\"673011ec4b5b245b\",\"/knowledge-medium/pr-preview/pr-1919/src/context/backgroundSubtree.js\":\"02b4af10b589e8c9\",\"/knowledge-medium/pr-preview/pr-1919/src/context/block.js\":\"c2fb583e9120a50a\",\"/knowledge-medium/pr-preview/pr-1919/src/context/layoutWsContext.js\":\"1b72e3b65d8d3c5e\",\"/knowledge-medium/pr-preview/pr-1919/src/context/propertyDisplay.js\":\"2204191d0d58c11d\",\"/knowledge-medium/pr-preview/pr-1919/src/context/repo.js\":\"b5b8d424c8d64d85\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasClaim.js\":\"359f71f15673f73b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasSeatNamespace.js\":\"fee60188ad35dfd5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockData.js\":\"6737879cd7fa2c22\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockType.js\":\"c14dbb090d395de5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/changeScope.js\":\"76e8b451e874b0d3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/codecs.js\":\"1ed7da63d2dd426e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/derivedData.js\":\"6f7b842ac9ac7e55\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/errors.js\":\"64830edaa19a826a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/events.js\":\"c7fb7c31840d3f18\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/handle.js\":\"5210f90f04f78f75\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/index.js\":\"3d9d4f5cfafa4c29\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/mutator.js\":\"639c1ac3e526df6b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/processor.js\":\"9c81730ca5ba16b5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/propertySchema.js\":\"370cfd7b978a3a36\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/query.js\":\"7576d236cfa32b0b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/sameTxProcessor.js\":\"7f649ab713708401\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/schema.js\":\"5210f90f04f78f75\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/tx.js\":\"5210f90f04f78f75\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/typedBlockQuery.js\":\"7ef75acebb372b39\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/user.js\":\"c2c068befd44b264\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresetCore.js\":\"d113408b7546f18b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresets.js\":\"e873717cf64b2659\",\"/knowledge-medium/pr-preview/pr-1919/src/data/attachmentCleanerIOVerb.js\":\"ea7e51e4dcc7b3c2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/block.js\":\"26fb9d48242549cd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockCache.js\":\"10ff7d61f5776aa1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockId.js\":\"22cc0e251b9f135a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockLiveness.js\":\"1e4ebb74755b048a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockMerge.js\":\"1dc10577f83133c1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockSchema.js\":\"0576d249e3fc0565\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypeLookup.js\":\"e636d60693800356\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypes.js\":\"6e2e9974712c810f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/childrenView.js\":\"66c21c3555995bac\",\"/knowledge-medium/pr-preview/pr-1919/src/data/clientContext.js\":\"6c7430b3dafb2325\",\"/knowledge-medium/pr-preview/pr-1919/src/data/dbFileSiblings.js\":\"3ff37447efc57816\",\"/knowledge-medium/pr-preview/pr-1919/src/data/definitionSeeds.js\":\"5f37689e1acf3d29\",\"/knowledge-medium/pr-preview/pr-1919/src/data/derivedIds.js\":\"a52f195b1988d360\",\"/knowledge-medium/pr-preview/pr-1919/src/data/drawnSubtree.js\":\"5f0ab58b13b3dc63\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facetBridge.js\":\"a5bddde83b5bc1de\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facets.js\":\"2db362d3876939ec\",\"/knowledge-medium/pr-preview/pr-1919/src/data/globalState.js\":\"83f3f194c2a6b853\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/aliasClaimRederiveProcessor.js\":\"144bc9960446da78\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/ancestorBatch.js\":\"1babad32d71c83ab\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/blockTypeTypeifyProcessor.js\":\"b7ff6aa246bac4d0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/clientSchema.js\":\"0b3508a2627264f4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/commitPipeline.js\":\"039e5404262931f0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/devAssertions.js\":\"e8c1d4ae4d39b0f2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/firstSync.js\":\"92aaaca7da5bb220\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/freshInitialLoad.js\":\"219eb07258000363\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/graphBackfillClaim.js\":\"c08e09fa2388f9b6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/handleStore.js\":\"6ef8a66a5c977106\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/idleMarkerJobs.js\":\"d3e7eeb8fe7461de\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initialDownload.js\":\"e51f1fa6a119d320\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initializeClientDatabase.js\":\"307853913bf6adc7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/jsonCanonical.js\":\"b337ad790547e36f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelInvalidation.js\":\"00071ee280ec77d6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelProcessors.js\":\"27c152364784c147\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelQueries.js\":\"4f2d4ce5479dc86d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/mergeTypeMembershipProcessor.js\":\"0a9529d85fee0cb0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/normalizeReferencesProcessor.js\":\"f95765ca3a499ecc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/poolInstrumentation.js\":\"039d1bc46a9caf12\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/processorRunner.js\":\"8a144602c93467e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyCellBackfill.js\":\"65e1d9e01d8bdff4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildMint.js\":\"e85ef88de03a3899\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildrenProcessor.js\":\"5f1e0aa3f3aa6e8f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionChangeProcessor.js\":\"a3f163f21b8a007e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionSynthesis.js\":\"0d4fdb251246fb48\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyKeyScan.js\":\"a400c7780dabb68e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertySchemaResolution.js\":\"34b715d80328f7bb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyValueEdits.js\":\"094582a6116b22bc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/raiseProtocol.js\":\"8f9aa9bead6f4199\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/readBatch.js\":\"d0b4944c13ccd252\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/refProjection.js\":\"95e46d7dbbf6036a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetLookups.js\":\"a815e894d6a005a8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetProcessor.js\":\"e0faa80d4188a486\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/replayMerge.js\":\"7a665dd5c6e444b3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/sqlBinds.js\":\"5d93bd654f0a8457\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"236226510e2530d1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/arrivalProcessors.js\":\"d06a69167c52375a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/invalidate.js\":\"3f12be774fa5a086\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/materialize.js\":\"85f7aa88994e59e9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/observer.js\":\"af78abe9a372321b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/reconcile.js\":\"189f2248346800ae\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/timingMetrics.js\":\"17ad9ee8d5a259c8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/treeQueries.js\":\"0dc532f8d6cf822e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txEngine.js\":\"d73732353ecfde0e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txSnapshots.js\":\"146088b7c4068b73\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/typedBlockQuery.js\":\"a5c6424b2cc933ed\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/undoManager.js\":\"4248ca3515792655\",\"/knowledge-medium/pr-preview/pr-1919/src/data/invalidation.js\":\"65a72b89b51adb3c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelDataExtension.js\":\"145a48adb7f5914d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelPage.js\":\"2088240df8e99cc3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelValuePresetCores.js\":\"7a96ec439930d33c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbCorruptionSignal.js\":\"c1964788ae371b1a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbStorage.js\":\"a5923a7d149e3661\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbVfs.js\":\"a31de75dd56145f9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localSchema.js\":\"3e8abe16772cd0a9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/maintenance.js\":\"38bf2c839d1957fe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mergeProperties.js\":\"560f033a551261a3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/metricsConsoleHook.js\":\"54f878a55a1d05aa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/migrationsPage.js\":\"26c1b579b7214fcd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mutators.js\":\"900a22bf764df9ef\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKey.js\":\"a21f8dbc5c6b400b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKeyPlacement.js\":\"4cd8676c201c60e1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/outlineSurface.js\":\"b658b4dd1653fb1c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingEditorContent.js\":\"b7400f4f4397e60b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingUploadsSql.js\":\"dcae0462c32a1288\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pluginStateExtensions.js\":\"cd15d828307f2099\",\"/knowledge-medium/pr-preview/pr-1919/src/data/powerSyncLogger.js\":\"efb59fd498fb3492\",\"/knowledge-medium/pr-preview/pr-1919/src/data/projectorRuntime.js\":\"823d0602d2fb4eec\",\"/knowledge-medium/pr-preview/pr-1919/src/data/properties.js\":\"049d4b48546006fd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertiesPage.js\":\"7f075f415d7617bd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyChildren.js\":\"cc026aa69c0071bd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionFanout.js\":\"52abaf88a20ee55b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionMetadata.js\":\"1d71759266b9128b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionRegistry.js\":\"f813e0c6b0ce1e3a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDisplayMode.js\":\"d4c73645f0614fb7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyRowCreation.js\":\"b18449fe1d1da094\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySchemaCreation.js\":\"d8b27fc22a0a6834\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySeeds.js\":\"cb7fa6a9f460ed77\",\"/knowledge-medium/pr-preview/pr-1919/src/data/recentsPage.js\":\"19c86504e5466956\",\"/knowledge-medium/pr-preview/pr-1919/src/data/refTargetComparableProperty.js\":\"26ff448b6a83f412\",\"/knowledge-medium/pr-preview/pr-1919/src/data/referenceBlock.js\":\"e77031bc00d0867e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rejectedUploads.js\":\"6c3c2995b769fa8f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/releasePowerSyncConnection.js\":\"092f346078e3914a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repo.js\":\"ed3f904d5d2729ec\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repoProvider.js\":\"2c87e7f0e48b652c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rowProperty.js\":\"0209aae3faaed82b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/searchFilter.js\":\"2fcf873bd7b65ad3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/seedIdentityLedger.js\":\"3afdf7d2ebb0d352\",\"/knowledge-medium/pr-preview/pr-1919/src/data/stateBlocks.js\":\"2cb952c461ec61ff\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralEditPolicy.js\":\"453396a260f4325e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralInsert.js\":\"54e7edb531e32e15\",\"/knowledge-medium/pr-preview/pr-1919/src/data/subtreeDelete.js\":\"ceddad4570bc0312\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncStreamLock.js\":\"c52c5f0d6c298ac5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableSqlRecognizer.js\":\"70ca01b161e5834b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableWriteGuard.js\":\"a6bc80fdce322d93\",\"/knowledge-medium/pr-preview/pr-1919/src/data/targets.js\":\"6c04e37616781ebb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeColors.js\":\"c82fd5919b479132\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionMetadata.js\":\"a37eed0b758897f9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionRegistry.js\":\"1e911a642498f27e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeExtraction.js\":\"b3b1a3f1015598a3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeInitialValues.js\":\"bd45e9298b3dd1f0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typePropertyGroups.js\":\"f88c6706f38e050a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeSeeds.js\":\"48a597f412e36b16\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeTagger.js\":\"4398271cc4ab9d58\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typedRecords.js\":\"74253591b689260a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typesPage.js\":\"bd5142b0b11a6113\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userPrefs.js\":\"1ea54c9dffd1e6a1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userSchemasService.js\":\"ad2d0a68318d07f6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userTypesService.js\":\"dd019db8a3fe7a20\",\"/knowledge-medium/pr-preview/pr-1919/src/data/valuePresetRegistry.js\":\"bbd60e775b021a86\",\"/knowledge-medium/pr-preview/pr-1919/src/data/visibleChildren.js\":\"004d164ce4582338\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceConversion.js\":\"bdf87c98b98b255b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceFirstSync.js\":\"62bd457a5c7bd002\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceIdNamespace.js\":\"b95e44535c8a928a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceSchema.js\":\"a5e0bf79a6a656f3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaces.js\":\"650dde478592361b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadLog.js\":\"094006c2e0ed8cc4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/BlockPasteShellDecorator.js\":\"10a29938bce04c53\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/atTrigger.js\":\"93560333aad5e363\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/autocomplete.js\":\"ebfedcb38a4cc4d0\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/codeMirrorExtensions.js\":\"4a65bc06abbfd40d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/contentFlush.js\":\"b797375e01a3ebfa\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/defaultInteractions.js\":\"127c811e655d4dcb\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/editSettleSignal.js\":\"ec1ad3bf4e755382\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/insertImage.js\":\"7e7d4d096a730afa\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceCompletionRange.js\":\"0a7bf83332732b4a\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceTargetTypes.js\":\"a901ad45e0d98485\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/syntaxContext.js\":\"4b64f9f0c48b0a65\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/triggerMatch.js\":\"830142495d31ec07\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/AppRuntimeProvider.js\":\"a3069f3a9c5b1b11\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/BlockFocusShellDecorator.js\":\"1ec9b3c9b064de91\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/ExtensionRenderBoundary.js\":\"e52b0415cc4eeab1\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/PanelContentRecovery.js\":\"34bcee3cfdfc6a25\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/apiCatalog.js\":\"7f457539fec5c451\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/appRuntimeController.js\":\"cb848952b8d9bfb6\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/approveExtensionHere.js\":\"46367aacfbcbbfe8\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/armedCutAppMount.js\":\"956566517fea0182\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/batchableKeyedStore.js\":\"bfee7700ed6025c1\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockInteraction.js\":\"6afd081a5a243610\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockSelectionAction.js\":\"5030a4cbc7977f13\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compileExtensionModule.js\":\"046fb3dbcd97f007\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compiledModuleCache.js\":\"9372a4fea08d33ef\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/continuousGestures.js\":\"3de97026ff704485\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/core.js\":\"53d1e6fb4eca6fad\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/defaultRenderers.js\":\"05d9327cf3f254fd\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/definitionFanoutAppMount.js\":\"6f1801130edf1deb\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dialogAppMount.js\":\"299bb6680a74f115\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensionSeeds.js\":\"35b02822152b7bb0\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensions.js\":\"7dc379ef233cff99\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/exampleExtensions.js\":\"81aeaa85a0131a2a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionApprovalStatus.js\":\"9e30a87acf354923\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionImportPolicy.js\":\"e2b4eea1d832028d\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrorToast.js\":\"cec90f5f93722270\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrors.js\":\"9c0ba028b26104e5\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLookup.js\":\"3239ce3d97e6f324\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionToggles.js\":\"8a0251f942a3f2d8\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionUtilitiesCss.js\":\"7afb98d7edf3d19a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/kernelPageDeletionGuard.js\":\"165739b6027f5ae9\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/liveRuntime.js\":\"81dcde8caf3672c5\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/normalizeExtensionSource.js\":\"8b37833e515cfc31\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/openExtensionsSettings.js\":\"9ec0a015b088a670\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/overridesCache.js\":\"24185e7f722e128e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/pluginIds.js\":\"4f16e38734d04a36\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/processorRejectionToast.js\":\"05484f03a9ee9022\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeActions.js\":\"6595afabf5184688\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeContext.js\":\"26ec861cb8e8c4db\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticAppExtensions.js\":\"3c568f303d2e4e72\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticDataExtensions.js\":\"d4e81070dd5a38fa\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/toastAppMount.js\":\"3ec22d58d6b1a611\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/transpileExtension.js\":\"a25727c576725b27\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useOverrides.js\":\"fd2cbadee3c71376\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useShortcutSurfaceActivations.js\":\"97240487583f8d59\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/discoverToggleTree.js\":\"f0692c9b4511a81e\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/facet.js\":\"f8e5cc31c7f251ac\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/resolveAppRuntime.js\":\"ff59aab9078db249\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/runtimeEvents.js\":\"1041e8d50236f99c\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/togglable.js\":\"bf7e6db91354badd\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/variantFacet.js\":\"59525867f0ff4e33\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/verbFacet.js\":\"b915b24047cc487b\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/block.js\":\"6037bccaab5dd150\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/focusedChild.js\":\"24e123d379d0029e\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/propertySchemas.js\":\"936d0fdbb72b0f81\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/typeRegistry.js\":\"2c1ae54377b1d3d4\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAncestorCrumbs.js\":\"070138c891859b4e\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAutocompleteListbox.js\":\"8ba3cbfd64610a41\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedSearch.js\":\"f2288c64339a9b2c\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedValue.js\":\"6b5f1cb4ba932c7c\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useFacetValue.js\":\"ed4552a4714e9c18\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsFocalRender.js\":\"308538f55ebad688\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsReadOnly.js\":\"8d5ad7fb2d50f3f0\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMaterializeBacklog.js\":\"88e6db2302cfb728\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMinuteClock.js\":\"90354946d5c97001\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePanelLayoutProjection.js\":\"033934cb93968693\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePendingInvitations.js\":\"195ffb16b3adc92e\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRendererRegistry.js\":\"e2a73679b2aa1e82\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRetainedFieldRows.js\":\"9f38ae6bc05af145\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useWorkspaces.js\":\"90a37d314ce1d375\",\"/knowledge-medium/pr-preview/pr-1919/src/lib/utils.js\":\"13a107e7d798fb19\",\"/knowledge-medium/pr-preview/pr-1919/src/main.js\":\"61f8b0c5f7937fa3\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/MarkdownImage.js\":\"fbc4aa5a21027ac6\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/blockSeparators.js\":\"74817ee5a9a6cf9b\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/context.js\":\"252126c0bceb3cf8\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/defaultMarkdownExtension.js\":\"e1e26a1f5617d98f\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/extensions.js\":\"64098103cb5ff545\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/renderMarkdownHtml.js\":\"20dea3b88a5af7c9\",\"/knowledge-medium/pr-preview/pr-1919/src/minimal-editor.js\":\"03bc66a2f098b7bd\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/armedCut.js\":\"d9182e98424e8d2d\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/captureMediaVerb.js\":\"bb63210ee54e8847\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/clipboard.js\":\"dd228e1ddf46ad46\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/decision.js\":\"4a93f5e9d83af6cc\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/operations.js\":\"92b08c7da4917f23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/AccountHeaderItem.js\":\"b5a0124cbb4d4d91\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/index.js\":\"f5a820fe3651ee95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"9fc9586d36b32c12\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askAgent.js\":\"cc77e52930abbfdb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askedStore.js\":\"381e99dcb6d05b82\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d4282ef771d29f76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/chipState.js\":\"b8db60cccf1b6952\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/dataExtension.js\":\"19b7e4acaffa32a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/index.js\":\"38361ac72074ae77\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"9f878abf8ab42dab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/schema.js\":\"72c1dee169e7f167\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/AgentTokensDialog.js\":\"fe2e607a2ac7945a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/BridgePairingDialog.js\":\"f4986ca119777861\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/addMedia.js\":\"54c5fc7a7adf3fdb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a0dba4e84da6789f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/block.js\":\"6e2e72239c3dfeff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/context.js\":\"c5b27a7fd8bc0371\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/displayIds.js\":\"5ad20355742ae4c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/index.js\":\"6a32cc829929041f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/outline.js\":\"7ee0e2b5aeae75ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/properties.js\":\"9f698449ccfdf240\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/refs.js\":\"a7eeb66d4ca65e13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0ba031ad31458bf8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/search.js\":\"fdecee0d0317c824\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/shared.js\":\"8758ef01d6b23bdd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f4e93d0ffae4a791\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/text.js\":\"f7451cdababc7bad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentWrites.js\":\"6304ac5c8aa2db35\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/authoringCatalog.js\":\"dd22eb964d69091f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/blockRefTargets.js\":\"d4a60903c4eef1f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridge.js\":\"e1d3942ff821179a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridgeLoop.js\":\"246eae654c17c02c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/changeHistory.js\":\"9b7cf11825b0c9fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commands.js\":\"99f736c5bd1aed50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commentsCommands.js\":\"6e45e4538d9dc382\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataExtension.js\":\"c922542028d98643\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataModelGuide.js\":\"c8cf8e022cd07110\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dayPropertyInputs.js\":\"dc8a9f58a635d779\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/describeRuntime.js\":\"480038dcb9f3ea47\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/extensionLint.js\":\"e353f4e72877fbc1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/grainAudit.js\":\"d31dc5884af086fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/healthCommand.js\":\"3d6be8cd3ea75f9f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/index.js\":\"5d845b04c42a9c08\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/presetIdentity.js\":\"1fd6c66981efa9b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"1fcad309f85aa19a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/readMedia.js\":\"e4e052288ffdc21d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/schema.js\":\"0d10ff02953d2800\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/serialization.js\":\"9d82e59c7431a912\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/targets.js\":\"0d0ee0c279d3f949\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/tokens.js\":\"87c41bc21cde6643\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/watchEvents.js\":\"d610b559049c50a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/workspaceGuard.js\":\"fbb1116c174eb2c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/writeCommands.js\":\"e8605c0527c05ac6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/AliasCollisionToast.js\":\"722faaf3ca03826e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/DuplicateNameBanner.js\":\"edc34685606a5bf8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/collisionMerge.js\":\"bf121918e683664f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/dataExtension.js\":\"47cfb5e75096e974\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/index.js\":\"772bdb3ccdc1037c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/mergeCollisionAction.js\":\"cd5699410ab14fb1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/pageStyling.js\":\"4d5614e8a3e2bd74\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/rejectionToast.js\":\"4e5b40df3ef4987f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/syncProcessor.js\":\"a953b70682d71130\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/actions.js\":\"57ab5078b860e052\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/addComment.js\":\"76f327740e48e42b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchor.js\":\"03bd68f0def56fe2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchorState.js\":\"064857d3d6b689e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/commentLinks.js\":\"e6fd843d1d47a1fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/confirmThreadDeletion.js\":\"52f04df1e84e84ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/container.js\":\"745d43658c71d8c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/dataExtension.js\":\"28551baef5137c15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/deleteComment.js\":\"0f012044f041880c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/highlights.js\":\"e895c41b5cff920a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/index.js\":\"cd86d12c5f70757d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/linkedCommentsPill.js\":\"d83317ed64b57b8e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/margin.js\":\"e9b4b666cec12800\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginAnchorLinks.js\":\"f610f44b44ad4b02\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginSchema.js\":\"9c828550e5d5ff23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/newComment.js\":\"7a7b0a24ffcc33a9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ownThreadPicker.js\":\"17b2ea850e029340\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/placement.js\":\"a8710bcbb0ba58dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/queries.js\":\"c80c5c8c7dbca52b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotePosition.js\":\"6755811f313f6406\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedIn.js\":\"c233b3efc69f1e83\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedRange.js\":\"3169deb751a04c7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/rangeRefs.js\":\"eb20d98b20ad5431\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readHighlights.js\":\"040bcd503fcadcd9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelection.js\":\"2490ba72d9a7714e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelectionUi.js\":\"4eacbad11d2733af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/reanchor.js\":\"de81b9da692e6bcb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/schema.js\":\"dbaee28bda203a1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scope.js\":\"fca6219cd2bd101a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scopeThreads.js\":\"5e6d24d07b866409\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/splitRetarget.js\":\"c2ce757d451c63ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestionCard.js\":\"0cf71bdcbc16f28a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestions.js\":\"d775cd9a1b7ef7cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaries.js\":\"d5d3a673f362f0f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaryBatch.js\":\"7ad9b85930922ca0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/surface.js\":\"2f7e99c3f6f958db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threadNavigation.js\":\"9ad6126fe749700e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threads.js\":\"94694fbe5715ab95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ui.js\":\"d2a8f62297e53f69\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/uiStore.js\":\"2420fb14801361e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/appIntents.js\":\"9918e633b1ac1069\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/index.js\":\"66537b1134d2d863\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/index.js\":\"b6002c7b8c9db2c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/status.js\":\"dbcfe2aef0fcd200\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"9ef0721e3e12b63f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaBlockRenderer.js\":\"0355b4de2e3337d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a68618d04500bb64\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaUploadReconciler.js\":\"fdb9fc10ab5681c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetDownLane.js\":\"c7cf622034d5c9bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetResolver.js\":\"70fc1076b8e7a0f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetUpload.js\":\"bd5b8e691e756319\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/attachmentCleanerIO.js\":\"ff2c605d567df1fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/supabaseAuditIO.js\":\"79cd342f1a162f5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/blobStore.js\":\"e810a231a83f87cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/browserMedia.js\":\"3f7b8c502d484507\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/byteStore.js\":\"e4cca6e59878b574\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanerIO.js\":\"62440d96ea950491\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanupAttachments.js\":\"9f88395311ff9e1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/dataExtension.js\":\"c833d9ad9024e86b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/downLane.js\":\"e05b7a13b726446e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/index.js\":\"90d46944b2df6533\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/insertImageContribution.js\":\"fe1b21b654a7a99d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneArming.js\":\"18472aeb01fd479e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneLock.js\":\"b7c8091d2564d114\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaBlock.js\":\"e05d1f22efb82407\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaCapture.js\":\"f4a45a80d3cc32ff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaLanes.js\":\"612b04f9adba13c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewers.js\":\"62342be74ebf41b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewersFacet.js\":\"1768a0d1b30b1778\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/pasteCapture.js\":\"2402297ca9157e01\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/resolver.js\":\"4f5139bf0c7c620a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/retryUploadsAction.js\":\"484b07b92d9163ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/storagePaths.js\":\"397c7263365a019b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadDrain.js\":\"94d70e6c359a3153\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadLaneStatus.js\":\"64a7dc04e253c9d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadReconcile.js\":\"c374de5ba2e427cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadRecovery.js\":\"7952b666c7418335\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadStore.js\":\"e6a5bc45d5b3ecb0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/useAssetObjectUrl.js\":\"91e264b3d67e026a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"1539ffaaf4bac08a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksViewSection.js\":\"71b4b3c57cb29451\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/facet.js\":\"5cd782aab27a75a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/index.js\":\"771e5e93c8aaf87e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/prop.js\":\"0111516bb738129d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinkFilters.js\":\"b48401203f882410\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"10dc5f59f2e018b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BlockEntry.js\":\"df176801e19f1764\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/LinkedReferences.js\":\"a34be5bc60014364\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"59d5327df852ac4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dailyNoteDefaults.js\":\"c767bc487a21bc33\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dataExtension.js\":\"87431839aa0d9fc0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/edgeExclusions.js\":\"68c40ca440ff4d3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/filterProperty.js\":\"4080dd9a3b190aa5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/index.js\":\"c802c2e97c575de2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"cd7766e62d6589d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/applies.js\":\"d49de285173cd058\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/countQuery.js\":\"51e31f7b89ddb5d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/expansionStore.js\":\"1c8f22422e0df2ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/index.js\":\"6fa25de8f1ee94ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"88044187d161a9c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/presentationInvalidation.js\":\"149f42aa0b4f8b2c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyEditorOverride.js\":\"cfb56a7459e99d01\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyFilter.js\":\"2072664a77339094\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/query.js\":\"32742bce0b585de9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/resolveFilter.js\":\"0bad6b1489b037d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sourceBatch.js\":\"66161f81bc431fd9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sources.js\":\"879a0e57fcf12bce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useBacklinks.js\":\"7fde0a0384120e12\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"48ed50e22ddd0aff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayCelebration.js\":\"00eaaeebb404add6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayOverlay.js\":\"62895eb93bf0ac57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/gate.js\":\"9542fbd02102ea1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/index.js\":\"7953f62a774420d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/wolfTheme.js\":\"baf8477ebbac13f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/BlockDragLayer.js\":\"59d8725aec6902fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dragController.js\":\"ca14043f236940eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dropTarget.js\":\"5adb692dfd4733cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/index.js\":\"d312c82d15ecceef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/projection.js\":\"3d4066c9fe8eda72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/BlockMetaCard.js\":\"cc741a1c06dbe99f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/index.js\":\"725a738d50302999\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/AddTagDialog.js\":\"2a0cd564f5bf75c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"68fe06c89f765815\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/TagNameIssueHint.js\":\"bf0b1482597fefd4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/addTagAction.js\":\"7ed6246695b272da\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/appendTag.js\":\"e5ae63ced56fa131\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/config.js\":\"77cadab0558ebb9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/dataExtension.js\":\"4533937de3452347\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/index.js\":\"eef07e4bbca1bd77\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/propertyEditorOverride.js\":\"a67436d0e467867a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbList.js\":\"5c87fae465243355\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ea14698bdfb699f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/Breadcrumbs.js\":\"2a9dd31600083551\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2d15ff8f7a4e3b9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"26a97500813416fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/index.js\":\"3e5dd12314928261\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7999ffab2bcff4dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/CharacterCountItem.js\":\"12b1036c5cd5caf0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/ProfilePropertyEditor.js\":\"96ffddd67c61f6d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/actions.js\":\"3017db90c73d6cfd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/blockType.js\":\"0a644e7ad2a5c9d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/charCount.js\":\"ddb39b09126904f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/dataExtension.js\":\"f6e663cf6026fa37\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/index.js\":\"4293541f9881f518\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/profiles.js\":\"c2826774baadb06c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/properties.js\":\"037bdb383110358d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/subtree.js\":\"3eb3b120f78d87b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/textCounts.js\":\"27b30a499af570ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/colemak-keybindings/index.js\":\"924cf8ca88c9ec10\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/CommandPalette.js\":\"6a0ef6ff4a29b63c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/HeaderItem.js\":\"5e8e7db1b01ef6de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/context.js\":\"1d816f1255112d78\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/index.js\":\"8b49e2912c52d927\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/selection.js\":\"eda8bd6e3397e327\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/toggleStore.js\":\"1728a921e7b96b81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/useCommandPaletteActions.js\":\"ca6f8da189174501\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ContributorBadges.js\":\"344716a258a03cab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ProfilePicture.js\":\"00b509b91ec68a12\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/author.js\":\"93269eddd03c5715\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/codeMirrorExtensions.js\":\"aed803164e881ad5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/dataExtension.js\":\"7f001322ddf1e032\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/index.js\":\"631e4e44af59fd70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/mentionAutocomplete.js\":\"1bf7933ae1554b9a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/processor.js\":\"5f7a8368c791e5cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/profiles.js\":\"b77cc9b4208e4079\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/queries.js\":\"02f24e74c595ea50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/schema.js\":\"18cc4384ee503158\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/useCommentAuthor.js\":\"f66494d98ba0fe49\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"f464b7cc149942d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/followOrigin.js\":\"87ecfb08a8e91cde\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/index.js\":\"17a533907e4d0171\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"d61cae94a48a9e6d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"67fb67d726515ecd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/CalendarGrid.js\":\"4c750af276e78e8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DailyNotePicker.js\":\"22e8a36a7d927a42\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8b51aaf178897d86\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateNavDecorator.js\":\"530dbe2a80f18e21\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateScrubOverlay.js\":\"14c5b04e45309496\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayPropertyControl.js\":\"e44a68c368e80a7f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayValueReferenceControl.js\":\"5665c6b808467f91\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/HeaderItem.js\":\"40d45ba67bd0abc5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/ReschedulePicker.js\":\"4eaff7a61c2ef256\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1287dd594f05237e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/actions.js\":\"baed38e49d0ef74a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/blockDateAdapter.js\":\"190f19c2e55f6081\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/calendar.js\":\"98cf290344421d62\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dailyNotes.js\":\"ac0cc99bc67302f5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dataExtension.js\":\"9d9cd7a3af0e7315\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubActions.js\":\"3ec6e1acf95ba624\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGesture.js\":\"b5cf6f474f461695\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGestureActions.js\":\"3d81ea30a88d9434\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubRecognizer.js\":\"6a1fe9e26f0f11e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayProperty.js\":\"342df198c03dc77d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"a337559b33274b76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/deletionGuard.js\":\"fc87aaddf3fece8f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dueQuery.js\":\"50f331890ec4fac0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/index.js\":\"f65926dc290863a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/landing.js\":\"3b9e7bd013690bcb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/localSchema.js\":\"f3dc52fb05055ec6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/referenceDateAdapter.js\":\"ec36c41b4ceb2392\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/rescheduleAction.js\":\"fb9b56756b334773\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/schema.js\":\"833f58e1ff5d9842\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadBlockDates.js\":\"8a83ac6e782604b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadDatesAction.js\":\"3abbe3724c5b7be6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/today.js\":\"f69cf4e25089a0bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"a096b90136cbc355\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"b493383505a9415d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/audit.js\":\"412bc92ee0b5a0b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditAction.js\":\"68ec40ca8df9a39a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditRanges.js\":\"89175c0629675782\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/diagnosticsSource.js\":\"80de1eeaad90e360\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/divergenceScan.js\":\"fb29a5bcdb44905a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/index.js\":\"1ca04e10244fb953\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/propertyChildrenChecks.js\":\"885abc9c653c433e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/referencesMirror.js\":\"94b4d196851261c0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/rowJson.js\":\"13447749f03cf8f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/schedule.js\":\"c68ccf302a0a91f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/store.js\":\"fba02b66b246ab97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/action.js\":\"53bdd5a8c636ef3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/index.js\":\"7e32954a2c43b103\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/plugin.js\":\"219cc636d253c2d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"48ed2a0092e30998\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/actions.js\":\"e459f0951a972dbf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/changeMarker.js\":\"95abe8ebab30b395\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/diagnostics.js\":\"9f530a922d149992\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/fileSystemAccess.js\":\"99ff0325a73437c0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/filenames.js\":\"9aa411fa69a0ecce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/index.js\":\"00216d76897145dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/mirror.js\":\"fcbe0aa827bd9c90\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runLock.js\":\"4115d3dbb8212860\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runtimeHealth.js\":\"8cc2bb7d59e49359\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/schedule.js\":\"1a490ddfd620ce4e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/store.js\":\"ce1b43d0259426cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/index.js\":\"92cb3426bec8bc4e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/themes.js\":\"d1791e41ec9ed6e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/facet.js\":\"78887b58bc560690\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/useDiagnostics.js\":\"058fc2e7cc0363d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/dismissals.js\":\"37f7e04c58a85c76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/index.js\":\"10f86685963a0bea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/status.js\":\"7c5ec230b3e63ad2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/store.js\":\"19c7cd29ef2a648a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"1612482d28e90f2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsSettings.js\":\"af3f6ec58f9d4039\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/actions.js\":\"43cec1502aba4290\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/config.js\":\"1bc87e5b26360813\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/dataExtension.js\":\"9e60cf35f8ebb031\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/effect.js\":\"14e7e888bf5cbd9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/index.js\":\"19e75258b97878e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/propertyEditorOverride.js\":\"145996159825ddf5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/useToggleTree.js\":\"f9d3d9a0a3e6624e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/ExtractTypeDialog.js\":\"e4c9056408182363\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"2758773cb917a179\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/PropertyShapePicker.js\":\"74a4e1b474ed0a6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/action.js\":\"2862bba66806f0fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/index.js\":\"8e52ff83f5325524\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/FindReplaceDialog.js\":\"5a2e23755c3cca65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/HeaderItem.js\":\"b73da4471026e28d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/dataExtension.js\":\"34e3d7d2a1367f6d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/index.js\":\"efd1b4043e06ab87\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/search.js\":\"d69dce0cc6bc924c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/toggleStore.js\":\"f166746cf5f4a810\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/LocationPropertyEditor.js\":\"252ac25a767c104b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/MapView.js\":\"f7560898e3307374\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/blockTypes.js\":\"ed9a2b317dcdafb7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/codeMirrorExtensions.js\":\"0751ecc38ece9637\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/createOrFindPlace.js\":\"bd206db14bbb06a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/currentLocation.js\":\"8e8adaf5cb37a561\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/dataExtension.js\":\"0bc2a0fd89a0d26f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/geoContentDecorator.js\":\"b0d2c123b94239d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/googlePlacesClient.js\":\"bfa59798c24ae34c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/index.js\":\"39bd9e7c3f16be26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/locationsPage.js\":\"d89ead91f1f945a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/mapViewport.js\":\"6663e831a2ea32a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/pickCurrentLocation.js\":\"382403f751788814\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeAutocomplete.js\":\"ded2eca257b32caa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeNameCollision.js\":\"857188daec959bfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/properties.js\":\"d7dac6b41362c17b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/propertyEditorOverrides.js\":\"d3e7e03a65462301\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/query.js\":\"3a7963cfb17f99cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/usePlaceSearch.js\":\"9b3ecc04ac91e957\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"4b79e7991f8f758e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"510b9ca6615acd14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7624e8b0e157ea88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/config.js\":\"ee014bd97130344f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/dataExtension.js\":\"22127b60f52dca65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/facet.js\":\"80fed60b7c10fd19\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/grouping.js\":\"9b7f4244d73dae31\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/index.js\":\"0bb6ba49f742422e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"4dc43a34e7b6d7a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/query.js\":\"93d3467734109f04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/resolveConfig.js\":\"6da2b125282fcfe7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d44af8e3d74c25d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a5336e9fef32b184\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlDocumentContent.js\":\"5d9fff487ab77150\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlFrame.js\":\"69abeeb7cddc1ff1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/actions.js\":\"bef400671ccd627b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/blockType.js\":\"591154c566b830b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/confirmRunScripts.js\":\"6c7890ace52ef41f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/dataExtension.js\":\"00b870976a44c2cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameAnnotations.js\":\"18b47dd932637471\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameDocument.js\":\"88f8442c5c81e424\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameTheme.js\":\"eac8ac0c4419b663\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/index.js\":\"4940d628b7a48666\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/scriptConsent.js\":\"ab6ef07dd3cf1985\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/sourceMap.js\":\"7581795bc1689eae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/useDocumentScripts.js\":\"ff05015b4397e67d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/index.js\":\"b65ff22f01518b00\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/record.js\":\"23e3c510eff4ef0a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/recordStore.js\":\"53263511547c9d60\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/responsiveness.js\":\"f025b568f69e7da0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/schedule.js\":\"909256c9ea729b60\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/sessionContext.js\":\"8691234adc69f69f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"273c16b25096a9b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"6c149040e2ed0eeb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/actions.js\":\"12ce5d0d8756edc0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/config.js\":\"41a54aab0b77d771\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/dataExtension.js\":\"17d42fad9dc254d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/effect.js\":\"6d2910f2f83f29c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/index.js\":\"c40eb0c108adeda2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/keyCapture.js\":\"67b86e307bf81a85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/overrideStore.js\":\"5fd92fda7513e5b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f98830a3e9760465\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/HeaderItem.js\":\"e8c882b5803f97fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/LeftSidebar.js\":\"6667372c4f10c622\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/actions.js\":\"008e70f39ecd8255\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/facet.js\":\"c8b6b44102475ba6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/index.js\":\"975b3d059f8be720\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/shortcuts.js\":\"e0a92c361ff0c05f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/toggleStore.js\":\"9ae5f60361370af0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/MergePicker.js\":\"a69227c81b8d80d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/index.js\":\"1967cb1447cdbb8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/mergeAction.js\":\"e4b7f1efb5f046c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/strategy.js\":\"bb3720e95aa36251\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/Button.js\":\"47c5c86ea9042183\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"bb4b454105570780\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/defaultItems.js\":\"0aa860d0265c24fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/facet.js\":\"277773cacce320d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/index.js\":\"a5c7d929b88f1890\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"a65ee1c1e461b9c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/actions.js\":\"cea997271540250f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"fb75b96273e2eaa5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8681c78825b882ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/index.js\":\"7f1137b3cb66f884\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/MoveDestinationPicker.js\":\"bb778a094e390cd1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/blockSubtreeMembership.js\":\"27a09dd989114f2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/contextMenuItem.js\":\"240240c8238c5cbb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/index.js\":\"5078152826d1b789\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveAction.js\":\"f28c4cd8f1f5a67a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveBlocks.js\":\"9aeb3a44daad4b15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/selectionAfterMove.js\":\"7b5b41430a65efa9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/TutorialBanner.js\":\"54ff49ee2ad82526\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/action.js\":\"8dc826e4039c0b57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/bannerDismissal.js\":\"0ed052aed235de89\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/documents/cheatSheet.js\":\"a718932a816da4bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/index.js\":\"3e06327daa13a109\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/keys.js\":\"2bdfaca5cdc7c5da\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/landing.js\":\"753794e0080fda01\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/outline.js\":\"ed7865b7f0c02298\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/seed.js\":\"629e5e7c7e354138\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/PerfTrendDialog.js\":\"4567267985ec9c6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/analyze.js\":\"5522970e416fac9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/diagnosticsSource.js\":\"3c26000c1749159b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/index.js\":\"b4dbce1c279aced5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/load.js\":\"9b32164061d829c6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/monitorRun.js\":\"209d1a5039809b3c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/schedule.js\":\"057e9d3ac91c3e14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/series.js\":\"dd758c6563032e15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/store.js\":\"54cf33ae95ce8386\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/trendAction.js\":\"1a2ba7ec4cfa0fa9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/verdict.js\":\"73f9d77779184267\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/clickToEditAction.js\":\"afbe9eb8a03df72d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/index.js\":\"d1ed4e4f2c2a6ef2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/interactions.js\":\"f2c07f89ba794b53\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d7538eae764d277e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGate.js\":\"280f3fc490ed3938\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGateDialog.js\":\"1dec16ad3c8b8c02\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/action.js\":\"3815726893c49d98\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/index.js\":\"bbaeaf3f49fb25fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/localRunMessage.js\":\"28a1d8e80cd8a142\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/plugin.js\":\"6976c71daab1293d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/progressReport.js\":\"35ce148e04467510\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/sweepProgress.js\":\"d897dc569e44e381\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/FieldRowRenderer.js\":\"4412269b166ac200\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/ValueRowRenderer.js\":\"4eea1f8caf17be77\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/actions.js\":\"391597323c02829e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/autocomplete.js\":\"8e0921d3b7082286\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/fieldRow.js\":\"1546d7a18840b52f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/index.js\":\"da5a0e444e362ca8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/referenceWarning.js\":\"450c5390c0d51367\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueAutocomplete.js\":\"8318b0cc0ff77b7f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueSchema.js\":\"2146fee15b87015c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/HeaderItem.js\":\"5c965b987bc8fb23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/QuickFind.js\":\"bff52496e4ab3260\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/index.js\":\"815cce99ac09ef26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/recents.js\":\"4bedc8cc95594ae8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/resultItems.js\":\"6d564b247aea62d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/selection.js\":\"36fcf961b450a149\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/toggleStore.js\":\"7bea455586e55d26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/HeaderItem.js\":\"f65786ef2ac4a512\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/RecentsPageBlockRenderer.js\":\"72c5823d1c63a36a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/grouping.js\":\"0c970e1bd95faaea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/index.js\":\"64ab06f13434e342\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/target.js\":\"1365f0fe40072508\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/codeMirrorExtensions.js\":\"63578f26ba650022\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/contentPrefill.js\":\"4bfb64c0d77f8f9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/dataExtension.js\":\"6cca881cbc4e9de6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/index.js\":\"5559a1ecdcef3175\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"6f189ce4d3aac3dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/invalidation.js\":\"0d5b1e35ec7c3ee1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/localSchema.js\":\"dd76df2bb8fe5436\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/index.js\":\"99f851c4910840f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"46946ef7720c954f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/index.js\":\"a57af2f4f8710066\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/referenceNode.js\":\"f423ab87353111c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7e1cfccfb101f4ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"b3df598e8eee5e08\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/index.js\":\"693f034282904289\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"65f6a6df335046be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"d176daffec37c55c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/mergeRetargetProcessor.js\":\"0c8ecb2363297341\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/parseFence.js\":\"df9ec0a35e6d9cd8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceParser.js\":\"d58038e7bb6727b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceProjection.js\":\"28b795f30bbb2514\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referencesProcessor.js\":\"5ceafc821362417e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/renameProcessor.js\":\"7a6f93ce71976251\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/spanReplacement.js\":\"7a0f2b815b703c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/htmlToOutline.js\":\"204a53269b886d12\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/index.js\":\"ac4b40b481b8b423\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/normalizeClipboardDom.js\":\"45e6f60113018a98\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/pasteDecision.js\":\"2d2afe0acd937f3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/action.js\":\"e5dc666030929429\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/blockIds.js\":\"789d492e6915f67d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/content.js\":\"a74408d650d046ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/effect.js\":\"52879e55b9cbdaa3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/ids.js\":\"ec220dba21eba341\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/import.js\":\"a58cf838351143a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/index.js\":\"76ef73fb4d48b8ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plan.js\":\"e5558ebe3fc7cb45\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plugin.js\":\"f895146e2b0cd629\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/promotion.js\":\"378b6519ab3e57a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/properties.js\":\"8f45827a20f58093\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/references.js\":\"b2968f70b119f5d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/report.js\":\"04a0b96c561b9c8f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/roamMemo.js\":\"a5be39f581fadbca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/runtime.js\":\"a50b7e1927aede32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/schemaReconciliation.js\":\"c0c6d2c62dbd4e7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/srsMarkers.js\":\"8296f35da44e838c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/todo.js\":\"c7f8e0685c3d5a76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/typeCandidates.js\":\"5f4634a7c3ced3b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/types.js\":\"3d02d65de578d296\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/index.js\":\"a0e261c1b184ce4e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/store.js\":\"3953cae88a7da423\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/HeaderItem.js\":\"4d4198f9457da5ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6d00b70962a62e62\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/index.js\":\"9bcaa131b387dfb3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/model.js\":\"6782989d130d32c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/toggleStore.js\":\"46c8f129580f53bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/useKeyInspector.js\":\"60349c921545ec46\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"0388c4b5f73cf68c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/ShellDecorator.js\":\"8d1d297929045133\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/actions.js\":\"cd8feb30a399e1d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c39c023ada4b64c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/index.js\":\"57d6be0ffbfeb735\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/shell.js\":\"c16a74d929e2cc7f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/surface.js\":\"ee45f229bc3080e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/walker.js\":\"39608f53a05abdb8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e35e33f499951de1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/dataExtension.js\":\"664c3f48c54d297d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/index.js\":\"7d9dd8b3a293dd73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/indicator.js\":\"ea9a9ea22ed41228\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/moveSrsState.js\":\"6bab88c138231830\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"ec38c386683728b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/scheduler.js\":\"ffa9c64345ed1360\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/schema.js\":\"0eed57ff7ec79466\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"11bfe5c44a735a50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsClipboard.js\":\"b866c5001f258c9d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5cd994e8e35bb059\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DailyNoteReviewHint.js\":\"662a07cd58cf6795\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DeckPicker.js\":\"2fee658c86be8636\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewControls.js\":\"f791bea1ab34dfc3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewDeckRenderer.js\":\"57a8a438a59e627b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewSession.js\":\"a98c169dde8d90e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/actions.js\":\"ae6741ea46b6ed81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/archive.js\":\"f33af942eb8a3c3d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dataExtension.js\":\"cc8c6adb63fe6a30\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/deck.js\":\"32e66eaa3e2dc5b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dueQuery.js\":\"c7002d8e725d6f21\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/gradeDecision.js\":\"f2164ee9091dd6a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/index.js\":\"3b68bda5ad4e6b6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/keyHints.js\":\"657798c2fb366bff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewCardLayout.js\":\"83da070c86b50314\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewProgress.js\":\"457bdbcf03d09afd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/schema.js\":\"97444521990450cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/useDueCards.js\":\"badbcb08d7451359\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/index.js\":\"a00b3b564ba09117\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/record.js\":\"41552e1511b29e7c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/index.js\":\"d3889eac36ca1983\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/persistenceStatus.js\":\"39cb26514850a47a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/requestAction.js\":\"b2c80d64f9abf8f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/TypeChipsDecorator.js\":\"35af505f09902172\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/codeMirrorExtensions.js\":\"c502a659188e1048\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/index.js\":\"00050b9410bfff8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/typeAutocomplete.js\":\"0e8a3828869cd09c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4d7a1580254efa21\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/actions.js\":\"1657aec326c46c84\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/anchor.js\":\"0205916dbdf4e818\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/events.js\":\"4708831cd28fb9aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/gestureActions.js\":\"14464a9f34dbd7ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/index.js\":\"2a387c6d61846121\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"f73ca4080e6651ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/collect.js\":\"46f187d6ab76aa0a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/index.js\":\"1a0066ee0dd7ee9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/record.js\":\"397ce4cc56b48510\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/RejectionDialog.js\":\"eef0be4a9754f0f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/SystemStatusHeaderItem.js\":\"ca33e9ae4ad7b747\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/index.js\":\"832f6d1b47938d5f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/model.js\":\"94791095ecff94b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/queueCounts.js\":\"c1d9c11e09cb2e91\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rejectedHelpers.js\":\"9192243e0240e96f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rematerializeAction.js\":\"cbb73bcce875585d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/useHysteresis.js\":\"99d582d3e4bc44a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/ColumnHeaders.js\":\"116904b0ce319955\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/QueryUi.js\":\"5c1d4503766e6a3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/TableLayout.js\":\"13093a618dcbe871\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/actions.js\":\"7dae5e1b32cedee8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/cellEdits.js\":\"7fb152457885f281\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/childrenViews.js\":\"ed19abc426b7bf13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/columns.js\":\"cea9bd7671b3bbef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/controller.js\":\"cf6779cfdc650444\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/convert.js\":\"7d218d6b7d7cb8a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/dataExtension.js\":\"d42e4e16c1e12ff0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/index.js\":\"f2a143ff6499337e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/keys.js\":\"b0b966447b4fd762\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/model.js\":\"3ae40886d0e2a8f6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/QueryText.js\":\"a1323ff54a1e7c84\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/backfill.js\":\"68cc1184d1d719d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/completion.js\":\"da0224143dbb91e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/format.js\":\"3ef1d74729281165\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/parse.js\":\"f216f856ed2052a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/queryValue.js\":\"bad0b295c1c45681\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/registrations.js\":\"eec24c8765fb1d50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/source.js\":\"0ba9d69c45e24b14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/registry.js\":\"e4a05a5437da616e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowGutter.js\":\"71b330b6d90e8394\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowVerbs.js\":\"8e5c85b1c019dcb7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/schema.js\":\"661c3516e69c9799\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/sort.js\":\"67ad5b34a0454985\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/effect.js\":\"76d0148699804d21\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/index.js\":\"4e97da79198623e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/theme.js\":\"d4025dea89b4a6ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/actions.js\":\"a8e320bd583f7d33\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/dataExtension.js\":\"b260a5b9a12e4877\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/index.js\":\"79c5f454f341d54f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/schema.js\":\"f08634479383ba57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/TouchSelectionLayer.js\":\"bf76de5af52f9097\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/actions.js\":\"a12682e67a9a5d15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/defaultItems.js\":\"296c79ce5639acd2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/facet.js\":\"ddf8d33796d13957\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/holdRecognizer.js\":\"cb721c4852566b38\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/index.js\":\"593a6a7a3892932c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/UpdateIndicator.js\":\"4849bccc21278919\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/index.js\":\"f9d447d2d5efd50c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/loadTimes.js\":\"ed7d189e1bbf56e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoNotesRenderer.js\":\"cea52e80345ffbec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoPlayerRenderer.js\":\"9dee0401a73b8de6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoTimeStamp.js\":\"a4795812ecd748c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/actions.js\":\"9109379b35d392e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/index.js\":\"040fcaf0843b1eec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/markdown.js\":\"691e3fdd6555f803\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/notes.js\":\"b127e4f7356d00b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/registry.js\":\"43343ea8981bdadf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/remark-timestamps.js\":\"43fbd1134384fdb8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/view.js\":\"9b9c51dbeaaa4b40\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/LinkHints.js\":\"5456408ba5c07bd9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/index.js\":\"9a03b7086787cc7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/model.js\":\"80bd743e7baf961b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/settings.js\":\"76917dcccd3f51e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/actions.js\":\"68dec577191535ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/index.js\":\"3ca80b2637a0af2c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/interactions.js\":\"3ba8e3361ced3676\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/workspace-header/index.js\":\"1c45b865ea05e63b\",\"/knowledge-medium/pr-preview/pr-1919/src/registerServiceWorker.js\":\"d471bb5310abf780\",\"/knowledge-medium/pr-preview/pr-1919/src/requestPersistentStorage.js\":\"3ec4fc07a26804e2\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authRequestDeadline.js\":\"30be07b1e94071fb\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authStorage.js\":\"ad9af96f3c3685bb\",\"/knowledge-medium/pr-preview/pr-1919/src/services/powersync.js\":\"823998741c0162f3\",\"/knowledge-medium/pr-preview/pr-1919/src/services/supabase.js\":\"4aa298bd052a717a\",\"/knowledge-medium/pr-preview/pr-1919/src/services/uploadErrorClassifier.js\":\"15fc487e13adbda5\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/ActiveContexts.js\":\"94e30bc5a867bab1\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/HotkeyReconciler.js\":\"e586e6016785fd7f\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/WipeLocalDataDialog.js\":\"0eb573a036b0caf6\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionDispatch.js\":\"bd8975289985a898\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionRefItems.js\":\"2cfbb9e79f49d2c7\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/applyKeybindingOverrides.js\":\"bf9c27e4caa74ca3\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockActions.js\":\"095958445e798814\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockMergeGesture.js\":\"9f8056a76a5a63fe\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/canonicalizeChord.js\":\"cdd6455c288729df\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultContexts.js\":\"66ab99efc763a36e\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultShortcuts.js\":\"a1544ebbd43e9b4d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/effectiveActions.js\":\"91b3d9945ae83995\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureAction.js\":\"cc78cd144623cda6\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureBinding.js\":\"5b58388f7b29729e\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/holdRegistry.js\":\"82e9ff10cfaf31df\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingConflicts.js\":\"2e85795b8da1754e\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingOverrides.js\":\"98f3fe15743e89b0\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/pointerAction.js\":\"a5302bf15a10872d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/resolve.js\":\"45c25710306acbad\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/runAction.js\":\"c17c15045773b388\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/sequenceMatcher.js\":\"8e64f887cbc67281\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/types.js\":\"64e0196d00e43bfb\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionContext.js\":\"66377b3bb10335f8\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionDiscovery.js\":\"234b4632a13b0dff\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/utils.js\":\"e06a72fc44f8f1d6\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/bootStore.js\":\"b04114e78cc05c71\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/previewDatabases.js\":\"56c263f8767fb4ea\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/byteTransform.js\":\"cb4c8ad41c186d3d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/attachmentCleaner.js\":\"b40732c43e39c639\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/attachmentParts.js\":\"27c115e8085a6032\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleParts.js\":\"39f9369096540365\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleRecord.js\":\"206db7e1c2cc5b59\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/manifest.js\":\"5d00210ef7dd0ead\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/takeBundle.js\":\"4112507c18e90dd9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/verifyBundle.js\":\"abbffa16466fdad0\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/cleaningStage.js\":\"26fd448d7a74f97f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionKey.js\":\"a6123def6279de6c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionServer.js\":\"9f0260f828339c03\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flip.js\":\"261e3cf9182c9aa1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flipAttempts.js\":\"c7a021dd8815a359\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/pages.js\":\"0cf3fe8b1755896c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/preflight.js\":\"81a8591610185a2f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/reseal.js\":\"e80058dc94df0ffc\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runConversion.js\":\"db9341f6886f790d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runLock.js\":\"06851b9c65d3c8eb\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealing.js\":\"f14855bdf88bada5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealingStage.js\":\"4e6b4df87ed62b75\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/stage.js\":\"c1c739f70e0d0b0d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/verifyReseal.js\":\"cdbad46dfed3c956\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aad.js\":\"814623fd198a550a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aead.js\":\"c9572dfe941405c3\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base32.js\":\"74e86041b4e2aea3\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base64url.js\":\"d0ad6515fcb8881a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/binaryEnvelope.js\":\"d7fb61f3058d7926\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/byteAead.js\":\"92e7ec063f392512\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/canary.js\":\"427410f04d1bba4d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentHash.js\":\"7af518852cc9d976\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentKey.js\":\"f21f907f401e75ea\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/derivedIdNamespace.js\":\"54bb48172c5fc804\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/envelope.js\":\"b14352554e681c92\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/hex.js\":\"624b05cf16a4eb70\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/sha256Hex.js\":\"81670defed25a962\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/workspaceKey.js\":\"118bc7cd8c381dca\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/conversionState.js\":\"0174f25abd997dc0\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9da9cf3b123abac7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/pastedKey.js\":\"83c17c4e01340017\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"2309d2b73842eea7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c6f2039253ca6bce\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/keyStore.js\":\"a8cf51f502ac2694\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/mintWorkspaceKey.js\":\"52b7791699857b72\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/modePin.js\":\"d2d52bfe70cfb3db\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/openWorkspaceKeys.js\":\"b64081c4330d4627\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolveWorkspaceEntry.js\":\"2e4268be055d3d46\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolver.js\":\"1987514d439ff7a6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/workspaceAccess.js\":\"d6e65531a0625e03\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/transform.js\":\"76f34a359b3eadb4\",\"/knowledge-medium/pr-preview/pr-1919/src/themeBootDefaults.js\":\"80c6b3e53817ea99\",\"/knowledge-medium/pr-preview/pr-1919/src/types.js\":\"6ad583c5efa65ef7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/ClientLocalSettings.js\":\"6e994cc462f148ee\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/abortableSleep.js\":\"ce73866467a23989\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/array.js\":\"c57f3d37cae7caef\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/backlinkAutocomplete.js\":\"a7c9fdec8363ff9a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockCrumbs.js\":\"28312d5139b238f1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockrefAutocomplete.js\":\"e0b982742bf61b13\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/cadencedIdleJob.js\":\"8dabafc3a1ba13f5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/callbackSet.js\":\"4207c8c6a46f725c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/clientId.js\":\"0ae96ff5196bba44\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirror.js\":\"e988250ca629df2e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirrorCompletion.js\":\"440e2fe06210714b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/copy.js\":\"a2379d44ae4a3331\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dailyPage.js\":\"2731a3d51fceab62\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensics.js\":\"c97ad581d7d56812\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensicsHooks.js\":\"266f13e9da685f1c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/deleteBlockThroughUi.js\":\"53de5460f3862352\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dialogs.js\":\"da29089bc2a5d7f6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dom.js\":\"05d2f04907e66ce7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/downloadBlob.js\":\"2e39d9ddfe5f3f67\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/drawnWalk.js\":\"8fcfbf8a3ee256ad\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/exportSqliteDb.js\":\"cb6846a5ff802a68\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fileSystemAccess.js\":\"9216f54fd893bfdd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/flipSlide.js\":\"01d65266b491b946\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fnv1a.js\":\"f572b066f1433a82\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/formatBytes.js\":\"10bb1df791b9d611\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fuzzyRank.js\":\"84128afc7666dce0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idbKeyedStore.js\":\"f07accdcd3113916\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idleCallbackPolyfill.js\":\"2be8b45c95998842\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardAwareScroll.js\":\"99c2b2f170f9c3e7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardViewport.js\":\"20d336d892693c95\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/lastWorkspace.js\":\"05df520a495108c5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutColumns.js\":\"480d07888ce55522\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionDom.js\":\"d61c371c6ebb9eae\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionId.js\":\"45275f6cee50cc9f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkClickGestures.js\":\"715003f44e4a76cf\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkTargetAutocomplete.js\":\"b05635ed4a52190d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbCorruption.js\":\"424e3a2f16110444\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbRecovery.js\":\"2e50f1dd518fb0b1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/markdownParser.js\":\"f71deeeb3c8259ec\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/memoize.js\":\"122450ee25433072\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameFieldCommit.js\":\"cbe8392a20b3b34e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameList.js\":\"6d6b056707b927b5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/navigation.js\":\"4ab8a08770ffeffe\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/omnilinerNamespace.js\":\"fd81918c718fc758\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/opfsPageScan.js\":\"955c02adc68c5e4d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelClearance.js\":\"5320928b24de6013\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelHistory.js\":\"2f706402a18d60d5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLanes.js\":\"5520328cba4aa0e5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLayoutProjection.js\":\"d0e7cb38eef9c57a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelScrollAnchor.js\":\"7913e2e67df9de52\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelUrlFlags.js\":\"28954304171775bb\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/platform.js\":\"294505f334228ec8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/pluralize.js\":\"d34f6aa9bc3435f1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyCreation.js\":\"4c0ae0179afaaa9e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyNavigation.js\":\"e0ce704e7caa05e1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyValueContext.js\":\"c50ca5544c585557\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/react.js\":\"a28daea9698dd51e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeDate.js\":\"58cdfad7f36808d8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeTime.js\":\"b7dcc77f40ed3f9d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/renderScope.js\":\"02bc53722a45eb99\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/resolvedThenable.js\":\"00053a7ec7f83d37\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/routing.js\":\"2265a6361ee556c7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/safeMode.js\":\"3b030abcf61fd493\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/scheduleIdle.js\":\"eb82ce11b1875529\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/screenWakeLock.js\":\"d15cf5cbffd3d460\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/selection.js\":\"df5eaa9b6e044b11\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/softKeyboardGrab.js\":\"7cd17e49838e7c96\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/startupTimeline.js\":\"0d94183b7ce90aed\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/state.js\":\"83f0ef3ab545fc54\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/string.js\":\"7344b66dd0d5f830\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/surfaceZoom.js\":\"17ff2db50b861716\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/time.js\":\"e1179b9228209d44\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toast.js\":\"5ef5e29e1100159c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toggleStore.js\":\"097b9f1d0dd0e777\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/untilStopped.js\":\"5b502d8b2c6225bc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/userActivity.js\":\"b797e4c8b299edfa\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewTransition.js\":\"d3c2d8208d039179\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewport.js\":\"807c58cc729e6aec\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/webLock.js\":\"c27559684600ff6a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceRecovery.js\":\"73dac9dfc9a126fa\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceSnapshotStore.js\":\"e9cf65442725037b\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-compiler-runtime.js\":\"f9ee72b5e3f1d9e8\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-client.js\":\"94f5ca6daba31e7a\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server-edge.js\":\"8f03b835f3b7294b\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server.js\":\"d4284c34c327a648\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static-edge.js\":\"0e0a1ea609bbc685\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static.js\":\"a8967beeb498547a\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-test-utils.js\":\"cb00176a89873945\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom.js\":\"aa39fbb2e49e3d96\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-runtime.js\":\"c8952e45439863c3\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react.js\":\"700ed72da3e78e04\",\"/knowledge-medium/pr-preview/pr-1919/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
