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
		buildId: "27c0492b7675-b56777ab",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/\":\"ecd473a1f9833aee\",\"/knowledge-medium/pr-preview/pr-1919/index.html\":\"ecd473a1f9833aee\",\"/knowledge-medium/pr-preview/pr-1919/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1919/assets/FacadeVFS-B6uLEty6.js\":\"7aa41e036a00e54b\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSCoopSyncVFS-BlTQX9s3.js\":\"ffc531704362af47\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSWriteAheadVFS-DsJdPs12.js\":\"3fd95c23c610ef98\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-DlROgey1.js\":\"6939b26e849b016a\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-lncq_ybC.js\":\"f7158d941bcb478b\",\"/knowledge-medium/pr-preview/pr-1919/assets/worker-fGhfelCd.js\":\"9944ebf8edc89357\",\"/knowledge-medium/pr-preview/pr-1919/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1919/chunks/app-B1GABvzk.js\":\"594523b736084d24\",\"/knowledge-medium/pr-preview/pr-1919/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1919/index.js\":\"fbd7a1256112c92f\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1919/assets/AccessHandlePoolVFS-BoGPYxRf.js\":\"74f37af66f9474f7\",\"/knowledge-medium/pr-preview/pr-1919/assets/IDBBatchAtomicVFS-B8u5ZU6X.js\":\"20b6f1e29b5b097a\",\"/knowledge-medium/pr-preview/pr-1919/assets/MemoryVFS-DNXLA_-D.js\":\"9cc0d305448017b6\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-U-fIfgwd.js\":\"7a17c6f49a224a15\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-C3avf6-K.js\":\"a60cd44b1039984d\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1919/chunks/AccessHandlePoolVFS-DTLhv0uD.js\":\"451e8a888c87ecf3\",\"/knowledge-medium/pr-preview/pr-1919/chunks/FacadeVFS-D67LLS1f.js\":\"c0bdc82ca772a40f\",\"/knowledge-medium/pr-preview/pr-1919/chunks/IDBBatchAtomicVFS-Bz44wxWf.js\":\"9fc5bee774a4b7fe\",\"/knowledge-medium/pr-preview/pr-1919/chunks/MemoryVFS-CUNbu1q6.js\":\"a36edcfe2a1dd294\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSCoopSyncVFS-BoJTSTiO.js\":\"558616db838234d2\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSWriteAheadVFS-BLFOtRpx.js\":\"2f07e6e2de05a6ab\",\"/knowledge-medium/pr-preview/pr-1919/chunks/Preview-BaQn-MNX.js\":\"ff0a42048258decb\",\"/knowledge-medium/pr-preview/pr-1919/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/card-DZmT4FpS.js\":\"277eab1c1ebe3c2d\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-DN8RTzMO.js\":\"b1c35276a77991ef\",\"/knowledge-medium/pr-preview/pr-1919/chunks/freezeExtensionImports-BDWM_AI4.js\":\"9c103e3b80965053\",\"/knowledge-medium/pr-preview/pr-1919/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1919/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-BKvlS76w.js\":\"a6f1a6c1d089a1c7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-async-B6EbCSq7.js\":\"663bca6c76ee6da8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-BBTGHaV1.js\":\"b132b7ec68343b96\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CTYjj-U_.js\":\"bab39893a8755fd2\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CdRuRVMK.js\":\"aacf43882e971279\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CuJD6YMP.js\":\"782c4b404b4c64d7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DUdC_QD1.js\":\"483da1a660bf1ad6\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DdaqKfeS.js\":\"552e3b984ca2a27c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-VzGISZHg.js\":\"2f23547a99b30574\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dmdGPdOv.js\":\"b5fe0aca8d14df92\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server-legacy.browser.production-BawKZksj.js\":\"cc384fa78213a335\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.browser.production-OGVAiF3B.js\":\"e406515d108a529d\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.edge.production-Crn08LYP.js\":\"b3d5f9d2805c3f59\",\"/knowledge-medium/pr-preview/pr-1919/chunks/server.browser-B7jQPnwL.js\":\"fa4da58002dfbf48\",\"/knowledge-medium/pr-preview/pr-1919/chunks/textarea-BaLWrhmu.js\":\"f094216054c20cae\",\"/knowledge-medium/pr-preview/pr-1919/chunks/ui-ZNOUHw3l.js\":\"db146ae5cfded635\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-DiMwuaFR.js\":\"dc46ccc9a5bb52b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-async-DAMXKp9v.js\":\"fe5b0a07c6c5a12a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1919/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/src/App.js\":\"fdc3e83d7f6d9f88\",\"/knowledge-medium/pr-preview/pr-1919/src/appUpdate.js\":\"877615eb3a6efc42\",\"/knowledge-medium/pr-preview/pr-1919/src/appVersion.js\":\"906430660b025a2d\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/initialLayout.js\":\"b0c344a5231e4b51\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/openWorkspaceData.js\":\"92e6bf9c47a2f998\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/resolveWorkspace.js\":\"da8fe9ae003748e7\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/workspaceBootstrap.js\":\"ea6b3a08c03ddd22\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockComponent.js\":\"4c3450d0ce3db166\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockCrumbs.js\":\"9a67f1a10eaf7f46\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockEditor.js\":\"b784c20ff05caec1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockLoadingPlaceholder.js\":\"266eec117733993d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockProperties.js\":\"3924e843fed862c8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockSearchPicker.js\":\"14b6f634a599f66a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ConfirmBulkDeleteDialog.js\":\"2ee3365edc1fc9b7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DividerHandle.js\":\"273475c5c0f59e3f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DraftEditor.js\":\"0e68b21352225430\",\"/knowledge-medium/pr-preview/pr-1919/src/components/GutterPill.js\":\"fa9249060c8e5c15\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Header.js\":\"153434fe11f09fb9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/LazyBlockComponent.js\":\"dfd6367eabab508c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Login.js\":\"a5e7a6e26474e6b9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ZoomableSurface.js\":\"3ef2bea69e0fe0cd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/editModeKeepalive.js\":\"658d7454f5ebe594\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyDisplay/PropertyDisplayScope.js\":\"825504870b340253\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"045703ce9074cf68\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefPropertyEditor.js\":\"b90840942cdd8942\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefTargetTypePicker.js\":\"9597a88d3059e4bc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/SelectPropertyEditor.js\":\"3f237d5b19ebbf49\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/TypesPropertyEditor.js\":\"e3d51804d4d6db37\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/defaults.js\":\"7e1d1acdd26709d1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/kernelValuePresets.js\":\"e251a89aecc1e104\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/selectablePresets.js\":\"a6717ea6a38f0d06\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/typesPropertyUi.js\":\"ad2d77e00a46c83b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/AddPropertyForm.js\":\"7e580412b0f75d5b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyPicker.js\":\"106ac2e210294885\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyRow.js\":\"27570ca233fe702a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/Rows.js\":\"b4b44926fb82d33e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/actions.js\":\"599e2ba2adbea101\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/declarationOnly.js\":\"223670eb83f032bb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/layout.js\":\"5b848ac7664f3b1c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/model.js\":\"359ea3bb668e850e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapeUi.js\":\"e261dcecf13d58fe\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapes.js\":\"34afaf22dbbc0b8e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/usePropertyEditingActivation.js\":\"663b10ec616dd17a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/visibility.js\":\"33bc8c01be5f1c8f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanelSections.js\":\"dcf857e06551c681\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockEmbed.js\":\"8c44fdc2f20ef1a9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockLink.js\":\"0e9205b004f31492\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockRef.js\":\"b8ed092877034596\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/CompactReferenceLink.js\":\"ada3281e3fd29dec\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/ReferenceLink.js\":\"b36a1b3c42050ce8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuard.js\":\"e5a0789ef0e5a1f8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuardContext.js\":\"b157ffb6a9e83776\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/linkInteraction.js\":\"878ad387704c2039\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/referenceLayout.js\":\"8d46a08acc36c537\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/useBlockRefAncestors.js\":\"07f91340c3093634\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockGutter.js\":\"ec7f6e9fe5ebde5b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockInfoDialog.js\":\"fa9bdb34177fe5ba\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockReadText.js\":\"352b7a379a884f8b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockTypeBlockRenderer.js\":\"bed5d4b4ab793331\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BulletHoverCard.js\":\"bf11e8451e86275c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorContentRenderer.js\":\"234cc14dcac16e91\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"67364a9b7290300b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ColumnResizeHandles.js\":\"b85c74decb9a4739\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"4518da1cfb77e98f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/DefaultBlockRenderer.js\":\"7035188a928babc8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/LayoutRenderer.js\":\"c7ff8b91bc6c6a3a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MarkdownContentRenderer.js\":\"1c5d98edeaec8960\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MissingDataRenderer.js\":\"37698dbbb162de36\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PanelRenderer.js\":\"30d652ada465fbe7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PropertySchemaBlockRenderer.js\":\"da381226bfe99883\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/TopLevelRenderer.js\":\"18ffa2a051d94242\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockGutterMode.js\":\"7ca18180498c1cd1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockTitleText.js\":\"755cd1fc02072a4e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/fieldCreationKeydown.js\":\"90567e71eac710c2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/layoutRootContext.js\":\"4e28e42a8849e599\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/TypeChip.js\":\"6a6c5ca37b843c02\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/chipStyle.js\":\"f01fadb329f872c3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/anchored-floating.js\":\"2f6388638e2bdf37\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/button.js\":\"e542be4290b01cb6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/card.js\":\"8d67a3441e4c936a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/checkbox.js\":\"c815eb9b77837852\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/collapsible.js\":\"711e4978915f2833\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/command.js\":\"bd0448a1b0906241\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/context-menu.js\":\"7a2e221696483e7d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dialog.js\":\"170bc62b1a85ebc8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dropdown-menu.js\":\"b41634e32955793b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/floating-listbox.js\":\"56358af32a694bd2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/index.js\":\"e70878dd1f98c0f0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/input.js\":\"1259fc7b8688479b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/kbd.js\":\"42f9925bf19dd4c1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/label.js\":\"982e364b92bf735e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/textarea.js\":\"39ecae5c88f416a7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/useEditModeYieldKeepalive.js\":\"2e52b58bf051b4e0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/BootFallback.js\":\"754f43c1ec57e89e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/FocusedRowLazyMount.js\":\"d5d2de5b25f77980\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LazyViewportMount.js\":\"bb18c46690f7265f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LocalDbCorruptionFallback.js\":\"ed49fca0aec11c9e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/error.js\":\"3a9b719aaea39b14\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/lazyMountRegistry.js\":\"4c39be89efbe51c0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/suspense.js\":\"d4ff7b52758ac43d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/CreateWorkspaceDialog.js\":\"578dcffaa35846a6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/PendingInvitations.js\":\"be3b5d4031bcde36\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/SyncProgress.js\":\"0b7c4bed2b6f6473\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/UnlockProgress.js\":\"fd96527d0f93a7d7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceKeyGate.js\":\"52b482dce7c06841\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSettingsDialog.js\":\"710dce4afb5b8be5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSwitcher.js\":\"dc1bfab34fbeb37a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSyncGate.js\":\"2676958789751c12\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlow.js\":\"033328a47c8e597e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlowHost.js\":\"66192dd58d04e838\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/EncryptionSection.js\":\"022a4c8d892f6b2e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/attachmentPrompts.js\":\"54748ca09d3fd345\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/bundleFolderPrompts.js\":\"6d54b9e15cd8251a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowDeps.js\":\"311efbcbc718d88a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowStore.js\":\"9f11277675b35df4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/flowUi.js\":\"6ee15cbd9a65bf55\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/useConversionRun.js\":\"3b0466ed01ade1f4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/keyUi.js\":\"6454a1ddf52ab46c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnKeyLoss.js\":\"6069593655851940\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnServerE2ee.js\":\"cc3cdc4b2a172421\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/workspaceUnlocked.js\":\"a50f8f724a71e18e\",\"/knowledge-medium/pr-preview/pr-1919/src/context/backgroundSubtree.js\":\"45e2959967196cb8\",\"/knowledge-medium/pr-preview/pr-1919/src/context/block.js\":\"0e8eda26540e7097\",\"/knowledge-medium/pr-preview/pr-1919/src/context/layoutWsContext.js\":\"bc2a16d30eaa175b\",\"/knowledge-medium/pr-preview/pr-1919/src/context/propertyDisplay.js\":\"06897918e787a0a7\",\"/knowledge-medium/pr-preview/pr-1919/src/context/repo.js\":\"5d167d8361cc9695\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasClaim.js\":\"464ae076e94c3793\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasSeatNamespace.js\":\"40a0ca88e6bd55ef\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockData.js\":\"168ce5b7dab6aaba\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockType.js\":\"07835ce7f561e94e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/changeScope.js\":\"c433f7507c10926d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/codecs.js\":\"fd7c30c5a9badf8f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/derivedData.js\":\"79071bb21dc496c8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/errors.js\":\"8d3eac8f8883fdb0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/events.js\":\"124df28a0e8a3905\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/handle.js\":\"aa2ea441a8ab2486\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/index.js\":\"728623507ef259cd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/mutator.js\":\"5a69772b0832bf45\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/processor.js\":\"287ef04a8f375bbf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/propertySchema.js\":\"cb8a11d10c94f15e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/query.js\":\"cbf38ffd00e14f84\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/sameTxProcessor.js\":\"48356a3b8fbeba85\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/schema.js\":\"aa2ea441a8ab2486\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/tx.js\":\"aa2ea441a8ab2486\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/typedBlockQuery.js\":\"f7fac9c1f6b53ebd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/user.js\":\"427b1e2e2979c85c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresetCore.js\":\"b900065976f52b36\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresets.js\":\"2b6c4821fd291e46\",\"/knowledge-medium/pr-preview/pr-1919/src/data/attachmentCleanerIOVerb.js\":\"df0820c85dc7cdbd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/block.js\":\"0516c058bf6b5bb0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockCache.js\":\"415b2b7f646ef918\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockId.js\":\"744db46eae566f54\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockLiveness.js\":\"87dc44b1ae556971\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockMerge.js\":\"e8ee352850cb060e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockSchema.js\":\"99bf98dd3266b791\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypeLookup.js\":\"274163c6076ea8d6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypes.js\":\"7b3abec163cdf19e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/childrenView.js\":\"dd1e737ab69401fe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/clientContext.js\":\"12f0f76e8166ac27\",\"/knowledge-medium/pr-preview/pr-1919/src/data/dbFileSiblings.js\":\"ee790b255cc3bef9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/definitionSeeds.js\":\"7da1c6819432b946\",\"/knowledge-medium/pr-preview/pr-1919/src/data/derivedIds.js\":\"d8b85a13c6177f8b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/drawnSubtree.js\":\"ab87070ff71d9eca\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facetBridge.js\":\"cdf050f36cbe0fbd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facets.js\":\"bba36feed7e4cd23\",\"/knowledge-medium/pr-preview/pr-1919/src/data/globalState.js\":\"30d0f06505bc7c22\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/aliasClaimRederiveProcessor.js\":\"b72536c11dd0d7ac\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/ancestorBatch.js\":\"b4625f98dab19109\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/blockTypeTypeifyProcessor.js\":\"68c2210ed5b51ccb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/clientSchema.js\":\"aa86b6d45b75b12a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/commitPipeline.js\":\"015b99931759bcf0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/devAssertions.js\":\"8922f714413d42ad\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/firstSync.js\":\"f4927301bc175141\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/freshInitialLoad.js\":\"732c0125667e69d6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/graphBackfillClaim.js\":\"4e2dd2b629e788c8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/handleStore.js\":\"de47e5afee1794e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/idleMarkerJobs.js\":\"fb11aa55fb2545ee\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initialDownload.js\":\"6ea9a93fdca736a7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initializeClientDatabase.js\":\"88bde3d5ad9fb747\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/jsonCanonical.js\":\"39e9ef768cbbd704\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelInvalidation.js\":\"5e0bd067cd4335c7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelProcessors.js\":\"3dc348fe5e1c054d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelQueries.js\":\"2f524dcabd4d91c5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/mergeTypeMembershipProcessor.js\":\"2ede8539d547cb78\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/normalizeReferencesProcessor.js\":\"779322bd162e1442\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/poolInstrumentation.js\":\"328927d3a6f7f7a4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/processorRunner.js\":\"fc63b99c14bac287\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyCellBackfill.js\":\"717794475d551267\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildMint.js\":\"a31d998c9d47e170\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildrenProcessor.js\":\"cad2dc598de9bdda\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionChangeProcessor.js\":\"cf2da47b63cab931\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionSynthesis.js\":\"5f24608a2b117b00\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyKeyScan.js\":\"6d94c0ae197c1f9a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertySchemaResolution.js\":\"dec0d250aaec9894\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyValueEdits.js\":\"42aa536b365c9e48\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/raiseProtocol.js\":\"fd16900e0ef6587b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/readBatch.js\":\"a17267577c56755f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/refProjection.js\":\"8e4b5acc8bd21cbf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetLookups.js\":\"90f866eba7d32bba\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetProcessor.js\":\"2e303eb5b7252fe0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/replayMerge.js\":\"8072c2c107cf8a95\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/sqlBinds.js\":\"bcbc149a1a708a04\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"fcebea7d342fb1c5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/arrivalProcessors.js\":\"70513d1d116d3571\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/invalidate.js\":\"d3d86866b8649fd8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/materialize.js\":\"1de39d8144b63e43\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/observer.js\":\"0bbcff588298acba\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/reconcile.js\":\"d45b58fda58c5a17\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/timingMetrics.js\":\"0d8452041ed2fd1f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/treeQueries.js\":\"bb87f00dcf451b6c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txEngine.js\":\"ed0046519ccd2db9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txSnapshots.js\":\"80b9967a3c8b9798\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/typedBlockQuery.js\":\"4c6b2c0ec15725d7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/undoManager.js\":\"7ce7aa3d1ce34d85\",\"/knowledge-medium/pr-preview/pr-1919/src/data/invalidation.js\":\"13747639ef8bf070\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelDataExtension.js\":\"92a2b27059e323b3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelPage.js\":\"a6ea645b8169642c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelValuePresetCores.js\":\"0a4e5e4a4d5360b8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbCorruptionSignal.js\":\"5c748f877bd5d0bb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbStorage.js\":\"52a7b504b71ed586\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbVfs.js\":\"b101db9bff7bd1df\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localSchema.js\":\"5d11fd63744f4d06\",\"/knowledge-medium/pr-preview/pr-1919/src/data/maintenance.js\":\"cc746ade1b31c0fe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mergeProperties.js\":\"87707e8d9b4de427\",\"/knowledge-medium/pr-preview/pr-1919/src/data/metricsConsoleHook.js\":\"c9324a25467ed9d2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/migrationsPage.js\":\"3cf451dfda86997c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mutators.js\":\"0774874a911698a6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKey.js\":\"7a0c8589bdf7834f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKeyPlacement.js\":\"ea8291bd5ea75720\",\"/knowledge-medium/pr-preview/pr-1919/src/data/outlineSurface.js\":\"de954e7bb463b88e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingEditorContent.js\":\"eb65bb40161d2439\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingUploadsSql.js\":\"165aebd618a2b4f6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pluginStateExtensions.js\":\"37007b34556bbb06\",\"/knowledge-medium/pr-preview/pr-1919/src/data/powerSyncLogger.js\":\"1f3bf227d2d29622\",\"/knowledge-medium/pr-preview/pr-1919/src/data/projectorRuntime.js\":\"29ebbfd1fc6f7bbe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/properties.js\":\"103c728f4fb8ac92\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertiesPage.js\":\"67e89077f59b0e11\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyChildren.js\":\"de8c235fc5575da6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionFanout.js\":\"b3f5ca5ef6bf48e2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionMetadata.js\":\"8ad356c86d858558\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionRegistry.js\":\"b37d11f57b237951\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDisplayMode.js\":\"0eb0926ee5996c34\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyRowCreation.js\":\"56cc19b5f6391791\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySchemaCreation.js\":\"b5d00bab2223453f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySeeds.js\":\"bfdb88210b6315ed\",\"/knowledge-medium/pr-preview/pr-1919/src/data/recentsPage.js\":\"b958ea4cc0c9da3f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/refTargetComparableProperty.js\":\"5af5ed6bbe25988e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/referenceBlock.js\":\"9302b248e6d9bb5c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rejectedUploads.js\":\"cd5dde9442355b06\",\"/knowledge-medium/pr-preview/pr-1919/src/data/releasePowerSyncConnection.js\":\"a5ff0af435d8c000\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repo.js\":\"58f994043fa1f145\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repoProvider.js\":\"cf6593842c19bdcd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rowProperty.js\":\"538e265cab236f07\",\"/knowledge-medium/pr-preview/pr-1919/src/data/searchFilter.js\":\"7be4175df014c78a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/seedIdentityLedger.js\":\"232d9d590c75f77c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/stateBlocks.js\":\"5ea21ccc98f19835\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralEditPolicy.js\":\"3d7b046d51ec8fbf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralInsert.js\":\"8bf7c5623653735e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/subtreeDelete.js\":\"1fd6cd898010ae01\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncStreamLock.js\":\"9cdefc947ffc3d95\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableSqlRecognizer.js\":\"14b403483b593316\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableWriteGuard.js\":\"69c1b1467a31514c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/targets.js\":\"f7f3afa3aa59b8b7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeColors.js\":\"8ae4bb12e693d8f1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionMetadata.js\":\"70bb4a4097295c0a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionRegistry.js\":\"4a08b9c19a3bd15f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeExtraction.js\":\"69bd88fa4b58a6f9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeInitialValues.js\":\"20841d509e2486ea\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typePropertyGroups.js\":\"7aee72598e83a0e3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeSeeds.js\":\"4123d9982573b2c0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeTagger.js\":\"b34e04d0af4021e3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typedRecords.js\":\"534103f952dc2458\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typesPage.js\":\"73ece41cdfef2ef0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userPrefs.js\":\"c5be7e22258d2963\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userSchemasService.js\":\"ea3379532481cf69\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userTypesService.js\":\"311664ade34f8b08\",\"/knowledge-medium/pr-preview/pr-1919/src/data/valuePresetRegistry.js\":\"8e0e70691658b1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/visibleChildren.js\":\"1e8756d7d54167ce\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceConversion.js\":\"719816a55227278b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceFirstSync.js\":\"61cd1ce69d9a2aa9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceIdNamespace.js\":\"110ce4de139864e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceSchema.js\":\"f16ebd7763e898af\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaces.js\":\"ba9809f42b42c390\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadLog.js\":\"4e521895642733bb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/BlockPasteShellDecorator.js\":\"aabec3c1bb86840d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/atTrigger.js\":\"b5ef6061a8c0cb07\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/autocomplete.js\":\"4710d86a0db631f0\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/codeMirrorExtensions.js\":\"977b42cadec9912f\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/contentFlush.js\":\"d1266fa716242cdb\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/defaultInteractions.js\":\"c88e5a43954aaeef\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/editSettleSignal.js\":\"b8589e380f027c1d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/insertImage.js\":\"19a6e75eb361ac29\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceCompletionRange.js\":\"2df2ede5d3fd432f\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceTargetTypes.js\":\"b9f7d89d2c9bd922\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/syntaxContext.js\":\"c3f6f524ef1fd11c\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/triggerMatch.js\":\"101ae12dd5842a01\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/AppRuntimeProvider.js\":\"af1be193d6572553\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/BlockFocusShellDecorator.js\":\"8d12f66a8dbc9af6\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/ExtensionRenderBoundary.js\":\"a087c1f59c747002\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/PanelContentRecovery.js\":\"57234889b6eaabc4\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/apiCatalog.js\":\"7fd79e4866770f1a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/appRuntimeController.js\":\"59415e9c19d9f77b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/approveExtensionHere.js\":\"c5e8b5632eaa6b80\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/armedCutAppMount.js\":\"584b01fd23c8ce31\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/batchableKeyedStore.js\":\"7184c846f5275bfc\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockInteraction.js\":\"b628a31694f2a819\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockSelectionAction.js\":\"2d93ea8a1a081243\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compileExtensionModule.js\":\"e0e3b5d62d5308fd\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compiledModuleCache.js\":\"8aae9ad33feb77c1\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/continuousGestures.js\":\"d7f893ff4a87348c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/core.js\":\"ec5a8fc684b18575\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/defaultRenderers.js\":\"afe92970b6fc92fe\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/definitionFanoutAppMount.js\":\"57318c621b8f0c2a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dialogAppMount.js\":\"ec82c33f429afad3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensionSeeds.js\":\"009735fa7b45e0c3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensions.js\":\"63208dd929e41cc3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/exampleExtensions.js\":\"63c8a90849d06c69\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionApprovalStatus.js\":\"47dad2cffe6f8e6b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionImportPolicy.js\":\"d2dfefc42bb6c861\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrorToast.js\":\"181347aa4fde13ef\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrors.js\":\"02ea37add9dd49dd\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLookup.js\":\"e5f1baf6b8c9186f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionToggles.js\":\"1227502faf89dd09\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionUtilitiesCss.js\":\"970d425a4399cab6\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/kernelPageDeletionGuard.js\":\"a5f95d1b59733c88\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/liveRuntime.js\":\"a85888591bba9b19\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/normalizeExtensionSource.js\":\"f78c22fb457b994f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/openExtensionsSettings.js\":\"271e569e23af0de6\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/overridesCache.js\":\"3c313cc65030ab6a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/pluginIds.js\":\"b4892daae51653fc\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/processorRejectionToast.js\":\"b41c428e42b8b49e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeActions.js\":\"04f1f0ea130f83b8\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeContext.js\":\"a2a4671c2920a5e9\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticAppExtensions.js\":\"c7bded218fb35340\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticDataExtensions.js\":\"58109b3dd2429bc7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/toastAppMount.js\":\"5f687b8fbf72d460\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/transpileExtension.js\":\"f47ab6fd2a60b6c6\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useOverrides.js\":\"07dacc743931abad\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useShortcutSurfaceActivations.js\":\"8d4d7e523f85c9cb\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/discoverToggleTree.js\":\"12c09d34341ffd98\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/facet.js\":\"f411a23ae60972d6\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/resolveAppRuntime.js\":\"682621a8e6932796\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/runtimeEvents.js\":\"d4c675e5fe76c8be\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/togglable.js\":\"d76c6a8385d5baf8\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/variantFacet.js\":\"6f459e7c67b04a56\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/verbFacet.js\":\"7191041274e96ce4\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/block.js\":\"ceb714a0b8504f09\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/focusedChild.js\":\"12837e0275cfad04\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/propertySchemas.js\":\"48b1fe4f0f8cb625\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/typeRegistry.js\":\"bfd984578bd7571b\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAncestorCrumbs.js\":\"4af53aa3a6ec48f3\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAutocompleteListbox.js\":\"edcb0c8407ba4ecc\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedSearch.js\":\"39075ff588b9d492\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedValue.js\":\"4a0a45a1a42405f7\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useFacetValue.js\":\"543e9fb266f58b76\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsFocalRender.js\":\"d429ecfba6f96992\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsReadOnly.js\":\"659a8ce32deb9faf\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMaterializeBacklog.js\":\"bfbe40e92f321593\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMinuteClock.js\":\"5957316b3ee89f9b\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePanelLayoutProjection.js\":\"ffa6abe5c28de3aa\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePendingInvitations.js\":\"98bde945d34e3c34\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRendererRegistry.js\":\"442cf51ba636804c\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRetainedFieldRows.js\":\"494f0030e88f42be\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useWorkspaces.js\":\"6b76a0520f0d60c7\",\"/knowledge-medium/pr-preview/pr-1919/src/lib/utils.js\":\"e5c402bf41db28a8\",\"/knowledge-medium/pr-preview/pr-1919/src/main.js\":\"9d2314183cb18b93\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/MarkdownImage.js\":\"557f5a5bab02a497\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/blockSeparators.js\":\"075912b052cb3fbd\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/context.js\":\"f725f200c7f18331\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/defaultMarkdownExtension.js\":\"7ec93296985cc24c\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/extensions.js\":\"3e1a14168abdc7e5\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/renderMarkdownHtml.js\":\"e42de24a2dece46a\",\"/knowledge-medium/pr-preview/pr-1919/src/minimal-editor.js\":\"1428fd1fbbb9bb12\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/armedCut.js\":\"177e4afd74546366\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/captureMediaVerb.js\":\"77b5919f9499f6a0\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/clipboard.js\":\"5ea32001e3af7096\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/decision.js\":\"3893936fa4d45cc6\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/operations.js\":\"4e3af581b2c54ef9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/AccountHeaderItem.js\":\"3b7b75406e74140d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/index.js\":\"6ed0319c8ad805a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"0c96f28928b37c63\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askAgent.js\":\"c42de566ef6b5a9f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askedStore.js\":\"cc0b8871390fd413\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a2ef9b4d17c51ea9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/chipState.js\":\"64ca30dac38d713f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/dataExtension.js\":\"8dede7faf0d90e10\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/index.js\":\"aeeade667164e9f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"226b2b95c71c9cf3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/schema.js\":\"eb31ea6cf6e47c9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/AgentTokensDialog.js\":\"1ce1ee9e53d9c32f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6415ba6d93efdd36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/addMedia.js\":\"8b72fb3434429ee0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/backlinks.js\":\"92242885b4e90b71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/block.js\":\"ead71a43eebd1c9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/context.js\":\"453645532bd92a9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/displayIds.js\":\"0f7e5384d3fb3dce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/index.js\":\"3b4d8c1ef72e237b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/outline.js\":\"cd19d7c8c5d96eb6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/properties.js\":\"f193dad2bdf7fdc4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/refs.js\":\"b2444d7b407617b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"3ba398c0decd26e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/search.js\":\"54843a043dc28ff1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/shared.js\":\"75dafe92c4e87393\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"56f90162528cf569\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/text.js\":\"9559534a7709b327\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentWrites.js\":\"22c883b9a20961c6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/authoringCatalog.js\":\"30673fba050b08cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/blockRefTargets.js\":\"4ca4a618f79ef16e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridge.js\":\"649c6fc5e1b87087\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridgeLoop.js\":\"e0217b9665ae62e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/changeHistory.js\":\"4fb9509d33b77822\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commands.js\":\"a520765954151efb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commentsCommands.js\":\"5585d71c95f4209a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataExtension.js\":\"35d317a12493d0b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataModelGuide.js\":\"923f096dade0d6d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dayPropertyInputs.js\":\"00903e8eae5791ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/describeRuntime.js\":\"603ea840c5eb201a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/extensionLint.js\":\"731d484ba85cad4d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/grainAudit.js\":\"99bca52da7f1331c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/healthCommand.js\":\"b54c4e2dbad038ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/index.js\":\"ccbc085dc8974732\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/presetIdentity.js\":\"dd79f4c97f691cfe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"3f22dca20a6847eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/readMedia.js\":\"d1e826b163e34b64\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/schema.js\":\"e3ed12055a902424\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/serialization.js\":\"f538eb0a320f65c6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/targets.js\":\"01672ad53a701d72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/tokens.js\":\"efe6f1cce1a97e8b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/watchEvents.js\":\"f7049f4ea58f60a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/workspaceGuard.js\":\"ba7f18e47b927423\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/writeCommands.js\":\"eba7c16fcee8d1b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/AliasCollisionToast.js\":\"0c6a3d7677e01f87\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/DuplicateNameBanner.js\":\"af7c4a77741fbbad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/collisionMerge.js\":\"023ff77c5cd54be6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/dataExtension.js\":\"ab52ab7bc194272f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/index.js\":\"9e143f71442eff0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/mergeCollisionAction.js\":\"269ccdf77b23f3af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/pageStyling.js\":\"9b4b231315cea591\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/rejectionToast.js\":\"142d10d0ac037f9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/syncProcessor.js\":\"88f84568072d3d44\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/actions.js\":\"01aa190524729a41\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/addComment.js\":\"b5ca16b36b273181\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchor.js\":\"e9ced1926634e04b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchorState.js\":\"9f8cb1ca7288cd63\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/commentLinks.js\":\"03c9c2971fa75111\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/confirmThreadDeletion.js\":\"63dd8233d8057ada\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/container.js\":\"cef1e48f747a365a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/dataExtension.js\":\"9afe0f47ebd5eb4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/deleteComment.js\":\"4a993a01fe05ae8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/highlights.js\":\"e54a2fb4b297a362\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/index.js\":\"204baa1c91c8d336\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/linkedCommentsPill.js\":\"fc30de9d746624cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/margin.js\":\"96f57501a69f0354\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginAnchorLinks.js\":\"f25e9a6bbdad5f73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginSchema.js\":\"be1f2f0b7e983bc8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/newComment.js\":\"6820a06766bdd640\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ownThreadPicker.js\":\"1760fb0aaa008069\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/placement.js\":\"96d207c1910087f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/queries.js\":\"66684a0378324671\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotePosition.js\":\"d0620bf532cab0cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedIn.js\":\"b46437a8e6e613cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedRange.js\":\"aa88643bc095c659\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/rangeRefs.js\":\"cf1dd0f85f89fc03\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readHighlights.js\":\"fa66afdbbed9dab3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelection.js\":\"ec0813902f958c3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelectionUi.js\":\"7d1e5af747aaab50\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/reanchor.js\":\"d96f975b4df7fb1f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/schema.js\":\"de360e6c8d3f2007\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scope.js\":\"bf18e7c452f787d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scopeThreads.js\":\"9e06a8e64c6c4123\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/splitRetarget.js\":\"1842aefd7c7784f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestionCard.js\":\"ec03a99aeef2e602\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestions.js\":\"21421f6f8b6a5108\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaries.js\":\"35c33854d0d99b26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaryBatch.js\":\"e31f9a207b04b5ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/surface.js\":\"74aa7ffdef869eca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threadNavigation.js\":\"da1e9c8d16fb6423\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threads.js\":\"6ab9d069e6739046\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ui.js\":\"cc4b11fd9bf0219c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/uiStore.js\":\"fad9422de96cc208\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/appIntents.js\":\"5659bf1cc2d2f98d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/index.js\":\"cc666af509598ecd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/index.js\":\"0a4badc82a9878ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/status.js\":\"a5cf504dc7d1aae7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"5037ce6e057dc60f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaBlockRenderer.js\":\"ef237b11b0adae0f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6ffbe3da5a284113\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaUploadReconciler.js\":\"da1b9a5cf79be8e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetDownLane.js\":\"daf2702d3b213dcc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetResolver.js\":\"172872f46793cba0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetUpload.js\":\"55209083b89532bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/attachmentCleanerIO.js\":\"1c62a0129589eee3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c23be7c4a6251e9d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/blobStore.js\":\"f5465106192c3267\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/browserMedia.js\":\"d2006ae54bea867a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/byteStore.js\":\"2b379b425287dadf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanerIO.js\":\"12c33757c762f0c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanupAttachments.js\":\"181c9c8df51c39d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/dataExtension.js\":\"0c00720c57db7691\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/downLane.js\":\"0eb4d1a12cc08139\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/index.js\":\"27e0ebd740aedeed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/insertImageContribution.js\":\"f423e5110c3d8412\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneArming.js\":\"ad35643f1c614264\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneLock.js\":\"022871359c4c629d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaBlock.js\":\"f8758d4e8349d377\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaCapture.js\":\"37c3857cc1fe63b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaLanes.js\":\"fc2219c4acbc4839\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewers.js\":\"4668364bae9ad1ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewersFacet.js\":\"9910a9e4e7e2d80d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/pasteCapture.js\":\"2999b8a78e9b1515\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/resolver.js\":\"8e694af89e952773\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/retryUploadsAction.js\":\"b3d6a545ebfe3932\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/storagePaths.js\":\"672736ad6e001445\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadDrain.js\":\"c1ed49ed409a4a06\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadLaneStatus.js\":\"dbd743812a6e4462\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadReconcile.js\":\"594d4b70726ddfd1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadRecovery.js\":\"a27ed4c4feb1ce90\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadStore.js\":\"69698f94baf5d0a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/useAssetObjectUrl.js\":\"65c247deb151a6c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0fab3751dec553f3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksViewSection.js\":\"1ee0bf92da26042a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/facet.js\":\"3742225b1310d993\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/index.js\":\"89a57cec2c661688\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/prop.js\":\"909b0f195d113479\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinkFilters.js\":\"2c3f8fb97801e017\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"e08b6130f5774c97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BlockEntry.js\":\"fc3771156760118a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/LinkedReferences.js\":\"e887a9a34e3236dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"9a64b4d2591107ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dailyNoteDefaults.js\":\"0d1220abd59712b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dataExtension.js\":\"06df6938784b9fc7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/edgeExclusions.js\":\"ebcbd874e773de06\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/filterProperty.js\":\"718c6f839ac1c838\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/index.js\":\"a98235a048a9ad5c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"368610bed4eb77de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/applies.js\":\"508a6fb930d64b75\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/countQuery.js\":\"88fb0121e8f3c2d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/expansionStore.js\":\"3d847e4469bb798b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/index.js\":\"fae9f0214772f866\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"e2846e6887f6979f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/presentationInvalidation.js\":\"6c47c139c16c811b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyEditorOverride.js\":\"9a43fcf7008a72b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyFilter.js\":\"1a16ca8d5ad19932\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/query.js\":\"89035d5e35e38728\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/resolveFilter.js\":\"d9b6986215393f93\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sourceBatch.js\":\"222d3f3e562d973d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sources.js\":\"897de7c4d7184c85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useBacklinks.js\":\"c1091ceec8557317\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ee9a80998428454c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayCelebration.js\":\"49e17c24d9e07903\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayOverlay.js\":\"4c07278bd7d13360\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/gate.js\":\"7e105355685fb203\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/index.js\":\"83158c615e82e7a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/wolfTheme.js\":\"81fc787b538c0b04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/BlockDragLayer.js\":\"8e41180036441b95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dragController.js\":\"f648c14dcf23cb36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dropTarget.js\":\"49112634efbad709\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/index.js\":\"c34713ec6b010244\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/projection.js\":\"8e0bee81acfa8fa1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/BlockMetaCard.js\":\"e3c57c6ab768abc5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/index.js\":\"f4e276f1b5255e9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/AddTagDialog.js\":\"08d89b97c110d7b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"33a266c92e2d3f14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/TagNameIssueHint.js\":\"589743be4223b56f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/addTagAction.js\":\"7344a40fdc832fc0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/appendTag.js\":\"be030363f582f198\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/config.js\":\"8602900c546da3ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/dataExtension.js\":\"f14523f25a780090\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/index.js\":\"4fe09476f6431bf8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/propertyEditorOverride.js\":\"384ea5260e39f42c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbList.js\":\"2323f7d2704d80d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"561bb7af2e81ab76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/Breadcrumbs.js\":\"339d0f1ce5ad3182\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"80eae5d9c762ffe2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"c09b54e71f5512db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/index.js\":\"808ce798f4d3dfcc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"2cd6eac8139052af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/CharacterCountItem.js\":\"556e3f4afcf9ce6d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/ProfilePropertyEditor.js\":\"c2caea24a30ee2f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/actions.js\":\"edc9908ba7a0e619\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/blockType.js\":\"326d2e5988770f76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/charCount.js\":\"c4b43e775d0b137c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/dataExtension.js\":\"1db4362f2df5fa5f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/index.js\":\"7d517ab2d010c151\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/profiles.js\":\"80de4417284a79d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/properties.js\":\"cd4b03236c742c09\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/subtree.js\":\"c665e3b385be14eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/textCounts.js\":\"43b10ea97af7f2b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/colemak-keybindings/index.js\":\"941ebc7bdf5bf131\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/CommandPalette.js\":\"2b5def23e4661470\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/HeaderItem.js\":\"69a87936ee8b1e79\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/context.js\":\"ffac20a108380b7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/index.js\":\"0f1ea4176cdac9f5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/selection.js\":\"ea50034cf626f69c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/toggleStore.js\":\"be260c7bc283f79c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/useCommandPaletteActions.js\":\"076cf310fc73dd4c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ContributorBadges.js\":\"f183d51a52e49b8b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ProfilePicture.js\":\"3a4443aea6630bcf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/author.js\":\"48091b4b0f85da99\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/codeMirrorExtensions.js\":\"535d5dd2a5312fa4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/dataExtension.js\":\"be66334c8efbccb0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/index.js\":\"fc75ec4d2063e8c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/mentionAutocomplete.js\":\"ea4e49c579197235\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/processor.js\":\"18caae37fd4045c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/profiles.js\":\"3c9fb5d91c7a8aca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/queries.js\":\"6607043fe2cca643\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/schema.js\":\"8b2d2732cd2ff776\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/useCommentAuthor.js\":\"7980967b1a007ad0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"8c361acdae1fcd0f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/followOrigin.js\":\"87a6e72ffc214f2d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/index.js\":\"2853e5b65e3102da\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"7f42071f0b632568\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"cc555ae6c2678304\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/CalendarGrid.js\":\"29477d9c0ef55de5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DailyNotePicker.js\":\"4d4c2ef0eb6b1148\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"94d99d83921dd5ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateNavDecorator.js\":\"aa1d5ad2b23f29d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateScrubOverlay.js\":\"f53bf1d19bc64128\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayPropertyControl.js\":\"2d426e6284dcc26b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayValueReferenceControl.js\":\"5add652aaef2a745\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/HeaderItem.js\":\"a5c03f861d5ee2eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/ReschedulePicker.js\":\"fd7b4f09356d2279\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/SpreadDatesDialog.js\":\"662204f7746ddb15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/actions.js\":\"382f1ed5a6786f4c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/blockDateAdapter.js\":\"bd2b05e89b53b52e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/calendar.js\":\"b5c961acdc6b99f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dailyNotes.js\":\"4ff98bc5af0aeb54\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dataExtension.js\":\"d0aa074e4360e785\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubActions.js\":\"b4888945cd1494e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGesture.js\":\"52f28fc1f31a3d95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGestureActions.js\":\"17fa0c77cbeedf34\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubRecognizer.js\":\"d71ad66f0c321c4d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayProperty.js\":\"3a073287335d6950\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"2a70430aaa1d3baa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/deletionGuard.js\":\"304b3c03bee782db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dueQuery.js\":\"5192b1ce93da00be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/index.js\":\"6b3fba13735a38fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/landing.js\":\"0a377f852d758f88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/localSchema.js\":\"1d68edc32317016a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/referenceDateAdapter.js\":\"807509bdda936586\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/rescheduleAction.js\":\"afb2680c78432d27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/schema.js\":\"f1bf2a8dac5582f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadBlockDates.js\":\"4c43591e001b6e7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadDatesAction.js\":\"4ced543496beaf0d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/today.js\":\"aea640ef3cd5cc99\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"39ee409e684a00f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d7979a8a6272f7cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/audit.js\":\"f9f4c8536ab310e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditAction.js\":\"ec00ffde48505522\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditRanges.js\":\"2ec5e2d8ec357c6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/diagnosticsSource.js\":\"e8140949a3401eeb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/divergenceScan.js\":\"8c0e30d9fbeb18a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/index.js\":\"eaf22bed4dc29e70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/propertyChildrenChecks.js\":\"3f7d7356ee2003c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/referencesMirror.js\":\"87d4ab11a0511662\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/rowJson.js\":\"371bc29e184c6082\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/schedule.js\":\"d87d1a42cae7e995\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/store.js\":\"088126370eecc71d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/action.js\":\"4f2de49c739ce9a3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/index.js\":\"371468de284b5b40\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/plugin.js\":\"9706a55deca99031\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"d9a287a1124a30cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/actions.js\":\"4b9ec54db791b662\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/changeMarker.js\":\"fbced3a5fba3c5e4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/diagnostics.js\":\"0d8d635d237ab6b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/fileSystemAccess.js\":\"e6a4d881b2bc03cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/filenames.js\":\"be1fb8cdd8004a5e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/index.js\":\"72b8444dceb34594\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/mirror.js\":\"7563703aa0bfe45f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runLock.js\":\"92d75ffb5f4748a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runtimeHealth.js\":\"4b1a2a41406f23e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/schedule.js\":\"73e131b1de3e72cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/store.js\":\"fa89d5964527205a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/index.js\":\"e229b2fdd007cb80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/themes.js\":\"89aa609d03978790\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/facet.js\":\"77d78955fa8ea324\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/useDiagnostics.js\":\"f11bd6f93c4fa10b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/dismissals.js\":\"4d7956f2bc34bfe8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/index.js\":\"f8d1c78c12c47079\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/status.js\":\"98a551d2a727120e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/store.js\":\"179b948ec606fa83\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4b47c222b84506d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsSettings.js\":\"0fac698d4f51aacf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/actions.js\":\"6c138d64661334c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/config.js\":\"56b45511207d8c37\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/dataExtension.js\":\"561635387facab91\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/effect.js\":\"0e4194e85bca110c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/index.js\":\"8bfaeaa067686cac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/propertyEditorOverride.js\":\"54b4a84e3c73295b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/useToggleTree.js\":\"18f8c3b6075cea6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/ExtractTypeDialog.js\":\"d10583d7e56bb182\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"950605e5ea46192a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/PropertyShapePicker.js\":\"21d96c371fea5be8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/action.js\":\"c7d6303645895f63\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/index.js\":\"df01d8d656103ec2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/FindReplaceDialog.js\":\"3ace1fac1ef0a5fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/HeaderItem.js\":\"d2fcc5e0ff80c93a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/dataExtension.js\":\"01678bb1910e0c3d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/index.js\":\"357fc6e58be02d55\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/search.js\":\"2acad2c21a3a4cda\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/toggleStore.js\":\"f51b9acd0c80e1dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/LocationPropertyEditor.js\":\"82d61d217766b246\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/MapView.js\":\"276ad7a7ad1a46d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/blockTypes.js\":\"3fc69629d4ff5b7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/codeMirrorExtensions.js\":\"05c4fcedbc3d0e71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/createOrFindPlace.js\":\"477c8aeed2caf2d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/currentLocation.js\":\"1e598e0195f1262e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/dataExtension.js\":\"6ac00fa31a8f2c02\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/geoContentDecorator.js\":\"08022b36933b8f54\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/googlePlacesClient.js\":\"9c741dd5a25a062e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/index.js\":\"17c56b042472845e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/locationsPage.js\":\"6c4f20f6419ce4be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/mapViewport.js\":\"5a64f188d73d7df0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/pickCurrentLocation.js\":\"055945e0216ee71e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeAutocomplete.js\":\"8f92eee19baa242d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeNameCollision.js\":\"b5a0d9e2c69030bc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/properties.js\":\"1a459ed86eb37a7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/propertyEditorOverrides.js\":\"3cf1acdd27372954\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/query.js\":\"d871d4ffd19ae47f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/usePlaceSearch.js\":\"af5a0893766a7a7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5e122952ee09158e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"4c389241c854b81a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a6c68abe474082a9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/config.js\":\"7079c272bd538631\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/dataExtension.js\":\"35989407db9e802f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/facet.js\":\"c6b896e571bf3a3d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/grouping.js\":\"a113c6edafd5fbed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/index.js\":\"d9b79590d6716303\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7e9f3b40c7b93bbb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/query.js\":\"56254d9aa21f26b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/resolveConfig.js\":\"efb84fb2925be301\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"4e6c89b7f628478b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"408d5ff0b089221b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlDocumentContent.js\":\"c71d1d80e967f32e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlFrame.js\":\"6588cc75a7eeeeb0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/actions.js\":\"562b5366f9bd158a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/blockType.js\":\"b4f6a487edfbdaf3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/confirmRunScripts.js\":\"4af5cc123a2400e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/dataExtension.js\":\"06c9183f604a7684\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameAnnotations.js\":\"6b88867d67ec3281\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameDocument.js\":\"b51cd2300e29bc2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameTheme.js\":\"d69f8f0d500040dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/index.js\":\"fd332b7e0a83657b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/scriptConsent.js\":\"ae50523d14b33e09\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/sourceMap.js\":\"5acc3a022c66251a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/useDocumentScripts.js\":\"ba00aac9232249c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/index.js\":\"0f1899a178bcafca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/record.js\":\"e3c35d8d526df3d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/recordStore.js\":\"e6eadc92d14ea2b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/responsiveness.js\":\"0d9efef427e13f6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/schedule.js\":\"cd3f9687b3b98dd4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/sessionContext.js\":\"ce957a53d138e39a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4fa4eb1d673928e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"a4f00816ce2e01d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/actions.js\":\"9a6e71e14b9b7b12\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/config.js\":\"7eca5df636de6947\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/dataExtension.js\":\"20fa6382f9bdeba9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/effect.js\":\"5419929473c650ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/index.js\":\"a5541a4625673177\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/keyCapture.js\":\"6e1d5c0b2428aa12\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/overrideStore.js\":\"49bf014ad1add09b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"472c914957acd56c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/HeaderItem.js\":\"4222946ab5d97e1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/LeftSidebar.js\":\"3884dd7e454aff6e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/actions.js\":\"18a534e7f085b719\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/facet.js\":\"a426706ce9b323e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/index.js\":\"fc9d258954be61cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/shortcuts.js\":\"089b9a2c899b02ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/toggleStore.js\":\"c3ee2f9e76642d31\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/MergePicker.js\":\"cd345372900a9c63\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/index.js\":\"ad25b762079345df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/mergeAction.js\":\"09b921f969dca73d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/strategy.js\":\"defd26de5f23b86a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/Button.js\":\"1f27a1527481de55\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"80fbbf1c5eaf6759\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/defaultItems.js\":\"3cf874d471e997c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/facet.js\":\"6f4125fc711c9424\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/index.js\":\"7be26093aefc5af3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"0dd77b03c9675c00\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/actions.js\":\"f32bef5f5b0221f5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"bea75675612efe90\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/facet.js\":\"239ccd20dcd4bdf0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/index.js\":\"a40f06832fec7a36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/MoveDestinationPicker.js\":\"2ac0f4faaf9fe19a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/blockSubtreeMembership.js\":\"0a4154752df3b370\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/contextMenuItem.js\":\"3fb28faec3de97b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/index.js\":\"3aa4c3963c4d81b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveAction.js\":\"ae512070619b6ae6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveBlocks.js\":\"d0179606ed841e48\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/selectionAfterMove.js\":\"cc31c092e755e726\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/TutorialBanner.js\":\"fe7e7dec082604b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/action.js\":\"cee75120230786bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/bannerDismissal.js\":\"1ce693fae557bbb7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/documents/cheatSheet.js\":\"0e474c9f149a574d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/index.js\":\"b5c2a4e3ecc90e73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/keys.js\":\"7fe82440f07d742a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/landing.js\":\"2f8f479087a70d81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/outline.js\":\"36a10641d6a63b0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/seed.js\":\"e261d9a8bd7e9ab1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/PerfTrendDialog.js\":\"058cbe1e4da9a9f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/analyze.js\":\"0b632a9d8e4451b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/diagnosticsSource.js\":\"da3c6bf7942489ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/index.js\":\"cd6087f43949651a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/load.js\":\"53d13245add20e4f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/monitorRun.js\":\"701dfafdaa0ff45b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/schedule.js\":\"239444718e5de431\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/series.js\":\"814154676b75b73a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/store.js\":\"4d7ba250da7a6abd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/trendAction.js\":\"f22e6269b14a0796\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/verdict.js\":\"9e25d176e59189f6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/clickToEditAction.js\":\"54371cb02705065c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/index.js\":\"f897b8b87f2f4e27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/interactions.js\":\"d1f58420c30db2c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3b57c24e635d93bb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGate.js\":\"b6edb9e52bb6d9fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGateDialog.js\":\"a632c89c57d28484\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/action.js\":\"6c500d14338cb907\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/index.js\":\"6ebf09ddd4b69d9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/localRunMessage.js\":\"507ec7b9dedd083b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/plugin.js\":\"674d758fece9f99b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/progressReport.js\":\"308d96334d664b2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/sweepProgress.js\":\"44b8a85eb5e8ed19\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/FieldRowRenderer.js\":\"09b723e29ba89c07\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/ValueRowRenderer.js\":\"251f13b5c209761f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/actions.js\":\"c8e00e756f2c07cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/autocomplete.js\":\"379167befa6fd24a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/fieldRow.js\":\"4dc18f6462a9163b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/index.js\":\"73d3be37d84fec27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/referenceWarning.js\":\"8fffdc9b34ce735c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueAutocomplete.js\":\"1231d24362c2267c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueSchema.js\":\"dbf4d5dd9aa03610\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/HeaderItem.js\":\"9dd94db2d832b3f5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/QuickFind.js\":\"f1967255db36e33c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/index.js\":\"33ae6a5a5104a34c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/recents.js\":\"d1c818d8c06ddd80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/resultItems.js\":\"030eaf517c4d0e0b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/selection.js\":\"7c560107d3c5cf5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/toggleStore.js\":\"87f80a5e699780da\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/HeaderItem.js\":\"92560e8c68f21d51\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/RecentsPageBlockRenderer.js\":\"206faa38cfb08aa4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/grouping.js\":\"394e93db2766506e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/index.js\":\"ee3061ed8ecf1420\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/target.js\":\"ff517290c3bf0eb9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/codeMirrorExtensions.js\":\"ce855ce89703863a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/contentPrefill.js\":\"a18d7c9f11036155\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/dataExtension.js\":\"abdfc4e2307ce123\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/index.js\":\"89cc5182eb6453ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"5bab63dad65969af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/invalidation.js\":\"799012a6bfa3abcc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/localSchema.js\":\"dc0238fd36d41ecc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/index.js\":\"ea3a94cc23192fd6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1d8bc5c1dc8ae4a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/index.js\":\"ca572818fc2573b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/referenceNode.js\":\"cbdddfe13b61107b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a7147c1413f6163d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"68ac52988100fa9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/index.js\":\"5a3ad67dd724fbfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"5cd83d68fe04f6a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3b93d5e23f75162d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/mergeRetargetProcessor.js\":\"55cf37cadbc5f6c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/parseFence.js\":\"b7440019e9aea3f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceParser.js\":\"a18345b7522de4a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceProjection.js\":\"19f2f037f27c4e5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referencesProcessor.js\":\"5d18d0de48cabbc2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/renameProcessor.js\":\"93e37bbc51cefce1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/spanReplacement.js\":\"fcdbcac47df4df26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/htmlToOutline.js\":\"1e0b1ba684b67e58\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/index.js\":\"c2dcd6018e6d6518\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f39e19fe245f65c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/pasteDecision.js\":\"dfcd3fa2297e7506\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/action.js\":\"c233947393957677\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/blockIds.js\":\"a7146aedf659e0e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/content.js\":\"1fe2aee593dd1170\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/effect.js\":\"d0f3c0b49aede41a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/ids.js\":\"e6336d070e8e60a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/import.js\":\"5f4c52f6d9666aac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/index.js\":\"2a92f126b4d255dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plan.js\":\"1fca11eaf8543b29\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plugin.js\":\"a36364347e4e0e9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/promotion.js\":\"ebb479db71741397\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/properties.js\":\"bbc9caebb1182d88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/references.js\":\"f9b63714a6a66066\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/report.js\":\"b22c108d8a885672\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/roamMemo.js\":\"bded92e550a0ad70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/runtime.js\":\"464c23ca87d9665c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/schemaReconciliation.js\":\"5aafd4c112b38f1e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/srsMarkers.js\":\"2a2edcf2f69b3611\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/todo.js\":\"c0a5a9b3dfae454c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/typeCandidates.js\":\"11705af788ad3a28\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/types.js\":\"4c08334fcaf76701\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/index.js\":\"36893b2e07824667\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/store.js\":\"ed47a237b7eb0d4c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/HeaderItem.js\":\"fda683cc5f5a3925\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"05d109316901e62a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/index.js\":\"972690997aebdaeb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/model.js\":\"874a80e1b18427c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/toggleStore.js\":\"1dc3624a3a42f86a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/useKeyInspector.js\":\"e85976cf6dfb3659\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"13508e23d63e608c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/ShellDecorator.js\":\"3bd54e7736168601\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/actions.js\":\"dab88145c4cd02b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/exclusionsFacet.js\":\"8712822a72a4cc56\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/index.js\":\"f0f9fa4a397d0934\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/shell.js\":\"93de6d32f0e65637\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/surface.js\":\"03ce5c7e1ca46bdf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/walker.js\":\"870bb9548cf20d42\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/RescheduleToast.js\":\"5c1537b21bf90dab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/dataExtension.js\":\"6c59aedd2f5a0def\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/index.js\":\"cc12f07a43bafd82\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/indicator.js\":\"6cbd8c1414b3514e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/moveSrsState.js\":\"215e71ea27040b3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"8839731e9573e863\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/scheduler.js\":\"9877431431076ae8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/schema.js\":\"e1aebbb8fb8ffd5a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"ccb18aac87146f5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsClipboard.js\":\"3f60ca8090ac047a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"16f51b515afbcbbf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3d77aad52221ddb3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DeckPicker.js\":\"dd0dfbe96a87faa7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewControls.js\":\"63d5560c98164187\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewDeckRenderer.js\":\"ce9a062acac5c306\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewSession.js\":\"39296ab7638bf3c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/actions.js\":\"705203f3b79d874c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/archive.js\":\"bf1e49c269f2c407\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dataExtension.js\":\"184ed38daae61455\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/deck.js\":\"b805d68a68c8f4e8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dueQuery.js\":\"372853df334794df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/gradeDecision.js\":\"5985c80f8bafb907\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/index.js\":\"ff9bedc86e05ebbd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/keyHints.js\":\"11e960df8330fac0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewCardLayout.js\":\"6c756457b0b0e932\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewProgress.js\":\"351d6db88a77b2e8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/schema.js\":\"d44010757fd43785\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/useDueCards.js\":\"ded3e2264344dbe2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/index.js\":\"a88017b97226aca1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/record.js\":\"22ff8635f24f7d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/index.js\":\"e33204e23d58a2f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/persistenceStatus.js\":\"029dae91e9e691c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/requestAction.js\":\"4342185100f0f12c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/TypeChipsDecorator.js\":\"627efa7bb9579021\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/codeMirrorExtensions.js\":\"0a9f082da4b71612\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/index.js\":\"bb5c405b092788c6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/typeAutocomplete.js\":\"8d4d76ca142ab15d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"258eec051765e0b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/actions.js\":\"aa737bf655bc3686\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/anchor.js\":\"defb64a2043f6e18\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/events.js\":\"af3ab2a76f59fd0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/gestureActions.js\":\"515ee276a2a0bcc5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/index.js\":\"3849d36c40022217\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"4b3a304bb63d4c1c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/collect.js\":\"0e780343099c778f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/index.js\":\"7b58fd83bdf483eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/record.js\":\"09e44b7b42b1aff4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/RejectionDialog.js\":\"a94dc40b6ce5c827\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/SystemStatusHeaderItem.js\":\"7a90f770f079a50e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/index.js\":\"c73c4d1e5b89f6fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/model.js\":\"7b5e07dd9c4c7209\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/queueCounts.js\":\"adaf39ceeea3d55a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rejectedHelpers.js\":\"f4593f9820c4df95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rematerializeAction.js\":\"913e426d083e01ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/useHysteresis.js\":\"d2cd8fc1848adc0d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/ColumnHeaders.js\":\"d90e825a681515e4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/QueryUi.js\":\"60c731c21d57bcc9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/TableLayout.js\":\"adc53f6929811f88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/actions.js\":\"d85197ab42e7614c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/cellEdits.js\":\"ac9dcf628e972bf5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/childrenViews.js\":\"3a161289f09d9132\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/columns.js\":\"08a981003ebe22b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/controller.js\":\"756fd09f9e7f5881\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/convert.js\":\"83cd569e8c6a89a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/dataExtension.js\":\"c834c0c7bdbb60d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/index.js\":\"a63283da3d761f4f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/keys.js\":\"e8b36fbb9c08428b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/model.js\":\"67eed0412fef5bac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/QueryText.js\":\"73cb1c60fb2618aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/backfill.js\":\"4a396ad678c8cfab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/completion.js\":\"5e0945c9e57403eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/format.js\":\"26b101593c6f6acd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/parse.js\":\"6cef8e14f4b38f49\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/queryValue.js\":\"8b451c1c6d41219d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/registrations.js\":\"521137d0a9af4c59\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/source.js\":\"6df20f41bace67cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/registry.js\":\"4084ac9cfbae994c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowGutter.js\":\"d78b6fc7527d12f5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowVerbs.js\":\"17cf58cf233f2526\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/schema.js\":\"402e419ffc4ee158\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/sort.js\":\"3cc2442a117bede8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/effect.js\":\"69197fe3977c9166\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/index.js\":\"00395404ae3c80c6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/theme.js\":\"e31e1dba78ec7bc0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/actions.js\":\"dd9d89da0be31577\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/dataExtension.js\":\"e304bc0654cd6fac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/index.js\":\"2c68cb805e436901\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/schema.js\":\"b011424e88aaa55e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/TouchSelectionLayer.js\":\"9564ac65734d637c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/actions.js\":\"a85d4d96856954d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/defaultItems.js\":\"9a2af62f92a911aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/facet.js\":\"8ae009b099a7a173\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/holdRecognizer.js\":\"a09b7f026cf78fa4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/index.js\":\"22d727a25cbcdf48\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/UpdateIndicator.js\":\"89ac9e23bdc07bb2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/index.js\":\"77deb56e217c96e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/loadTimes.js\":\"3548191cce7531aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoNotesRenderer.js\":\"0db86f765ced9183\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoPlayerRenderer.js\":\"672308382f32ce23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoTimeStamp.js\":\"a301e43b707bdfc0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/actions.js\":\"652a89fba1d6f93e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/index.js\":\"017f574f4b8d0fa9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/markdown.js\":\"a1320a862fc6f767\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/notes.js\":\"456eb4ab4c0674e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/registry.js\":\"70c2db10ce77f6ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/remark-timestamps.js\":\"3bfb7438d7270068\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/view.js\":\"68b1c84df3bdcf1e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/LinkHints.js\":\"a701aa74d66ac7f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/index.js\":\"ad031406d522b0e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/model.js\":\"76f869689cdb715c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/settings.js\":\"5d5d0de1c8984dd7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/actions.js\":\"8605b03960d0d146\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/index.js\":\"ee45e3a6ab5afc7f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/interactions.js\":\"d08b2d863ea53158\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/workspace-header/index.js\":\"8096fa796295762d\",\"/knowledge-medium/pr-preview/pr-1919/src/registerServiceWorker.js\":\"b7d3829c29b79939\",\"/knowledge-medium/pr-preview/pr-1919/src/requestPersistentStorage.js\":\"eaf3d470be1b7327\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authRequestDeadline.js\":\"2ba04842fbbe5ca0\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authStorage.js\":\"88fa5cdc79be2afe\",\"/knowledge-medium/pr-preview/pr-1919/src/services/powersync.js\":\"864d34b129ccb57b\",\"/knowledge-medium/pr-preview/pr-1919/src/services/supabase.js\":\"15bb5148f0a136ad\",\"/knowledge-medium/pr-preview/pr-1919/src/services/uploadErrorClassifier.js\":\"fa229831b8d15f1d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/ActiveContexts.js\":\"225c3ae7f6b189fc\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/HotkeyReconciler.js\":\"a597fada89e4fdc4\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/WipeLocalDataDialog.js\":\"35d378889b1fd96d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionDispatch.js\":\"171e314f722ccc5d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionRefItems.js\":\"52d2b40f7ac51e91\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/applyKeybindingOverrides.js\":\"32b21f13f68f7c56\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockActions.js\":\"241d4bb47050b18d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockMergeGesture.js\":\"a46380340ea67e4f\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/canonicalizeChord.js\":\"c3b589b1b2abad7a\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultContexts.js\":\"3fafb4d5b74981f0\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultShortcuts.js\":\"d0910d5a37b98ed8\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/effectiveActions.js\":\"00268b7d85767c49\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureAction.js\":\"d48b5be51b3419a6\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureBinding.js\":\"dff4d855d1c7c5b5\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/holdRegistry.js\":\"5c0c5dfdd4839432\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingConflicts.js\":\"16e8beaec4eca0d0\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingOverrides.js\":\"07aaf78e37d0c7c0\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/pointerAction.js\":\"3c573623617d0bcd\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/resolve.js\":\"87c17c7ce7c91dcb\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/runAction.js\":\"46c8015878cd5c1e\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/sequenceMatcher.js\":\"0929e1f9c2ecf1aa\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/types.js\":\"b62ed8abfddfe812\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionContext.js\":\"bf2a13ccfc531afa\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionDiscovery.js\":\"e5ac155db21a8a32\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/utils.js\":\"ebf076a5e2b1553f\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/bootStore.js\":\"4dece235b38a88e7\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/previewDatabases.js\":\"3a6b71f956bc3254\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/byteTransform.js\":\"80f1706a7a160e5d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/attachmentCleaner.js\":\"49d4db40e496e1f8\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/attachmentParts.js\":\"b8cb6d3bc314a7bb\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleParts.js\":\"2f3f5554093685ad\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleRecord.js\":\"dd79c46ff5ba1970\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/manifest.js\":\"f733998f8385cfcf\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/takeBundle.js\":\"7c67ce246945da9d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/verifyBundle.js\":\"c2499fc7fc53a236\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/cleaningStage.js\":\"a6bf8e5d777e4b90\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionKey.js\":\"e616b3c78bce7c96\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionServer.js\":\"6d8e26517f1f6179\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flip.js\":\"502c9a15e773404d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flipAttempts.js\":\"bad0b3f66d3ab2a9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/pages.js\":\"7f0b54394437c51d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/preflight.js\":\"62540cbe3ad5a4e7\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/reseal.js\":\"7a89a38355b47848\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runConversion.js\":\"bb3fcc7d16edf524\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runLock.js\":\"8ddad0db1d483f0a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealing.js\":\"1fdbe2bba9c44b3a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealingStage.js\":\"b232e855d520645a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/stage.js\":\"029920a963cd199c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/verifyReseal.js\":\"346f221a0bd8ae22\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aad.js\":\"cf1b39db76e53a89\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aead.js\":\"cb9b44ad8602199b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base32.js\":\"106b34e6e1189a92\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base64url.js\":\"94fb8246d9f850a4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/binaryEnvelope.js\":\"55b9328566701d16\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/byteAead.js\":\"741a7a637e0f7437\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/canary.js\":\"2ebfa0249d5888bf\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentHash.js\":\"6338acbc3a809d2e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentKey.js\":\"6c17aad60a28a984\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/derivedIdNamespace.js\":\"7ae12799e90df399\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/envelope.js\":\"90ade9d51a6477f1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/hex.js\":\"fa8669a0bdcd077e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/sha256Hex.js\":\"46b5aa82185b623c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/workspaceKey.js\":\"da6093542bd8f7b4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/conversionState.js\":\"63b443e9adca5f18\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/createEncryptedWorkspace.js\":\"ab994c1426d6a533\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/pastedKey.js\":\"d26dd67141e72648\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"dbb55a19d5a4b2a3\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/upgradeWorkspacePin.js\":\"15f91fb74fb66d22\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/keyStore.js\":\"c26064b72c394c1b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/mintWorkspaceKey.js\":\"aef1379928d2c05c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/modePin.js\":\"d55762a17f791395\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/openWorkspaceKeys.js\":\"4f5be86ebb2ccd5d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolveWorkspaceEntry.js\":\"98c0121d82d5fb52\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolver.js\":\"8c4ae0cac766e767\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/workspaceAccess.js\":\"006dc5312ac58ed1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/transform.js\":\"9dfea059a1b6d561\",\"/knowledge-medium/pr-preview/pr-1919/src/themeBootDefaults.js\":\"7395bae1748268a8\",\"/knowledge-medium/pr-preview/pr-1919/src/types.js\":\"6503b7ef675218a5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/ClientLocalSettings.js\":\"24ab79b6595153fd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/abortableSleep.js\":\"939745d037a548ef\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/array.js\":\"e06db8dd280bc022\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/backlinkAutocomplete.js\":\"dc6235239176e518\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockCrumbs.js\":\"654ee4fb4b28b305\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockrefAutocomplete.js\":\"196b24baa18ee50b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/cadencedIdleJob.js\":\"3a3c34db7ece40b3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/callbackSet.js\":\"8c1ef23575289d9c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/clientId.js\":\"b6f04cf4a7c6fee3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirror.js\":\"2f32adb142baabf4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirrorCompletion.js\":\"b7a8a25cfd165851\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/copy.js\":\"025488c83c1f6a87\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dailyPage.js\":\"35830600db5fb215\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensics.js\":\"e4242030677494ee\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensicsHooks.js\":\"77ee56655d230056\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/deleteBlockThroughUi.js\":\"a03e5b787310d3fd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dialogs.js\":\"e581dca6658392fe\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dom.js\":\"543b5f7eaf1404e8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/downloadBlob.js\":\"5704f4ace0cba62c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/drawnWalk.js\":\"0c49d57623fb47d8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/exportSqliteDb.js\":\"bd7c0605ee11920a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fileSystemAccess.js\":\"802e9cd9a32ba193\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/flipSlide.js\":\"ee388bbdef512a13\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fnv1a.js\":\"f49fddd297823702\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/formatBytes.js\":\"80b3d6ee50da530b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fuzzyRank.js\":\"023b950a1737b265\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idbKeyedStore.js\":\"2fe07a9a79ef8cf0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idleCallbackPolyfill.js\":\"b81301823c1ea770\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardAwareScroll.js\":\"6c9cad90b53647dc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardViewport.js\":\"d838d51e46929ecd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/lastWorkspace.js\":\"661842792736eaf4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutColumns.js\":\"539a040506464f92\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionDom.js\":\"abd2f31524eb7137\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionId.js\":\"2ca41eeb19fa710a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkClickGestures.js\":\"0a1a7f6218caffad\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkTargetAutocomplete.js\":\"0664ea9ca513b316\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbCorruption.js\":\"3ae47444a826f7c9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbRecovery.js\":\"245dd0e302666f76\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/markdownParser.js\":\"79c7d2fc3ebbb03f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/memoize.js\":\"c9da94e53bf1cf17\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameFieldCommit.js\":\"45848d44e85373d9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameList.js\":\"250a40879c15238f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/navigation.js\":\"816953db4ac565bd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/omnilinerNamespace.js\":\"39091c087be766c3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/opfsPageScan.js\":\"347e4ca1d079be48\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelClearance.js\":\"c94dbb8b2753e6a1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelHistory.js\":\"76697b401db76d48\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLanes.js\":\"c9f864b06d397afd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLayoutProjection.js\":\"eac37e5467b74438\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelScrollAnchor.js\":\"80828a40a5f93ebe\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelUrlFlags.js\":\"ad3cc4eda3ad9050\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/platform.js\":\"cf78bb1bca10a277\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/pluralize.js\":\"862c2f1887322fbd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyCreation.js\":\"e37485bef7c8d3a7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyNavigation.js\":\"5acfa546bebadff8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyValueContext.js\":\"3cdd33090bca7514\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/react.js\":\"80ce65c237de9176\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeDate.js\":\"a925c1f554b17275\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeTime.js\":\"6858cb9cfdc39b83\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/renderScope.js\":\"beff9cf9ec66ba22\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/resolvedThenable.js\":\"97347864be2890df\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/routing.js\":\"1a25917cca2459a6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/safeMode.js\":\"d2af5e04bbae11b5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/scheduleIdle.js\":\"48a9f5c80b4bb184\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/screenWakeLock.js\":\"4b453fe2f3a058c2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/selection.js\":\"050100874159b1b5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/softKeyboardGrab.js\":\"9f03c79d4d8cf60c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/startupTimeline.js\":\"cad3e8d91e0b05bc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/state.js\":\"731c97a142c6cf92\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/string.js\":\"82ae4583a43c414b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/surfaceZoom.js\":\"09a9dfb0e05d6cf3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/time.js\":\"b47119425d5132a6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toast.js\":\"acf8e1840b2bdfa8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toggleStore.js\":\"b188bc340500db79\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/untilStopped.js\":\"f3f81b54b8739523\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/userActivity.js\":\"581ea86471d0824b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewTransition.js\":\"d04bcd044ef21ccb\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewport.js\":\"7060172ee9b1ee89\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/webLock.js\":\"b15d579c476878e7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceRecovery.js\":\"25d9f5b582c4909f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceSnapshotStore.js\":\"3fbabf7804d43b36\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-compiler-runtime.js\":\"0d00a0869fc2d7e2\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-client.js\":\"9914e6309e9398d3\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server-edge.js\":\"53e24bb04edf2528\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server.js\":\"56ba5dedf868234d\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static-edge.js\":\"6d722d9141c78a60\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static.js\":\"30f2bd2550374489\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-test-utils.js\":\"7b962ee677ae2021\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom.js\":\"34826d5d5057eb65\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-runtime.js\":\"c108f14132ae60b4\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react.js\":\"fe0aa407cc51c935\",\"/knowledge-medium/pr-preview/pr-1919/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
