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
		buildId: "7a754f5b64ec-0320232d",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/\":\"95cc67901f5da5a1\",\"/knowledge-medium/pr-preview/pr-1919/index.html\":\"95cc67901f5da5a1\",\"/knowledge-medium/pr-preview/pr-1919/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1919/assets/FacadeVFS-B6uLEty6.js\":\"7aa41e036a00e54b\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSCoopSyncVFS-BlTQX9s3.js\":\"ffc531704362af47\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSWriteAheadVFS-DsJdPs12.js\":\"3fd95c23c610ef98\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-DlROgey1.js\":\"6939b26e849b016a\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-lncq_ybC.js\":\"f7158d941bcb478b\",\"/knowledge-medium/pr-preview/pr-1919/assets/worker-fGhfelCd.js\":\"9944ebf8edc89357\",\"/knowledge-medium/pr-preview/pr-1919/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1919/chunks/app-CIp246Ux.js\":\"018223b7839b80a6\",\"/knowledge-medium/pr-preview/pr-1919/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1919/index.js\":\"b2370038b95c836d\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1919/assets/AccessHandlePoolVFS-BoGPYxRf.js\":\"74f37af66f9474f7\",\"/knowledge-medium/pr-preview/pr-1919/assets/IDBBatchAtomicVFS-B8u5ZU6X.js\":\"20b6f1e29b5b097a\",\"/knowledge-medium/pr-preview/pr-1919/assets/MemoryVFS-DNXLA_-D.js\":\"9cc0d305448017b6\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-U-fIfgwd.js\":\"7a17c6f49a224a15\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-C3avf6-K.js\":\"a60cd44b1039984d\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1919/chunks/AccessHandlePoolVFS-OyPqVlD9.js\":\"146e2349b06cdd0a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/FacadeVFS-Bbe-4gzK.js\":\"800ade3fb1287317\",\"/knowledge-medium/pr-preview/pr-1919/chunks/IDBBatchAtomicVFS-BcxVl56N.js\":\"67a58c27f9490dbb\",\"/knowledge-medium/pr-preview/pr-1919/chunks/MemoryVFS-aklvz2Dj.js\":\"7b82c2c153177cb0\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSCoopSyncVFS-Bif0dEs4.js\":\"da4484e323cb253c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSWriteAheadVFS-DaSl5EQl.js\":\"9841e12e3a69ca2e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/Preview-C8MDCKUe.js\":\"5fa9688ee246be94\",\"/knowledge-medium/pr-preview/pr-1919/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/card-jy3M4Ij2.js\":\"30a60239199816c8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-nrzVUI6k.js\":\"55679dcdb2163caf\",\"/knowledge-medium/pr-preview/pr-1919/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-BKvlS76w.js\":\"a6f1a6c1d089a1c7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-async-B6EbCSq7.js\":\"663bca6c76ee6da8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-6kSdzG0S.js\":\"d3b8cf1a2191b7d5\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-BITGCNJn.js\":\"70d6ff0606c896fd\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-BkBY7MVQ.js\":\"a7663c3f4b7a01bf\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CygsdLdH.js\":\"0ec0e01557771bd2\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DL08DZDy.js\":\"1a4a29fe38673111\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server-legacy.browser.production-C3sCIu0I.js\":\"a119e99d61ae2841\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.browser.production-DXtiNjCM.js\":\"b5fe69c0dd0624e1\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.edge.production-WUo1juCp.js\":\"d747505bd33b7470\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-l-rQQyYT.js\":\"dc89bba63443ef95\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-sc4Hlvka.js\":\"7d63fbe59ea61725\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-xQ_Ch5jm.js\":\"ac9e274162788114\",\"/knowledge-medium/pr-preview/pr-1919/chunks/server.browser-C5G7tNw9.js\":\"466924a712da1b2b\",\"/knowledge-medium/pr-preview/pr-1919/chunks/textarea-BvPr-7NV.js\":\"38e0014d36b59466\",\"/knowledge-medium/pr-preview/pr-1919/chunks/ui-CE5oW77h.js\":\"455e9c037abf600b\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-DiMwuaFR.js\":\"dc46ccc9a5bb52b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-async-DAMXKp9v.js\":\"fe5b0a07c6c5a12a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1919/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/src/App.js\":\"d5cbb9140e78dc9c\",\"/knowledge-medium/pr-preview/pr-1919/src/appUpdate.js\":\"1a0ab2da100ec8ac\",\"/knowledge-medium/pr-preview/pr-1919/src/appVersion.js\":\"06353f54dde2ced2\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/initialLayout.js\":\"05b963404e7ba3fc\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/openWorkspaceData.js\":\"ae8a4c8a60b006b4\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/resolveWorkspace.js\":\"d94e6bc0376f70b9\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/workspaceBootstrap.js\":\"225f9acc5637dd5b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockComponent.js\":\"e48857a7a217a0a9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockCrumbs.js\":\"4a845ac316ab00a7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockEditor.js\":\"2373a4d4f4d8f445\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockLoadingPlaceholder.js\":\"fd4bdfb422ba8250\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockProperties.js\":\"a308a2bc0253d068\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockSearchPicker.js\":\"748df3acbda72591\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ConfirmBulkDeleteDialog.js\":\"32fb25b1a76f2e51\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DividerHandle.js\":\"1f50c013eb40337d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DraftEditor.js\":\"8a6c6ed0fe6733d5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/GutterPill.js\":\"b07099818407816d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Header.js\":\"c906ea20254b837e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/LazyBlockComponent.js\":\"83790d00e889fb5f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Login.js\":\"a260ed376a995f93\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ZoomableSurface.js\":\"f388ac28c606e596\",\"/knowledge-medium/pr-preview/pr-1919/src/components/editModeKeepalive.js\":\"573474c564d68e73\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyDisplay/PropertyDisplayScope.js\":\"dd3078ad857692f6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8485a2203d765fc0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefPropertyEditor.js\":\"c9643ea792f1bc76\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefTargetTypePicker.js\":\"2d8d77559927b245\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/SelectPropertyEditor.js\":\"a8a3e8dae9ad2d02\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/TypesPropertyEditor.js\":\"727afec3f583e9d6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/defaults.js\":\"5f6bcafb3903f088\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/kernelValuePresets.js\":\"89745132da13e361\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/selectablePresets.js\":\"4ee615ec2deb1124\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/typesPropertyUi.js\":\"fbc96f58aabac66d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/AddPropertyForm.js\":\"47428fac0de3bb74\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyPicker.js\":\"4ec94d7df6911683\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyRow.js\":\"46aa8a18175cdf46\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/Rows.js\":\"234feaba7a15c6e1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/actions.js\":\"df343032bc77a78e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/declarationOnly.js\":\"9ee22bc5cfc9ef7a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/layout.js\":\"f1f3466cddb95400\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/model.js\":\"504b193e543386b3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapeUi.js\":\"b2dfef70f31f7b59\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapes.js\":\"c7b8988efc340798\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/usePropertyEditingActivation.js\":\"862bf3bde32e5503\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/visibility.js\":\"444340f367ad5c27\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanelSections.js\":\"f9a02f34d793916f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockEmbed.js\":\"53d4fc100183fef4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockLink.js\":\"bdce75fb145f3c23\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockRef.js\":\"3c0eab0c6833c54b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/CompactReferenceLink.js\":\"6a1c567c5b3a6c1f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/ReferenceLink.js\":\"4c67a0de626011e6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuard.js\":\"a4648126120eebbf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuardContext.js\":\"a0166c36a3b3d9c2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/linkInteraction.js\":\"9ecba823707a6343\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/referenceLayout.js\":\"31eb083fc36012c3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/useBlockRefAncestors.js\":\"a220ce3824839baf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockGutter.js\":\"08bc1a627fa48667\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockInfoDialog.js\":\"c1dc1a517c676fac\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockReadText.js\":\"db163bb495676759\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockTypeBlockRenderer.js\":\"dd72a96db11dbc42\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BulletHoverCard.js\":\"9bce4e6a07b8efe0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorContentRenderer.js\":\"d4048d779f8759b5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2ebf3d6d17e67344\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ColumnResizeHandles.js\":\"5860fccfb0428223\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"73673b1c220e3d33\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/DefaultBlockRenderer.js\":\"f04fd1d7463d06c6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/LayoutRenderer.js\":\"cd55a4f88be947a7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MarkdownContentRenderer.js\":\"aa8e5909cd8fa255\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MissingDataRenderer.js\":\"28ec51e7af159ead\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PanelRenderer.js\":\"690cc7a6a826a4b3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PropertySchemaBlockRenderer.js\":\"7d18ba964e3065c1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/TopLevelRenderer.js\":\"feae67735f09d50e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockGutterMode.js\":\"fed563f77934bf35\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockTitleText.js\":\"a6bca5edb3f7f55a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/fieldCreationKeydown.js\":\"415c4488168412cf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/layoutRootContext.js\":\"dba78a87ae14b80c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/TypeChip.js\":\"f495a7f95c91a0ea\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/chipStyle.js\":\"6c0a8985410f872f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/anchored-floating.js\":\"889b55e1b7b1c3e9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/button.js\":\"f645145e14d930e4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/card.js\":\"f7f502230820ee33\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/checkbox.js\":\"b9298461f20c0af2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/collapsible.js\":\"cb4bde84c243ca21\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/command.js\":\"ef07b0ac01bd34c7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/context-menu.js\":\"012418db3d8dada8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dialog.js\":\"745c4a9044e65d26\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dropdown-menu.js\":\"04f930be3cdcbbdf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/floating-listbox.js\":\"1d132ec88d60d5c1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/index.js\":\"f1ed0313f6f196ab\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/input.js\":\"11b3f931619c37b4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/kbd.js\":\"4a5790c6f89489b3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/label.js\":\"340063209a2956b4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/textarea.js\":\"41678ff9527a358c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/useEditModeYieldKeepalive.js\":\"6deee28f23a39641\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/BootFallback.js\":\"175389e00de9e33b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/FocusedRowLazyMount.js\":\"0a0300dbe5325d88\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LazyViewportMount.js\":\"6373778f1fdc23d7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LocalDbCorruptionFallback.js\":\"af2ff082bcd46baa\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/error.js\":\"0bf53439ee752ec9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/lazyMountRegistry.js\":\"4668b072d11fdb95\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/suspense.js\":\"5277fd627d3ced79\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/CreateWorkspaceDialog.js\":\"c9b8de0909a515e2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/PendingInvitations.js\":\"d68d047ff20999fb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/SyncProgress.js\":\"badea6d19f603328\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/UnlockProgress.js\":\"78b0410edde113e1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceKeyGate.js\":\"f6fe2bb7629e2a73\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSettingsDialog.js\":\"6d7d4df1cef1d310\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSwitcher.js\":\"a9744efc905db102\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSyncGate.js\":\"ebdd4600f9ce21b4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlow.js\":\"40e46af8674e21af\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlowHost.js\":\"76c898f47b624d30\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/EncryptionSection.js\":\"f02b570b2150aaa9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/attachmentPrompts.js\":\"d0b0def2fc45faf4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/bundleFolderPrompts.js\":\"175784ae74fd43b8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowDeps.js\":\"fd316e3a02bd6cf1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowStore.js\":\"518228efa8deeb22\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/flowUi.js\":\"884cd84e45db038b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/useConversionRun.js\":\"a558e5cd697b6319\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/keyUi.js\":\"dbdcc5b2ed0bb5c0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnKeyLoss.js\":\"a9d9588b29f6b734\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnServerE2ee.js\":\"0497b633d83988d0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/workspaceUnlocked.js\":\"a3d1a81e0f0adffc\",\"/knowledge-medium/pr-preview/pr-1919/src/context/backgroundSubtree.js\":\"88be564e5943549b\",\"/knowledge-medium/pr-preview/pr-1919/src/context/block.js\":\"f31880406f1b3781\",\"/knowledge-medium/pr-preview/pr-1919/src/context/layoutWsContext.js\":\"3af9b1d2853eaa5a\",\"/knowledge-medium/pr-preview/pr-1919/src/context/propertyDisplay.js\":\"6dde34309a98a2cd\",\"/knowledge-medium/pr-preview/pr-1919/src/context/repo.js\":\"4f69577e99960189\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasClaim.js\":\"d1addda810ae22fb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasSeatNamespace.js\":\"12b0638709ffd913\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockData.js\":\"f1a5b4dbb25826a6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockType.js\":\"ca15b1a5ed1bec8c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/changeScope.js\":\"c43bbfdee4676edc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/codecs.js\":\"9018bb8011166b5f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/derivedData.js\":\"0c6cd4f7f675e29a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/errors.js\":\"995f6c7231ab9922\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/events.js\":\"ad8cae7a6eb948fa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/handle.js\":\"e8a57bb2fbe3e76b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/index.js\":\"771460f47fa3592b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/mutator.js\":\"26c1228ec04267bc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/processor.js\":\"045f730afd457eb7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/propertySchema.js\":\"2f2993aa6efc52dc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/query.js\":\"be312ed376df1d67\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/sameTxProcessor.js\":\"7a8af44967d9de75\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/schema.js\":\"e8a57bb2fbe3e76b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/tx.js\":\"e8a57bb2fbe3e76b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/typedBlockQuery.js\":\"697fc6cab8d8a870\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/user.js\":\"b2a8d68f7b68b2a9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresetCore.js\":\"643362e90a10ff1f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresets.js\":\"eb2e60da2f50fb04\",\"/knowledge-medium/pr-preview/pr-1919/src/data/attachmentCleanerIOVerb.js\":\"3fdcf77a8e068bb8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/block.js\":\"e95ba457c0d4227a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockCache.js\":\"6348d737cef469c4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockId.js\":\"ed749ba136d1ed6a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockLiveness.js\":\"04d6b794fc19653a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockMerge.js\":\"bd5919377ad76c1e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockSchema.js\":\"319e32f28ae39975\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypeLookup.js\":\"65b942398ca1ed28\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypes.js\":\"4ae80a6f13084a05\",\"/knowledge-medium/pr-preview/pr-1919/src/data/childrenView.js\":\"9f4ac7e7736417d5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/clientContext.js\":\"e28196b66df9c79b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/dbFileSiblings.js\":\"1ab198e6930b4ba0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/definitionSeeds.js\":\"598ba4b7554bc3dd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/derivedIds.js\":\"6cc3e5fc7cbb9c00\",\"/knowledge-medium/pr-preview/pr-1919/src/data/drawnSubtree.js\":\"2be21045229ad867\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facetBridge.js\":\"202ac40153c4adb2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facets.js\":\"3550b09b09dbe05e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/globalState.js\":\"89a63ce10ddbbbe5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/aliasClaimRederiveProcessor.js\":\"01c884e4766b4faa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/ancestorBatch.js\":\"7a20162ce9da4bc7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/blockTypeTypeifyProcessor.js\":\"0555161d7e510ed9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/clientSchema.js\":\"16415673fed4a112\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/commitPipeline.js\":\"4b960369954b9477\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/devAssertions.js\":\"91dbc39a635e2445\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/firstSync.js\":\"b261d98f2fe2b85d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/freshInitialLoad.js\":\"2146b3738f7ac417\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/graphBackfillClaim.js\":\"a00bcf106da824fe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/handleStore.js\":\"1664a8b3433f03ee\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/idleMarkerJobs.js\":\"fce4af95658bde6b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initialDownload.js\":\"3c73213ca84affa8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initializeClientDatabase.js\":\"2d5d313bf42fad65\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/jsonCanonical.js\":\"9de01354a66ceba8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelInvalidation.js\":\"78ece80bbed2317a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelProcessors.js\":\"be897c5c3c562f03\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelQueries.js\":\"c2107942378b5cd1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/mergeTypeMembershipProcessor.js\":\"a215889b88420862\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/normalizeReferencesProcessor.js\":\"2cefabd4c743fa5a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/poolInstrumentation.js\":\"7d9ca08a70770e08\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/processorRunner.js\":\"0ec580a3c1e93867\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyCellBackfill.js\":\"4b4e8a439e82c1d1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildMint.js\":\"f01edadd63798175\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildrenProcessor.js\":\"e61bc2d11d50d3d2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionChangeProcessor.js\":\"d407f107cb24898d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionSynthesis.js\":\"64260c15793bd4e1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyKeyScan.js\":\"2e96dfdb78bd86b7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertySchemaResolution.js\":\"5486eb8381e48c50\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyValueEdits.js\":\"16fc4af0a8073464\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/raiseProtocol.js\":\"663cf38e308bb0af\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/readBatch.js\":\"f34dfcb4e099636c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/refProjection.js\":\"f22b88370dadef1e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetLookups.js\":\"d0158fe84d7cb093\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetProcessor.js\":\"d9b028f9c7a359f3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/replayMerge.js\":\"e5a1469cb87c378b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/sqlBinds.js\":\"74277e1de976d248\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"976c4009d39ab562\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/arrivalProcessors.js\":\"5ce317511abb5542\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/invalidate.js\":\"48ef33ff26cb9619\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/materialize.js\":\"f2854b01de26dd1a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/observer.js\":\"0737f7ea4b3a645c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/reconcile.js\":\"b3a2dc92d0462d70\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/timingMetrics.js\":\"52627322fde33f0d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/treeQueries.js\":\"7d27c5ad11133354\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txEngine.js\":\"2f5dcf1db8385b61\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txSnapshots.js\":\"fc797c9c1f668fcb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/typedBlockQuery.js\":\"004e981189775b80\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/undoManager.js\":\"4e8faf1d22ce2167\",\"/knowledge-medium/pr-preview/pr-1919/src/data/invalidation.js\":\"3280bd046c3cb29f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelDataExtension.js\":\"24bd9bc4c920493b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelPage.js\":\"53d38989a00311f0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelValuePresetCores.js\":\"f477007e9f322a45\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbCorruptionSignal.js\":\"eb15ed80a813f1bf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbStorage.js\":\"2e33e0622e750382\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbVfs.js\":\"5baa1f0092c946f8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localSchema.js\":\"ee047fd7b2a3be26\",\"/knowledge-medium/pr-preview/pr-1919/src/data/maintenance.js\":\"cb7445b0a2e77a28\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mergeProperties.js\":\"0033670d522e5a56\",\"/knowledge-medium/pr-preview/pr-1919/src/data/metricsConsoleHook.js\":\"f533afd9728e4876\",\"/knowledge-medium/pr-preview/pr-1919/src/data/migrationsPage.js\":\"ca8fc02c6083c69d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mutators.js\":\"bfd65202d503442e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKey.js\":\"993e93033ad2c7b1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKeyPlacement.js\":\"0fb63c849b558ae6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/outlineSurface.js\":\"afca0086ad76874c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingEditorContent.js\":\"0f650509fb53de96\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingUploadsSql.js\":\"3e6135df25e7813e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pluginStateExtensions.js\":\"964761fa91cc9fa0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/powerSyncLogger.js\":\"ac398e2df2aa20ae\",\"/knowledge-medium/pr-preview/pr-1919/src/data/projectorRuntime.js\":\"6c7da3f8b1e45d3b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/properties.js\":\"267bf6c3a2e65a94\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertiesPage.js\":\"9c4331da57ddc03f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyChildren.js\":\"e71549c6b62dadba\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionFanout.js\":\"b8ddbc68c90be758\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionMetadata.js\":\"f2d8b6dc55189a57\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionRegistry.js\":\"bc763fc6a356021f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDisplayMode.js\":\"7e23810138aa23c7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyRowCreation.js\":\"2e87ca09a6b0a04e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySchemaCreation.js\":\"ef519da691db8b0f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySeeds.js\":\"ad139d534bb08ec7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/recentsPage.js\":\"573b1d0f353ced1a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/refTargetComparableProperty.js\":\"bd59ec5c743c4d3e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/referenceBlock.js\":\"a64647d61c2ffb17\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rejectedUploads.js\":\"77398e055fa808ef\",\"/knowledge-medium/pr-preview/pr-1919/src/data/releasePowerSyncConnection.js\":\"6787519ca23a2915\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repo.js\":\"7b16002d902631e1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repoProvider.js\":\"8983e3d45010426e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rowProperty.js\":\"ef29eab5b12ac6f8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/searchFilter.js\":\"0533093fc2b5b0da\",\"/knowledge-medium/pr-preview/pr-1919/src/data/seedIdentityLedger.js\":\"369f485e515d1836\",\"/knowledge-medium/pr-preview/pr-1919/src/data/stateBlocks.js\":\"8dc66e687814fc95\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralEditPolicy.js\":\"41834eccefcff873\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralInsert.js\":\"1b4f9ed0fd416803\",\"/knowledge-medium/pr-preview/pr-1919/src/data/subtreeDelete.js\":\"b25b9a723755df07\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncStreamLock.js\":\"a059f9fc65ff96e0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableSqlRecognizer.js\":\"cb8617d8b94b4a7f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableWriteGuard.js\":\"574ce0b3dec15926\",\"/knowledge-medium/pr-preview/pr-1919/src/data/targets.js\":\"88edb2bef01e67aa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeColors.js\":\"cea413cf4890bdec\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionMetadata.js\":\"8a927a9386eb42cd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionRegistry.js\":\"a63a6e5311bcc1e4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeExtraction.js\":\"e3fdd9fbe47c5914\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeInitialValues.js\":\"3cd27321c1570b3e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typePropertyGroups.js\":\"70f2057085f5506e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeSeeds.js\":\"c2842442fe20ab26\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeTagger.js\":\"186950e6c1e44599\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typedRecords.js\":\"f6d9b7f3314edb33\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typesPage.js\":\"f5b310aeca068f3c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userPrefs.js\":\"e4e20efec96484e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userSchemasService.js\":\"ae61a3072387c1f3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userTypesService.js\":\"6d1bd077a62e1b1e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/valuePresetRegistry.js\":\"6f85836ffa8e6b74\",\"/knowledge-medium/pr-preview/pr-1919/src/data/visibleChildren.js\":\"001853cfe47945f9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceConversion.js\":\"eb4eec4630842e79\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceFirstSync.js\":\"6a08a94e74c677ca\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceIdNamespace.js\":\"83e4e554b5dd117e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceSchema.js\":\"3c9071d1c03ba2fc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaces.js\":\"cf5b27f6d0dc3896\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadLog.js\":\"261382752b0629e0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/BlockPasteShellDecorator.js\":\"184cdd3751bf4b06\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/atTrigger.js\":\"1d4559e5a16b34a3\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/autocomplete.js\":\"65e570a2fdd44238\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/codeMirrorExtensions.js\":\"e9aee01d19ab5a93\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/contentFlush.js\":\"c56024f558b7ce07\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/defaultInteractions.js\":\"89fa92519f6bca3b\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/editSettleSignal.js\":\"e0161045f8368e2e\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/insertImage.js\":\"70832fd312c9f43a\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceCompletionRange.js\":\"ef5cc84ae8e51508\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceTargetTypes.js\":\"2fa1b0f59438403d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/syntaxContext.js\":\"53c7978ceeecdec6\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/triggerMatch.js\":\"07cf8ba46a767d7c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/AppRuntimeProvider.js\":\"461f194fd5492c2a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/BlockFocusShellDecorator.js\":\"2e9835d0c81c4968\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/ExtensionRenderBoundary.js\":\"aaa9932d0201d698\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/PanelContentRecovery.js\":\"a04648ff4eb18ed0\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/apiCatalog.js\":\"ff51a1125657e262\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/appRuntimeController.js\":\"d32f79e9345c77a8\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/approveExtensionHere.js\":\"871d15693a917660\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/armedCutAppMount.js\":\"67b3378df2fc8631\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/batchableKeyedStore.js\":\"65122e8333d33e90\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockInteraction.js\":\"29e388edefa51377\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockSelectionAction.js\":\"218b55c705d3f593\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compileExtensionModule.js\":\"53a6b980b87095a8\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compiledModuleCache.js\":\"3a70a65802e735d1\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/continuousGestures.js\":\"b6afa63ca5857cc4\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/core.js\":\"ac02724cb8115735\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/defaultRenderers.js\":\"0b86949bc85f4946\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/definitionFanoutAppMount.js\":\"9c98a30fdde22a45\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dialogAppMount.js\":\"da8e89e170573400\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensionSeeds.js\":\"82e869e93e382a76\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensions.js\":\"f5db75786c2e7ae5\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/exampleExtensions.js\":\"90e964e8c79a720f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionApprovalStatus.js\":\"29219c253a69ba26\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrorToast.js\":\"0e92f45dada0879e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrors.js\":\"4cc551977ca9d9ad\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLookup.js\":\"284c02e59442b37a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionToggles.js\":\"aa59c38ab4080782\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionUtilitiesCss.js\":\"e98024698501eebf\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/kernelPageDeletionGuard.js\":\"7a10b974f9f3b07f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/liveRuntime.js\":\"526f6e69f749d177\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/openExtensionsSettings.js\":\"51490ba6421cc05c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/overridesCache.js\":\"ca4ffc5f445c17b5\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/pluginIds.js\":\"920b2638eb4831bb\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/processorRejectionToast.js\":\"0f8672d7dcdd064a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeActions.js\":\"c2ff121a638f346f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeContext.js\":\"a0886319083e2f4e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticAppExtensions.js\":\"41d064aa19b4b3c4\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticDataExtensions.js\":\"2b069f698604e177\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/toastAppMount.js\":\"09950f3cfd4d99a7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useOverrides.js\":\"398b792c3a39c604\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useShortcutSurfaceActivations.js\":\"7bea8968d27fff42\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/discoverToggleTree.js\":\"9a77f2db2e7160ea\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/facet.js\":\"b340a18efd80596e\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/resolveAppRuntime.js\":\"db76d75eae85677b\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/runtimeEvents.js\":\"558969898ec6e40a\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/togglable.js\":\"513dbf8409f51add\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/variantFacet.js\":\"ff86455a6038e586\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/verbFacet.js\":\"a2657bd4ed1f0cd7\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/block.js\":\"428ebe69fe9684bd\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/focusedChild.js\":\"b433f54616f15b4b\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/propertySchemas.js\":\"6135e089c18a8058\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/typeRegistry.js\":\"1cde62eafb53042f\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAncestorCrumbs.js\":\"b6928f33c6a16a56\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAutocompleteListbox.js\":\"9330ecb9282aabd6\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedSearch.js\":\"30c24ab3f3d70524\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedValue.js\":\"99ad0a2e0dfeacfe\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useFacetValue.js\":\"b3d64d4b3fafbfc8\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsFocalRender.js\":\"014b1957f686f120\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsReadOnly.js\":\"bb2951704d0b8fdd\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMaterializeBacklog.js\":\"e0502927dd699bc4\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMinuteClock.js\":\"7b9369d14717b6e3\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePanelLayoutProjection.js\":\"73240dc8fa3df36e\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePendingInvitations.js\":\"975d0ad9370b3c46\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRendererRegistry.js\":\"f66ac90884768dc5\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRetainedFieldRows.js\":\"94fbbefa5e8a0f8a\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useWorkspaces.js\":\"3043b361bcec1ff8\",\"/knowledge-medium/pr-preview/pr-1919/src/lib/utils.js\":\"44a85a4659a929b2\",\"/knowledge-medium/pr-preview/pr-1919/src/main.js\":\"96a2a124e62ae762\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/MarkdownImage.js\":\"96e03a406e21b195\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/blockSeparators.js\":\"ad0f4908c3757e3c\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/context.js\":\"b433696d36db7c02\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/defaultMarkdownExtension.js\":\"960e3a9d41fb5fe2\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/extensions.js\":\"e2a879a20d174e30\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/renderMarkdownHtml.js\":\"c68d44c12c58f152\",\"/knowledge-medium/pr-preview/pr-1919/src/minimal-editor.js\":\"77995f02b5b46c49\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/armedCut.js\":\"edb82f8ad485f7a7\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/captureMediaVerb.js\":\"73a29f87a6b84225\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/clipboard.js\":\"7ac2f58cb0c1e3d0\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/decision.js\":\"3234e77c86b99cc3\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/operations.js\":\"080d3c240f292243\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/AccountHeaderItem.js\":\"bf0cef77414cff81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/index.js\":\"23e3894ab8e41fb9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"aedd4a4deccb6805\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askAgent.js\":\"3e4a711929f7e513\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askedStore.js\":\"9c1ccb21dc226cee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"9a11c107b78fd7da\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/chipState.js\":\"1113057eab9b4a67\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3f4ec64daea96fd8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/index.js\":\"ab86441db6675320\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"458db29576d77479\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/schema.js\":\"32a49cc1b0ff9d24\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b7d47ef72b1cbef5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/BridgePairingDialog.js\":\"e7da214f987e1466\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/addMedia.js\":\"dccf71a9d3ece730\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/backlinks.js\":\"bb33afad9c6202c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/block.js\":\"485e790131e43a27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/context.js\":\"d74227ffce00aaae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/displayIds.js\":\"81ceea124f3ff9ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/index.js\":\"a4a5723e00b89e15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/outline.js\":\"e7e49c4ff74c6be8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/properties.js\":\"2a7645b6ecf6e2a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/refs.js\":\"aa29a2893036e8c0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"53a5064b5aa8f255\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/search.js\":\"b7f9b8b113ff4bfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/shared.js\":\"fb1eaabb29881f27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f4a8df0e672fb3b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/text.js\":\"85f3398f27973a7f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentWrites.js\":\"25a7494c392269a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/authoringCatalog.js\":\"1c3192f62f7b2cb9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/blockRefTargets.js\":\"a39ae8e1c3cc2d0f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridge.js\":\"1a4b53db84140873\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridgeLoop.js\":\"645b73ca239fc5f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/changeHistory.js\":\"a99167f40d9ab4cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commands.js\":\"1147c092a5221130\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commentsCommands.js\":\"86c54223d4a2f50f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataExtension.js\":\"d1b9c8f4f0375ca4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataModelGuide.js\":\"ed45ff710dd632ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dayPropertyInputs.js\":\"427c3ed87645c5a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/describeRuntime.js\":\"06c8c4f5061feb1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/extensionLint.js\":\"669f26d9f133a008\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/grainAudit.js\":\"f27561e5ea3d64fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/healthCommand.js\":\"559b56244a9843d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/index.js\":\"ee0c31490967e88f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/presetIdentity.js\":\"dea1fc1e9692e76d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e863b0a01aeeb336\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/readMedia.js\":\"cd6b8211db274f61\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/schema.js\":\"4405dd9da1716b53\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/serialization.js\":\"bfc34a4998079ef6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/targets.js\":\"e974e7a502991023\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/tokens.js\":\"eee772f9f5055b19\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/watchEvents.js\":\"3a9d5e5cfac57ca1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/workspaceGuard.js\":\"0308e34904a5562e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/writeCommands.js\":\"d280f0b3604e5ed9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/AliasCollisionToast.js\":\"4e3881117388bf06\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/DuplicateNameBanner.js\":\"dd8d4f53a7cae6ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/collisionMerge.js\":\"3ceec41449500fea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/dataExtension.js\":\"2333309c41063f9f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/index.js\":\"221b4fe27b4ed4af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/mergeCollisionAction.js\":\"580fefa938cea954\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/pageStyling.js\":\"b6e89c614028ee09\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/rejectionToast.js\":\"5a39b300a56d1750\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/syncProcessor.js\":\"795e3c047427fa2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/actions.js\":\"7c8618c976c01dd2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/addComment.js\":\"9e3bdc4cdde69fb8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchor.js\":\"d624337ef1f0d42a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchorState.js\":\"28e4b65a813c58ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/commentLinks.js\":\"cf6bed03727804ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/confirmThreadDeletion.js\":\"094a426bf5b6052a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/container.js\":\"ef907ccfddb7d3cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/dataExtension.js\":\"62e95fe69fdd8f4b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/deleteComment.js\":\"ebfc17bf4921f5bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/highlights.js\":\"1264c87ad62f9908\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/index.js\":\"69c3e0bf8fe6ba6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/linkedCommentsPill.js\":\"16505342966f2f14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/margin.js\":\"69c6570e2e682c2a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginAnchorLinks.js\":\"260f8ce608659475\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginSchema.js\":\"1f56f8799e832f00\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/newComment.js\":\"a272061d7b558edf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ownThreadPicker.js\":\"c2dbbadbed86a343\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/placement.js\":\"d2f9ec200d674564\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/queries.js\":\"fa74ecf89a90211e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotePosition.js\":\"b6da314c9c3437e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedIn.js\":\"f49924d090cace4d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedRange.js\":\"b46f1fe8f220c319\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/rangeRefs.js\":\"1980b03192186b85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readHighlights.js\":\"6d2273f14be1b3f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelection.js\":\"03c2dc70789450de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelectionUi.js\":\"8ab618f8bfe1fd92\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/reanchor.js\":\"1c135e5b253da71e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/schema.js\":\"3e4f656eaf93e194\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scope.js\":\"0e86569f4e9334c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scopeThreads.js\":\"c602e84cb5c02046\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/splitRetarget.js\":\"6462620390564919\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestionCard.js\":\"dc6f35be8be7fd7c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestions.js\":\"ebdbf5b66b67ae74\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaries.js\":\"2eef99d35eec7049\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaryBatch.js\":\"3f7cbcb855fd7904\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/surface.js\":\"c61bcc91d85ea07c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threadNavigation.js\":\"39db307e72b07981\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threads.js\":\"5bf9a114e86fc1a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ui.js\":\"b57d5fd715af3a96\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/uiStore.js\":\"fd924dd6fc230b0d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/appIntents.js\":\"e7dca3647af35a57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/index.js\":\"0b9dcc273af3b740\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/index.js\":\"7c7a1b584c118e5e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/status.js\":\"42eaacd0c99cedbe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a47c42d103f800a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaBlockRenderer.js\":\"07fc4e43c09e720f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9471af04b86a3240\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaUploadReconciler.js\":\"5be8b55df4297b23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetDownLane.js\":\"57fe30dc1a261f8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetResolver.js\":\"6ebfa72be63cacca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetUpload.js\":\"1b16d48fba15b309\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/attachmentCleanerIO.js\":\"38c4e8b0081c5338\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/supabaseAuditIO.js\":\"51437a1f53597ee0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/blobStore.js\":\"2b90e1ff0829550d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/browserMedia.js\":\"4ab88b9eebcec849\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/byteStore.js\":\"a43a3b1622376ffa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanerIO.js\":\"9d939a571cfffd2a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanupAttachments.js\":\"3274fd5806664a63\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/dataExtension.js\":\"0d4ed368b4c616b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/downLane.js\":\"29f90f5bc524b818\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/index.js\":\"42f4c5c4cc762a52\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/insertImageContribution.js\":\"e5cea620c26c0df5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneArming.js\":\"b6157b09637b10dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneLock.js\":\"7b59862352f07a8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaBlock.js\":\"7f24b9517a696c01\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaCapture.js\":\"4fe16eee90970710\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaLanes.js\":\"1d45d43a64513229\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewers.js\":\"7800a6f72495a76f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewersFacet.js\":\"161f0b3d7aada2dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/pasteCapture.js\":\"bc3f5beee6d11369\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/resolver.js\":\"772d1afb6407e520\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/retryUploadsAction.js\":\"686f174949b1bc80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/storagePaths.js\":\"95cb49abe92572c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadDrain.js\":\"6a30d70a3251da2d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadLaneStatus.js\":\"d4c300d15bd52a72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadReconcile.js\":\"ebd40d542ac08cff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadRecovery.js\":\"1028471c2f5c54e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadStore.js\":\"e9f2e6755f1f2b33\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/useAssetObjectUrl.js\":\"d7363f1b42fb62c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"96c220f57c917b25\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksViewSection.js\":\"5a8eafb5b3e2b47d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/facet.js\":\"ee666f3d4cfb08a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/index.js\":\"257c10e67274ff21\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/prop.js\":\"817598c317e3dd2a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinkFilters.js\":\"9238886f99e80812\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e0ef8c9838f45b57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BlockEntry.js\":\"014e64a4e7916911\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/LinkedReferences.js\":\"962b56b23f011421\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"37bdc7ab04c424e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dailyNoteDefaults.js\":\"a62ab4b1137937db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dataExtension.js\":\"c41a063030d24abe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/edgeExclusions.js\":\"56188505e7807ea6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/filterProperty.js\":\"b7179570dfdb1cba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/index.js\":\"6eb6e96e99b9c8ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e997bc00ece06dfd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/applies.js\":\"70e59428394ede2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/countQuery.js\":\"c320b0677e058e73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/expansionStore.js\":\"e164b5a3fa8d884e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/index.js\":\"8986931b5b161013\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"aa4bd83684e9ac1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/presentationInvalidation.js\":\"a92de5d6f0c95b72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyEditorOverride.js\":\"59ee4aaed22422c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyFilter.js\":\"129fa87331479bdd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/query.js\":\"71604119784f2c87\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/resolveFilter.js\":\"645cca540f4d6153\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sourceBatch.js\":\"a2b3974fa333b2ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sources.js\":\"a55cd8ec933ee416\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useBacklinks.js\":\"2bc45a79a00f1b7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"9635063b3b2f81eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayCelebration.js\":\"3046569da458765d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayOverlay.js\":\"053870b607f84300\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/gate.js\":\"e47747f3ea905817\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/index.js\":\"0826c6e3384d15f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/wolfTheme.js\":\"de88716cf2dd2fa5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/BlockDragLayer.js\":\"dd0fe2c24030f5b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dragController.js\":\"f5a35e1700ba8e9a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dropTarget.js\":\"aa7efe0fb60b800b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/index.js\":\"20083eb750aa6039\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/projection.js\":\"71d3e21368e88566\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/BlockMetaCard.js\":\"132798cbf08b8d0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/index.js\":\"e5d8f549e7943fec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/AddTagDialog.js\":\"5dbad88154347913\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"5202646dd04503b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/TagNameIssueHint.js\":\"c636b6799598a905\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/addTagAction.js\":\"5e860002b420fcea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/appendTag.js\":\"c1c5806a637c4bc6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/config.js\":\"79a5767b0b072ba4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/dataExtension.js\":\"8a36b91bf42f5a89\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/index.js\":\"6a91afc60a2a4d59\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/propertyEditorOverride.js\":\"5394c87dc1cb1503\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbList.js\":\"718078ed51d95d1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"4c7ffadc87c394ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/Breadcrumbs.js\":\"efd70bf73839ac8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"5688838ec797ebd3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"93a68b29938f1f76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/index.js\":\"56c99e6fc12cc565\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"079f6f00c03d5e6d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/CharacterCountItem.js\":\"240f38341201f4b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c02b63c723338d8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/actions.js\":\"a3c6e61a6af95221\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/blockType.js\":\"b96471720744bdc7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/charCount.js\":\"268a16d49addd101\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/dataExtension.js\":\"79658f46ebe54c15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/index.js\":\"1d4ca283ca567fe1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/profiles.js\":\"81a5be51bc3d6da0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/properties.js\":\"ed239a107b5c5fc8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/subtree.js\":\"6e24a353d57a12fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/textCounts.js\":\"cf617c79df070a88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/colemak-keybindings/index.js\":\"f623f7abf24e5f84\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/CommandPalette.js\":\"584af187129a6c5f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/HeaderItem.js\":\"4fef91ad2afe54b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/context.js\":\"97d3e82c67b418ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/index.js\":\"8c3ca1b179aafd34\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/selection.js\":\"d8d6c1aaf7cb90fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/toggleStore.js\":\"93b77a220a5a06b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/useCommandPaletteActions.js\":\"b624719cd84da1d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ContributorBadges.js\":\"eab46dbe316da7e4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ProfilePicture.js\":\"86ea135c9f101aad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/author.js\":\"b5ad800281b77c76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/codeMirrorExtensions.js\":\"3746d8c9a9425eda\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/dataExtension.js\":\"e65adf1cb210f7ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/index.js\":\"83dc0184323a3740\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/mentionAutocomplete.js\":\"7209ac96dda27167\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/processor.js\":\"3a32cf1b372e7528\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/profiles.js\":\"2445878b80a0edae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/queries.js\":\"901ee288f2aba6de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/schema.js\":\"ec52d50539a60ae9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/useCommentAuthor.js\":\"ae58d0484bef1acf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"4f97e0112e5767e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/followOrigin.js\":\"ecdc87a09dce94c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/index.js\":\"2985c9e61069eb93\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"705d3d19f3a31a11\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"94bba6069c497859\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/CalendarGrid.js\":\"fe967c38ab3b2d12\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DailyNotePicker.js\":\"76004e36d179002f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3e84d88d50d39bb5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateNavDecorator.js\":\"db4d377df90353a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateScrubOverlay.js\":\"b955f9cef5e920ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayPropertyControl.js\":\"3c6d59960a3c484c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayValueReferenceControl.js\":\"bdd2a407b825aa38\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/HeaderItem.js\":\"ad11b1e9168940cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/ReschedulePicker.js\":\"109be84f8c1f3b88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/SpreadDatesDialog.js\":\"5020685a3a4a8137\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/actions.js\":\"902a544e6333fb13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/blockDateAdapter.js\":\"bebd548b802810b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/calendar.js\":\"dbc0a0e0725a020e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dailyNotes.js\":\"876d8b27c055b67f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dataExtension.js\":\"7c451a8422b12f32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubActions.js\":\"159644f06adaf82f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGesture.js\":\"c4a6527fb4f64b9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGestureActions.js\":\"26af3a242d8d0add\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubRecognizer.js\":\"dde8879fd0467c4c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayProperty.js\":\"b65b51564d78cdda\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"dba6a3a60e0b4787\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/deletionGuard.js\":\"9da11dc527e4bff6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dueQuery.js\":\"4a90f24a08ef2309\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/index.js\":\"a0673264925f9ba5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/landing.js\":\"36d90fac4f6701c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/localSchema.js\":\"b1255f90a068e66e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/referenceDateAdapter.js\":\"2ea56eddf5c08865\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/rescheduleAction.js\":\"d1926773cfb3cb36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/schema.js\":\"6c6076e775e9255e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadBlockDates.js\":\"8541550ccaba36cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadDatesAction.js\":\"365ca6e52796111d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/today.js\":\"2231aa89502f8cc8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8bb994b260716855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"cf3c8d1147e36695\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/audit.js\":\"567c98e3384e9d5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditAction.js\":\"b1c6da55f090c0ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditRanges.js\":\"c513714f1fe75089\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/diagnosticsSource.js\":\"6be3553aedff1bdd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/divergenceScan.js\":\"a6f6d8592444670b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/index.js\":\"878c30e50359564d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5703aab528c26ba9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/referencesMirror.js\":\"ca1417d008af0d1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/rowJson.js\":\"a8da3ec663677aed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/schedule.js\":\"53212c7f0ddb9f34\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/store.js\":\"98efd99f2ec12b46\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/action.js\":\"2f31c9d71e60e757\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/index.js\":\"3148274796b7311a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/plugin.js\":\"87df663cdf8c4f6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"fc06679298de20d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/actions.js\":\"8cd18e9bb4f6eef2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/changeMarker.js\":\"36899bf8738fb325\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/diagnostics.js\":\"2ea3feee74854f16\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/fileSystemAccess.js\":\"9bdf72dc465f05f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/filenames.js\":\"1248733b4b4c1a2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/index.js\":\"90ad8b3b6aa4dba3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/mirror.js\":\"e140fb6bbef4afbf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runLock.js\":\"d1bba0d52bbc7708\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runtimeHealth.js\":\"98f238439f798822\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/schedule.js\":\"3fad02cddc2450bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/store.js\":\"b6932447a6016a72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/index.js\":\"096ad608c57c8036\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/themes.js\":\"d1a7d3abd7099f05\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/facet.js\":\"5835f19a43ae96be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/useDiagnostics.js\":\"8a6cfcacb0212f4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/dismissals.js\":\"8df88ef93eabc66b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/index.js\":\"87763581fb330686\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/status.js\":\"340bbb7707b876d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/store.js\":\"f2d11c825a529717\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"7721b0fd067a1d67\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsSettings.js\":\"35ba1bca203882f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/actions.js\":\"35e29259045d1ab3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/config.js\":\"c390fba63d636c70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/dataExtension.js\":\"07ca973742167b4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/effect.js\":\"a04726cec34610ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/index.js\":\"6a147bfa3a521a13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/propertyEditorOverride.js\":\"c132fa3d8e6cc08b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/useToggleTree.js\":\"2a1928152529423c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/ExtractTypeDialog.js\":\"7174df3a45a5a316\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"09dee53264e8a400\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/PropertyShapePicker.js\":\"6f21a4ffaae5b1cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/action.js\":\"a8690251cf5b0e8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/index.js\":\"9f82d033f1c88f14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/FindReplaceDialog.js\":\"b5d6ccbcb8c4a615\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/HeaderItem.js\":\"30ac12b9cf2e90aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/dataExtension.js\":\"bd3469e36407aa81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/index.js\":\"9ea458e11f120b04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/search.js\":\"86ff492f1ef00efe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/toggleStore.js\":\"579146af056e7130\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/LocationPropertyEditor.js\":\"5397c46a351407b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/MapView.js\":\"dea5efc8900cfed8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/blockTypes.js\":\"5812bb839ca48e06\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/codeMirrorExtensions.js\":\"a9e94a684d24470a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/createOrFindPlace.js\":\"0a3d0ae64d79f171\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/currentLocation.js\":\"6170e40a901dc604\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/dataExtension.js\":\"6ea5f0bc10259c63\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/geoContentDecorator.js\":\"48cba4c4388358e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/googlePlacesClient.js\":\"91ca9d1f223c1438\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/index.js\":\"8c8e26ab8be11b15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/locationsPage.js\":\"c593b41b355ace31\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/mapViewport.js\":\"c7ace61955f60abd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/pickCurrentLocation.js\":\"7cd498400d518623\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeAutocomplete.js\":\"160b24a812be71bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeNameCollision.js\":\"3c3cf35a0976a5cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/properties.js\":\"69566d074628ee10\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/propertyEditorOverrides.js\":\"3e8e8d745e9352d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/query.js\":\"fd01da6974232f9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/usePlaceSearch.js\":\"4b88ff87507e12e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"117f0715d5f783ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"ad101f5a806753c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"e04e1d9f7714da07\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/config.js\":\"48d40288ad0b93aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/dataExtension.js\":\"001e8f85a1842754\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/facet.js\":\"0dc2095cf2fdc530\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/grouping.js\":\"93ce04405506a431\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/index.js\":\"56699629f4c08114\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7eaea121f3a0e39e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/query.js\":\"1e675f2d1a134258\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/resolveConfig.js\":\"4b1133bfd5aa65e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"9bf59b1fafaa96fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"a8c51d80f8fdc81f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlDocumentContent.js\":\"d3c339442bd3cfce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlFrame.js\":\"0f2867deacc3d337\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/actions.js\":\"6c7ce45ea0066bb6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/blockType.js\":\"73674cda30a92612\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/confirmRunScripts.js\":\"092dd0cbf1fad827\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/dataExtension.js\":\"17310a282db2e70c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameAnnotations.js\":\"af339e5966b04e70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameDocument.js\":\"1008ca87fdfcaf4c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameTheme.js\":\"45bc86aefff2acbe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/index.js\":\"662d7574ebe47a21\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/scriptConsent.js\":\"cca16532a72b5021\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/sourceMap.js\":\"db12d73926e7c475\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/useDocumentScripts.js\":\"e14310ab693047ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/index.js\":\"9217e207c5c3e60a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/record.js\":\"27e0936353b7bc7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/recordStore.js\":\"df630f5676a7cd74\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/responsiveness.js\":\"bb176a13bfb522c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/schedule.js\":\"c94c9f5b51d01d67\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/sessionContext.js\":\"9cfda8745919fd6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"352cd77a702ce7ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"039c99bac67daa1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/actions.js\":\"9381331d075b61e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/config.js\":\"aaec964f99b4446d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/dataExtension.js\":\"2753a4342feea645\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/effect.js\":\"5773987ae03d24d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/index.js\":\"f53b91f742eb3b6c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/keyCapture.js\":\"ed7b727654429381\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/overrideStore.js\":\"403f809c09f36ee2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ef6dee79830a5c13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/HeaderItem.js\":\"14133fc921e34423\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/LeftSidebar.js\":\"02934d230c32a359\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/actions.js\":\"975e4e55da526d9d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/facet.js\":\"d282b5dcb2fbf8b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/index.js\":\"a9027a364bb27129\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/shortcuts.js\":\"8414706b04bb193d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/toggleStore.js\":\"4e0b47219abbecb7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/MergePicker.js\":\"1f08e74cd895b442\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/index.js\":\"77989b5db972eff8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/mergeAction.js\":\"ad1405c319427037\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/strategy.js\":\"ad3b3039b34511b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/Button.js\":\"c10334b6929c66e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"5ed841e5fba5d9f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b006d0994359afb6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/facet.js\":\"e631e8bbb55bda2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/index.js\":\"2754f359143f458d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"87a0a4c5013782a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/actions.js\":\"0f36e3c30291086b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"43cc4801bef490be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7e9ca446740095d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/index.js\":\"297d81322fd09488\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e781097ac25eaa95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/blockSubtreeMembership.js\":\"7ac8cb9373fa7d85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/contextMenuItem.js\":\"cce79b5c57c5debd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/index.js\":\"f9ae9d6044e7bf59\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveAction.js\":\"8e8f8eb0d15e20fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveBlocks.js\":\"8ce828c76c3f526a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/selectionAfterMove.js\":\"ebc92ccbfade177a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/TutorialBanner.js\":\"0bc79217820e58d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/action.js\":\"24a009408ebab098\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/bannerDismissal.js\":\"de679fd2853e9d5a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/documents/cheatSheet.js\":\"5ccf11f158543e1f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/index.js\":\"337d57d8d95932ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/keys.js\":\"c590e8f6e031b728\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/landing.js\":\"2213619992511487\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/outline.js\":\"c657057eac09e1fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/seed.js\":\"fa00c2d9ae74af1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/PerfTrendDialog.js\":\"64ba50faa779a987\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/analyze.js\":\"5c44f8a4e94f6c44\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/diagnosticsSource.js\":\"f05df167a39f91af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/index.js\":\"f1afafe7d9725baa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/load.js\":\"8e1457f19eb32aa7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/monitorRun.js\":\"08e41449b6e28ae0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/schedule.js\":\"89fbed7f357f1139\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/series.js\":\"6025128697861403\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/store.js\":\"a088e6ca32fac6e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/trendAction.js\":\"df65f54033edc827\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/verdict.js\":\"23c72cd1eb9b4cf0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/clickToEditAction.js\":\"8409907c1067bded\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/index.js\":\"341acbb92e831cdd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/interactions.js\":\"6cb8ee1f109ba5ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"53bc5418035c3654\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGate.js\":\"9ada4e09a783e051\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGateDialog.js\":\"bffc7e33c07e1833\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/action.js\":\"145898858537cf58\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/index.js\":\"7adca381ae0d2c68\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/localRunMessage.js\":\"ffa08075025057b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/plugin.js\":\"0b11b3e11f6458b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/progressReport.js\":\"2ec810a1e573f203\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/sweepProgress.js\":\"314eeb5c50d32f84\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/FieldRowRenderer.js\":\"25a7678061e58cea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/ValueRowRenderer.js\":\"246ba579e6ddae75\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/actions.js\":\"f52ffcbf1429dff2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/autocomplete.js\":\"8d615145c2250589\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/fieldRow.js\":\"202b49583d7dfb4f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/index.js\":\"15229f4ea5526eda\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/referenceWarning.js\":\"45f2b799ea57ff3c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueAutocomplete.js\":\"ed0ca84abf097dcc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueSchema.js\":\"59c7964f78b0b847\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/HeaderItem.js\":\"6bc829e14c38f616\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/QuickFind.js\":\"e374922f9385397d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/index.js\":\"ab5d995f28dc88c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/recents.js\":\"dc96b9d77de73724\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/resultItems.js\":\"bcd36b44fb328646\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/selection.js\":\"4edfef5cef491aa6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/toggleStore.js\":\"97cea385350db324\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/HeaderItem.js\":\"808907c03dd2d3d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4fb227486af0b105\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/grouping.js\":\"b05d2787270db52a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/index.js\":\"16bc0f2c3930ea8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/target.js\":\"65f68c3e67f4da32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/codeMirrorExtensions.js\":\"96d173246c0fdc99\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/contentPrefill.js\":\"55142b0a6d7674d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/dataExtension.js\":\"11a6a5ae248c17e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/index.js\":\"b7f46de849d2683f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"733849132d4cfd7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/invalidation.js\":\"bfac9fcf4ca404e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/localSchema.js\":\"e81852d3b14d1c24\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/index.js\":\"9b6e37a6b5d6a5cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"ef507aae30636e95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/index.js\":\"c8596faf4255ab42\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/referenceNode.js\":\"271479a14232e8dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/remark-reference-occurrences.js\":\"48ee95a937829111\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"17bf805e002edcae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/index.js\":\"89b76016e06ac5f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"7941224d35d0bf8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"b24a233df1a31aed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/mergeRetargetProcessor.js\":\"35f3206e8198309b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/parseFence.js\":\"bc8363912114c15a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceParser.js\":\"b851c4f06e202a7f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceProjection.js\":\"35cc26e54e163a39\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referencesProcessor.js\":\"e54c678d1d119324\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/renameProcessor.js\":\"7c5308c309c2ca8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/spanReplacement.js\":\"cd44ba08a27e7c7f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/htmlToOutline.js\":\"7775b735297bfb57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/index.js\":\"3a34c982d849228e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5e841449fc71376a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/pasteDecision.js\":\"1d308be8657fa5a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/action.js\":\"7e29839ea46dcc04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/blockIds.js\":\"fb90575033e06639\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/content.js\":\"36bb9a9ec480b07a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/effect.js\":\"7964c303f5d5ec47\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/ids.js\":\"e2a709a7f5c8396d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/import.js\":\"e2a1d656676f8b97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/index.js\":\"bd312c1de9a76afc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plan.js\":\"a74a8f353158039d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plugin.js\":\"86c61ef36a371fdc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/promotion.js\":\"d3904e6634c9406f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/properties.js\":\"698e6d3fb01573cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/references.js\":\"a44e7faff11b47a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/report.js\":\"35aa2d7ac915a493\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/roamMemo.js\":\"201d6ea2eae56331\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/runtime.js\":\"88ec38612159624a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/schemaReconciliation.js\":\"c6ea85add7a55dfb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/srsMarkers.js\":\"eaba6717904ef13b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/todo.js\":\"58f4e1deca156496\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/typeCandidates.js\":\"2e37ff05258c64be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/types.js\":\"f78e432a6fb37562\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/index.js\":\"86e782dc024b4d5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/store.js\":\"1484deed6005ed73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/HeaderItem.js\":\"067ad919b93ae4e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"435e29466c870f0a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/index.js\":\"de93aebbdaee673a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/model.js\":\"1e38f5859c269930\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/toggleStore.js\":\"2e639893d08aa383\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/useKeyInspector.js\":\"cf94dbb1812e6a7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"6258ade4f207f860\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/ShellDecorator.js\":\"ecc200edaf28bfec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/actions.js\":\"1627bae693ce5996\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d2f94dcb2aeca717\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/index.js\":\"628cfd6c50b6df75\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/shell.js\":\"61e4e0cd21d2013c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/surface.js\":\"a573219f18ef70fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/walker.js\":\"3fa0d3d8d90b16f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1aa3bed1efec93f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/dataExtension.js\":\"a03a9c5a90d5b074\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/index.js\":\"d1935142d0655d1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/indicator.js\":\"ab863b41e9224a52\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/moveSrsState.js\":\"c3882d30c52dd17c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"36cec0813efc23aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/scheduler.js\":\"1630304be0079774\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/schema.js\":\"9e378a17057ac6fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"50d4d76ca1b96849\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsClipboard.js\":\"aca34e5f47b8df9a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"67cba31f72a31573\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DailyNoteReviewHint.js\":\"48a2bda105404381\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DeckPicker.js\":\"4b2f573c355e1b5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewControls.js\":\"ffc8c65c6c30e904\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewDeckRenderer.js\":\"68670deaeec2ce60\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewSession.js\":\"56d5ac49a0e4ef9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/actions.js\":\"c9ac08dbbb26ea9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/archive.js\":\"e4cafc33dac2b33a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dataExtension.js\":\"0b0c7e410ff6055e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/deck.js\":\"d245e78f00bbe32a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dueQuery.js\":\"837ffd2fc86b853a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/gradeDecision.js\":\"069ea0f90465fb81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/index.js\":\"bd97e7c6da2ed5e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/keyHints.js\":\"ea0bea8ad981b769\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewCardLayout.js\":\"14429b9c3572c2ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewProgress.js\":\"ecb3e5d0546b31b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/schema.js\":\"1514ddd39bf87f57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/useDueCards.js\":\"0ab6041062edbe6f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/index.js\":\"24dce568fde3a17e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/record.js\":\"ead20e1184b14cfe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/index.js\":\"85266dd532d58cdd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/persistenceStatus.js\":\"bbdf08ade8d87cbf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/requestAction.js\":\"d674b633a8a64910\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/TypeChipsDecorator.js\":\"2ceca76052bed0ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/codeMirrorExtensions.js\":\"899c8fc5f7a668db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/index.js\":\"7f141de122b69975\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/typeAutocomplete.js\":\"0c38fa26829104d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"c00a5071106a47b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/actions.js\":\"20f410dedbf766ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/anchor.js\":\"2cb07c15456b708b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/events.js\":\"ced8f0f856b89f87\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/gestureActions.js\":\"b9df100ae74d49aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/index.js\":\"ebf237ace18ec161\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"dfa9157f55b0cf92\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/collect.js\":\"432964c533658020\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/index.js\":\"503cd2474c738c61\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/record.js\":\"e9b13ba6c65cf079\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/RejectionDialog.js\":\"184dd0946e6082a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/SystemStatusHeaderItem.js\":\"f9ddd2a805c2a138\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/index.js\":\"eaff4878a45eb360\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/model.js\":\"142a7c68265cb413\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/queueCounts.js\":\"caa9351d71d16a85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rejectedHelpers.js\":\"a469260750b44cbe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rematerializeAction.js\":\"760eac4fc51f438d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/useHysteresis.js\":\"14d6479afad6f362\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/ColumnHeaders.js\":\"5cfd88af6e8d6cbc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/QueryUi.js\":\"841fb13b575e9b89\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/TableLayout.js\":\"2bec243389bf2940\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/actions.js\":\"a954a2429b62c23a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/cellEdits.js\":\"51f2cd721a53196c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/childrenViews.js\":\"0bd2bd5b945b4ca1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/columns.js\":\"e20a8c22b9b0b79b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/controller.js\":\"c5ee0d10e2a38dbf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/convert.js\":\"bd75bbf95f746da9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/dataExtension.js\":\"7c27bc04c7dbfd70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/index.js\":\"2c688d917c31fe7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/keys.js\":\"0e718983067c62a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/model.js\":\"d27fdfb73638e7b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/QueryText.js\":\"09fd7f5447a94813\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/backfill.js\":\"37c7c9ba0cd8fea4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/completion.js\":\"737e206072cad6d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/format.js\":\"32fcbbe98aac0965\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/parse.js\":\"9029d90206334536\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/queryValue.js\":\"1498fa4fa0e7e07d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/registrations.js\":\"1b3d10ebd5cf1afb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/source.js\":\"b1c024059042abe6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/registry.js\":\"7a541e7f640fdce6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowGutter.js\":\"af32905136ee47b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowVerbs.js\":\"a9675861806d540c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/schema.js\":\"0b2a4f1c46c70504\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/sort.js\":\"bc909fa5f771da99\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/effect.js\":\"5707314d931a6475\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/index.js\":\"f02754b06bd1c909\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/theme.js\":\"cb26dfb55a119ea2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/actions.js\":\"59be1105ab0b6725\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/dataExtension.js\":\"26a3f2e6f048e42a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/index.js\":\"b47a19ffcec1c868\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/schema.js\":\"50d394a501b8afbe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/TouchSelectionLayer.js\":\"406d4677ce98e33f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/actions.js\":\"def8ad389173a810\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/defaultItems.js\":\"3748d69a0ab3596c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/facet.js\":\"b08bf17838524fb8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/holdRecognizer.js\":\"7682c56688d8e48a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/index.js\":\"f8eec9eeb25feaae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/UpdateIndicator.js\":\"0c15c9573eb53b9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/index.js\":\"83fa647ea69af769\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/loadTimes.js\":\"9e2cd98e13703d8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoNotesRenderer.js\":\"44d27a979a3c1d46\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoPlayerRenderer.js\":\"1f7dc236dfa7ad23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoTimeStamp.js\":\"29d0e4c552f32477\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/actions.js\":\"6977a19500ba9e03\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/index.js\":\"289657cd19472421\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/markdown.js\":\"575ee6f50d476c9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/notes.js\":\"d7926ff20b4e5589\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/registry.js\":\"054cad6fa7212b09\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/remark-timestamps.js\":\"e98e42f61fd1e12e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/view.js\":\"64c05a06e7917a8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/LinkHints.js\":\"1898d94f64e4d8d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/index.js\":\"745fec110bf9f582\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/model.js\":\"ddb1ffa0cf4087e4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/settings.js\":\"ae9a5943c2151fde\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/actions.js\":\"117b7b62233cce4d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/index.js\":\"73e870a39ea0b400\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/interactions.js\":\"c38497483a74fae5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/workspace-header/index.js\":\"28f559bd705b060b\",\"/knowledge-medium/pr-preview/pr-1919/src/registerServiceWorker.js\":\"d5cdebe977092683\",\"/knowledge-medium/pr-preview/pr-1919/src/requestPersistentStorage.js\":\"558bbf0c8beb0ad7\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authRequestDeadline.js\":\"75d0b6c170894b13\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authStorage.js\":\"738479e962237f58\",\"/knowledge-medium/pr-preview/pr-1919/src/services/powersync.js\":\"e028d31854ff49ec\",\"/knowledge-medium/pr-preview/pr-1919/src/services/supabase.js\":\"0111b52bf4393373\",\"/knowledge-medium/pr-preview/pr-1919/src/services/uploadErrorClassifier.js\":\"424d42ed6ee8e1da\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/ActiveContexts.js\":\"9a6b46e9cd6346a7\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/HotkeyReconciler.js\":\"b492f03c5b784861\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/WipeLocalDataDialog.js\":\"66d25ae057ef04ad\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionDispatch.js\":\"0658e48ee50c9a26\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionRefItems.js\":\"e056e91874a83c45\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/applyKeybindingOverrides.js\":\"e1270b185d7f07ce\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockActions.js\":\"62bf1e245f54aab6\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockMergeGesture.js\":\"08eaa873c2925b59\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/canonicalizeChord.js\":\"11ae5957dbfa4c7a\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultContexts.js\":\"d3bc73815aca557e\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultShortcuts.js\":\"4322dac223ecd0b2\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/effectiveActions.js\":\"8e4346389894fcc7\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureAction.js\":\"e175d8fe25aa1b69\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureBinding.js\":\"fe2096cec168e6cf\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/holdRegistry.js\":\"22b4ce05a51205f1\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingConflicts.js\":\"67db2d7ca93714cf\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingOverrides.js\":\"296ba773fa505be8\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/pointerAction.js\":\"14109343e0dd6822\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/resolve.js\":\"f2bc647e51bbec2a\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/runAction.js\":\"021bf147d1d9d81e\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/sequenceMatcher.js\":\"ca9fe4b673a6912f\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/types.js\":\"9d818174af0e71e7\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionContext.js\":\"c1b3b0e52c4cf5e4\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionDiscovery.js\":\"b54bc418226c5b29\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/utils.js\":\"3928148adc25c224\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/bootStore.js\":\"7d305377d7e09169\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/previewDatabases.js\":\"fe78cbc96e7d8ea5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/byteTransform.js\":\"338e843fff79109b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/attachmentCleaner.js\":\"dd3e828801354fa4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/attachmentParts.js\":\"f5b0ba0d3d3e3374\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleParts.js\":\"98be399f33d0ace5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleRecord.js\":\"1fd7b1bf013a9824\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/manifest.js\":\"ac1af657b810ee27\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/takeBundle.js\":\"8239f87a49d6a715\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/verifyBundle.js\":\"09c319f1e260174a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/cleaningStage.js\":\"a065ef478fb3f8f3\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionKey.js\":\"d69f5c6347e69605\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionServer.js\":\"8ec44cc750bbb27c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flip.js\":\"572be65bd227a592\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flipAttempts.js\":\"1444d55d1e2bc469\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/pages.js\":\"f8fad4ec037a4923\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/preflight.js\":\"37bf8b47c5149470\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/reseal.js\":\"88b2fde0cbecb593\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runConversion.js\":\"7cf025a97e9e2600\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runLock.js\":\"f6db4505643e1b16\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealing.js\":\"e1de0a190763a366\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealingStage.js\":\"a5eb3da6bc77fd3a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/stage.js\":\"ba4d068ff932ad12\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/verifyReseal.js\":\"8b4baf04877b99ce\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aad.js\":\"f3180552c08ed8aa\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aead.js\":\"1e305ecf3d217d02\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base32.js\":\"9372feba0702a21e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base64url.js\":\"caaeb8ff0b9666e0\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/binaryEnvelope.js\":\"8def090bb47c7d9c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/byteAead.js\":\"7f9b497f9cd65858\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/canary.js\":\"e84814e155142660\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentHash.js\":\"88398784d6ad923a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentKey.js\":\"8e5ea9c3b5cdb76d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/derivedIdNamespace.js\":\"611bbce69ceb4d36\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/envelope.js\":\"d60d77eae54c8635\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/hex.js\":\"de71fe91b0cacada\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/sha256Hex.js\":\"bdefc65b20d072bb\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/workspaceKey.js\":\"d45d41f0c2e54b68\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/conversionState.js\":\"0395e5bb9f388568\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0a0dc24443c5a533\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/pastedKey.js\":\"bf97b346923506c5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"196149952af2f719\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/upgradeWorkspacePin.js\":\"d0625685b51bec1b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/keyStore.js\":\"c370bb6f71178708\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/mintWorkspaceKey.js\":\"c25fc62e545f35c1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/modePin.js\":\"ad247438e5cb2765\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/openWorkspaceKeys.js\":\"0608568b7c62d2d6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolveWorkspaceEntry.js\":\"007c752814283d97\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolver.js\":\"b70ce1f69843d16b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/workspaceAccess.js\":\"305951e576871942\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/transform.js\":\"66d1afcb907e92cc\",\"/knowledge-medium/pr-preview/pr-1919/src/themeBootDefaults.js\":\"d4e8aedb94ddd140\",\"/knowledge-medium/pr-preview/pr-1919/src/types.js\":\"063a47ced7e9c11d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/ClientLocalSettings.js\":\"c3a3983aae73df47\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/abortableSleep.js\":\"4aec0dfb06ab2b08\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/array.js\":\"b02934ad3dd5e416\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/backlinkAutocomplete.js\":\"d37ff86318b97163\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockCrumbs.js\":\"044eee1f23eb6502\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockrefAutocomplete.js\":\"f03f3bac06b36eeb\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/cadencedIdleJob.js\":\"ffdb4a4c1629024e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/callbackSet.js\":\"11b660392606cc5b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/clientId.js\":\"f9b26312fb588b6f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirror.js\":\"183807b224123eed\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirrorCompletion.js\":\"2bdf193f015c1324\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/copy.js\":\"773ac849f619e039\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dailyPage.js\":\"6ce69a469f150287\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensics.js\":\"4b51ea0106d075f0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensicsHooks.js\":\"170a22fe628067b7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/deleteBlockThroughUi.js\":\"061f53569cd8f82f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dialogs.js\":\"13b34c3c4887ece2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dom.js\":\"fadf2af0d0f2437f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/downloadBlob.js\":\"0e6d416be0c62123\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/drawnWalk.js\":\"7a8368ca37a5f5f1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/exportSqliteDb.js\":\"63d147e49f0395b2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fileSystemAccess.js\":\"dc2ba278432c98b7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/flipSlide.js\":\"f90a146ada2e6985\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fnv1a.js\":\"d36c1ad628589a66\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/formatBytes.js\":\"84f820d86ac3c23a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fuzzyRank.js\":\"9b1f79b8f2f7eba5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idbKeyedStore.js\":\"60d4bef93c1048c2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idleCallbackPolyfill.js\":\"7843e934ce49123c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardAwareScroll.js\":\"55f611037cddfef3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardViewport.js\":\"f41b1c5d01508b48\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/lastWorkspace.js\":\"4e20b454f94681b5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutColumns.js\":\"654aad20f0fd930a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionDom.js\":\"24691931073287f2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionId.js\":\"98e86fdcfcaf75af\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkClickGestures.js\":\"0bd4a56b1bfa7c9d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkTargetAutocomplete.js\":\"d51cd74fa7443f4c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbCorruption.js\":\"65bd5b63c3a4a88c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbRecovery.js\":\"bb82ebd82dd6d79d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/markdownParser.js\":\"227d6c91c0e83e08\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/memoize.js\":\"8bbe21184ad58897\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameFieldCommit.js\":\"ad071a04361a3c2e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameList.js\":\"fbef16b8eaa2f473\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/navigation.js\":\"34bbe32480d49933\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/omnilinerNamespace.js\":\"a65eb64c1c3490e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/opfsPageScan.js\":\"9b4cbe97fbc305d3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelClearance.js\":\"213585f02309eb2c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelHistory.js\":\"a6b305af7ddbc50a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLanes.js\":\"4f022d818205f454\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLayoutProjection.js\":\"cdd85908fc29ba0b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelScrollAnchor.js\":\"153bb60ff23e47a5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelUrlFlags.js\":\"6790fc58ef96c1d7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/platform.js\":\"3ea666430573a4ed\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/pluralize.js\":\"29e699ff1b97a9e9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyCreation.js\":\"44c9f04be58ea25d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyNavigation.js\":\"47d7448365a97bc0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyValueContext.js\":\"32dcfc702b332a59\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/react.js\":\"1eba12826d7baf13\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeDate.js\":\"024d6574c069b92f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeTime.js\":\"1af6e4ee0b17f633\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/renderScope.js\":\"cf7cc6675670aa63\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/resolvedThenable.js\":\"a4df54149a1f745e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/routing.js\":\"2d9b939fbe382ec8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/safeMode.js\":\"f885e3618def380e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/scheduleIdle.js\":\"22763c44cea9cdcb\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/screenWakeLock.js\":\"c51e5a37edd6de90\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/selection.js\":\"413cfa2744e01053\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/softKeyboardGrab.js\":\"6e6d0b4c581b104e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/startupTimeline.js\":\"3074839dbdcbcb29\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/state.js\":\"c941a36bad2ad746\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/string.js\":\"14ca5f57dae2e146\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/surfaceZoom.js\":\"92a2f78ce1430fbc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/time.js\":\"24cb37c647ea476b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toast.js\":\"ebf8d2a7590d0c1d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toggleStore.js\":\"f1ab73ce818c3f4e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/untilStopped.js\":\"963c9e522051f52b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/userActivity.js\":\"208029384bd645dc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewTransition.js\":\"7a4723af35b5d668\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewport.js\":\"ed6618b39b237e1e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/webLock.js\":\"046f606a23ef20d0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceRecovery.js\":\"2024b9deeb32614d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceSnapshotStore.js\":\"1b176900110cadf8\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-compiler-runtime.js\":\"e890eefc13d52430\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-client.js\":\"bd0ce46ba1b12994\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server-edge.js\":\"f9bfecc1d1c3ed35\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server.js\":\"526e926a4c3787ea\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static-edge.js\":\"44b19267f20d01b4\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static.js\":\"5d5411c25975227f\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-test-utils.js\":\"48509f2cc01ee0f5\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom.js\":\"e95bf4a84ccf4c01\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-runtime.js\":\"4f06758fb363e94b\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react.js\":\"05709800cc9fb4da\",\"/knowledge-medium/pr-preview/pr-1919/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
