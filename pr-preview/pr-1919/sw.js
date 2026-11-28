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
		buildId: "6c358b98cf20-99ff547e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/\":\"75cafb2239034172\",\"/knowledge-medium/pr-preview/pr-1919/index.html\":\"75cafb2239034172\",\"/knowledge-medium/pr-preview/pr-1919/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1919/assets/FacadeVFS-B6uLEty6.js\":\"7aa41e036a00e54b\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSCoopSyncVFS-BlTQX9s3.js\":\"ffc531704362af47\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSWriteAheadVFS-DsJdPs12.js\":\"3fd95c23c610ef98\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-DlROgey1.js\":\"6939b26e849b016a\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-lncq_ybC.js\":\"f7158d941bcb478b\",\"/knowledge-medium/pr-preview/pr-1919/assets/worker-fGhfelCd.js\":\"9944ebf8edc89357\",\"/knowledge-medium/pr-preview/pr-1919/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1919/chunks/app-BSx8WeSP.js\":\"c8f24b871e449399\",\"/knowledge-medium/pr-preview/pr-1919/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1919/index.js\":\"2b1cb89c6d208117\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1919/assets/AccessHandlePoolVFS-BoGPYxRf.js\":\"74f37af66f9474f7\",\"/knowledge-medium/pr-preview/pr-1919/assets/IDBBatchAtomicVFS-B8u5ZU6X.js\":\"20b6f1e29b5b097a\",\"/knowledge-medium/pr-preview/pr-1919/assets/MemoryVFS-DNXLA_-D.js\":\"9cc0d305448017b6\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-U-fIfgwd.js\":\"7a17c6f49a224a15\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-C3avf6-K.js\":\"a60cd44b1039984d\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1919/chunks/AccessHandlePoolVFS-mtxD4zSi.js\":\"650ef67bf4ff2b82\",\"/knowledge-medium/pr-preview/pr-1919/chunks/FacadeVFS-ClR9j0dG.js\":\"5a8cda11e827459e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/IDBBatchAtomicVFS-CJ-v7oTS.js\":\"e3643b441421f653\",\"/knowledge-medium/pr-preview/pr-1919/chunks/MemoryVFS-DmrYH5wq.js\":\"3d0d3c7b7734cf3d\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSCoopSyncVFS-DkJijRMF.js\":\"5d61cddbb43789e6\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSWriteAheadVFS-DQMLyyyB.js\":\"15bc8d9e1edfe1a0\",\"/knowledge-medium/pr-preview/pr-1919/chunks/Preview-DtY__QCA.js\":\"d39d339c71c48580\",\"/knowledge-medium/pr-preview/pr-1919/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/card-s324n6Jw.js\":\"8ffd4b93ba922279\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-DUjrqc3u.js\":\"78a12bb8948ac21e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/freezeExtensionImports-B5hnPuln.js\":\"d5333d090a3aff48\",\"/knowledge-medium/pr-preview/pr-1919/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1919/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-BKvlS76w.js\":\"a6f1a6c1d089a1c7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-async-B6EbCSq7.js\":\"663bca6c76ee6da8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-48IX0vj1.js\":\"b1fbe5dfcb580fb3\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-B4XnaEWj.js\":\"b117da9ec70e0bb2\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Bb937AkR.js\":\"b397ca6f0d4f32d7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-COkukmUo.js\":\"7ef015a2c836d454\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CxWjAs2N.js\":\"496a3e342e32b96a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-D90VHWmG.js\":\"a92c9c23b02429b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server-legacy.browser.production-gv8-DJJx.js\":\"71b04f63345392af\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.browser.production-DYlfO1yG.js\":\"9bb583e85c9f4039\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.edge.production-B_HJ8WFQ.js\":\"607396ca65ec996f\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-evJxLgTH.js\":\"1777f28f2652af7e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-xq6nYPBI.js\":\"3d26a18bc3860540\",\"/knowledge-medium/pr-preview/pr-1919/chunks/server.browser-BRJTHy2M.js\":\"1f1847092772a74c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/textarea-BXexP37o.js\":\"557e2fcc56f7537c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/ui-BdxYhRZM.js\":\"8560229c5f3e5297\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-DiMwuaFR.js\":\"dc46ccc9a5bb52b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-async-DAMXKp9v.js\":\"fe5b0a07c6c5a12a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1919/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/src/App.js\":\"ca81c8442ac7a3e1\",\"/knowledge-medium/pr-preview/pr-1919/src/appUpdate.js\":\"fb7fcef3d2e415ee\",\"/knowledge-medium/pr-preview/pr-1919/src/appVersion.js\":\"a4e3d34565c5e1b8\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/initialLayout.js\":\"e18f481939a3e2d5\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/openWorkspaceData.js\":\"7606b1c0ebde7745\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/resolveWorkspace.js\":\"d1568925eac4d46e\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/workspaceBootstrap.js\":\"d00939e14c88eec9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockComponent.js\":\"2018c2daaed4b599\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockCrumbs.js\":\"b58f8147b9057d9e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockEditor.js\":\"011cc74c868e6200\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockLoadingPlaceholder.js\":\"ccd765e3fe34eda0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockProperties.js\":\"3ed081c995e80933\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockSearchPicker.js\":\"433f59fecc69c5a1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ConfirmBulkDeleteDialog.js\":\"bfd9cbce164a5c83\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DividerHandle.js\":\"40be9e8d1b6a7f4d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DraftEditor.js\":\"fef0e0f1565bcac2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/GutterPill.js\":\"143ed9c5affb711d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Header.js\":\"cc6c82139a0a17d2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/LazyBlockComponent.js\":\"070f25d73b198530\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Login.js\":\"87f3014589782240\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ZoomableSurface.js\":\"138be38a0dab69c9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/editModeKeepalive.js\":\"5be3755bbe4c1767\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyDisplay/PropertyDisplayScope.js\":\"941cf901fe00f089\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"fcf8b0e32f04cc63\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefPropertyEditor.js\":\"5d07f228b7dd83fd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefTargetTypePicker.js\":\"c218c4a68af6e81b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/SelectPropertyEditor.js\":\"3d7ef758d0410fb4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/TypesPropertyEditor.js\":\"834b17fbc387a7ed\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/defaults.js\":\"457aa3416ee0b125\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/kernelValuePresets.js\":\"cb2806c45ab519db\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/selectablePresets.js\":\"fb92c66d21282771\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/typesPropertyUi.js\":\"f18a2c7de2189a9a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/AddPropertyForm.js\":\"ade23c9bb3d45337\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyPicker.js\":\"e66db1b145a36b65\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyRow.js\":\"e8744ae2e624b69f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/Rows.js\":\"69e4052d859e24f9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/actions.js\":\"5411b1c94a9e9f18\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/declarationOnly.js\":\"59c3c52a7ce99ad3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/layout.js\":\"fe913b22e9ec0264\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/model.js\":\"ffb0ade5408cfcbf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapeUi.js\":\"fca01899107ab1cf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapes.js\":\"5861e948a2dc6759\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/usePropertyEditingActivation.js\":\"395c6a40c6406374\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/visibility.js\":\"e117cf5f971bebd4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanelSections.js\":\"a9b0b5c8e9864d1c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockEmbed.js\":\"c4a5090a060d1974\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockLink.js\":\"209b4c489583ba60\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockRef.js\":\"72a4d57f3fcb7355\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/CompactReferenceLink.js\":\"b6f67e86fb66b4ba\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/ReferenceLink.js\":\"da47f869cf40ef52\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuard.js\":\"0af617168a4b7799\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuardContext.js\":\"05d88c68f7534d82\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/linkInteraction.js\":\"847aabf3082ef1ec\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/referenceLayout.js\":\"f46f2da4a54a61de\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/useBlockRefAncestors.js\":\"372fac5d2fa943c5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockGutter.js\":\"59cd0a526cc32e81\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockInfoDialog.js\":\"18a1d358d373cadc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockReadText.js\":\"71c1a1ad5d57a5f4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockTypeBlockRenderer.js\":\"6ad81a84c4cfecec\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BulletHoverCard.js\":\"c10854f2988df7ef\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorContentRenderer.js\":\"222e21ed775f57e5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9d31cddf61b63486\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ColumnResizeHandles.js\":\"f2b1762837055114\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"62dd7e6ec0df287e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/DefaultBlockRenderer.js\":\"863b6fafe623fe96\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/LayoutRenderer.js\":\"8d1d7c3f91f35562\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MarkdownContentRenderer.js\":\"b4585eb305b91bbb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MissingDataRenderer.js\":\"4e04fcea83bce74f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PanelRenderer.js\":\"a9a0f64167d1c237\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PropertySchemaBlockRenderer.js\":\"27f18ad3773fc72f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/TopLevelRenderer.js\":\"b2ec5b656b374f2d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockGutterMode.js\":\"4c32d72fc3234cc5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockTitleText.js\":\"80a074d7fd163986\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/fieldCreationKeydown.js\":\"2bad59bcb7e8c6c3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/layoutRootContext.js\":\"35e542e0c2fa03dd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/TypeChip.js\":\"24009b04566f8e03\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/chipStyle.js\":\"da21764cfda92c61\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/anchored-floating.js\":\"4d33b29140809ba1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/button.js\":\"5e82b024cfd10469\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/card.js\":\"b3981a009dfdd5f4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/checkbox.js\":\"6c6936ac670c9570\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/collapsible.js\":\"8c67500b68dc8ebb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/command.js\":\"7300877c9e6c49f7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/context-menu.js\":\"1d27e9856ee9f2e1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dialog.js\":\"1099d9db2b05ba79\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dropdown-menu.js\":\"071b5f3e8a7b12bd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/floating-listbox.js\":\"f4b51f0d6150e9e5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/index.js\":\"904d0870dbbd9ec9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/input.js\":\"87732d491fcf2766\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/kbd.js\":\"d42e6782e9a9f9d6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/label.js\":\"02251c09cc2cc08c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/textarea.js\":\"da423f8133cd7ef1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/useEditModeYieldKeepalive.js\":\"c8bb92a04d7836d4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/BootFallback.js\":\"3f30c5011de6a37c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/FocusedRowLazyMount.js\":\"525b80968b43645e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LazyViewportMount.js\":\"4e66ee31e7d9f421\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LocalDbCorruptionFallback.js\":\"c4cbc7b213a55d22\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/error.js\":\"db9e0029f5b0f601\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/lazyMountRegistry.js\":\"eaa655f689aca0f1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/suspense.js\":\"bcdbe0b1f47bfc6a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/CreateWorkspaceDialog.js\":\"a27acfbb18d051d8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/PendingInvitations.js\":\"e5e5f78049a86613\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/SyncProgress.js\":\"9262c7985e41efbc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/UnlockProgress.js\":\"68e5036d6fbce04c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceKeyGate.js\":\"3c05e8e492074657\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSettingsDialog.js\":\"f2262a82f3679248\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSwitcher.js\":\"3d78ed0a8b8c86fc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSyncGate.js\":\"912064ac899db29d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlow.js\":\"8908615e907afb9b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlowHost.js\":\"6ad91a1c9f479a0a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/EncryptionSection.js\":\"64ac3665c22538ec\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/attachmentPrompts.js\":\"2be74ad3ce6f2086\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0f4e8ee478488989\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowDeps.js\":\"7fd1e73c29772413\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowStore.js\":\"c416701f072463b7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/flowUi.js\":\"a3020be89b0d3bd3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/useConversionRun.js\":\"fbb8808d21f1bfe8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/keyUi.js\":\"b376ce6395cf1342\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnKeyLoss.js\":\"aecad9103b091f7b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnServerE2ee.js\":\"af71dc21b8d247e0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/workspaceUnlocked.js\":\"8a5d96dff4472729\",\"/knowledge-medium/pr-preview/pr-1919/src/context/backgroundSubtree.js\":\"9076e8f42c024e39\",\"/knowledge-medium/pr-preview/pr-1919/src/context/block.js\":\"b2025c52b9974d8c\",\"/knowledge-medium/pr-preview/pr-1919/src/context/layoutWsContext.js\":\"85d52757737a56e9\",\"/knowledge-medium/pr-preview/pr-1919/src/context/propertyDisplay.js\":\"5669f2111bdbda40\",\"/knowledge-medium/pr-preview/pr-1919/src/context/repo.js\":\"1bd72f1b2f714dbc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasClaim.js\":\"c3967490a9e80f4c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasSeatNamespace.js\":\"d30ce6cb008c8d6a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockData.js\":\"e1ea09465d0d7014\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockType.js\":\"a6ba7466c1aef94a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/changeScope.js\":\"973bc60bf7e13a2b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/codecs.js\":\"f4f73b3c65277efd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/derivedData.js\":\"28f8bca6b36abf91\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/errors.js\":\"2c923553db63168e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/events.js\":\"d08662662aecbab9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/handle.js\":\"ac01c5d722c34e00\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/index.js\":\"8db1c59de8d32a55\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/mutator.js\":\"7517fcba8f120442\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/processor.js\":\"0fd96c48ce767906\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/propertySchema.js\":\"35b201e215d152bc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/query.js\":\"7e08adc9da570068\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/sameTxProcessor.js\":\"34c8b60ce84bd2b1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/schema.js\":\"ac01c5d722c34e00\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/tx.js\":\"ac01c5d722c34e00\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/typedBlockQuery.js\":\"9454af5abf7f5501\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/user.js\":\"33b28215253df019\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresetCore.js\":\"10df6f944e80aefe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresets.js\":\"9b5a2d9d7f559e92\",\"/knowledge-medium/pr-preview/pr-1919/src/data/attachmentCleanerIOVerb.js\":\"0ecf72e42519f37f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/block.js\":\"e48679deb0252f5b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockCache.js\":\"c0093f2e687b055d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockId.js\":\"bce63bb18bd2bc3e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockLiveness.js\":\"b70aa56cb5df6b2e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockMerge.js\":\"042fb6928d89b259\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockSchema.js\":\"31fe8761b0fe08ee\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypeLookup.js\":\"2f78c13b64cb2dfd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypes.js\":\"bfe1fc41c97c16d2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/childrenView.js\":\"7fb71664aec20584\",\"/knowledge-medium/pr-preview/pr-1919/src/data/clientContext.js\":\"5d09daf4c3c82cc3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/dbFileSiblings.js\":\"bb0cfc0894a944ac\",\"/knowledge-medium/pr-preview/pr-1919/src/data/definitionSeeds.js\":\"72e911b75fed9cbf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/derivedIds.js\":\"86302634b6fd2c57\",\"/knowledge-medium/pr-preview/pr-1919/src/data/drawnSubtree.js\":\"27a0350ae2f19c85\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facetBridge.js\":\"4be14026b0b5ed0b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facets.js\":\"2b933f802f6f0975\",\"/knowledge-medium/pr-preview/pr-1919/src/data/globalState.js\":\"05113b97d11362f1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/aliasClaimRederiveProcessor.js\":\"cc0292a50fa55036\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/ancestorBatch.js\":\"5768ad1a92a27697\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/blockTypeTypeifyProcessor.js\":\"d50e4988ca3a0cc0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/clientSchema.js\":\"2149ce32857f1843\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/commitPipeline.js\":\"d9dc12c21e59a0f5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/devAssertions.js\":\"bc3f13b3099f1f2f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/firstSync.js\":\"a25b01fcb66c4335\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/freshInitialLoad.js\":\"40fddbc8eefccdf3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/graphBackfillClaim.js\":\"0462741c75a6c822\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/handleStore.js\":\"3f1cea37679203e5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/idleMarkerJobs.js\":\"b146b13467efa8af\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initialDownload.js\":\"7e3b11ba97d9ff96\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initializeClientDatabase.js\":\"a10412542b8ba714\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/jsonCanonical.js\":\"f1ab31d037950ae6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelInvalidation.js\":\"4a531a18bf958f47\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelProcessors.js\":\"c80da0a923abe608\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelQueries.js\":\"a3b92a4824257844\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/mergeTypeMembershipProcessor.js\":\"45e9f7e13d5c2787\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/normalizeReferencesProcessor.js\":\"07f262be5c4dc5b6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/poolInstrumentation.js\":\"3bebeb3fda715639\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/processorRunner.js\":\"dc8bc5183295f9c1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyCellBackfill.js\":\"6a1ebfc05084fbb1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildMint.js\":\"0f0dc32c9b978e11\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildrenProcessor.js\":\"2009f8c98934771f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c76acdd0de10b908\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionSynthesis.js\":\"c5e2938a69839c1c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyKeyScan.js\":\"4eb18fbf7be7cff8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertySchemaResolution.js\":\"aeb6b686a2d70d50\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyValueEdits.js\":\"5a89d43bbd8a1cb0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/raiseProtocol.js\":\"a1a7236f3b6ae20b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/readBatch.js\":\"3e473eb177df3939\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/refProjection.js\":\"fe8e1d3e03f91e36\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetLookups.js\":\"41f26d0df842c24a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetProcessor.js\":\"379159c6ce52025d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/replayMerge.js\":\"6f7e72128301838f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/sqlBinds.js\":\"26bb352059c8a5e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"a32424bc50c9266c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/arrivalProcessors.js\":\"5647ff85a44ec63c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/invalidate.js\":\"9ad579b59cd93dc0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/materialize.js\":\"0e0417e37590085f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/observer.js\":\"3d5c84d1fd83ccad\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/reconcile.js\":\"66b22cbaa11b0418\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/timingMetrics.js\":\"97eccc4c48427ec0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/treeQueries.js\":\"b4bb1612ad9fc9ef\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txEngine.js\":\"c54dbcb9375e7f31\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txSnapshots.js\":\"7d9cd588328d78b9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/typedBlockQuery.js\":\"9466a634a36ceb39\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/undoManager.js\":\"843ce95107c2d711\",\"/knowledge-medium/pr-preview/pr-1919/src/data/invalidation.js\":\"f43e5acbed994dab\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelDataExtension.js\":\"08a82976bd6e8290\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelPage.js\":\"fd7d30b6b4ff5f99\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelValuePresetCores.js\":\"04dbd748d2e0cdf1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbCorruptionSignal.js\":\"df18122cc16b647b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbStorage.js\":\"9d4cd7c3e6f876ba\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbVfs.js\":\"662ba37f9dda9d1a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localSchema.js\":\"1a629954908b96e4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/maintenance.js\":\"aa36559060bacf2f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mergeProperties.js\":\"b3b1d8a80f3a0a2c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/metricsConsoleHook.js\":\"0b3a0b6acf6ae8da\",\"/knowledge-medium/pr-preview/pr-1919/src/data/migrationsPage.js\":\"124dac1b908f7f6c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mutators.js\":\"e076a0517dd147eb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKey.js\":\"b6c85f8708681e41\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKeyPlacement.js\":\"8fadfc0398717c13\",\"/knowledge-medium/pr-preview/pr-1919/src/data/outlineSurface.js\":\"ddec602f3b7fe15d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingEditorContent.js\":\"40e7ad8b4a92dab7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingUploadsSql.js\":\"c0e792be513e3ae8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pluginStateExtensions.js\":\"9a60c77946669513\",\"/knowledge-medium/pr-preview/pr-1919/src/data/powerSyncLogger.js\":\"5fda80ef0e721cee\",\"/knowledge-medium/pr-preview/pr-1919/src/data/projectorRuntime.js\":\"0e2885c3f407916e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/properties.js\":\"75d0108676ac1203\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertiesPage.js\":\"85f15752700a3d9c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyChildren.js\":\"b66cadd58019f434\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionFanout.js\":\"dac5b6d7155e228f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionMetadata.js\":\"737f18bd7140c184\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionRegistry.js\":\"20d33f6ab3733c31\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDisplayMode.js\":\"fb2a95019dcc03be\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyRowCreation.js\":\"7ef23d8d1f1cc687\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySchemaCreation.js\":\"833dc5218c9917eb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySeeds.js\":\"6c4455f7c6669826\",\"/knowledge-medium/pr-preview/pr-1919/src/data/recentsPage.js\":\"3d6a236ef4e103cf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/refTargetComparableProperty.js\":\"57abc241232295ee\",\"/knowledge-medium/pr-preview/pr-1919/src/data/referenceBlock.js\":\"d14a875b2f68f11b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rejectedUploads.js\":\"bf1adae83011700e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/releasePowerSyncConnection.js\":\"ac1e1c4c49c2af79\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repo.js\":\"32136ab50fe86fc2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repoProvider.js\":\"5f42fff3df132772\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rowProperty.js\":\"ec8edcd35e3385f2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/searchFilter.js\":\"64e4604e3421f511\",\"/knowledge-medium/pr-preview/pr-1919/src/data/seedIdentityLedger.js\":\"3799336a34ec5f6d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/stateBlocks.js\":\"714f40bd0cea26ae\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralEditPolicy.js\":\"07fcf87d460c13d9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralInsert.js\":\"1a56a81c71044fb8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/subtreeDelete.js\":\"fb352f8c0a20cb47\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncStreamLock.js\":\"a379f2a48f0afe52\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableSqlRecognizer.js\":\"f20b1017622a0efa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableWriteGuard.js\":\"4006da7c71b41d27\",\"/knowledge-medium/pr-preview/pr-1919/src/data/targets.js\":\"64ec305a09463cd7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeColors.js\":\"9cf8b2447a226acc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionMetadata.js\":\"d3fd2672569145ba\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionRegistry.js\":\"40405c67d4b05b69\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeExtraction.js\":\"44a85fb49b8d8da8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeInitialValues.js\":\"e58e819112edec9d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typePropertyGroups.js\":\"88ff360a89489ac4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeSeeds.js\":\"d31a8bbc43e9a8d7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeTagger.js\":\"fd8281aebd2f7ded\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typedRecords.js\":\"3fd3cf97df30ef1f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typesPage.js\":\"1f1d43ddc4e63084\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userPrefs.js\":\"f5d6e3dee3190636\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userSchemasService.js\":\"7b2c1ebbe69c56a7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userTypesService.js\":\"9da8552a1428b8fa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/valuePresetRegistry.js\":\"dd722019cd5d281b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/visibleChildren.js\":\"03bb4189fde9830a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceConversion.js\":\"bcedc20068bd8036\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceFirstSync.js\":\"9f54681131335c96\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceIdNamespace.js\":\"0f6492b1ad854f81\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceSchema.js\":\"db867b36fb7c6ee7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaces.js\":\"51621a6d7ee228c1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadLog.js\":\"596dccc598c494e4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/BlockPasteShellDecorator.js\":\"4ee95194ccc4fcd9\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/atTrigger.js\":\"bb421f30b37e5fe6\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/autocomplete.js\":\"4d19971938ff28c5\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/codeMirrorExtensions.js\":\"5f0404c5137003e9\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/contentFlush.js\":\"39f9a1845a910da7\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/defaultInteractions.js\":\"f12b8500d435a86b\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/editSettleSignal.js\":\"23e9771afb292357\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/insertImage.js\":\"5c1f4a95af7335b2\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceCompletionRange.js\":\"382ae0c6ce467fb3\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceTargetTypes.js\":\"a562bc611f19740c\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/syntaxContext.js\":\"0d9210c1281f407d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/triggerMatch.js\":\"4beacbcdacbb8c7b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/AppRuntimeProvider.js\":\"4c71954e29040216\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/BlockFocusShellDecorator.js\":\"47beb3c47f82869c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/ExtensionRenderBoundary.js\":\"22df18c26b79780a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/PanelContentRecovery.js\":\"3dd1a1a46c35b598\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/apiCatalog.js\":\"1bbadf7a7e2a72e3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/appRuntimeController.js\":\"ebfe0ef235e2ef06\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/approveExtensionHere.js\":\"c4488741c4070aab\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/armedCutAppMount.js\":\"46150224e432e2c7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/batchableKeyedStore.js\":\"a09078443d673f2b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockInteraction.js\":\"fac6eb71e3e7ad4f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockSelectionAction.js\":\"8e34f55142132999\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compileExtensionModule.js\":\"df977175ee51039f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compiledModuleCache.js\":\"09e7158fd0733d3b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/continuousGestures.js\":\"50050a86dabba64a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/core.js\":\"5d92c00565ca6e22\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/defaultRenderers.js\":\"427852e6c8c67d9a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/definitionFanoutAppMount.js\":\"15010534ca92ccb9\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dialogAppMount.js\":\"e49af7c5eee9dac9\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensionSeeds.js\":\"e74a94e2944ce854\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensions.js\":\"a261eca4133148fc\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/exampleExtensions.js\":\"1635bcbfa94d24b1\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionApprovalStatus.js\":\"f350fe31e7243074\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionImportPolicy.js\":\"d70217a7037d3445\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrorToast.js\":\"c33dae78cb53f6dc\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrors.js\":\"fd7568b9dfc1f9ea\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLookup.js\":\"0929a2d8bdaa6d0d\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionToggles.js\":\"3befff15ef92e3f0\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionUtilitiesCss.js\":\"5c2501694b236f11\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/kernelPageDeletionGuard.js\":\"ac2a44e9a1eb92d8\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/liveRuntime.js\":\"0f74132b4fe8bed2\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/normalizeExtensionSource.js\":\"6b8a2c6c5390a4cd\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/openExtensionsSettings.js\":\"5b85a161bc954b18\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/overridesCache.js\":\"9b247dcef1807028\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/pluginIds.js\":\"1c2bdd2cb623991c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/processorRejectionToast.js\":\"2f4214641e032a0c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeActions.js\":\"906f8404f8ec6497\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeContext.js\":\"d39cd14a849a739e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticAppExtensions.js\":\"e51932b5f339445d\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticDataExtensions.js\":\"a851903cd69acc75\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/toastAppMount.js\":\"9c5d0c5e516e89a7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/transpileExtension.js\":\"4372abe7da196efa\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useOverrides.js\":\"5e99f5f6e2b26108\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useShortcutSurfaceActivations.js\":\"8bc2569a472f3cef\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/discoverToggleTree.js\":\"03db76ab34df49d4\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/facet.js\":\"2b45c2508a05858b\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/resolveAppRuntime.js\":\"72b76ef7734bdaea\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/runtimeEvents.js\":\"746d3245eaf2d4f7\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/togglable.js\":\"06323aee6afbcc8c\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/variantFacet.js\":\"b0cd1232ef691582\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/verbFacet.js\":\"7c6a055da90daa02\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/block.js\":\"c78550dfbe614ae8\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/focusedChild.js\":\"c5fb3199ea5db2f5\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/propertySchemas.js\":\"b0daf67e0dc64671\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/typeRegistry.js\":\"f853504cf947f924\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAncestorCrumbs.js\":\"a58625490e7015be\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAutocompleteListbox.js\":\"a0c12627a2033490\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedSearch.js\":\"538d93871423e6a0\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedValue.js\":\"79502b25418ae6b5\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useFacetValue.js\":\"fe5b0b4a19b34fec\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsFocalRender.js\":\"851439bac48937e9\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsReadOnly.js\":\"9541a8a64aeed663\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMaterializeBacklog.js\":\"0bad177587e7e661\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMinuteClock.js\":\"e824a888123231e9\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePanelLayoutProjection.js\":\"31c3342fed260e0d\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePendingInvitations.js\":\"e6cd9abd80ead627\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRendererRegistry.js\":\"0333492784d7d48a\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRetainedFieldRows.js\":\"eb8db0bb9e3897d3\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useWorkspaces.js\":\"8110ef6ceacc2645\",\"/knowledge-medium/pr-preview/pr-1919/src/lib/utils.js\":\"4694e124cf37ea6c\",\"/knowledge-medium/pr-preview/pr-1919/src/main.js\":\"21b2bee2722ae139\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/MarkdownImage.js\":\"6c91c0669043501c\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/blockSeparators.js\":\"6e4f29f509e62608\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/context.js\":\"2c3fcc475c2e5c7c\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/defaultMarkdownExtension.js\":\"da129b37e825b033\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/extensions.js\":\"83ba3a15ee6d1c6f\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/renderMarkdownHtml.js\":\"7f5fcdef87c70fa2\",\"/knowledge-medium/pr-preview/pr-1919/src/minimal-editor.js\":\"c0b743eb25da3c14\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/armedCut.js\":\"b7b4c136698555ed\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/captureMediaVerb.js\":\"a1e82e0890894e88\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/clipboard.js\":\"a7589da791bbda84\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/decision.js\":\"237a6c0c0db9548d\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/operations.js\":\"314420f4d3733d0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/AccountHeaderItem.js\":\"853b93a069929865\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/index.js\":\"3c2e2bb99daa701c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"eec04579f109cd42\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askAgent.js\":\"b8352e141837c5db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askedStore.js\":\"27ca8b885c76f793\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d2569e2c998aa8a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/chipState.js\":\"1bb71fc4c407759c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4f8cca57352e6628\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/index.js\":\"9ba7e08e6d1828ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"853bf2adc5a7f52b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/schema.js\":\"ec022500f3be8396\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/AgentTokensDialog.js\":\"12bab676780f80ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6f2e94df75d93c27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/addMedia.js\":\"51f2a58b38a2dd6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/backlinks.js\":\"8d32da13441db319\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/block.js\":\"905c44ff5498641d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/context.js\":\"952340e59c492dc9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d26a98fd856d6150\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/index.js\":\"a2a1e64b149e1e87\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/outline.js\":\"9debf34eea840a64\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/properties.js\":\"691e01dd7fd4ed60\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/refs.js\":\"3c03af6964481aeb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"22ee82078d6f369f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/search.js\":\"2ab9106a0f89dc10\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/shared.js\":\"72d93f1e4464871f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"a2cb189788adec5e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/text.js\":\"8860cf885d433029\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentWrites.js\":\"7290080fbee88dca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/authoringCatalog.js\":\"bc6cca93d0806f02\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/blockRefTargets.js\":\"fa71d757b5436b77\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridge.js\":\"7eb4d814f7bb77d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridgeLoop.js\":\"85e45becde0ae6c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/changeHistory.js\":\"5505d3d86131d91c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commands.js\":\"55a9441765764289\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commentsCommands.js\":\"0e1f835432f8eb0d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataExtension.js\":\"1acf5c4846eb65a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataModelGuide.js\":\"7bf14555ee6dff04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dayPropertyInputs.js\":\"9f3fdcccba5750ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/describeRuntime.js\":\"f40bd22bfef46528\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/extensionLint.js\":\"921ff49d09d6a8be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/grainAudit.js\":\"19296ed7363f7e29\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/healthCommand.js\":\"ccfa7517b7781c54\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/index.js\":\"c9147ccd3847781a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/presetIdentity.js\":\"aa43d79b08f07aef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"0527f8149bd8ee4b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/readMedia.js\":\"afa00e77265ad44b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/schema.js\":\"5f7ec243f07a5433\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/serialization.js\":\"d07435187339d8d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/targets.js\":\"10ea5a0d8c682532\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/tokens.js\":\"941ad0342a491192\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/watchEvents.js\":\"abf092d60d4feaa2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/workspaceGuard.js\":\"433a2e49bfb9e84a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/writeCommands.js\":\"35181398b8cdceec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/AliasCollisionToast.js\":\"3f4e17538876ed56\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/DuplicateNameBanner.js\":\"8f8c1b69d98ca8aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/collisionMerge.js\":\"92107ac97985a0e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/dataExtension.js\":\"31d3c06efea02e82\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/index.js\":\"fc6887e5976170d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/mergeCollisionAction.js\":\"e4d5b7d5e6d3b7f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/pageStyling.js\":\"b3356f961f03b3c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/rejectionToast.js\":\"ee2f1e486e463e3b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/syncProcessor.js\":\"8bdbd7fc9fd01867\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/actions.js\":\"264dcf1953bbfe61\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/addComment.js\":\"aaf46d69d124b51a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchor.js\":\"8f884b504cefc1a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchorState.js\":\"10e59b960b36a457\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/commentLinks.js\":\"c1c5218a6aff125f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/confirmThreadDeletion.js\":\"3d16556f1999b730\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/container.js\":\"9d1ce575323515a9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/dataExtension.js\":\"7dcd3d41c8a9af2b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/deleteComment.js\":\"314a7f4f9461b134\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/highlights.js\":\"82c58f4349f81064\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/index.js\":\"603059ef7dd4c0b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/linkedCommentsPill.js\":\"516f5688c6128571\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/margin.js\":\"194a55e86b010073\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginAnchorLinks.js\":\"b72da5dc90e7ab2b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginSchema.js\":\"ad678d95564aaa49\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/newComment.js\":\"e3c87d9ae201b540\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ownThreadPicker.js\":\"7bfa9cfd85316b5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/placement.js\":\"c3b02d10e56efb98\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/queries.js\":\"cae2d452ab5d9413\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotePosition.js\":\"57dba0e69cb40647\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedIn.js\":\"929ebc43bcacd27c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedRange.js\":\"f17dde38668818fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/rangeRefs.js\":\"ea4138a89787e03a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readHighlights.js\":\"fff2666ee28ccb3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelection.js\":\"e43acbedea3c5392\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelectionUi.js\":\"11feab55d663d8bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/reanchor.js\":\"fd0fa003c1c9a11f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/schema.js\":\"56307dd05495de95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scope.js\":\"0641a8a143971251\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scopeThreads.js\":\"342ee08beb99bc41\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/splitRetarget.js\":\"a5e1268186f09c98\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestionCard.js\":\"f639c9b7a3d6cf57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestions.js\":\"415dce34d6838304\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaries.js\":\"33850f74c21c88b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaryBatch.js\":\"f001102fedd165ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/surface.js\":\"c09db8bdba57f4ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threadNavigation.js\":\"76c84bb7865cfd52\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threads.js\":\"2d9e68c42304140e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ui.js\":\"ddf91821cfa29688\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/uiStore.js\":\"388926cad440440c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/appIntents.js\":\"afaa217f44104f4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/index.js\":\"7e6854e471c5d520\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/index.js\":\"1195c34992c11755\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/status.js\":\"985d3b693c51c7a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"0091601cdd3252d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaBlockRenderer.js\":\"0970c1c97cb495b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaDownLaneReplicator.js\":\"8b931a27b9306ebc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaUploadReconciler.js\":\"b3ec8b059f0a8f7c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetDownLane.js\":\"0ad9f5599933360f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetResolver.js\":\"668ebd2f520229a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetUpload.js\":\"d1fe2c46889ff9fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/attachmentCleanerIO.js\":\"fff4605ffb9741ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/supabaseAuditIO.js\":\"10b51ec42b4f9838\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/blobStore.js\":\"50d9ab41d11d1ca9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/browserMedia.js\":\"d09ebb5a8107e64f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/byteStore.js\":\"5189a4215968fb02\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanerIO.js\":\"0eaebe1582c8d024\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanupAttachments.js\":\"4ebfbe43b3d990d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/dataExtension.js\":\"980306026718431e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/downLane.js\":\"c7632b298c451913\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/index.js\":\"689d8fe8eb523d4b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/insertImageContribution.js\":\"516fe5e022353c91\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneArming.js\":\"0ba29ff26c254c4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneLock.js\":\"31b2064ffebe30f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaBlock.js\":\"12c0823418bc77c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaCapture.js\":\"cfbf18419794ce55\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaLanes.js\":\"0f1b972621993a84\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewers.js\":\"caec7ace0e80f8ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewersFacet.js\":\"f03db6a6ddc40215\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/pasteCapture.js\":\"968773a3f1025f97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/resolver.js\":\"597064f38598713d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/retryUploadsAction.js\":\"9328979ac3876ffc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/storagePaths.js\":\"29b5c99c452f987f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadDrain.js\":\"2133a828a628648c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadLaneStatus.js\":\"dd66122cf2535775\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadReconcile.js\":\"b676109e0aa3fbc2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadRecovery.js\":\"3667ecfec89c0db0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadStore.js\":\"055825ab6ce7cccd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/useAssetObjectUrl.js\":\"86ac4da46230db5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ff3b82a61a903cd8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksViewSection.js\":\"7e656deffc38c7e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/facet.js\":\"df4dd2545d46b8be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/index.js\":\"4583107e774f11f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/prop.js\":\"8c230b08cbd614f6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinkFilters.js\":\"715ba992b947924b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e93d9a996065be76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BlockEntry.js\":\"c0908f17ff06bee4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/LinkedReferences.js\":\"2238ee469d1a66f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"208e89270e72b778\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dailyNoteDefaults.js\":\"ded3eaf33e191950\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dataExtension.js\":\"37fb988a9ac07d34\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/edgeExclusions.js\":\"a3af643b0509ec6e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/filterProperty.js\":\"e8139313eaa895ff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/index.js\":\"c262986863cd5d62\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"bcfa1e7f6405e730\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/applies.js\":\"fa9a79cbf1aa6a82\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/countQuery.js\":\"95eca56d68c6d7c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/expansionStore.js\":\"91171e262a58ae29\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/index.js\":\"b5db26ecdf6ca866\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c09545a4af15be62\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/presentationInvalidation.js\":\"05f5b0c90dbbb66d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyEditorOverride.js\":\"960a0823f10164ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyFilter.js\":\"e0181b370784d97d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/query.js\":\"897c3ad8c48eeb1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/resolveFilter.js\":\"09bc1bab6cf367be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sourceBatch.js\":\"27aa38075736caa2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sources.js\":\"7ba966bc36f7c9f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useBacklinks.js\":\"d4ca55fe0fad271b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"70ea6b285560b859\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayCelebration.js\":\"d309d52c50b8d279\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayOverlay.js\":\"f5dae0678c550d2b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/gate.js\":\"ee0ebe05cf488bf2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/index.js\":\"12b3a9872c393840\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/wolfTheme.js\":\"8f684b9bf8d519a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/BlockDragLayer.js\":\"4109fe0e69d0cbb9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dragController.js\":\"6631d07fd22d822b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dropTarget.js\":\"aa9ffa45947c8406\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/index.js\":\"354ab2a40f4533e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/projection.js\":\"100549ffbf00b6b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/BlockMetaCard.js\":\"14ce6605d9b8a566\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/index.js\":\"7a19361acb32d4eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/AddTagDialog.js\":\"7ab394411df68533\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"e5879fecd8d49fdb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/TagNameIssueHint.js\":\"0675583226700f93\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/addTagAction.js\":\"40834fe47cf0c84b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/appendTag.js\":\"a10a499b82a0a2f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/config.js\":\"ca11018f362ffa07\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/dataExtension.js\":\"0b31b6ab6ad47a2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/index.js\":\"491c7e68d6873859\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/propertyEditorOverride.js\":\"1e490c9bd557b3b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbList.js\":\"f3c9756bf795f6fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"ead52e62b903b785\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/Breadcrumbs.js\":\"e14335e32f7cbc81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b345d4008def63f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"030a4c9ca63233af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/index.js\":\"4d2e649efd2e0926\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d63cf6cea2c4c65b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/CharacterCountItem.js\":\"db88c87634c0d870\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/ProfilePropertyEditor.js\":\"9c63cee04492d258\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/actions.js\":\"20c43d63123d290e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/blockType.js\":\"ba47a0a27b371b26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/charCount.js\":\"41e3a01178b70cfb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/dataExtension.js\":\"ad0e29e2645fd19b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/index.js\":\"c6bc512c1be55090\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/profiles.js\":\"a187b56871ab57e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/properties.js\":\"6c7e0d629552db1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/subtree.js\":\"fce8db7628c2dda9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/textCounts.js\":\"d2293c06fc293778\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/colemak-keybindings/index.js\":\"9935df2f562b6368\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/CommandPalette.js\":\"6155e59384d8a211\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/HeaderItem.js\":\"31829159a3c6a46d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/context.js\":\"9f37b251380e0cf0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/index.js\":\"89482be16dfba945\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/selection.js\":\"9f55745b362b52d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/toggleStore.js\":\"b12c1db59b8a3ea5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/useCommandPaletteActions.js\":\"67c0e9dea092792a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ContributorBadges.js\":\"4c35293d9e5ec48b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ProfilePicture.js\":\"1ed2b63377a747d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/author.js\":\"6b18a4b7b9153138\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/codeMirrorExtensions.js\":\"4d0bd81d4b3e0e2d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/dataExtension.js\":\"f12d72b6c2cdb126\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/index.js\":\"35de5c88a6898bca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/mentionAutocomplete.js\":\"f81ffcfe60b63111\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/processor.js\":\"18237f491637850d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/profiles.js\":\"e7e793b9dbac5ae3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/queries.js\":\"73874f86a35db1b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/schema.js\":\"77b890bb3d0e7dd5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/useCommentAuthor.js\":\"eb43fde93c9a2395\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"eb1d8e8c17fefbac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/followOrigin.js\":\"99b543ff14e72581\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/index.js\":\"3d8de196c984fc50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"28f90ef56c44d2f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b2e1ebf0c76027f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/CalendarGrid.js\":\"ed0d4a7b97564bc5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DailyNotePicker.js\":\"64b2ed1330f95749\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9c3fa2a79df75c3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateNavDecorator.js\":\"93dff34f1ed8ec37\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateScrubOverlay.js\":\"5df967f711a88423\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayPropertyControl.js\":\"0fe13597baecdff0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayValueReferenceControl.js\":\"7672d0ef9257c0db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/HeaderItem.js\":\"5986fd1d223f3081\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/ReschedulePicker.js\":\"8cb3f4f7e527217f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/SpreadDatesDialog.js\":\"daac415290730a43\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/actions.js\":\"b6ba15798ff0382b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/blockDateAdapter.js\":\"d969ba06d258677e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/calendar.js\":\"3c56c0e67884aa58\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dailyNotes.js\":\"ab03f18fc1e895ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dataExtension.js\":\"cda5c7ea7b415106\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubActions.js\":\"4666e53a6c76dd6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGesture.js\":\"35d1a756b1a4ad0d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGestureActions.js\":\"1a2c9bdf1b577e18\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1d9d514a2b19185d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayProperty.js\":\"c1572245c5ac5200\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"675c80b499318c26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/deletionGuard.js\":\"ad681cc493005899\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dueQuery.js\":\"6dae36d88a858e81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/index.js\":\"58276071cb90daf6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/landing.js\":\"87716576468474cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/localSchema.js\":\"4956c6279ee0972c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/referenceDateAdapter.js\":\"53dfeb80616b4686\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/rescheduleAction.js\":\"773fb486947e365a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/schema.js\":\"1f6b104189a472a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadBlockDates.js\":\"9c837bc0eaab5200\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadDatesAction.js\":\"d670877f4854858c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/today.js\":\"d1f53ebca07bd9f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f39e927c4c422042\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"2aa5ac2d3d8077eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/audit.js\":\"9e2f172e01fb4d87\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditAction.js\":\"4fc13d363e2f1c1f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditRanges.js\":\"9c08f26a0af0fd64\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/diagnosticsSource.js\":\"be9d17e128c83cf3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/divergenceScan.js\":\"904a0bfad25cce21\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/index.js\":\"9811eba05015984b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3f0f4504225f966d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/referencesMirror.js\":\"ece723c63bba366c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/rowJson.js\":\"96f2122dc4cc4a4b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/schedule.js\":\"95b54ba4f7e46829\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/store.js\":\"3a1237727ee5c827\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/action.js\":\"d3d7d1951d1ff717\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/index.js\":\"afeb1598c4ff7de0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/plugin.js\":\"b823444db0a35743\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d6f78b02d1376b0d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/actions.js\":\"a41bfe87a9db2302\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/changeMarker.js\":\"55731a3a7b7ea1e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/diagnostics.js\":\"f870bb847fbd1f9a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/fileSystemAccess.js\":\"254ef33b6aeb43ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/filenames.js\":\"93952980aa8cb1a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/index.js\":\"9d4985ff7a5be485\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/mirror.js\":\"2dfebfe2fddc9c39\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runLock.js\":\"a45015de579f197c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runtimeHealth.js\":\"a85ebde8ca33a4c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/schedule.js\":\"b17c9fdebbbb27a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/store.js\":\"cdfe6b084b88c2c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/index.js\":\"04d6e87cc35153bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/themes.js\":\"ca9265c90882a7dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/facet.js\":\"92111a99a7ab3ceb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/useDiagnostics.js\":\"6f484fffb057a091\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/dismissals.js\":\"c355107a2615dd10\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/index.js\":\"8828b6eb54ff8df0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/status.js\":\"6b087dc5e95dbb5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/store.js\":\"e12f48d50e9c9cc1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"63ba8e5227f96acf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsSettings.js\":\"1edc4162d7f5ed46\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/actions.js\":\"c6a9f9e4fe2a2d2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/config.js\":\"c46aa08b056cb653\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/dataExtension.js\":\"8292826278a8e300\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/effect.js\":\"1feb5708afb3dfb1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/index.js\":\"c9b7f71c03a7de4b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/propertyEditorOverride.js\":\"9cef996c95cd267c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/useToggleTree.js\":\"80eec6cd14b2eb40\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/ExtractTypeDialog.js\":\"30886aa192c2b244\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"918611a367136e53\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/PropertyShapePicker.js\":\"80767338012e86ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/action.js\":\"dc74d760605874cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/index.js\":\"72b8e7b5dbb17cfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/FindReplaceDialog.js\":\"d833582b5538df74\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/HeaderItem.js\":\"7bfedba7049cda8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/dataExtension.js\":\"1b65bea8fc556414\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/index.js\":\"8799160a5dfd43fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/search.js\":\"b395ea6301aed6d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/toggleStore.js\":\"44e41d2986243c32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/LocationPropertyEditor.js\":\"d5f8af338258ab3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/MapView.js\":\"70a9da62240579e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/blockTypes.js\":\"d8d667760adc7160\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/codeMirrorExtensions.js\":\"7587fe67d3571515\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/createOrFindPlace.js\":\"995ee32dd12af7f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/currentLocation.js\":\"e23e1275d97a6272\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/dataExtension.js\":\"1eee1e5b246b0842\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/geoContentDecorator.js\":\"54161bb71da24ce1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/googlePlacesClient.js\":\"a791dab75ea51ac7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/index.js\":\"ba26d07eb8c3962c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/locationsPage.js\":\"e00eb67162f92496\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/mapViewport.js\":\"4dc5f0c02fb699ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/pickCurrentLocation.js\":\"36675fc21ec156e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeAutocomplete.js\":\"40b4675271d859df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeNameCollision.js\":\"cf40624f7777eecf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/properties.js\":\"2491e5e24a59fec9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/propertyEditorOverrides.js\":\"93764f4763d40c54\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/query.js\":\"5627ee511b9cccfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/usePlaceSearch.js\":\"d5b8adc5ddd41e4b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"de8df497721d5c5c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"705380478b36aad0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"03638bdc51c37bf7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/config.js\":\"582c33fe687758cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/dataExtension.js\":\"2bff1d37bf45d04f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/facet.js\":\"8478d8a2a428a5ff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/grouping.js\":\"e5d73b082483dcb7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/index.js\":\"31db062abadc4b2d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"b121fb9e48940073\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/query.js\":\"fa931f90c2e445d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/resolveConfig.js\":\"eb25660529194996\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2c7f6716dec3b08f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"396f6cf2a5602ea7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlDocumentContent.js\":\"29932e8cea2003c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlFrame.js\":\"7e647fc3534f064f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/actions.js\":\"4b199ce512e2c4ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/blockType.js\":\"6d2dc15bc034977b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/confirmRunScripts.js\":\"305038f578279e03\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/dataExtension.js\":\"593b33ab2cf25fce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameAnnotations.js\":\"449a2aba0b0fb427\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameDocument.js\":\"59ee5b75a119aa47\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameTheme.js\":\"79c8aa4703791c8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/index.js\":\"6020394c6c6a2289\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/scriptConsent.js\":\"8630b0fab43fb0ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/sourceMap.js\":\"6cf82ad0fc2421a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/useDocumentScripts.js\":\"ac6f0c26888a7730\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/index.js\":\"4d3511421497dcd3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/record.js\":\"a3337435c59e8019\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/recordStore.js\":\"e2f67ae55bb6b2ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/responsiveness.js\":\"3e155ef28310038b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/schedule.js\":\"95328eb5081a400f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/sessionContext.js\":\"006543c38bdfee00\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"9e97a2821c11d001\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"79e4f5a91e2f4984\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/actions.js\":\"a0f53b9596fdff20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/config.js\":\"c537ae34d3fdb630\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/dataExtension.js\":\"f58383a4eac5a7cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/effect.js\":\"398ef9f93fdd988d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/index.js\":\"95a059f6c6ead1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/keyCapture.js\":\"8d3e8697927be71f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/overrideStore.js\":\"482b36d55c8d272b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"551fbcb6cf1dec29\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/HeaderItem.js\":\"0f11728213d9fb57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/LeftSidebar.js\":\"82138936738831b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/actions.js\":\"9e846faf11f8124b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/facet.js\":\"9056c0f4347be7b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/index.js\":\"e249b727b8d18dfd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/shortcuts.js\":\"2513b0e4e64a5b9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/toggleStore.js\":\"21cd77b479099204\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/MergePicker.js\":\"14199925399d48e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/index.js\":\"4f514a575385137a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/mergeAction.js\":\"f4bdb2195edc4fb4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/strategy.js\":\"925156b6992ca0ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/Button.js\":\"4a510d21fea45915\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"c245ab2dc803a880\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/defaultItems.js\":\"f7de5e4e5dcbbe53\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/facet.js\":\"bed1a4d50f5d292d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/index.js\":\"67a6e18318e85719\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1906d3df83fdf731\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ca436bc7d97f90e8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"15a96be2e5c0f0af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/facet.js\":\"27fff6d9e1b0186e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/index.js\":\"7d080864e1243d9a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/MoveDestinationPicker.js\":\"e4497404b185278e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/blockSubtreeMembership.js\":\"ffb45544687c0444\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/contextMenuItem.js\":\"9412fdf6faa7dcae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/index.js\":\"e7a619c95a00010c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveAction.js\":\"97d3f3ba36593441\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveBlocks.js\":\"61f66245eb480575\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/selectionAfterMove.js\":\"8ad37019cac1551d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/TutorialBanner.js\":\"92935c5b5203642f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/action.js\":\"0528695067ff69d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/bannerDismissal.js\":\"91720ce36bd267aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/documents/cheatSheet.js\":\"7ca18abae0592538\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/index.js\":\"579b30922ca3b767\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/keys.js\":\"178ef6188b5bfbb4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/landing.js\":\"4df947f85e9f378c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/outline.js\":\"7908e78265363ca8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/seed.js\":\"1bbd7ca81af09f9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b5db41882cdb7554\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/analyze.js\":\"a2f872b0bd3ee07c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/diagnosticsSource.js\":\"4f93c927ca2a53e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/index.js\":\"aa29b29069a4bcdd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/load.js\":\"339ee3d2e37872e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/monitorRun.js\":\"f663ae7ad08b4419\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/schedule.js\":\"7027b0925d78ec83\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/series.js\":\"e6b9f31a8a4f174c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/store.js\":\"574bb74bd7b5e4fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/trendAction.js\":\"de35f4edae7a39e4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/verdict.js\":\"f215e9daa45bd704\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/clickToEditAction.js\":\"178e6f144e33bd60\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/index.js\":\"ac121fdfe486e98c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/interactions.js\":\"e6ca0ef507d88839\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2a7329791e6de0e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGate.js\":\"d32562c763fe9284\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGateDialog.js\":\"03d1e3b4d3c1f92e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/action.js\":\"e65427b17bcdcde6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/index.js\":\"2433fbe089673533\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/localRunMessage.js\":\"e433da1dab28ea4b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/plugin.js\":\"bde05b390620da9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/progressReport.js\":\"3e9c3aea2746cd67\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/sweepProgress.js\":\"7c386545066dd55e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/FieldRowRenderer.js\":\"231dbfe3de66d185\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/ValueRowRenderer.js\":\"2b30f613dafd6d78\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/actions.js\":\"e25cb24cedb73b7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/autocomplete.js\":\"ad6463b67c196e34\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/fieldRow.js\":\"c995913101898811\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/index.js\":\"6046926882589487\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/referenceWarning.js\":\"805f2c3d8d76b1fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueAutocomplete.js\":\"f00e07a28df6c3b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueSchema.js\":\"93b54b511e09b5b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/HeaderItem.js\":\"6968f3396034e704\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/QuickFind.js\":\"d88790515f7c6324\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/index.js\":\"4123fb7b50714707\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/recents.js\":\"1501620cdfe1a659\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/resultItems.js\":\"6f3f32eb864e27d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/selection.js\":\"34e0184df5724529\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/toggleStore.js\":\"c0b1d1f79f99d46d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/HeaderItem.js\":\"d7e9ecb6b637467c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b66da36e85d7683a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/grouping.js\":\"7368d3524d41c952\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/index.js\":\"d6c9a86e42a3411e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/target.js\":\"8a8154590ee7ca1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/codeMirrorExtensions.js\":\"693f8324dd0f27fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/contentPrefill.js\":\"0d71434450f323fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/dataExtension.js\":\"dd2674a7436967f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/index.js\":\"4f46b934a65579c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"52433378e72e0dae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/invalidation.js\":\"51b05da9e3e5f609\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/localSchema.js\":\"8ff0fdf1624985c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/index.js\":\"cb29fd506f908d93\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"0ead684e68399eb1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/index.js\":\"0d32263fa4411420\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/referenceNode.js\":\"3a904da9e07646fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/remark-reference-occurrences.js\":\"cdfd3ff5e51c6760\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"dc0676963623ca0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/index.js\":\"15cf6b147368a15c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"44cc6e00f5bba355\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"bea6a9ee891fe704\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/mergeRetargetProcessor.js\":\"89633f1d0bf72328\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/parseFence.js\":\"679772732b108c1f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceParser.js\":\"469bbde34fbbf72e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceProjection.js\":\"6636779307b91ca8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referencesProcessor.js\":\"e2e1956a808e4313\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/renameProcessor.js\":\"80ca641487100ba9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/spanReplacement.js\":\"fe187faf67b10693\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/htmlToOutline.js\":\"2faf487955ac3556\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/index.js\":\"07903c1bc5d30595\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/normalizeClipboardDom.js\":\"3e6f978651c85ecc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/pasteDecision.js\":\"b2a991020d9e079c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/action.js\":\"96f85fe49cef702e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/blockIds.js\":\"e47e6bcbd140a9a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/content.js\":\"7e0d2ba74cff4cd2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/effect.js\":\"e62acce6a692c9b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/ids.js\":\"bcf61b9feb35959a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/import.js\":\"33243218f47f036b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/index.js\":\"80a7d9dda8eea4ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plan.js\":\"866758eba94201c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plugin.js\":\"083381f0df08e63b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/promotion.js\":\"c609d2da17b3ffdb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/properties.js\":\"5517a70a18a8eaec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/references.js\":\"4b4497c3935705fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/report.js\":\"dac3376f266a655d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/roamMemo.js\":\"a9ca99025f4b55f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/runtime.js\":\"9decb68c0e9989cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/schemaReconciliation.js\":\"6387a761fab5f0ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/srsMarkers.js\":\"7557094604fa5980\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/todo.js\":\"7608e27bab6b6bd4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/typeCandidates.js\":\"a78686d1509d7f94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/types.js\":\"7911e25296d7366f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/index.js\":\"4dcbfb179c89fded\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/store.js\":\"c7af40a8add9c067\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/HeaderItem.js\":\"2f7bf93d5630b9bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"aee18e1b7b4820b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/index.js\":\"6a95e3bee7478159\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/model.js\":\"28b523cee013030e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/toggleStore.js\":\"6eda42bf6543bc6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/useKeyInspector.js\":\"ff0f1d0072ac2984\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"32d4b58e5b3bad18\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/ShellDecorator.js\":\"29f7bd7b36419142\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/actions.js\":\"f88e246f74a1fcc7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/exclusionsFacet.js\":\"eaf601543abb3024\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/index.js\":\"4fbbf1c51d792334\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/shell.js\":\"323cd593804c20b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/surface.js\":\"8d03b187246ee322\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/walker.js\":\"2de1bdb6bfc678be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/RescheduleToast.js\":\"c960668acd6f9e97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/dataExtension.js\":\"5a5991041398f3ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/index.js\":\"d0fa98a17a135e1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/indicator.js\":\"aafd4341f18dd486\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/moveSrsState.js\":\"b7313ed35bad91f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"843c12bdbe7499e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/scheduler.js\":\"2be3fda8b1c061b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/schema.js\":\"8e4067ee01adf57a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ac108846990dbd48\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsClipboard.js\":\"6553e7df0dc3e89b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"23f8c5fa3d1639bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9c416ce4da5676f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DeckPicker.js\":\"18d0d36b5ca779d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewControls.js\":\"c29fc53be9490e2d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2fa566c669ffd01a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewSession.js\":\"d37b0db90845f3af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/actions.js\":\"92f88713f5b08279\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/archive.js\":\"1d107b684afde235\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dataExtension.js\":\"6150007766c66946\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/deck.js\":\"849d0ae76dc4510a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dueQuery.js\":\"0d4590128e89bd20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/gradeDecision.js\":\"e9784401d5ee64ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/index.js\":\"6e0488025df24b1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/keyHints.js\":\"9248a9f63762008d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewCardLayout.js\":\"c416e6b27092577c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewProgress.js\":\"d5bdee838d30ebd7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/schema.js\":\"a31c6cb69e52845e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/useDueCards.js\":\"4629585a55a32734\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/index.js\":\"e676b9c082adf082\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/record.js\":\"2dda0ee8ccfd0ce1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/index.js\":\"f7225545e26b2d88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/persistenceStatus.js\":\"1e4a1b2fa99e4583\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/requestAction.js\":\"0ff129483e7c6b68\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/TypeChipsDecorator.js\":\"a94f2cee9d32e321\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/codeMirrorExtensions.js\":\"52cf8aba02a7455b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/index.js\":\"f941c772ab8d18b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/typeAutocomplete.js\":\"5acda73fc9c61409\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"dde175a3732736d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/actions.js\":\"bd545b141f0079ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/anchor.js\":\"097d057fb58da0a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/events.js\":\"a87930cc4102d40e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/gestureActions.js\":\"8c89a67c45778611\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/index.js\":\"385ab177acfae8f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"14fd3c445eef2571\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/collect.js\":\"819ded8a4c30b09b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/index.js\":\"74f9cc665295f4ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/record.js\":\"3a90ec89832f089f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/RejectionDialog.js\":\"8dbe0bf44bc4f438\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/SystemStatusHeaderItem.js\":\"20f22ab8bd81ab40\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/index.js\":\"b26ae747a732d40b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/model.js\":\"d0799734b42c6828\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/queueCounts.js\":\"55c157af8f2af85f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rejectedHelpers.js\":\"2599479ef81d14e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rematerializeAction.js\":\"1705b34a5cb832f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/useHysteresis.js\":\"6daa9e1e095e2179\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/ColumnHeaders.js\":\"09666cb0d48f9800\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/QueryUi.js\":\"0c9be5e9312714b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/TableLayout.js\":\"6d04a0ed274cc05c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/actions.js\":\"6f292fa448789916\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/cellEdits.js\":\"be7936efc257c067\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/childrenViews.js\":\"ecb35cdd38bd1b3b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/columns.js\":\"941e53c5aac14f50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/controller.js\":\"e55b734b270b01e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/convert.js\":\"e633cddac3de5dfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/dataExtension.js\":\"b235a0099b7d761d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/index.js\":\"888c48ab4a0ba6ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/keys.js\":\"41e08379011fc890\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/model.js\":\"6c600f17fb5b8436\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/QueryText.js\":\"04ced205fbfd04c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/backfill.js\":\"238bac3b29a2cb04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/completion.js\":\"22660aa4052823dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/format.js\":\"3cc8bdfb8ec0cb1f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/parse.js\":\"8da83ffdbd0f158f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/queryValue.js\":\"4b095264e9b0e1d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/registrations.js\":\"26f85dd1981caba6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/source.js\":\"9a95bedc924b5fad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/registry.js\":\"3748f43631963f8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowGutter.js\":\"deaa1f1f032d0eff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowVerbs.js\":\"08043b15c6c23059\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/schema.js\":\"4e321e165b382ed5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/sort.js\":\"e831fe6da32d8ac3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/effect.js\":\"e394db2c211a947c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/index.js\":\"e04b77c378054a67\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/theme.js\":\"ed0335099e8aeecf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/actions.js\":\"9cdebd2ee2e3a9fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/dataExtension.js\":\"0fc2221114296bdf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/index.js\":\"789bdc0b322835b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/schema.js\":\"9c100ab7fbff2de9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/TouchSelectionLayer.js\":\"dd9cf542d4fa5f69\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/actions.js\":\"0b71b12d42c7c2bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/defaultItems.js\":\"592d7444de9a3fa0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/facet.js\":\"4de9a1e23dbb0686\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/holdRecognizer.js\":\"3607755b07a2eaae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/index.js\":\"f210d6de2cf0d408\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/UpdateIndicator.js\":\"e5e7e6062ad420d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/index.js\":\"e29f9d5e24ba1d04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/loadTimes.js\":\"9b6b73a0d87dc418\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoNotesRenderer.js\":\"cd41ffca5e95b1fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoPlayerRenderer.js\":\"9b1ce3ea84cb16f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoTimeStamp.js\":\"3c5069f9fac45060\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/actions.js\":\"f1a00bc53a98b54a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/index.js\":\"85cd5b77a508ac16\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/markdown.js\":\"ee93e5391f4753d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/notes.js\":\"7447546a9011edfb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/registry.js\":\"4570602d01892052\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/remark-timestamps.js\":\"4fe96ef164060844\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/view.js\":\"73ec2afb57c280b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/LinkHints.js\":\"d9d8e3f19b035d3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/index.js\":\"b687c8a51321751e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/model.js\":\"1e25bfbd8fefb621\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/settings.js\":\"ad179536baa83814\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/actions.js\":\"9278b180be0cc0c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/index.js\":\"93f2b5ff21589de7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/interactions.js\":\"d9b766e65c891c7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/workspace-header/index.js\":\"a9f4aaad6b2fb2ea\",\"/knowledge-medium/pr-preview/pr-1919/src/registerServiceWorker.js\":\"7b142d4c2adcfab8\",\"/knowledge-medium/pr-preview/pr-1919/src/requestPersistentStorage.js\":\"1952802d1a1e8ace\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authRequestDeadline.js\":\"1c4c282463f5ebb3\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authStorage.js\":\"1a9cdc11391e2270\",\"/knowledge-medium/pr-preview/pr-1919/src/services/powersync.js\":\"a2287f5e93e001b0\",\"/knowledge-medium/pr-preview/pr-1919/src/services/supabase.js\":\"7e838af0072b8bad\",\"/knowledge-medium/pr-preview/pr-1919/src/services/uploadErrorClassifier.js\":\"5c1525769d43feef\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/ActiveContexts.js\":\"487c21c972e59d49\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/HotkeyReconciler.js\":\"a779f84936aa2e73\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/WipeLocalDataDialog.js\":\"cf90205b434ca59c\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionDispatch.js\":\"20460a5064a0dd9d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionRefItems.js\":\"9934df29f6813bbf\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/applyKeybindingOverrides.js\":\"b19d9f6f9a573475\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockActions.js\":\"96434dac6e02442a\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockMergeGesture.js\":\"95d2b80f88c45b47\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/canonicalizeChord.js\":\"76dcf3cbd219c23a\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultContexts.js\":\"ee1ceb8b25125c10\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultShortcuts.js\":\"113abf91234b1d01\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/effectiveActions.js\":\"5371c09bd8a179cc\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureAction.js\":\"e4438696bde7f94e\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureBinding.js\":\"39e2af2c5eae3115\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/holdRegistry.js\":\"8fad59489d4461f8\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingConflicts.js\":\"5c77302c27e4fde6\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingOverrides.js\":\"74d08fb1b0e7151f\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/pointerAction.js\":\"c3a190073def4e3d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/resolve.js\":\"b760e5cac6a2a166\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/runAction.js\":\"23e50318c39ac9cf\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/sequenceMatcher.js\":\"64eaa73744789dce\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/types.js\":\"6f513687c16ffa72\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionContext.js\":\"fc2a300ae8718ac1\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionDiscovery.js\":\"6ddde24ce0255a47\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/utils.js\":\"64711c97b52e334c\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/bootStore.js\":\"e32b3e7bdc453b10\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/previewDatabases.js\":\"50949aeac1d698ad\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/byteTransform.js\":\"8f2011a5d6a8b7ca\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/attachmentCleaner.js\":\"537dd618df3ed8dd\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/attachmentParts.js\":\"0ed04c9b0abe3798\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleParts.js\":\"fad5dafe19f7f535\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleRecord.js\":\"934989936584a730\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/manifest.js\":\"5c6d63272b5994f5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/takeBundle.js\":\"2df5d877a3624bcf\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/verifyBundle.js\":\"04df1c535e9bfd25\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/cleaningStage.js\":\"2245e672a8dbf607\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionKey.js\":\"ea08793e56e906c6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionServer.js\":\"a1644fbf3823174f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flip.js\":\"b561356e1ae47924\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flipAttempts.js\":\"9a86a5412b7922b6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/pages.js\":\"6ae535f4ab716be7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/preflight.js\":\"e763d655d1a2c577\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/reseal.js\":\"2ce2e4ed09fe4054\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runConversion.js\":\"09bd86533e413233\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runLock.js\":\"3dbcffecb1351440\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealing.js\":\"4a55fe261f1538ed\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealingStage.js\":\"548fe716e9a90cbf\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/stage.js\":\"089410f2a7588a03\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/verifyReseal.js\":\"fcd9fde1b1f5c853\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aad.js\":\"5b0e5611bb1f59c8\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aead.js\":\"3645d7bf99c6a0e2\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base32.js\":\"499dfe285a720470\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base64url.js\":\"ad9f5ebeca39d7f3\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/binaryEnvelope.js\":\"e67584ff52303e15\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/byteAead.js\":\"ffc0c2500d22b4a8\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/canary.js\":\"c36cbe4e1bb25263\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentHash.js\":\"f1695a9cd82e9db5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentKey.js\":\"62fb6d52f3ac645c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/derivedIdNamespace.js\":\"7776e27c5e6c3153\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/envelope.js\":\"384398e39acaf4d8\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/hex.js\":\"13dc059f4158cf50\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/sha256Hex.js\":\"d719f69d35c219e3\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/workspaceKey.js\":\"88e51b29ee2bbb92\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/conversionState.js\":\"5046dfe34fb33569\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/createEncryptedWorkspace.js\":\"dc5aac2b1c36c617\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/pastedKey.js\":\"5715821b77e110cc\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3f17b8da1d49c4d1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/upgradeWorkspacePin.js\":\"103c62588f693cb6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/keyStore.js\":\"649e2d97e48be388\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/mintWorkspaceKey.js\":\"b757e55c91e5faa4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/modePin.js\":\"5975416596d32679\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/openWorkspaceKeys.js\":\"f18451a23a4f4846\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolveWorkspaceEntry.js\":\"9311402193f3a004\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolver.js\":\"11616a6a9dab4ea9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/workspaceAccess.js\":\"ce4543040a3d4706\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/transform.js\":\"770d7e6f92666169\",\"/knowledge-medium/pr-preview/pr-1919/src/themeBootDefaults.js\":\"3192b6790a85739e\",\"/knowledge-medium/pr-preview/pr-1919/src/types.js\":\"52b954ff2ce08f42\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/ClientLocalSettings.js\":\"c95b2e903cbb27af\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/abortableSleep.js\":\"f1e0cd8d4d585db6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/array.js\":\"9012992db4d489b6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/backlinkAutocomplete.js\":\"1fdf3e3d2746c652\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockCrumbs.js\":\"433e78ae942794a2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockrefAutocomplete.js\":\"e8cde26f28ae9be4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/cadencedIdleJob.js\":\"5aa632385a9c8c81\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/callbackSet.js\":\"eb84296cc4d37dd4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/clientId.js\":\"5412e9c07a9c3c9f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirror.js\":\"c25d136bc21fe0cf\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirrorCompletion.js\":\"f1870fad538e422f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/copy.js\":\"5485f54fc19d7545\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dailyPage.js\":\"ee0b44b78f9cdf11\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensics.js\":\"5ab7bb6f4ca0cf75\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensicsHooks.js\":\"6d2dfa3440502f6a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/deleteBlockThroughUi.js\":\"4e2850fe271978a3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dialogs.js\":\"a2ca31a319e1ad56\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dom.js\":\"4c8d7230f3985298\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/downloadBlob.js\":\"fdfe044c270d072a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/drawnWalk.js\":\"80b97c65a3d8efaa\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/exportSqliteDb.js\":\"1848b12755477f43\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fileSystemAccess.js\":\"8c04d198566f30e0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/flipSlide.js\":\"9a2b4c420c8625f8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fnv1a.js\":\"36faa05a09957bc6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/formatBytes.js\":\"6389e46ab3dfe3a7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fuzzyRank.js\":\"422dc3297b70e58f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idbKeyedStore.js\":\"291334f3d4e8f3c7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idleCallbackPolyfill.js\":\"7d65279453b41bbd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardAwareScroll.js\":\"f7849fe9cf47c12d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardViewport.js\":\"520943446c4108c5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/lastWorkspace.js\":\"44bc14a4973068f3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutColumns.js\":\"55bfe4f45d46138f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionDom.js\":\"b411c20eb56416df\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionId.js\":\"755c488be287dfb7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkClickGestures.js\":\"85a2cf613e1969cf\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkTargetAutocomplete.js\":\"ca3133dac82befc5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbCorruption.js\":\"f834d8f14067cd80\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbRecovery.js\":\"3b9133bf74635079\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/markdownParser.js\":\"e2e9fac2b1215b2f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/memoize.js\":\"8100f1a8e3452cd4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameFieldCommit.js\":\"bd5f402cb12a6238\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameList.js\":\"b78c6200dd1b003d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/navigation.js\":\"0b7ce09238c34956\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/omnilinerNamespace.js\":\"f1bbdaa549c0b4f4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/opfsPageScan.js\":\"f7afbc8c23e723f1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelClearance.js\":\"43c89e4eab7492ca\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelHistory.js\":\"55dd8c92717a4fb3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLanes.js\":\"387e662483817705\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLayoutProjection.js\":\"32ab70c7fbb649e5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelScrollAnchor.js\":\"929e236257cea7f1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelUrlFlags.js\":\"3caffd0e8b828e84\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/platform.js\":\"1c05ba013085526f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/pluralize.js\":\"f0c5a840f1867345\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyCreation.js\":\"611a11e73ff7a964\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyNavigation.js\":\"d97281d65d23fe8c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyValueContext.js\":\"1539025172aa06de\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/react.js\":\"0a0fdc5d2e7932ae\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeDate.js\":\"a353d319de493598\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeTime.js\":\"edc13622d5be2862\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/renderScope.js\":\"a55cbe1ba678f3a7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/resolvedThenable.js\":\"d06961c58bd249cb\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/routing.js\":\"00df20f1474b5fc4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/safeMode.js\":\"978a4c1678544e11\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/scheduleIdle.js\":\"d7566442c8117b3d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/screenWakeLock.js\":\"7aa2ef7a049214f0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/selection.js\":\"d4b8a5a1c73d5d37\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/softKeyboardGrab.js\":\"009254a391405552\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/startupTimeline.js\":\"e480db9d505f8e17\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/state.js\":\"4ee13436214a28d9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/string.js\":\"8702e6c1c1be5cf2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/surfaceZoom.js\":\"98e2ae96970f93ac\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/time.js\":\"e7218a84ea440f70\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toast.js\":\"b9d72c542064bb24\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toggleStore.js\":\"ebc2e339119ae422\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/untilStopped.js\":\"92bd0416fc0c0ed3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/userActivity.js\":\"2a92f718a1cc5c84\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewTransition.js\":\"9868a25723373a38\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewport.js\":\"a7c790a4a7199334\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/webLock.js\":\"5523f24497262e9b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceRecovery.js\":\"7fbc6f0f9b4eee13\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceSnapshotStore.js\":\"f554c62c573fa19a\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-compiler-runtime.js\":\"17ae6c4010fd69b4\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-client.js\":\"e9daec424b2fded8\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server-edge.js\":\"81cf683ad4613cef\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server.js\":\"9822900ffa754b8e\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static-edge.js\":\"1c236ccede0e02e5\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static.js\":\"a9841c3f12932638\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-test-utils.js\":\"9811cae95f81e4ac\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom.js\":\"1df9e3aa46f26d22\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-runtime.js\":\"f58d9da7b03191aa\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react.js\":\"6a2efb2b289f819d\",\"/knowledge-medium/pr-preview/pr-1919/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
