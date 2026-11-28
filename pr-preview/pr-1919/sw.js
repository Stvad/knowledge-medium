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
		buildId: "36dc4828e331-3e71edd8",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/\":\"266032147956bab0\",\"/knowledge-medium/pr-preview/pr-1919/index.html\":\"266032147956bab0\",\"/knowledge-medium/pr-preview/pr-1919/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1919/assets/FacadeVFS-B6uLEty6.js\":\"7aa41e036a00e54b\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSCoopSyncVFS-BlTQX9s3.js\":\"ffc531704362af47\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSWriteAheadVFS-DsJdPs12.js\":\"3fd95c23c610ef98\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-DlROgey1.js\":\"6939b26e849b016a\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-lncq_ybC.js\":\"f7158d941bcb478b\",\"/knowledge-medium/pr-preview/pr-1919/assets/worker-fGhfelCd.js\":\"9944ebf8edc89357\",\"/knowledge-medium/pr-preview/pr-1919/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1919/chunks/app-CWbVzXEv.js\":\"c47f5fd71f48b242\",\"/knowledge-medium/pr-preview/pr-1919/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1919/index.js\":\"48c9d40816b84205\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1919/assets/AccessHandlePoolVFS-BoGPYxRf.js\":\"74f37af66f9474f7\",\"/knowledge-medium/pr-preview/pr-1919/assets/IDBBatchAtomicVFS-B8u5ZU6X.js\":\"20b6f1e29b5b097a\",\"/knowledge-medium/pr-preview/pr-1919/assets/MemoryVFS-DNXLA_-D.js\":\"9cc0d305448017b6\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-U-fIfgwd.js\":\"7a17c6f49a224a15\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-C3avf6-K.js\":\"a60cd44b1039984d\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1919/chunks/AccessHandlePoolVFS-CFVSWwMy.js\":\"478a4af56158678f\",\"/knowledge-medium/pr-preview/pr-1919/chunks/FacadeVFS-C_aP3bOu.js\":\"a0ebbcf7adacb05e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/IDBBatchAtomicVFS-D-yx73aU.js\":\"c32d2005439ace6a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/MemoryVFS-CY1vw93c.js\":\"8e7cc81a78dade9f\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSCoopSyncVFS-BdBUofi2.js\":\"57792b0abdba3643\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSWriteAheadVFS-CP-hGhuN.js\":\"f133f7fce435fa38\",\"/knowledge-medium/pr-preview/pr-1919/chunks/Preview-DxTYFUoT.js\":\"3993465def910cad\",\"/knowledge-medium/pr-preview/pr-1919/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/card-C252oMyd.js\":\"897117324dc44c4c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-Cr7j1BND.js\":\"00e5dde780b1183b\",\"/knowledge-medium/pr-preview/pr-1919/chunks/freezeExtensionImports-B7zwW5Pg.js\":\"b538143529b68749\",\"/knowledge-medium/pr-preview/pr-1919/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1919/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-BKvlS76w.js\":\"a6f1a6c1d089a1c7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-async-B6EbCSq7.js\":\"663bca6c76ee6da8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-BZdnY262.js\":\"4a66bb2a0333df08\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-C7HzmID9.js\":\"0b5a8567f73eb0d9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CNAwfOPX.js\":\"2eeb2cced9768d78\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DOmDodmK.js\":\"786b6d8e4c8fbc89\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DcfbyMtO.js\":\"f4e2979e6f8939b6\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-FqzQAGb9.js\":\"5527674ad764a20e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-TJC3gHxh.js\":\"d6ef8cba7f09255c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-cGOm7-tP.js\":\"05230d4175354f4e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server-legacy.browser.production-DyiobMXV.js\":\"8db4610301111207\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.browser.production-wgWj8t76.js\":\"a5bcbcd189a53eb6\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.edge.production-D5kQBZg6.js\":\"32480b75fad0de64\",\"/knowledge-medium/pr-preview/pr-1919/chunks/server.browser-D2JoYgcJ.js\":\"9a69c7008d17817e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/textarea-5sAt_8fk.js\":\"9765af7898345e34\",\"/knowledge-medium/pr-preview/pr-1919/chunks/ui-BSwPvtU9.js\":\"6b0bcea3fb48ebcf\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-DiMwuaFR.js\":\"dc46ccc9a5bb52b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-async-DAMXKp9v.js\":\"fe5b0a07c6c5a12a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1919/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/src/App.js\":\"c82d4b28129fd013\",\"/knowledge-medium/pr-preview/pr-1919/src/appUpdate.js\":\"a92c2a74672741f5\",\"/knowledge-medium/pr-preview/pr-1919/src/appVersion.js\":\"23dd3497a889ab72\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/initialLayout.js\":\"f04f2acd3dc56fd3\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/openWorkspaceData.js\":\"620e7267288e7de4\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/resolveWorkspace.js\":\"0f179b08c99b6e57\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/workspaceBootstrap.js\":\"4a8f3b70a76dce1b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockComponent.js\":\"72b9aa32b30fa479\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockCrumbs.js\":\"db3c7a8a0ae8cd83\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockEditor.js\":\"c92a3881871af003\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockLoadingPlaceholder.js\":\"ce1c176e26ca59ca\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockProperties.js\":\"cf723a14ba1ffea3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockSearchPicker.js\":\"c1db1371fb7d2b35\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ConfirmBulkDeleteDialog.js\":\"53e2119c635fa1a5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DividerHandle.js\":\"04d50e38de77e529\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DraftEditor.js\":\"99acde298bdda3c3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/GutterPill.js\":\"a01875e9b73b84a7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Header.js\":\"f848f38b883de1e9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/LazyBlockComponent.js\":\"f4336403418fe70e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Login.js\":\"5bafdc1b9ef3152f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ZoomableSurface.js\":\"bb2fb26228ac5016\",\"/knowledge-medium/pr-preview/pr-1919/src/components/editModeKeepalive.js\":\"5902601b6270945f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyDisplay/PropertyDisplayScope.js\":\"a74478960a3e7141\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"4522b44a0f64da54\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefPropertyEditor.js\":\"0fed825d8eab4aaa\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefTargetTypePicker.js\":\"9643d35cc6ab3d2f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/SelectPropertyEditor.js\":\"887e9a281a5c0751\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/TypesPropertyEditor.js\":\"77c6ca1cf0a00602\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/defaults.js\":\"e3c2aebb68cb8541\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/kernelValuePresets.js\":\"74bdb1a6cd6f2098\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/selectablePresets.js\":\"a0533b16548b0529\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/typesPropertyUi.js\":\"486636c580bf2e23\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/AddPropertyForm.js\":\"351c19e5131e86fe\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyPicker.js\":\"aa962bee6ef13886\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyRow.js\":\"ed44b8d854f3617e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/Rows.js\":\"938f917fe77a14bc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/actions.js\":\"acd2961f02c4a399\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/declarationOnly.js\":\"4d3cb4b657707953\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/layout.js\":\"83390f6bd550d2c4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/model.js\":\"e3815238449e96fc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapeUi.js\":\"6e2f352c2853a468\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapes.js\":\"25d06a4cbc47fa34\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/usePropertyEditingActivation.js\":\"7f2908d0410f2760\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/visibility.js\":\"6984b1ec21e7abe2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanelSections.js\":\"1f91d23e24aa852d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockEmbed.js\":\"2c06e4a2fb82ceb3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockLink.js\":\"059e4b53c91a4139\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockRef.js\":\"b9898399e7313cb8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/CompactReferenceLink.js\":\"e41fab55a23f9f90\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/ReferenceLink.js\":\"d8067964ec4df5cc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuard.js\":\"c3af705ffda3f0e0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuardContext.js\":\"813233a63126ab7f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/linkInteraction.js\":\"8167a976656e653b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/referenceLayout.js\":\"313a5c3b9f94f8b0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/useBlockRefAncestors.js\":\"f5b5e17d9773cbe6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockGutter.js\":\"5744b9ed14e95722\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockInfoDialog.js\":\"c0d1c9cf6a3bd92f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockReadText.js\":\"86f1ee5f3b96ff38\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockTypeBlockRenderer.js\":\"da5bcf0b8de2a49d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BulletHoverCard.js\":\"fdbe097497b388e9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorContentRenderer.js\":\"bd076afbff42dbd3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"261acfe939dcaa48\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ColumnResizeHandles.js\":\"34f95d4ea4850484\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"efc515516adf073f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/DefaultBlockRenderer.js\":\"02b1768c98e5e53e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/LayoutRenderer.js\":\"fd34bb5075a22b22\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MarkdownContentRenderer.js\":\"8ee0334c1fa45c23\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MissingDataRenderer.js\":\"eaf8d8e62eee2b06\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PanelRenderer.js\":\"ad1d11eff7eb1ada\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ec1778ec10ae2482\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/TopLevelRenderer.js\":\"e7ea2ea32e2d24b1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockGutterMode.js\":\"cccc17ad200eec1d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockTitleText.js\":\"5d8c67784b63fa95\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/fieldCreationKeydown.js\":\"d072e3ad73ba083b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/layoutRootContext.js\":\"b3d24969a45fb505\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/TypeChip.js\":\"f55198ff56490e1f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/chipStyle.js\":\"1a3fdbb1093e0b08\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/anchored-floating.js\":\"875833d5ad30f85e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/button.js\":\"30fd95f6c6058fd0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/card.js\":\"56c0de7c5d991402\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/checkbox.js\":\"55e07ad1eb89edbb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/collapsible.js\":\"5ac981f4ef0dc917\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/command.js\":\"d83276ad4d86e64a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/context-menu.js\":\"afdd192ff74b1f8a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dialog.js\":\"a36730e39e6dacfd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dropdown-menu.js\":\"eb90f2094a17fc6e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/floating-listbox.js\":\"fde6eaa08aa28996\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/index.js\":\"41ff142dcb2df87b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/input.js\":\"12025bd418d67092\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/kbd.js\":\"36e37b388e128b84\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/label.js\":\"033511d1e1595dc6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/textarea.js\":\"757739a90ee3db5e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/useEditModeYieldKeepalive.js\":\"35602e38180c35f2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/BootFallback.js\":\"e6696dcbc0b1eedf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/FocusedRowLazyMount.js\":\"d2a5354567864958\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LazyViewportMount.js\":\"4240ffb3f4c3563a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LocalDbCorruptionFallback.js\":\"5b10874829336944\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/error.js\":\"5c80b5475408005f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/lazyMountRegistry.js\":\"a320752181cd45f0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/suspense.js\":\"18a1ddc51aa996fb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/CreateWorkspaceDialog.js\":\"a5c5378caa66c9d4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/PendingInvitations.js\":\"a2574eb62b763405\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/SyncProgress.js\":\"dfcd0bd5937ce011\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/UnlockProgress.js\":\"54afead141175e1e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceKeyGate.js\":\"747757c1f16b27bc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSettingsDialog.js\":\"ca338f0f8aa44ea0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSwitcher.js\":\"b10e9acc6c753626\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSyncGate.js\":\"0cb7ce0f7f5bae04\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlow.js\":\"349fdf4f50c6704d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlowHost.js\":\"b926f2468a7dfba7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/EncryptionSection.js\":\"3a445af4f79f197f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/attachmentPrompts.js\":\"a4723aa1fa8f5aac\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7aae689fd32c69a2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowDeps.js\":\"976d794641f3ed75\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowStore.js\":\"1da4b35456bad9ca\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/flowUi.js\":\"608efefde7ba0e52\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/useConversionRun.js\":\"19369192483f392c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/keyUi.js\":\"0b1bd1d30a9ca5ed\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnKeyLoss.js\":\"406d190e4217f65c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnServerE2ee.js\":\"3ad4776c4ed69d82\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/workspaceUnlocked.js\":\"635a652d8ddce434\",\"/knowledge-medium/pr-preview/pr-1919/src/context/backgroundSubtree.js\":\"1b5779be377819f3\",\"/knowledge-medium/pr-preview/pr-1919/src/context/block.js\":\"d31e840806f02676\",\"/knowledge-medium/pr-preview/pr-1919/src/context/layoutWsContext.js\":\"f23f8bf7fb07eefa\",\"/knowledge-medium/pr-preview/pr-1919/src/context/propertyDisplay.js\":\"c9672b8a16f64ad1\",\"/knowledge-medium/pr-preview/pr-1919/src/context/repo.js\":\"6be49d6dd433ac77\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasClaim.js\":\"5d882d617e1142a8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasSeatNamespace.js\":\"5ad10ac52150ad25\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockData.js\":\"edc82c05a921a55e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockType.js\":\"d9a08d17e0dd7c32\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/changeScope.js\":\"441425f7ac2f8853\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/codecs.js\":\"25dfe331280b3e9d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/derivedData.js\":\"a0d516d36f758174\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/errors.js\":\"6a228c4e44ea7fed\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/events.js\":\"d969914fbb08335e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/handle.js\":\"c926f981039901f5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/index.js\":\"5a85e89893ef14d4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/mutator.js\":\"2e1403d1773f5769\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/processor.js\":\"bc741022fe81489c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/propertySchema.js\":\"a7ebbfa2738662a9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/query.js\":\"140e6b2c7e56a28a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/sameTxProcessor.js\":\"ae4c0301a4fbcebe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/schema.js\":\"c926f981039901f5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/tx.js\":\"c926f981039901f5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/typedBlockQuery.js\":\"0d2a7e03b8074945\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/user.js\":\"e3bc0b24696f98dc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresetCore.js\":\"99674d19df5ecf0e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresets.js\":\"a7a1f6f9648f062e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/attachmentCleanerIOVerb.js\":\"3e6ee2f1afac2ecf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/block.js\":\"af6d9870b93e42ee\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockCache.js\":\"1535bfa50d6e5265\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockId.js\":\"1282bf24a03a6e25\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockLiveness.js\":\"86e2ac26cf776cd2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockMerge.js\":\"33ae786e39ba36a1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockSchema.js\":\"89bc93ad1e829aca\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypeLookup.js\":\"89775b14e2dbe2e2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypes.js\":\"b580228ad3642c32\",\"/knowledge-medium/pr-preview/pr-1919/src/data/childrenView.js\":\"e45f82b232255d55\",\"/knowledge-medium/pr-preview/pr-1919/src/data/clientContext.js\":\"c95fb752accfbdf8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/dbFileSiblings.js\":\"c703d0e6f1530c28\",\"/knowledge-medium/pr-preview/pr-1919/src/data/definitionSeeds.js\":\"358dba3c15dc8612\",\"/knowledge-medium/pr-preview/pr-1919/src/data/derivedIds.js\":\"0c210d56144700f0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/drawnSubtree.js\":\"c56de1da96e66aa4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facetBridge.js\":\"c165a4b04b138bcd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facets.js\":\"dc7ea5ac7453e51e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/globalState.js\":\"f90b07c6c78873da\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/aliasClaimRederiveProcessor.js\":\"36a4d8d427f91ce6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/ancestorBatch.js\":\"f6e0a69416d00f92\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/blockTypeTypeifyProcessor.js\":\"5840e928f61f3031\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/clientSchema.js\":\"054b348b0b7467d4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/commitPipeline.js\":\"0956e7efc888e32a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/devAssertions.js\":\"200c77718c16e0ca\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/firstSync.js\":\"3d0e08b21c7ff535\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/freshInitialLoad.js\":\"e64dca59660b18ea\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/graphBackfillClaim.js\":\"2f881c5a2226a5da\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/handleStore.js\":\"189632ceea2dabd8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/idleMarkerJobs.js\":\"2983cb50d1e72351\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initialDownload.js\":\"d61ae5de71b0dd85\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initializeClientDatabase.js\":\"97e40387f71a70f3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/jsonCanonical.js\":\"67e5acba9664c0f6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelInvalidation.js\":\"2d76268acdba7bc7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelProcessors.js\":\"4b9c827b6a381ca8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelQueries.js\":\"2966f58fea342ef1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/mergeTypeMembershipProcessor.js\":\"1f896b19d7e2d617\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/normalizeReferencesProcessor.js\":\"674abcfe33f14a9c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/poolInstrumentation.js\":\"7e64312548c6c1a5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/processorRunner.js\":\"b2b34391c11d906b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyCellBackfill.js\":\"6a93a1ebf39cc41f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildMint.js\":\"9342beffeb30a3fb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildrenProcessor.js\":\"808348b216f75d11\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionChangeProcessor.js\":\"43fea4d839fca76c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionSynthesis.js\":\"1242ac6fc7e85b21\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyKeyScan.js\":\"21f41305472d3ca4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertySchemaResolution.js\":\"9a1203980c4b69b4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyValueEdits.js\":\"63a67ad10408bad6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/raiseProtocol.js\":\"58f8f6c5f55ac44d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/readBatch.js\":\"6f0a135274e9c39d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/refProjection.js\":\"5509551fbd4582eb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetLookups.js\":\"9201acd1d7ec190e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetProcessor.js\":\"4b293eae8f6206ad\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/replayMerge.js\":\"6539bc4d81bc4061\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/sqlBinds.js\":\"8617d25ad17d06fc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6af9d58bcf52b52b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/arrivalProcessors.js\":\"09ede3417334feaf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/invalidate.js\":\"d9c862240c0b6936\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/materialize.js\":\"e9b0168344c4d440\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/observer.js\":\"f124e0300bb108f6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/reconcile.js\":\"e9d50a7dce51e146\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/timingMetrics.js\":\"cf3150af18e8c985\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/treeQueries.js\":\"6de9fec294c0add7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txEngine.js\":\"6bb8371710996b00\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txSnapshots.js\":\"58b96fef100d7c3c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/typedBlockQuery.js\":\"80aa9ce7ca389264\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/undoManager.js\":\"20c662bf614584b2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/invalidation.js\":\"b3bd4c9f7f23c048\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelDataExtension.js\":\"b37b48c1b550c26e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelPage.js\":\"3fd02d526a1727aa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelValuePresetCores.js\":\"615abfb1e329b3d0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbCorruptionSignal.js\":\"62742b8c7b7ca2d9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbStorage.js\":\"69ae558474b723b2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbVfs.js\":\"8de4b64533bf0630\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localSchema.js\":\"568929e410f5d2b0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/maintenance.js\":\"e1d77e6473afdf3c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mergeProperties.js\":\"d1d408d907223864\",\"/knowledge-medium/pr-preview/pr-1919/src/data/metricsConsoleHook.js\":\"09e4c81fedd13a2a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/migrationsPage.js\":\"29d6ccd3de9900f4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mutators.js\":\"a8748d12abf9e370\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKey.js\":\"2d6dd0597d53afb4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKeyPlacement.js\":\"c69db09d967f6b30\",\"/knowledge-medium/pr-preview/pr-1919/src/data/outlineSurface.js\":\"0a7f119ab734cb66\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingEditorContent.js\":\"20cf0e9f8bc33bc3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingUploadsSql.js\":\"2b86c12d58cf8407\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pluginStateExtensions.js\":\"c562e4b4c1f6c1d8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/powerSyncLogger.js\":\"218ed56621a70508\",\"/knowledge-medium/pr-preview/pr-1919/src/data/projectorRuntime.js\":\"7bbc6c318b0e27d9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/properties.js\":\"d7dd63900cc70c23\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertiesPage.js\":\"67df41c10fb6c6c1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyChildren.js\":\"8fbab177a462af5f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionFanout.js\":\"73549e33fe00bab2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionMetadata.js\":\"b7d93ee22f9c6b0b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionRegistry.js\":\"380ed2caa86deec1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDisplayMode.js\":\"9a6500db07fae343\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyRowCreation.js\":\"dffbcce1ab0ba782\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySchemaCreation.js\":\"20c73ab498a642f3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySeeds.js\":\"475a26aaa9c6ba4f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/recentsPage.js\":\"ef191503e3e55739\",\"/knowledge-medium/pr-preview/pr-1919/src/data/refTargetComparableProperty.js\":\"cc42fd02cb42a14e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/referenceBlock.js\":\"e3d2c6ff2bff85d9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rejectedUploads.js\":\"4244d74a715b068a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/releasePowerSyncConnection.js\":\"9d65e375d1914cd3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repo.js\":\"4ce998f905b1f939\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repoProvider.js\":\"f10d3cda6856b3e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rowProperty.js\":\"2af1e518cfc9bfeb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/searchFilter.js\":\"6109efa74be16259\",\"/knowledge-medium/pr-preview/pr-1919/src/data/seedIdentityLedger.js\":\"6354c3233664842d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/stateBlocks.js\":\"15dd6c1431ee402c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralEditPolicy.js\":\"43ff189728712c02\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralInsert.js\":\"164732c13e87a5ff\",\"/knowledge-medium/pr-preview/pr-1919/src/data/subtreeDelete.js\":\"02ea0c4197048cd9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncStreamLock.js\":\"b482304d1b2fa721\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableSqlRecognizer.js\":\"7ee7f7201a02ce63\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableWriteGuard.js\":\"ba829cb0cb1c684c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/targets.js\":\"b966d1ba9edf08e9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeColors.js\":\"aaf79a343cf3a3cc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionMetadata.js\":\"717814a4ca492b89\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionRegistry.js\":\"c50fa75fe7abaee5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeExtraction.js\":\"8033e65e3d8a4f94\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeInitialValues.js\":\"c65c9bbec932fe1d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typePropertyGroups.js\":\"7360d04eccf98f4a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeSeeds.js\":\"d0abefc54f4bc8a2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeTagger.js\":\"1b551eb0c5a0eecf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typedRecords.js\":\"8959913ccf9538be\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typesPage.js\":\"1906b78d9aaf5a4d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userPrefs.js\":\"942ac185d1b3c72d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userSchemasService.js\":\"6f2ab5743d03a1b9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userTypesService.js\":\"f8d7a41aea6fd668\",\"/knowledge-medium/pr-preview/pr-1919/src/data/valuePresetRegistry.js\":\"2feb52c3dccacaf9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/visibleChildren.js\":\"3f0dff518afa9d1f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceConversion.js\":\"c2ed9d587a11e5a0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceFirstSync.js\":\"67950fa760420212\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceIdNamespace.js\":\"2c7f54e8bc876b61\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceSchema.js\":\"36d5b11576698ba2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaces.js\":\"c6c9310bc49483f5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadLog.js\":\"fa93f754b6fb1bcb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/BlockPasteShellDecorator.js\":\"4bcfe306efab05be\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/atTrigger.js\":\"77275d7cc31f086d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/autocomplete.js\":\"09997514c259625d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/codeMirrorExtensions.js\":\"c2811db59448c87b\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/contentFlush.js\":\"6757683d08611c7c\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/defaultInteractions.js\":\"b9286711814f9dcc\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/editSettleSignal.js\":\"d9583d8098ec520d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/insertImage.js\":\"46b312384da81f37\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceCompletionRange.js\":\"2398dfefe0bda4c8\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceTargetTypes.js\":\"65e10d2628afef99\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/syntaxContext.js\":\"f6864b0d2e29edc2\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/triggerMatch.js\":\"5dcc507ce9c15c32\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/AppRuntimeProvider.js\":\"f3c141bc06cc30b7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/BlockFocusShellDecorator.js\":\"76314e69e24ca386\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/ExtensionRenderBoundary.js\":\"316423070303fc13\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/PanelContentRecovery.js\":\"adabe71e8410a4e3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/apiCatalog.js\":\"458f3459cc695b89\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/appRuntimeController.js\":\"44a1eb70406c1f16\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/approveExtensionHere.js\":\"d33431181080767a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/armedCutAppMount.js\":\"90d64a721e65ce07\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/batchableKeyedStore.js\":\"56219697228f3b21\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockInteraction.js\":\"27ef0776a2227e4a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockSelectionAction.js\":\"88386db3fb94f678\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compileExtensionModule.js\":\"4e5dbb89dd735680\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compiledModuleCache.js\":\"de8f547210842a65\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/continuousGestures.js\":\"d391ff37b103305a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/core.js\":\"1c6db94b8f65e43d\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/defaultRenderers.js\":\"2b2c23cff7cfeb57\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/definitionFanoutAppMount.js\":\"5ff44b7705300815\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dialogAppMount.js\":\"3d941dea0fb541bb\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensionSeeds.js\":\"df587b2716f1ad79\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensions.js\":\"180b0c1efeee65e2\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/exampleExtensions.js\":\"188110e783c13b00\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionApprovalStatus.js\":\"8e357c46dbf07c03\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionImportPolicy.js\":\"398c29172433f73e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrorToast.js\":\"574339731e5aeabb\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrors.js\":\"2c86be0ef958fb97\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLookup.js\":\"c75bac9e741f3ae7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionToggles.js\":\"1cea5de590d6299b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionUtilitiesCss.js\":\"9b76181370670925\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/kernelPageDeletionGuard.js\":\"e53031935696d019\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/liveRuntime.js\":\"73839f0a1e2d2e00\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/normalizeExtensionSource.js\":\"15e8287dc94bdaae\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/openExtensionsSettings.js\":\"815ab4fb019c169f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/overridesCache.js\":\"694fa2356110e280\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/pluginIds.js\":\"94cc2326468cc2d4\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/processorRejectionToast.js\":\"1833343b16e1a0c7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeActions.js\":\"8eafefd8d1e9e39c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeContext.js\":\"cb1673d221502f97\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticAppExtensions.js\":\"babcffae1f7fb1f7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticDataExtensions.js\":\"f956fc69920cb552\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/toastAppMount.js\":\"7c5a05ccc590b66e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/transpileExtension.js\":\"654fdb98997262a3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useOverrides.js\":\"790d414238de6ba0\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useShortcutSurfaceActivations.js\":\"10211eaf5295797b\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/discoverToggleTree.js\":\"9793e969b90611c3\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/facet.js\":\"fe6c827e14ace46d\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/resolveAppRuntime.js\":\"346f4ca596654e25\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/runtimeEvents.js\":\"c5cf6aaed9c6590f\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/togglable.js\":\"a0b5e6bbc361519c\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/variantFacet.js\":\"bb444f6c849db751\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/verbFacet.js\":\"8f5c3a1a575d2627\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/block.js\":\"5a074f4c93aaaaec\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/focusedChild.js\":\"74db5bc49a1c7433\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/propertySchemas.js\":\"1b92af7ed39056af\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/typeRegistry.js\":\"660ae2893ac61412\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAncestorCrumbs.js\":\"13075a7f8f980eb1\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAutocompleteListbox.js\":\"0138c0a55e58e073\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedSearch.js\":\"65cb78971559130b\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedValue.js\":\"1631a957ceb0c7ef\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useFacetValue.js\":\"92e97e84c6d9b830\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsFocalRender.js\":\"212102b98b749745\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsReadOnly.js\":\"e86043911fd6b547\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMaterializeBacklog.js\":\"c5874858eaec9ddf\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMinuteClock.js\":\"bdd41552ce565c1b\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePanelLayoutProjection.js\":\"13a898fa8e454550\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePendingInvitations.js\":\"3cbdf0b632c2252f\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRendererRegistry.js\":\"1c9e989a258933f4\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRetainedFieldRows.js\":\"8ee94ea972014f1d\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useWorkspaces.js\":\"873f84c9faca64de\",\"/knowledge-medium/pr-preview/pr-1919/src/lib/utils.js\":\"a092af357395e6b4\",\"/knowledge-medium/pr-preview/pr-1919/src/main.js\":\"cf2679b97b33f501\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/MarkdownImage.js\":\"5f249534bf6165e0\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/blockSeparators.js\":\"ba516b6225cd226f\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/context.js\":\"f2355a5dbc866dd4\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/defaultMarkdownExtension.js\":\"36f89970b4a5f556\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/extensions.js\":\"cfc0debcbc097825\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/renderMarkdownHtml.js\":\"05bc209b1ce4805e\",\"/knowledge-medium/pr-preview/pr-1919/src/minimal-editor.js\":\"8c651f6a209ad924\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/armedCut.js\":\"cdb340a22e9ec1d1\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/captureMediaVerb.js\":\"6cb9c71041b4aaca\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/clipboard.js\":\"436554e1d54f85db\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/decision.js\":\"baf7293c44226781\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/operations.js\":\"d86f74204fe70c7c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/AccountHeaderItem.js\":\"ed341185eff1263f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/index.js\":\"d876e95f0cdd2835\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"936882d78996748a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askAgent.js\":\"84708409fa1d9f7f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askedStore.js\":\"196b644e31964f1e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"d511b9b7caba6da0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/chipState.js\":\"7a3ae5fdf83be97b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/dataExtension.js\":\"f6da9976d5a9ca4c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/index.js\":\"a2910ebe306ec729\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"4bbba1dd7b8980e8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/schema.js\":\"49666e63f4a92af6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9840477eabc4216d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/BridgePairingDialog.js\":\"939663b0fbff0bcf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/addMedia.js\":\"58120486c10d8252\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/backlinks.js\":\"95df15446f0b0d5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/block.js\":\"7ad025fe1e007823\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/context.js\":\"97c4a712c4a73b49\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/displayIds.js\":\"7f3db15c89c78566\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/index.js\":\"2e6a03931209e49f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/outline.js\":\"c2893b4c62526748\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/properties.js\":\"8d33f0dba98454c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/refs.js\":\"a3deff995389a0b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"14641ee5c00f4126\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/search.js\":\"8472ddf818eb5df7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/shared.js\":\"34c964d7645e529a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"adb356ac335dc321\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/text.js\":\"b5548f7c7757106e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentWrites.js\":\"1cd1b65c55cc019a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/authoringCatalog.js\":\"beb5f7530e041e01\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/blockRefTargets.js\":\"59e0b48c73d002ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridge.js\":\"38e5be802fd72ccb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridgeLoop.js\":\"570cf10e7cf7e591\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/changeHistory.js\":\"bfdf2144102bab32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commands.js\":\"e2616951f60d511c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commentsCommands.js\":\"81fd2ec349be89c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataExtension.js\":\"5308fec7b4ce2ed6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataModelGuide.js\":\"be696c9239e62cc0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dayPropertyInputs.js\":\"2f4bb16713897b23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/describeRuntime.js\":\"c5afe1c259df6b1f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/extensionLint.js\":\"a5c67f082f632419\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/grainAudit.js\":\"87d6e99dac2e8221\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/healthCommand.js\":\"068fb3ced8ef9231\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/index.js\":\"ae989cdcfbb683f6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/presetIdentity.js\":\"4d61993ef4bc9474\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e12122cab3b7a312\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/readMedia.js\":\"7efa790efc8b53ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/schema.js\":\"a89a7723a95cd482\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/serialization.js\":\"157f8d51ed0cd67b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/targets.js\":\"9d86642ed30f1b3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/tokens.js\":\"fce1f93ddaf0c2b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/watchEvents.js\":\"7ce2420204f5c463\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/workspaceGuard.js\":\"08a1fc601a9e5040\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/writeCommands.js\":\"eafcdf1e14ce80dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/AliasCollisionToast.js\":\"a9f2993c42ed073b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/DuplicateNameBanner.js\":\"e51e2b0f8708196b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/collisionMerge.js\":\"8ce06f96abe4c5ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/dataExtension.js\":\"03b3078d5e47f24d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/index.js\":\"7fdb15efd1d04833\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/mergeCollisionAction.js\":\"ce2532775c43437d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/pageStyling.js\":\"b6f4bc80ac60a77b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/rejectionToast.js\":\"de966816d4a8f25e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/syncProcessor.js\":\"c895955fe3a5b6b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/actions.js\":\"37ed5dfbd05db3cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/addComment.js\":\"8d120276d3f4a17b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchor.js\":\"df16febd9fc7bf1e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchorState.js\":\"3df20cbad971a927\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/commentLinks.js\":\"93e00b8aa3620eb0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/confirmThreadDeletion.js\":\"885557dcc6adabc2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/container.js\":\"9d1f130d5b6be7ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/dataExtension.js\":\"e12416df4805f92a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/deleteComment.js\":\"9aba7c1363f456b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/highlights.js\":\"5211617ad8c82f36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/index.js\":\"806addcba619ab9a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/linkedCommentsPill.js\":\"c8b35af12d260e6d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/margin.js\":\"1bc7f86b11b2291f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginAnchorLinks.js\":\"f106660038e7080a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginSchema.js\":\"16a5aaf1e96d1a95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/newComment.js\":\"dda94d3ccb9518bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ownThreadPicker.js\":\"cd229efe0e8e305c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/placement.js\":\"d83a58117a514141\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/queries.js\":\"195a412bf1bde5b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotePosition.js\":\"4a406a1f7c0b64a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedIn.js\":\"79d9405fed7704b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedRange.js\":\"7fb32e7c335d32f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/rangeRefs.js\":\"fab14216d46d4535\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readHighlights.js\":\"7192f40e95c8acb9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelection.js\":\"fa41d192c6ae291e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelectionUi.js\":\"aeb56346e456f951\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/reanchor.js\":\"a8dbc54a31a79e57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/schema.js\":\"da90e9d739c8cce3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scope.js\":\"2153fe3e3120ad82\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scopeThreads.js\":\"3f2af53cbb69b525\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/splitRetarget.js\":\"d46380b97c1a2eff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestionCard.js\":\"1fae5a1d624270a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestions.js\":\"657d918a9fbf21e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaries.js\":\"4a3a177ab141a9f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaryBatch.js\":\"c7bf58579aae55ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/surface.js\":\"b144e89abde3f74d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threadNavigation.js\":\"98c8b8096a6f5230\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threads.js\":\"29283a76cb7582b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ui.js\":\"77dbff04509c00fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/uiStore.js\":\"6a5254360472bccb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/appIntents.js\":\"6379d1fdc800ecf8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/index.js\":\"30a8f099678b52f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/index.js\":\"bead53043e93a144\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/status.js\":\"dc3c75e53f331943\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"fd93ba2871e5d4bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaBlockRenderer.js\":\"06215ec9de9cf69a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4fe8718d659f032d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaUploadReconciler.js\":\"cd78332eab68adc9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetDownLane.js\":\"55207cd9ba1a737e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetResolver.js\":\"1082840ba5ff45c0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetUpload.js\":\"007b109b2a945edb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/attachmentCleanerIO.js\":\"c3705149e825c2a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/supabaseAuditIO.js\":\"841bf9eda30bea90\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/blobStore.js\":\"eda0b4c31da4ab83\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/browserMedia.js\":\"efa413d57dbed5f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/byteStore.js\":\"34175360da1d06a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanerIO.js\":\"1d089802f9b75b8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanupAttachments.js\":\"66d6de0ff45f1383\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/dataExtension.js\":\"2a3089a66d572f89\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/downLane.js\":\"9454738929cd7a8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/index.js\":\"fce1a551ac3c023f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/insertImageContribution.js\":\"c82f18b6f235985e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneArming.js\":\"1fd5fd94085d5a17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneLock.js\":\"ac4bdecec6aa6ef7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaBlock.js\":\"43bfdeed5eec8cc5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaCapture.js\":\"ce0ac7a3ac257cd0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaLanes.js\":\"83bf76b15b5a796b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewers.js\":\"81d523d15e38ac45\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewersFacet.js\":\"4e59efeb5d453a81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/pasteCapture.js\":\"f36220cd5175425a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/resolver.js\":\"1ee84fe3d2c046a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/retryUploadsAction.js\":\"e80617371c0e29bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/storagePaths.js\":\"d40ece45c2d34599\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadDrain.js\":\"420095a26e48e47f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadLaneStatus.js\":\"18aff6716b1a5e6e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadReconcile.js\":\"83fb9c774dddd303\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadRecovery.js\":\"68a3e8799e2efa64\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadStore.js\":\"dfb1ef1a01a7efbf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/useAssetObjectUrl.js\":\"961fe8524e4a1e6f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"e32df554afc790fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksViewSection.js\":\"f015e44c540c7f36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/facet.js\":\"9665bc4d0f4864d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/index.js\":\"a1b08523aeb41db1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/prop.js\":\"f9e763d0c4d1fcfe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinkFilters.js\":\"ea1755a31bb26b14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"9519fcce6229aa8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BlockEntry.js\":\"0d2a31dba81e39a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/LinkedReferences.js\":\"fa60f5a0dc8c50db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"ce9ed138009af830\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dailyNoteDefaults.js\":\"75a7277e7ce6e211\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dataExtension.js\":\"064876860468eadc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/edgeExclusions.js\":\"86f3a8ff654efd78\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/filterProperty.js\":\"d01e7ca3e26eb79b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/index.js\":\"2e32bf48c96502c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"52303420dfeb9a02\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/applies.js\":\"2e58d2fb960a3327\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/countQuery.js\":\"4a821fa9a868410e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/expansionStore.js\":\"deeafa9287575292\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/index.js\":\"074136fe039e5361\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"d07eec81a9d4b43f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/presentationInvalidation.js\":\"fe49da85861cf823\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyEditorOverride.js\":\"60b942db9ed745e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyFilter.js\":\"9fde276685f28cf1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/query.js\":\"279d9b401b5a0e1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/resolveFilter.js\":\"b33b139c85a18539\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sourceBatch.js\":\"80694a6181700a23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sources.js\":\"3f9e30533635c48a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useBacklinks.js\":\"3bba27769ad9c2a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"7d18565ce59d00ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayCelebration.js\":\"087fa59be6b26fc8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayOverlay.js\":\"82eea04b8d9e9bad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/gate.js\":\"bda7f3f9de2a7fb1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/index.js\":\"096cb76ce13b03ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/wolfTheme.js\":\"85ce62169fbe4666\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/BlockDragLayer.js\":\"1bacab5f99621f7f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dragController.js\":\"83fce7aeef9c91e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dropTarget.js\":\"d4cea292477f116d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/index.js\":\"2b53644eede30053\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/projection.js\":\"e7fd6a7e8399adde\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/BlockMetaCard.js\":\"c284a8f7a3a76904\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/index.js\":\"7cf8aa0350c99110\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/AddTagDialog.js\":\"f34c4f020c5da525\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"72c4d2dcc6a121fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/TagNameIssueHint.js\":\"57a22645ee25ed8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/addTagAction.js\":\"62ba09f7890e8521\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/appendTag.js\":\"69a71d4cf2c646ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/config.js\":\"08120251ed535e9d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/dataExtension.js\":\"facbcb589d3084e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/index.js\":\"2ba0da94b00a7d9d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/propertyEditorOverride.js\":\"d19bcb13cc1b4326\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbList.js\":\"8f98dcfd7143ac67\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"635eb002924510b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/Breadcrumbs.js\":\"1e9215ef59a6a01b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9483699a622441ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"09bb1bfc34f478d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/index.js\":\"489c0e7f0c411ad1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"772d67622c3744de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/CharacterCountItem.js\":\"14565065a90b39bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/ProfilePropertyEditor.js\":\"e0657097327f8f31\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/actions.js\":\"313852312eff023b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/blockType.js\":\"57292565e81eeb89\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/charCount.js\":\"9e2fd1261ba066b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/dataExtension.js\":\"cd4789208c3ceea3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/index.js\":\"c7f6ae2e00a89997\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/profiles.js\":\"b082c3e8fcb9a26a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/properties.js\":\"6a2506087115b2d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/subtree.js\":\"ad34e74478968f13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/textCounts.js\":\"b85406476f41bd71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/colemak-keybindings/index.js\":\"3c625c0624ea24a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/CommandPalette.js\":\"001fb789acff09cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/HeaderItem.js\":\"b2ad1db4647e6cb2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/context.js\":\"99bbbaba1b65d608\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/index.js\":\"b7435a5f74e0023a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/selection.js\":\"1e19777460e5a717\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/toggleStore.js\":\"ea834a7d76024636\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/useCommandPaletteActions.js\":\"e306c8f0a107081f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ContributorBadges.js\":\"114687822496ba15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ProfilePicture.js\":\"abc19ce45a3983b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/author.js\":\"9af7a244f04a27c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/codeMirrorExtensions.js\":\"8d86020d556b4d1c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/dataExtension.js\":\"a13391d0133b6f51\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/index.js\":\"5291e8757f28690d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/mentionAutocomplete.js\":\"75f616dbb2ab17cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/processor.js\":\"52b79eb02b6d1ab2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/profiles.js\":\"993e2a8d3f5bd054\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/queries.js\":\"a5f9b13acf7aab91\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/schema.js\":\"bf7b0b149e5c5e55\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/useCommentAuthor.js\":\"07d60863c82a7f8f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"c099fd434a6e197c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/followOrigin.js\":\"e51663db4b27276a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/index.js\":\"6cda3813eb2b2638\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1f751709c7dc8fce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"8f90626e6164e1b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/CalendarGrid.js\":\"4c4b4acc40f1ded5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DailyNotePicker.js\":\"027b37d6a662f96d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a61d7cce862d9db3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateNavDecorator.js\":\"05f0cb5f6072ceb4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateScrubOverlay.js\":\"91a8e83bc105c2dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayPropertyControl.js\":\"5cfbef6a359779c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayValueReferenceControl.js\":\"cf97a80b5e5c4031\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/HeaderItem.js\":\"89275e76d016553f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/ReschedulePicker.js\":\"34860e74f5b4d392\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/SpreadDatesDialog.js\":\"00ceca7cb5b8bbe5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/actions.js\":\"7967f5e22901d775\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/blockDateAdapter.js\":\"06fc837e4c4397eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/calendar.js\":\"a534d48be393e74b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dailyNotes.js\":\"d4b61eb8cc424419\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dataExtension.js\":\"3b9da9b1421a5198\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubActions.js\":\"81a50c8c1870c07b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGesture.js\":\"fc2267362f1d9aca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGestureActions.js\":\"28a21f96cdc57e42\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubRecognizer.js\":\"bdf83236739af3ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayProperty.js\":\"331618e0c860b15a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"4b46173bdc7b4472\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/deletionGuard.js\":\"aaa61baa5f89fa50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dueQuery.js\":\"3ab22ea16eb6e1fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/index.js\":\"742967bd1072cd51\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/landing.js\":\"0fbaa8061482dd2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/localSchema.js\":\"9b5b0758a25529e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/referenceDateAdapter.js\":\"1f8cc7c466585983\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/rescheduleAction.js\":\"ec749e3dfd9cabbc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/schema.js\":\"cdb9951e7839c766\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadBlockDates.js\":\"2a0bbe9f3b809a1f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadDatesAction.js\":\"07a3a7487bd3c377\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/today.js\":\"0e52e69d4a59984b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f906cc3864b9d7e4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"032885e4f5950dc9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/audit.js\":\"d91f5e0ab0186945\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditAction.js\":\"0c4442077df26790\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditRanges.js\":\"853ad3236e943849\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/diagnosticsSource.js\":\"083d697b7d215220\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/divergenceScan.js\":\"f9fda5ea5c2de40c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/index.js\":\"109ab425e60bbe38\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/propertyChildrenChecks.js\":\"658ee90d1050fb3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/referencesMirror.js\":\"f0ef85cea556ca17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/rowJson.js\":\"39a0bd9ce0d922a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/schedule.js\":\"979ad7d5dd291a5c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/store.js\":\"79c5c61ba84e59c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/action.js\":\"041d36f39b83ee9f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/index.js\":\"db62c41b63c4b061\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/plugin.js\":\"9a5d3aeb28459807\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"2512dfd5da955d53\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/actions.js\":\"b7e91104824fca82\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/changeMarker.js\":\"b83fd52273cb1dd8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/diagnostics.js\":\"5033852811aa76b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/fileSystemAccess.js\":\"496184659ff3e46e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/filenames.js\":\"bd846dd78ab7a836\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/index.js\":\"bbeb74a843ad6787\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/mirror.js\":\"e687e9ed2719d6ff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runLock.js\":\"7cdd968b3239cffb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runtimeHealth.js\":\"e84030340e9c7219\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/schedule.js\":\"2ea539f5ef065251\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/store.js\":\"25e7a761286b7d5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/index.js\":\"69061da8899aa29e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/themes.js\":\"424e6b6289e924ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/facet.js\":\"a53d6bd4e72f5649\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/useDiagnostics.js\":\"fb521dd694064114\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/dismissals.js\":\"7f2f3df3bcc9abd8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/index.js\":\"23379ce312c508e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/status.js\":\"96e835eb9654982e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/store.js\":\"e6eefac59802cb9f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"58602cd26c4c9346\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsSettings.js\":\"de5e59da11ae98de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/actions.js\":\"55f5831146a2612b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/config.js\":\"3cc0a8b5697de76f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/dataExtension.js\":\"1aa90b78fa04429c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/effect.js\":\"e73cb3a2b3fe4bd6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/index.js\":\"bc1e1a4cf985111a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/propertyEditorOverride.js\":\"0f03b75e39b170a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/useToggleTree.js\":\"d196965a70acf670\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/ExtractTypeDialog.js\":\"8f2fa0e2c8379955\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b6d2d01f8322e000\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/PropertyShapePicker.js\":\"d4b115a710525d4d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/action.js\":\"c7ed416b513cf0a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/index.js\":\"e425adb4ff3082f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/FindReplaceDialog.js\":\"5b5597bfd055e6df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/HeaderItem.js\":\"5c93a07fb3c61525\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/dataExtension.js\":\"7117c9a2e1dc119e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/index.js\":\"9c6b914bb7ee173d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/search.js\":\"eed60c8e88a4b85f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/toggleStore.js\":\"4721ec9a9537a4b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/LocationPropertyEditor.js\":\"d340ccd96f737736\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/MapView.js\":\"673364f926d1b6e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/blockTypes.js\":\"d40623cc75a5acb8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/codeMirrorExtensions.js\":\"0d4f54e5899a46a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/createOrFindPlace.js\":\"77302b054ee809a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/currentLocation.js\":\"7bfe3253ffe95548\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/dataExtension.js\":\"d0ececc2d261127c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/geoContentDecorator.js\":\"6cda0cb433fdcd31\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/googlePlacesClient.js\":\"e1272934471eced1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/index.js\":\"b7923c6569806275\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/locationsPage.js\":\"a3c7ed1ac85f41a9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/mapViewport.js\":\"e2b53e1c8289d441\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/pickCurrentLocation.js\":\"334a754d01abd7aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeAutocomplete.js\":\"46024896886934ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeNameCollision.js\":\"54fb5397e68ee462\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/properties.js\":\"d697e6c6563702cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/propertyEditorOverrides.js\":\"8b82ceb3899937b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/query.js\":\"ad2e429e4d0d8825\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/usePlaceSearch.js\":\"d480df297c24c3d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"afbba83acb08e43f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"60fcc40772f2b596\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"5f9cc1c3deeaca52\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/config.js\":\"2cb65564e3ba4388\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/dataExtension.js\":\"e26ce5c8cdc81d0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/facet.js\":\"0dbad27cd61ec2ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/grouping.js\":\"4501d892788c0dd9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/index.js\":\"c66babde6dc9a4d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"9644f17e96a4b8e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/query.js\":\"b6df2e0c323ae2a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/resolveConfig.js\":\"1e26d130ced7e560\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"f8197bff0459ba58\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d0d7aa6d8b84a588\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlDocumentContent.js\":\"cbb7167ec4f22501\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlFrame.js\":\"02be5a9c0e62ac1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/actions.js\":\"7a980032ef72dc46\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/blockType.js\":\"843483bc8fb73722\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/confirmRunScripts.js\":\"bb1fd9ecea6911ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/dataExtension.js\":\"0f5cd8e1d8a5cd7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameAnnotations.js\":\"8e371bbaef27af8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameDocument.js\":\"2be46c20a7f3ae7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameTheme.js\":\"835fd2063f169756\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/index.js\":\"320f4e7ec129312c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/scriptConsent.js\":\"c9d37385b820df6c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/sourceMap.js\":\"368c08669e481555\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/useDocumentScripts.js\":\"97daec159e18663a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/index.js\":\"f4cc1c0e97b2d3f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/record.js\":\"805288aea75848d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/recordStore.js\":\"bafa9ce07410c38d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/responsiveness.js\":\"88cd75dbde255207\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/schedule.js\":\"1fbb1ea76cdb390c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/sessionContext.js\":\"e7b63c264760b0e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"d5fe8719c6d16b52\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3097981a4765b03d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/actions.js\":\"66120bc34b01abce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/config.js\":\"a8414a656cd4289f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/dataExtension.js\":\"5e1208fe2dc0312f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/effect.js\":\"7a09cb0ee0b36580\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/index.js\":\"05013b3824c81e3e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/keyCapture.js\":\"5f6169d3e42ea415\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/overrideStore.js\":\"9913ae30c8d2f3fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"1f4f900a3bd0c9b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/HeaderItem.js\":\"d086835ac3bbf98e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/LeftSidebar.js\":\"6bc50891b638526a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/actions.js\":\"de76ecfdfcbbc1b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/facet.js\":\"6c13fe84983f0776\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/index.js\":\"5736537f2d9a8a3e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/shortcuts.js\":\"34cc19622284d4b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/toggleStore.js\":\"9b748e5c7c8d2238\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/MergePicker.js\":\"ec990595d4a849cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/index.js\":\"29e33f806d975d68\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/mergeAction.js\":\"6ddd169f9a727469\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/strategy.js\":\"6fd7491395f5ce0d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/Button.js\":\"f3fb0310a5623232\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f668f35720612991\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/defaultItems.js\":\"21737f6abecd0c45\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/facet.js\":\"aa73128c26a3597a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/index.js\":\"ac128385e7e447aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"2f5f867f7ba456b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/actions.js\":\"27764f53dd817e7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8eb3ca228f68f7f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/facet.js\":\"065df3454f74c015\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/index.js\":\"b178bc7e64bbe0bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/MoveDestinationPicker.js\":\"60540237f96179fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5d48964531ebf0e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/contextMenuItem.js\":\"401c7bb74724c5cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/index.js\":\"837fe5f79a42209b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveAction.js\":\"96ce0b18e1fa5353\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveBlocks.js\":\"5ddbaaf8e7a31884\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/selectionAfterMove.js\":\"02280755c1bd3763\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/TutorialBanner.js\":\"35d3f3ad54ba60c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/action.js\":\"3693d27dc80bc245\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/bannerDismissal.js\":\"0c9ee773a2dc8d2c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/documents/cheatSheet.js\":\"ed95a0ef5741fd26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/index.js\":\"67e9bce30eacaa3d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/keys.js\":\"b937731bb50fe156\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/landing.js\":\"d4e3ed82cd38425e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/outline.js\":\"dd23aaaf5f9a6614\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/seed.js\":\"3f14ac1aa8545a20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/PerfTrendDialog.js\":\"0532630dfed62c4f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/analyze.js\":\"45d0f8b141a6eaf1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/diagnosticsSource.js\":\"43419881fa8c5901\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/index.js\":\"5d5f4620e01623d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/load.js\":\"771fde54044fe76c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/monitorRun.js\":\"f313df6bcf524fad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/schedule.js\":\"d21dc417488d48fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/series.js\":\"9e6496eab3a3106f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/store.js\":\"ac719431863362b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/trendAction.js\":\"914a5296612de452\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/verdict.js\":\"9f989b2385d23395\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/clickToEditAction.js\":\"bd36204712645f29\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/index.js\":\"8b948156ca6daf07\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/interactions.js\":\"33eba307ba12482b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"02fd4fc591cb22bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGate.js\":\"2ef14f7c4032abe4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGateDialog.js\":\"b3373d26ff9fae8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/action.js\":\"1f6b423d43e97881\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/index.js\":\"ca06bd30878610ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/localRunMessage.js\":\"c40f3a3ae2a230e8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/plugin.js\":\"94d142eacaee9fc4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/progressReport.js\":\"1e7c5cccdf0b181f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/sweepProgress.js\":\"e96b6d28b9601ec5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/FieldRowRenderer.js\":\"b8929e58d0ca4f30\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/ValueRowRenderer.js\":\"354960a0ca108bbc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/actions.js\":\"e0acf0d0082a9493\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/autocomplete.js\":\"b401ae18e11cfdb7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/fieldRow.js\":\"80a85ec5dcde63f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/index.js\":\"7a5daf7d039110a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/referenceWarning.js\":\"861291dfce0cb53c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueAutocomplete.js\":\"d6ea482591dbf2a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueSchema.js\":\"5f9d851c27e86d9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/HeaderItem.js\":\"de3395d3f117ec8b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/QuickFind.js\":\"3cc68f01c497efaf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/index.js\":\"4fb91a1a79b743a9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/recents.js\":\"83bc4b5c7574b1bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/resultItems.js\":\"7ce0e39b57ffd94a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/selection.js\":\"ddcfdd7830ca4d7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/toggleStore.js\":\"a638a6d1d1cba2cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/HeaderItem.js\":\"d084d4c5ac01f3ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a21cb86d4ad76557\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/grouping.js\":\"e8a77c0a57a91ea0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/index.js\":\"833805d7f23b9e89\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/target.js\":\"fc9ee959b64de206\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/codeMirrorExtensions.js\":\"c828ddaa8e0b1efd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/contentPrefill.js\":\"ff6ef96d94e4910f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/dataExtension.js\":\"34c223637f711ae8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/index.js\":\"03383108b4d05d69\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"8014e0eb8c777a6d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/invalidation.js\":\"8fad2cbdb4419efc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/localSchema.js\":\"d5742ca87ee8ce26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/index.js\":\"65b3b6228edc0713\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"8dbbf0869b515d60\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/index.js\":\"dd437cf94f6ba880\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/referenceNode.js\":\"60f4215d20450434\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/remark-reference-occurrences.js\":\"1456c6298782fe57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f1807f9ad88bdbbd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/index.js\":\"3f9ec657c24e803b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3bbafed19bcc7d05\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"00d032ba5aa5d3fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/mergeRetargetProcessor.js\":\"75019bf76ebf8bb7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/parseFence.js\":\"f918f740f5ad60df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceParser.js\":\"39cafc94d0327045\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceProjection.js\":\"dbcb07b5e3d85aa5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referencesProcessor.js\":\"e669ae5f8da62f3e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/renameProcessor.js\":\"22b6d71041cfa9b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/spanReplacement.js\":\"1107e4b6114b5677\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/htmlToOutline.js\":\"b5bf1bf7a9cf8485\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/index.js\":\"7e1a8dcb48bc859a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/normalizeClipboardDom.js\":\"9891e2b5c1832962\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/pasteDecision.js\":\"1491fd839c0baf94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/action.js\":\"c67f626b488245fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/blockIds.js\":\"61a16401b8930ecc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/content.js\":\"d8f9f8ac491ac852\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/effect.js\":\"7d75f9a3ca23edc6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/ids.js\":\"a4041c9114f14755\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/import.js\":\"3b1d35bc918e9277\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/index.js\":\"7d075eb614c2765b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plan.js\":\"26690acc2a04e77d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plugin.js\":\"c47580ad4dfd8d42\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/promotion.js\":\"9ff2b93cb9ae8001\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/properties.js\":\"e6c423178241dbe5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/references.js\":\"cc0bc76da13298b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/report.js\":\"574565a22c84ef18\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/roamMemo.js\":\"83965628e0b5d813\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/runtime.js\":\"95a16159caaa4895\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/schemaReconciliation.js\":\"6762d21aae28e420\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/srsMarkers.js\":\"584ef04e25fa5eec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/todo.js\":\"79ba5b8b6329ee96\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/typeCandidates.js\":\"50eccc65533c734d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/types.js\":\"43be40aca6265bab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/index.js\":\"46cbb929512e7f94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/store.js\":\"22dde46db39dee32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/HeaderItem.js\":\"f9b7907253e2af1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"a16a13b286a09efd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/index.js\":\"ed77a316f04dc365\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/model.js\":\"1278f5d3691fb448\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/toggleStore.js\":\"6c5f1ce977db6371\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/useKeyInspector.js\":\"dfebba79932928e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"bf5e90146880ce22\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/ShellDecorator.js\":\"7d8ccbfe0982d13c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/actions.js\":\"16a86514199e84d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d11be21906c94328\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/index.js\":\"d3564e1dc92fda3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/shell.js\":\"355d0bdf8acb208e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/surface.js\":\"35df97b0eb78229c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/walker.js\":\"202a7061b40699e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e17d71535893509a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/dataExtension.js\":\"6b83667229f4e95e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/index.js\":\"41b9bdb26ebac729\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/indicator.js\":\"57f949976d54664f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/moveSrsState.js\":\"10d7f5bb853faca0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"502a73b56b483c78\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/scheduler.js\":\"04cbe742bf2d44dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/schema.js\":\"d4c9b3274f937888\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f31f537a0a0de28b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsClipboard.js\":\"1e60e06836e2f6ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"80f11eae200dc52a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DailyNoteReviewHint.js\":\"177018a6dc23c47e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DeckPicker.js\":\"795d5aca3bac9401\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewControls.js\":\"e460bb905f45a7dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewDeckRenderer.js\":\"4bea5b21cbd055d8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewSession.js\":\"4764654b45397467\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/actions.js\":\"5b7c7b0cf8079c0f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/archive.js\":\"ba174fdc944e44b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dataExtension.js\":\"f4700ae0d60df05d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/deck.js\":\"2f96dd427880e1c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dueQuery.js\":\"66c11aff2c6781ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/gradeDecision.js\":\"123cf14ab34113bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/index.js\":\"3a2d87523b805d8f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/keyHints.js\":\"6db88e4a349a815c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewCardLayout.js\":\"4afbee9354c869b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewProgress.js\":\"7eff7d0819754148\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/schema.js\":\"97bf8b232c1fea1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/useDueCards.js\":\"ac6187c96d64ef8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/index.js\":\"f5281d14c6959a47\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/record.js\":\"ff57e38866b177ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/index.js\":\"113d3ca1641eef20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/persistenceStatus.js\":\"c07de9786b802679\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/requestAction.js\":\"a648084b8b992cf6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/TypeChipsDecorator.js\":\"f2e496db98570f74\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/codeMirrorExtensions.js\":\"84ef683244cf6c56\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/index.js\":\"39f86869c56c08f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/typeAutocomplete.js\":\"6e50621d09b1c9cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"8e707957d23cea01\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/actions.js\":\"7ca5d7da258cf6a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/anchor.js\":\"60897bfbd7fd6fe4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/events.js\":\"3b4ad3cfa0882cb1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/gestureActions.js\":\"4a596f7dba0cd156\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/index.js\":\"4af79fd19b6dc167\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"d7a3bd509436a756\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/collect.js\":\"445e6e6ba9e7d054\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/index.js\":\"1b3099a82c27ef16\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/record.js\":\"3ec55877c8a75c7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/RejectionDialog.js\":\"f90e355d4176350a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a42de4b9a888ea7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/index.js\":\"fd28aac5de2c2501\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/model.js\":\"0d8ed7b5d22be89d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/queueCounts.js\":\"54af62cbad505358\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rejectedHelpers.js\":\"03ffba70f45a89a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rematerializeAction.js\":\"aaaf97aa8f9937df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/useHysteresis.js\":\"4500e4ed3a9e7aba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/ColumnHeaders.js\":\"288cad6601c9e47f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/QueryUi.js\":\"6287fb7fb16c9e6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/TableLayout.js\":\"f76b71b6c0385097\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/actions.js\":\"771d7009e7fad384\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/cellEdits.js\":\"bba90460a5d8ba1c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/childrenViews.js\":\"6748885daf9fc28e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/columns.js\":\"52fae9e01beb92d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/controller.js\":\"7f89a4da5614b11c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/convert.js\":\"b3a14bc474eb9604\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/dataExtension.js\":\"74ca02882e336359\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/index.js\":\"3456d6cbda589129\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/keys.js\":\"4093222e087f2b35\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/model.js\":\"836d5bcc3063afc2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/QueryText.js\":\"30d19933139193f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/backfill.js\":\"d0540ac012986ed1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/completion.js\":\"1bfea412ce6aa887\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/format.js\":\"9c10ec46ce533182\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/parse.js\":\"16c51105445bb871\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/queryValue.js\":\"51dc15d74ec2af13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/registrations.js\":\"e3df2724d92caf13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/source.js\":\"8bcaa8bcdcc5e811\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/registry.js\":\"e58a854810563f58\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowGutter.js\":\"81ab8e80f9dfd280\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowVerbs.js\":\"fe2b5f51caa793bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/schema.js\":\"54a2a9be3778887e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/sort.js\":\"ba12f7a520534699\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/effect.js\":\"9f419567214e39f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/index.js\":\"3993df7a45007a83\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/theme.js\":\"513ae2ba95178c40\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/actions.js\":\"18b0632602df0fef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/dataExtension.js\":\"764f2e702c77c159\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/index.js\":\"29008b6222d8cdfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/schema.js\":\"3bde7eb43ba855b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/TouchSelectionLayer.js\":\"b5b478c87cc71fa8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/actions.js\":\"333f4dd5a3cacbaa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/defaultItems.js\":\"5350b2c3b2d976a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/facet.js\":\"1c1693870714843d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/holdRecognizer.js\":\"42b4f1016929a31a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/index.js\":\"773cee04d48084d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/UpdateIndicator.js\":\"fd03e312bc6495b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/index.js\":\"e7dc1b890ee6efc5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/loadTimes.js\":\"000f9524dd7929b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoNotesRenderer.js\":\"8f09560012d3f226\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoPlayerRenderer.js\":\"c63c4ebf05d88acf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoTimeStamp.js\":\"a462d7d1c08a0e4e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/actions.js\":\"269819ebb85d9b2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/index.js\":\"78fe1037202f992b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/markdown.js\":\"0ffe1f6804dbc872\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/notes.js\":\"647125c988314233\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/registry.js\":\"971cb71ef784b35f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/remark-timestamps.js\":\"8988ea6d83a853a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/view.js\":\"c45f614799aa87fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/LinkHints.js\":\"e7a7b19bb182e765\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/index.js\":\"e2da0e5e26e8c28a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/model.js\":\"3f7d6ec571d0c0f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/settings.js\":\"1bcc17e8c5d607a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/actions.js\":\"4c16b7f7a86ec4b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/index.js\":\"e199e0ccca4f7731\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/interactions.js\":\"a3a36011d93f4e1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/workspace-header/index.js\":\"ea1578a0b292c9a8\",\"/knowledge-medium/pr-preview/pr-1919/src/registerServiceWorker.js\":\"2138dd3b7c181a9e\",\"/knowledge-medium/pr-preview/pr-1919/src/requestPersistentStorage.js\":\"8a40f12b017d102f\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authRequestDeadline.js\":\"19150b8cac46222a\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authStorage.js\":\"1fb7fc86f25450bd\",\"/knowledge-medium/pr-preview/pr-1919/src/services/powersync.js\":\"5c37df502b06e0ba\",\"/knowledge-medium/pr-preview/pr-1919/src/services/supabase.js\":\"22c8f57eff2a2a1f\",\"/knowledge-medium/pr-preview/pr-1919/src/services/uploadErrorClassifier.js\":\"b5d142a8720758f1\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/ActiveContexts.js\":\"8e143c8d71370140\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/HotkeyReconciler.js\":\"63eb39d10790d09f\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/WipeLocalDataDialog.js\":\"5c83f328405fbf37\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionDispatch.js\":\"5ae2e21290b71a07\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionRefItems.js\":\"8753fa653b051946\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/applyKeybindingOverrides.js\":\"2e3dcd68ee735755\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockActions.js\":\"c5af7c35b8d18dec\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockMergeGesture.js\":\"7aa73a3762d57737\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/canonicalizeChord.js\":\"c7fc9c220d1d7ed0\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultContexts.js\":\"8ef0dc71d32c4e24\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultShortcuts.js\":\"99d123f9cadf48a7\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/effectiveActions.js\":\"19dfcb721ab08211\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureAction.js\":\"cb2eb7d6a5684f91\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureBinding.js\":\"91d1011cdb458626\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/holdRegistry.js\":\"af1dccd82e939c30\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingConflicts.js\":\"6b9e5eb7a892f3a7\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingOverrides.js\":\"33157daced5729a1\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/pointerAction.js\":\"9f843c7f5d7d5150\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/resolve.js\":\"cc860b1ec91656ab\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/runAction.js\":\"3394ca58b0ed0b46\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/sequenceMatcher.js\":\"13ff06fcfd01d133\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/types.js\":\"69c3de8cb11b28d8\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionContext.js\":\"8407688a67d8e798\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionDiscovery.js\":\"fb694bdf869695f2\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/utils.js\":\"845ab71da9baa08b\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/bootStore.js\":\"86c6067fd3d6bc52\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/previewDatabases.js\":\"43056f52ac8fd78b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/byteTransform.js\":\"69081e685ceaa367\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/attachmentCleaner.js\":\"83830c6bf3a4d2eb\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/attachmentParts.js\":\"ba8f37c370dfb522\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleParts.js\":\"48ef211cc1a0d046\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleRecord.js\":\"909ae2e46bad93a5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/manifest.js\":\"c2f307a9c8a1031f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/takeBundle.js\":\"c977024742ea55b4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/verifyBundle.js\":\"c6e2baa5670bc876\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/cleaningStage.js\":\"e04154c3044c9fb2\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionKey.js\":\"1bfdd8063b0e2707\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionServer.js\":\"c83e1e5d7f229f0a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flip.js\":\"0531484b1fc92a1d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flipAttempts.js\":\"7e5403095377df38\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/pages.js\":\"e9d81e9496c69332\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/preflight.js\":\"b47423ae85bc1a27\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/reseal.js\":\"d7fe9694312d8ed9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runConversion.js\":\"ea437914e4fda291\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runLock.js\":\"3ee57cb5f421fe4f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealing.js\":\"77c06ba8ae606759\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealingStage.js\":\"f827c8257381becd\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/stage.js\":\"f1f20bc9d26382ed\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/verifyReseal.js\":\"a0c2adf675c1f0a7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aad.js\":\"be45729107a7c9e2\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aead.js\":\"24d19cfa01fa6336\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base32.js\":\"550f9a18cc9cc3c4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base64url.js\":\"6ea369148a1ae6e5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/binaryEnvelope.js\":\"68b9ae8419c5b938\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/byteAead.js\":\"ea98608e9171ac8a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/canary.js\":\"0e7aadf21c44853e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentHash.js\":\"9d705bff5ea66462\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentKey.js\":\"20cd2bc1e0559995\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/derivedIdNamespace.js\":\"cdc5edf4950533a0\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/envelope.js\":\"d210cb85cc98fa01\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/hex.js\":\"cae6dcbb9e10262b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/sha256Hex.js\":\"c6dde7ff56daac15\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/workspaceKey.js\":\"8af4f5057170eeab\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/conversionState.js\":\"b85626d75d1dea39\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/createEncryptedWorkspace.js\":\"feed89987100ae84\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/pastedKey.js\":\"ee2ab3d19efef7ac\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"4039f549190c2651\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/upgradeWorkspacePin.js\":\"388cbd73621a7b04\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/keyStore.js\":\"a1f76bba741ec078\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/mintWorkspaceKey.js\":\"add9293100e9e083\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/modePin.js\":\"eecf24b910c6a46a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/openWorkspaceKeys.js\":\"48a2df5db6f363c7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolveWorkspaceEntry.js\":\"898f3ca5fd03350f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolver.js\":\"0bf08e12cf1e4a1f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/workspaceAccess.js\":\"24c3afb6c49ee287\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/transform.js\":\"d20752838382c216\",\"/knowledge-medium/pr-preview/pr-1919/src/themeBootDefaults.js\":\"0d80d8e4d39cb737\",\"/knowledge-medium/pr-preview/pr-1919/src/types.js\":\"0990aba90b80f524\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/ClientLocalSettings.js\":\"d09dc6994bc0557c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/abortableSleep.js\":\"687e25189acac1ca\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/array.js\":\"43fb2c856fb4723d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/backlinkAutocomplete.js\":\"e629fb3e71fee38c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockCrumbs.js\":\"857cbd161e25c7e1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockrefAutocomplete.js\":\"5cd960cb8f98fadf\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/cadencedIdleJob.js\":\"697b54b32340633b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/callbackSet.js\":\"a7b24f953a2499a4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/clientId.js\":\"38e78b38618c203b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirror.js\":\"46a087f2cdcd53c6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirrorCompletion.js\":\"582fbfb297174291\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/copy.js\":\"0f3ad9e4c7db5dc5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dailyPage.js\":\"09267365e9a3c2ea\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensics.js\":\"2be91f2e1ac531f0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensicsHooks.js\":\"eca2b31fd1cc9569\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/deleteBlockThroughUi.js\":\"06b2bf96561e4b40\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dialogs.js\":\"425ea57867bfad6b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dom.js\":\"8f3f077be17935ee\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/downloadBlob.js\":\"dd37af6605f46eaf\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/drawnWalk.js\":\"910f8360b077956e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/exportSqliteDb.js\":\"e4e3dfdce9da318c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fileSystemAccess.js\":\"7206048cee150285\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/flipSlide.js\":\"2faca22f2291e074\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fnv1a.js\":\"4fb229811f5c3a73\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/formatBytes.js\":\"c32d84bf6122d721\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fuzzyRank.js\":\"c4d4cf598999c2d0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idbKeyedStore.js\":\"36e25def11d12e72\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idleCallbackPolyfill.js\":\"b50d7f9f9368b0e9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardAwareScroll.js\":\"1b7bb2e66a2c19c8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardViewport.js\":\"759f345bfe59643c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/lastWorkspace.js\":\"6d83692e2d35a900\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutColumns.js\":\"82804a6a4619d94a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionDom.js\":\"a0c47429c9471db0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionId.js\":\"ab2763d6ec1d845c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkClickGestures.js\":\"cbec90da959ebdcf\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkTargetAutocomplete.js\":\"9fe113c27ff404cd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbCorruption.js\":\"5c287b01d2abb625\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbRecovery.js\":\"f92ab7edbb341b08\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/markdownParser.js\":\"081d75e130e165f5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/memoize.js\":\"45c17ad4c08ca6db\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameFieldCommit.js\":\"69b79c5f52da6fe2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameList.js\":\"31d996820130ee7c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/navigation.js\":\"3a2b5e6d4fa7ec46\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/omnilinerNamespace.js\":\"b3846649bf2af1c3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/opfsPageScan.js\":\"ff7ef1449773362a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelClearance.js\":\"0da79f580bb597dc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelHistory.js\":\"15c6b9f3013db989\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLanes.js\":\"9134d38c90b50c45\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLayoutProjection.js\":\"49888dcad1f42ed7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelScrollAnchor.js\":\"c6907e8a71088012\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelUrlFlags.js\":\"d989b7bc6d42f65d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/platform.js\":\"390e0052c960eed7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/pluralize.js\":\"0b5601d2b886c554\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyCreation.js\":\"26483e9321144466\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyNavigation.js\":\"52989394d93abc3b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyValueContext.js\":\"4baa056a4b1f6fca\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/react.js\":\"7209bf8b2dda5c8a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeDate.js\":\"44afd753a921f225\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeTime.js\":\"05f3ddcc4a2b6c76\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/renderScope.js\":\"ffcd2910b5efcf03\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/resolvedThenable.js\":\"433e95145557fc6f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/routing.js\":\"ea3c8495a8aa364e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/safeMode.js\":\"50bbb5a439043014\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/scheduleIdle.js\":\"b27f3eef5baa7d73\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/screenWakeLock.js\":\"a1f54f8d44afce2e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/selection.js\":\"fc0a13f10c88847a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/softKeyboardGrab.js\":\"e421ef20f44ce7b1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/startupTimeline.js\":\"cb5ecf810c614e38\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/state.js\":\"f3512c7f4f4d097c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/string.js\":\"105c719b41276d71\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/surfaceZoom.js\":\"dc27bdbb7d9a73c6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/time.js\":\"4784f693ae2e2b96\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toast.js\":\"2d99f375b6455096\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toggleStore.js\":\"f12844b846aa771f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/untilStopped.js\":\"ea3003e6257e3c73\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/userActivity.js\":\"1ea41ec29fa70b65\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewTransition.js\":\"8db1a2fdcef6ef8c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewport.js\":\"5c9bc5398262826b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/webLock.js\":\"23fc7845faf6cdb8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceRecovery.js\":\"13f0cedbf85d454d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceSnapshotStore.js\":\"c9f70c8e0b104c7b\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-compiler-runtime.js\":\"d4c172a8b07377b9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-client.js\":\"0399082efa9ddb28\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server-edge.js\":\"2e73db179dc604f2\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server.js\":\"f7f920ccba362568\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static-edge.js\":\"5a0c60f714643012\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static.js\":\"506c570b99b20341\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-test-utils.js\":\"fe385fc99fd123b3\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom.js\":\"b83d10e0ac34bebe\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-runtime.js\":\"67784568b36bdabf\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react.js\":\"45127980314e97c4\",\"/knowledge-medium/pr-preview/pr-1919/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
