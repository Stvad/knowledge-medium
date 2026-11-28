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
		buildId: "3c8b587c15b6-0563674e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/\":\"79033bc45f1f9e5b\",\"/knowledge-medium/pr-preview/pr-1919/index.html\":\"79033bc45f1f9e5b\",\"/knowledge-medium/pr-preview/pr-1919/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1919/assets/FacadeVFS-B6uLEty6.js\":\"7aa41e036a00e54b\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSCoopSyncVFS-BlTQX9s3.js\":\"ffc531704362af47\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSWriteAheadVFS-DsJdPs12.js\":\"3fd95c23c610ef98\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-DlROgey1.js\":\"6939b26e849b016a\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-lncq_ybC.js\":\"f7158d941bcb478b\",\"/knowledge-medium/pr-preview/pr-1919/assets/worker-fGhfelCd.js\":\"9944ebf8edc89357\",\"/knowledge-medium/pr-preview/pr-1919/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1919/chunks/app-BBNYzX6z.js\":\"86a9c1c3bd9f9bff\",\"/knowledge-medium/pr-preview/pr-1919/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1919/index.js\":\"e18eb2cd478b685e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1919/assets/AccessHandlePoolVFS-BoGPYxRf.js\":\"74f37af66f9474f7\",\"/knowledge-medium/pr-preview/pr-1919/assets/IDBBatchAtomicVFS-B8u5ZU6X.js\":\"20b6f1e29b5b097a\",\"/knowledge-medium/pr-preview/pr-1919/assets/MemoryVFS-DNXLA_-D.js\":\"9cc0d305448017b6\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-U-fIfgwd.js\":\"7a17c6f49a224a15\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-C3avf6-K.js\":\"a60cd44b1039984d\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1919/chunks/AccessHandlePoolVFS-DwG9S807.js\":\"c39b9de0567dcb99\",\"/knowledge-medium/pr-preview/pr-1919/chunks/FacadeVFS-D2BcvSRo.js\":\"7ec800c4c677382d\",\"/knowledge-medium/pr-preview/pr-1919/chunks/IDBBatchAtomicVFS-D_g0-H-Q.js\":\"a0f97df791e908fe\",\"/knowledge-medium/pr-preview/pr-1919/chunks/MemoryVFS-D6d-DNkX.js\":\"b479cddf96ec7b5c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSCoopSyncVFS-zyQ6bJvH.js\":\"62c81fe8c0e26a12\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSWriteAheadVFS-uDQqzHWO.js\":\"4ae8980abcb2154d\",\"/knowledge-medium/pr-preview/pr-1919/chunks/Preview-C3lfnR3S.js\":\"359873e132833189\",\"/knowledge-medium/pr-preview/pr-1919/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/card-I7lbYykS.js\":\"c9b294c1811728c3\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-De0e6oFz.js\":\"ea345c5373747fef\",\"/knowledge-medium/pr-preview/pr-1919/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-BKvlS76w.js\":\"a6f1a6c1d089a1c7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-async-B6EbCSq7.js\":\"663bca6c76ee6da8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-BDKTXpFx.js\":\"63130a95728c2e0a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-BXDtvcTc.js\":\"a35676717a550967\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DX6OAwmK.js\":\"bcee4ec7409d8518\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Dqh4Cg51.js\":\"d1a23705108cc63b\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-G17ORUM5.js\":\"b82d0b969467d823\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-R9CeEI4v.js\":\"d3ec5d6664b54fbd\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-ZxSp4z05.js\":\"1a1f1926d86f1f25\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server-legacy.browser.production-Vtrq3MWW.js\":\"1879f52d47ef3cf6\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.browser.production-BaSyl7DE.js\":\"d2984d295462992a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.edge.production-CtvoVhNa.js\":\"e90b98be4d7a77b7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-eAcrJRF0.js\":\"72683bd720d6474f\",\"/knowledge-medium/pr-preview/pr-1919/chunks/server.browser-sgAIg4sO.js\":\"bfe6926f7b14e103\",\"/knowledge-medium/pr-preview/pr-1919/chunks/textarea-DlIkQxEL.js\":\"0c0abaadad8bb907\",\"/knowledge-medium/pr-preview/pr-1919/chunks/ui-BTtMUH6Q.js\":\"c6247d477942d228\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-DiMwuaFR.js\":\"dc46ccc9a5bb52b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-async-DAMXKp9v.js\":\"fe5b0a07c6c5a12a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1919/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/src/App.js\":\"7536330435f3d0ed\",\"/knowledge-medium/pr-preview/pr-1919/src/appUpdate.js\":\"735a9d5b2435aade\",\"/knowledge-medium/pr-preview/pr-1919/src/appVersion.js\":\"9df3d1e6f143eaef\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/initialLayout.js\":\"7a39e9100ecb79c2\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/openWorkspaceData.js\":\"cc1da702b2071af6\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/resolveWorkspace.js\":\"fda12bcfa14d34ae\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/workspaceBootstrap.js\":\"df6809222f069725\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockComponent.js\":\"2f4bd0c6e30a25f6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockCrumbs.js\":\"28f759c8db28299b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockEditor.js\":\"64f0263d9214cf2d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockLoadingPlaceholder.js\":\"c4d7010e1ce2fb23\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockProperties.js\":\"82ef5866e9886cfe\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockSearchPicker.js\":\"4bc1e6ac65676a72\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ConfirmBulkDeleteDialog.js\":\"1422e1506d728de4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DividerHandle.js\":\"b084dcb598b1fc8d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DraftEditor.js\":\"177a3eb22f0b7b83\",\"/knowledge-medium/pr-preview/pr-1919/src/components/GutterPill.js\":\"2ffd2cfa783f57fb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Header.js\":\"ab63810db11b4c60\",\"/knowledge-medium/pr-preview/pr-1919/src/components/LazyBlockComponent.js\":\"086453a8e976c0ad\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Login.js\":\"2159d178f185d21a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ZoomableSurface.js\":\"6a9c721a7a385923\",\"/knowledge-medium/pr-preview/pr-1919/src/components/editModeKeepalive.js\":\"d570b8e5b64d6715\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c4a5adebe7cb4c54\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"71ac4cc3b3f8fc7d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefPropertyEditor.js\":\"9550960af67f6896\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefTargetTypePicker.js\":\"024d4a507b6c5e8d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/SelectPropertyEditor.js\":\"883b922da23b5ddb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/TypesPropertyEditor.js\":\"fee99026fb842b44\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/defaults.js\":\"04bd579b3a908226\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/kernelValuePresets.js\":\"6b66fcefc9454991\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/selectablePresets.js\":\"02e2b01e67b27ee0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/typesPropertyUi.js\":\"c09c20dbf996a907\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/AddPropertyForm.js\":\"b07d27359caa74b5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyPicker.js\":\"3db1ff41808728de\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyRow.js\":\"1b46ecda8c52651a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/Rows.js\":\"98d54097ee4bb950\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/actions.js\":\"8f059719d4272c94\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/declarationOnly.js\":\"67eeebe8939017d3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/layout.js\":\"edb4cb9cd19afad2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/model.js\":\"1985d2b43e93e5e7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapeUi.js\":\"93f3a36ee26da7e1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapes.js\":\"e3a68b3f144f9c9a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/usePropertyEditingActivation.js\":\"e2a3e1d015ab2bea\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/visibility.js\":\"eb6df0ad5d646288\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanelSections.js\":\"9a6698ec27ea06c7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockEmbed.js\":\"3eabf2e34fae5951\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockLink.js\":\"2c425bdd31cfd73a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockRef.js\":\"81290904933df093\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/CompactReferenceLink.js\":\"ea9b80b6100e81b8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/ReferenceLink.js\":\"51ee8d5da4d9834b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuard.js\":\"39a6fc5ba6df6cf2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuardContext.js\":\"a763d293b0547efa\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/linkInteraction.js\":\"d90b54da25c733b2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/referenceLayout.js\":\"5f489646fff0be99\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/useBlockRefAncestors.js\":\"4581728d6d059dff\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockGutter.js\":\"d04757288786b515\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockInfoDialog.js\":\"9f85aeb0c94146e9\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockReadText.js\":\"0a7477489d4fa432\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockTypeBlockRenderer.js\":\"9fd3872092611f6b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BulletHoverCard.js\":\"668b0b4cd3004181\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorContentRenderer.js\":\"2350c2b7b6642591\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0d7f41985f39d42f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ColumnResizeHandles.js\":\"bc42677c6fffa6ba\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"51ffb2c4eedf04b0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/DefaultBlockRenderer.js\":\"62ecc2cd497361fb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/LayoutRenderer.js\":\"655d9a85b715a103\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MarkdownContentRenderer.js\":\"5e8557ab9f2bb27b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MissingDataRenderer.js\":\"9d6042feec9a3edb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PanelRenderer.js\":\"0a622264d0cd6706\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PropertySchemaBlockRenderer.js\":\"efd44368d42113e1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/TopLevelRenderer.js\":\"03168b1c0d5830b2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockGutterMode.js\":\"9c1120e4cad863d0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockTitleText.js\":\"9cb4312f2eda07f0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/fieldCreationKeydown.js\":\"479e44a27dd291aa\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/layoutRootContext.js\":\"a8e82810df0329e5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/TypeChip.js\":\"38204811f42eaf20\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/chipStyle.js\":\"17d22ada21ef240b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/anchored-floating.js\":\"e4e7729eb33a196c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/button.js\":\"ce8f2ae227d01831\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/card.js\":\"f97520a773d2d725\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/checkbox.js\":\"406869b3f6f68a6e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/collapsible.js\":\"000fd743eac2aee2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/command.js\":\"3ba4e8e8fa043e16\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/context-menu.js\":\"3d489b964ad78248\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dialog.js\":\"3c5c8d8a2e9caf0d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dropdown-menu.js\":\"d0980e6d6ac791d7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/floating-listbox.js\":\"ffa314f3c9361021\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/index.js\":\"8d726a74051a4dd5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/input.js\":\"7cfc04f2c0bb50f7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/kbd.js\":\"17b4f97745e66789\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/label.js\":\"9e474398c2e4484d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/textarea.js\":\"5f98d3e72e27fac5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/useEditModeYieldKeepalive.js\":\"d9f4daeac0fd40aa\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/BootFallback.js\":\"a46ceaadbbde74d7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/FocusedRowLazyMount.js\":\"93eefa99d9c2be13\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LazyViewportMount.js\":\"47f4f64fae9b8f1b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LocalDbCorruptionFallback.js\":\"42f9ae8bb0bf0715\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/error.js\":\"219c2e875d8e4335\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/lazyMountRegistry.js\":\"e75a0d9e3f02ed2b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/suspense.js\":\"952f235d4527de11\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/CreateWorkspaceDialog.js\":\"63f73d3f47a042db\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/PendingInvitations.js\":\"0273245e30c8b995\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/SyncProgress.js\":\"580124c3ac07de4c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/UnlockProgress.js\":\"db4cf461a9b90b93\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceKeyGate.js\":\"a78ea05775ae98bd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSettingsDialog.js\":\"04d2778c4a2797f4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSwitcher.js\":\"0dded9d9e9f5529e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSyncGate.js\":\"6697b6f9d9758039\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlow.js\":\"5699f316efefa56a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlowHost.js\":\"9eec284ff9159d11\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/EncryptionSection.js\":\"b6a1a59c7f5e09de\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/attachmentPrompts.js\":\"a7f78ad1e6197c2d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/bundleFolderPrompts.js\":\"96db1288bf797d09\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowDeps.js\":\"bf0ab805781c5cca\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowStore.js\":\"a8610044a534a1e3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/flowUi.js\":\"b190f08751bb6654\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/useConversionRun.js\":\"693ef911c44b433d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/keyUi.js\":\"eb5c57b4f30586a4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnKeyLoss.js\":\"385e80b2d87b02f6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnServerE2ee.js\":\"209b6b04980c95ab\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/workspaceUnlocked.js\":\"9bdceebe94aac22f\",\"/knowledge-medium/pr-preview/pr-1919/src/context/backgroundSubtree.js\":\"ab466156608195fe\",\"/knowledge-medium/pr-preview/pr-1919/src/context/block.js\":\"ffd195e7d75550a3\",\"/knowledge-medium/pr-preview/pr-1919/src/context/layoutWsContext.js\":\"200a0ab9611f31b0\",\"/knowledge-medium/pr-preview/pr-1919/src/context/propertyDisplay.js\":\"883f60200a526e9f\",\"/knowledge-medium/pr-preview/pr-1919/src/context/repo.js\":\"804dbe2bddafbaeb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasClaim.js\":\"a9d9fd1ad88f59f9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasSeatNamespace.js\":\"b2372149fb8f633b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockData.js\":\"7431c26b0fee5a99\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockType.js\":\"b351e0da5967c769\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/changeScope.js\":\"00b6e5428bf8ff5a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/codecs.js\":\"363af52bc9296142\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/derivedData.js\":\"5cc341e617dc0620\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/errors.js\":\"e94ff0ba442ac7f8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/events.js\":\"660116f7daea7233\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/handle.js\":\"f574cbae48eeb4c2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/index.js\":\"18a25182d7c51f28\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/mutator.js\":\"9798ff54bc4069a5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/processor.js\":\"e278b26a8b5632f8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/propertySchema.js\":\"fde2c3499e09f5a3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/query.js\":\"d5879c0f7cf5bc90\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/sameTxProcessor.js\":\"5912242ebb728522\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/schema.js\":\"f574cbae48eeb4c2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/tx.js\":\"f574cbae48eeb4c2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/typedBlockQuery.js\":\"bec3e1fb37c73fc7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/user.js\":\"e0a0811c17056a13\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresetCore.js\":\"a052f6abeac7abdc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresets.js\":\"6d541f8bd69aedbf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/attachmentCleanerIOVerb.js\":\"07cd7018cb0368fd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/block.js\":\"625ffe2a8cdbcea6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockCache.js\":\"d5e0f75615223060\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockId.js\":\"e38acc9da2e79a65\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockLiveness.js\":\"5f22ca1175ddfa51\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockMerge.js\":\"c7e3529078cf1439\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockSchema.js\":\"8db8a5a96c48e396\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypeLookup.js\":\"5063bf251e4bc776\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypes.js\":\"f57c2cea2cb2d071\",\"/knowledge-medium/pr-preview/pr-1919/src/data/childrenView.js\":\"a9b5129dc2b65c8d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/clientContext.js\":\"a77859f4d69404b1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/dbFileSiblings.js\":\"e87aad8e02495b2b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/definitionSeeds.js\":\"b5afd8a340444ced\",\"/knowledge-medium/pr-preview/pr-1919/src/data/derivedIds.js\":\"aaeb635ab98f6a02\",\"/knowledge-medium/pr-preview/pr-1919/src/data/drawnSubtree.js\":\"0de68863e48f3b4d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facetBridge.js\":\"7ec6d50cdb1ab7b4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facets.js\":\"48dd1157ce26afa5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/globalState.js\":\"4d8f116f141eb874\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/aliasClaimRederiveProcessor.js\":\"944c2dbc93f5ac22\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/ancestorBatch.js\":\"366c2cb4a8815c48\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/blockTypeTypeifyProcessor.js\":\"7a374a317676e07d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/clientSchema.js\":\"7a2cd1e440d66922\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/commitPipeline.js\":\"96bce2b2a1a55693\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/devAssertions.js\":\"6742fb16c9f2eda0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/firstSync.js\":\"59b775cf94d4ad1b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/freshInitialLoad.js\":\"c48a80978f6c38d0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/graphBackfillClaim.js\":\"714af765f86afe2c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/handleStore.js\":\"b3baa32574da6092\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/idleMarkerJobs.js\":\"ff96bc9b24208598\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initialDownload.js\":\"dc458472837acef2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initializeClientDatabase.js\":\"c895d3f284be7135\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/jsonCanonical.js\":\"037d54153fbb3b5b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelInvalidation.js\":\"7910666305b9a3c2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelProcessors.js\":\"3e27730f08c5c38b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelQueries.js\":\"ad0c01f2efcad442\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/mergeTypeMembershipProcessor.js\":\"1648db93531a5cb2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/normalizeReferencesProcessor.js\":\"c6b2004eb3055ae8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/poolInstrumentation.js\":\"a285ba10c44f3ac9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/processorRunner.js\":\"91c51cccde6075a4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyCellBackfill.js\":\"226688c023d9c486\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildMint.js\":\"63db1bb6ae0e4b2d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildrenProcessor.js\":\"092704912251ffc5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2594df064653c398\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionSynthesis.js\":\"eeb4b23a6a295a17\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyKeyScan.js\":\"9fa6f00b016dce65\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertySchemaResolution.js\":\"bc1aabb2792905fe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyValueEdits.js\":\"c516e20eca05625e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/raiseProtocol.js\":\"ba2da4a3858be999\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/readBatch.js\":\"758958c8eb0164c9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/refProjection.js\":\"082d226bfdaaa2a7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetLookups.js\":\"72392bf025d7b879\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetProcessor.js\":\"cd4f0ef16952be9b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/replayMerge.js\":\"da01ccf70258502c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/sqlBinds.js\":\"e6f832cf4e4c3196\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"ff33db85abd2215b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/arrivalProcessors.js\":\"8d3b4841cc4360b8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/invalidate.js\":\"e9257e70ee71c479\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/materialize.js\":\"c7975225510c0832\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/observer.js\":\"bdf5f4f108363316\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/reconcile.js\":\"ac8b0ef668d5622c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/timingMetrics.js\":\"0d67d5d00dcda3f0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/treeQueries.js\":\"8d4c0a9b4cb85177\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txEngine.js\":\"8b73dbca377cd079\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txSnapshots.js\":\"b04caf71af8a4632\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/typedBlockQuery.js\":\"9c8e3b34a72f1237\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/undoManager.js\":\"cd49dd0403133538\",\"/knowledge-medium/pr-preview/pr-1919/src/data/invalidation.js\":\"9362d33da84c8af2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelDataExtension.js\":\"9f716b68ac3b6dcb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelPage.js\":\"6947c1c1e983a40d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelValuePresetCores.js\":\"1a30cc91b32b7672\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbCorruptionSignal.js\":\"3a179caf740a3c31\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbStorage.js\":\"43083ae5a17b03f1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbVfs.js\":\"7d5e6ed8c7fea43d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localSchema.js\":\"937189bf7ffa31dd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/maintenance.js\":\"2fb33bb79ddc0fb8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mergeProperties.js\":\"d97486c1b1af3e2d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/metricsConsoleHook.js\":\"df46690acb5c9b67\",\"/knowledge-medium/pr-preview/pr-1919/src/data/migrationsPage.js\":\"0016aea0a04e35ca\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mutators.js\":\"42db933a8e11c8fa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKey.js\":\"339be4a29ceee4e4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKeyPlacement.js\":\"fc53f4c58c633489\",\"/knowledge-medium/pr-preview/pr-1919/src/data/outlineSurface.js\":\"ca2c4933f4451c2a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingEditorContent.js\":\"888bfcf4ab1b8445\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingUploadsSql.js\":\"1555321dd6b2d971\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pluginStateExtensions.js\":\"286217732870e335\",\"/knowledge-medium/pr-preview/pr-1919/src/data/powerSyncLogger.js\":\"d0da89dc3b902304\",\"/knowledge-medium/pr-preview/pr-1919/src/data/projectorRuntime.js\":\"79efd540327b8d3c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/properties.js\":\"fc4ab88988132bf2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertiesPage.js\":\"55cff92667478807\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyChildren.js\":\"3ebd3d76d559eafb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionFanout.js\":\"09d59b1a2cbd2c14\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionMetadata.js\":\"07c279eadb46aac5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionRegistry.js\":\"66d5819d35e8be2a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDisplayMode.js\":\"56a67304887a3ca3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyRowCreation.js\":\"50c6d61fee3956aa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySchemaCreation.js\":\"333b23d2217cc74e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySeeds.js\":\"9b5a02147a085c1f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/recentsPage.js\":\"4ffcc898931a1313\",\"/knowledge-medium/pr-preview/pr-1919/src/data/refTargetComparableProperty.js\":\"a1c62d66e09ff65e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/referenceBlock.js\":\"f67d538f43f7ba5c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rejectedUploads.js\":\"3a445cf0eb41d493\",\"/knowledge-medium/pr-preview/pr-1919/src/data/releasePowerSyncConnection.js\":\"a00071369095ba66\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repo.js\":\"80d09cfc74f784d3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repoProvider.js\":\"0aefe044e47c2dfa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rowProperty.js\":\"b3e367373fdbeae7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/searchFilter.js\":\"8eb9ce2f7fc1b40b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/seedIdentityLedger.js\":\"04641fc3b7397d41\",\"/knowledge-medium/pr-preview/pr-1919/src/data/stateBlocks.js\":\"e0e3871a6a6a412b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralEditPolicy.js\":\"d3dd731f00c4bd8c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralInsert.js\":\"40ef2bbb3b5f7ed5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/subtreeDelete.js\":\"6441ad04a0261647\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncStreamLock.js\":\"7452d7aca52ce094\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableSqlRecognizer.js\":\"5b7fad6d68e8d59c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableWriteGuard.js\":\"5a6bda33f3e864ff\",\"/knowledge-medium/pr-preview/pr-1919/src/data/targets.js\":\"4a0b80c62f1b17a8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeColors.js\":\"0b1088d5c499287f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionMetadata.js\":\"297b2a851731f6b0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionRegistry.js\":\"09874eb9d9602772\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeExtraction.js\":\"c1d194995e1dafbe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeInitialValues.js\":\"bb311da7024c99a1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typePropertyGroups.js\":\"57db48b296965c2f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeSeeds.js\":\"0fa3246438796f16\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeTagger.js\":\"0c5b33cddf5cdba6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typedRecords.js\":\"fab4a3ee2af65b1d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typesPage.js\":\"b34b443ee10b710a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userPrefs.js\":\"bba983880b96e54e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userSchemasService.js\":\"cfaaa010a8de0f49\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userTypesService.js\":\"1a4a4f0a49630ce7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/valuePresetRegistry.js\":\"0260f063418d20c8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/visibleChildren.js\":\"2a79ec47dade9749\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceConversion.js\":\"59a3469ad47205c9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceFirstSync.js\":\"0ff45548a6afc1e1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceIdNamespace.js\":\"cee9e2bb70697c82\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceSchema.js\":\"bfba311d4b60e24d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaces.js\":\"44d498222290a48b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadLog.js\":\"fe8f6425dfa9407a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/BlockPasteShellDecorator.js\":\"03c861c9bc587ee8\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/atTrigger.js\":\"f40d89163a01f37d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/autocomplete.js\":\"c77392cc1e56b14d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/codeMirrorExtensions.js\":\"e4eb323b8495b6fb\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/contentFlush.js\":\"83162c2d1ffb3e65\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/defaultInteractions.js\":\"50f94caaadf364a5\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/editSettleSignal.js\":\"3a8602a3c679a540\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/insertImage.js\":\"6ca7ba986ed7b861\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceCompletionRange.js\":\"f35afa1343ce8ffe\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceTargetTypes.js\":\"8c2dec616a50d76e\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/syntaxContext.js\":\"91efc417ee7ede78\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/triggerMatch.js\":\"7204808760f29799\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/AppRuntimeProvider.js\":\"415e207d72600ec2\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/BlockFocusShellDecorator.js\":\"ab371c4594d4f927\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/ExtensionRenderBoundary.js\":\"3dbb2fb488ba0993\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/PanelContentRecovery.js\":\"0d18e70b09ecb37c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/apiCatalog.js\":\"aaeb7e6b6a39e154\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/appRuntimeController.js\":\"2b81149ce270409b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/approveExtensionHere.js\":\"4ae485db5cc90afa\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/armedCutAppMount.js\":\"9bb5a9981462b275\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/batchableKeyedStore.js\":\"a760da6e8b6cca8f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockInteraction.js\":\"6ac6389f0575c8ba\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockSelectionAction.js\":\"d7305a6e7034c4b3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compileExtensionModule.js\":\"0b687525e295033a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compiledModuleCache.js\":\"c46e017dcacfb15e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/continuousGestures.js\":\"bf8cc5016e4a903c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/core.js\":\"fdb53ad58bee221d\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/defaultRenderers.js\":\"8225ae30bfca5784\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/definitionFanoutAppMount.js\":\"a1fbb4abcea12d59\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dialogAppMount.js\":\"9b6ba6ec4056b46b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensionSeeds.js\":\"013b065c83f47fca\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensions.js\":\"dc67b6777f26f326\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/exampleExtensions.js\":\"2e2c9cc4a17ae04f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionApprovalStatus.js\":\"1d3508dd9446c3b7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrorToast.js\":\"e5ba8f38bac0ba8e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrors.js\":\"681527db64706628\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLookup.js\":\"a9e4d89067db2823\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionToggles.js\":\"479de481e986f8e9\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionUtilitiesCss.js\":\"7dbe64292514c96d\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/kernelPageDeletionGuard.js\":\"48b89f0a2ee0d580\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/liveRuntime.js\":\"0052785c1d63c8e2\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/openExtensionsSettings.js\":\"42d529937d8eda75\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/overridesCache.js\":\"50bc512ca2614118\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/pluginIds.js\":\"ad4614cae70587ad\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/processorRejectionToast.js\":\"f28c7b56007c81a9\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeActions.js\":\"6312c424d928a4cf\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeContext.js\":\"8cfe3501a06f1e12\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticAppExtensions.js\":\"8199d438447a24c0\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticDataExtensions.js\":\"0d4a9320061bcd2d\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/toastAppMount.js\":\"63665a5564e26d27\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useOverrides.js\":\"4cdaed2b1da3eb63\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useShortcutSurfaceActivations.js\":\"748ffceabdda021a\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/discoverToggleTree.js\":\"00419ce1c3049fe4\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/facet.js\":\"5828b9a1caafab36\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/resolveAppRuntime.js\":\"b646d86b6d406cb3\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/runtimeEvents.js\":\"116d1537054b515e\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/togglable.js\":\"46ed01e267480657\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/variantFacet.js\":\"e0f74b2311e238f0\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/verbFacet.js\":\"ac11f16713429d9e\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/block.js\":\"46bd99c2f7f6e4c9\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/focusedChild.js\":\"af2fc20bb530d716\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/propertySchemas.js\":\"499a74089cf10936\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/typeRegistry.js\":\"d43d6e963d69e6d9\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAncestorCrumbs.js\":\"5fc9f3991f303295\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAutocompleteListbox.js\":\"64c9e9347b441005\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedSearch.js\":\"7b250f1440707f77\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedValue.js\":\"01c2958eeb9e46d1\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useFacetValue.js\":\"8cd3c78a9840c9f1\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsFocalRender.js\":\"9339ca50dd840eaf\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsReadOnly.js\":\"886e4959ab49e465\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMaterializeBacklog.js\":\"d2784771861b934d\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMinuteClock.js\":\"c990b302a41e77ff\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePanelLayoutProjection.js\":\"c175437b23b01dd6\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePendingInvitations.js\":\"6b5c9df0d2a9596b\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRendererRegistry.js\":\"b86891ff94100545\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRetainedFieldRows.js\":\"b5966941ae1456fe\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useWorkspaces.js\":\"5804099316b9bfdf\",\"/knowledge-medium/pr-preview/pr-1919/src/lib/utils.js\":\"754971f42e656679\",\"/knowledge-medium/pr-preview/pr-1919/src/main.js\":\"fca432e96dd29c5b\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/MarkdownImage.js\":\"b7cdd2f2ec993b17\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/blockSeparators.js\":\"3770cbbd63120ca3\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/context.js\":\"dc4011ece2333917\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/defaultMarkdownExtension.js\":\"69f9c000c727c6a0\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/extensions.js\":\"397654d184a165c3\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/renderMarkdownHtml.js\":\"fcd9f35e66b47d11\",\"/knowledge-medium/pr-preview/pr-1919/src/minimal-editor.js\":\"b49520387ba0e5fd\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/armedCut.js\":\"95f008955da11cfe\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/captureMediaVerb.js\":\"06bdd78b043a0d69\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/clipboard.js\":\"44427e80d40e5c4c\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/decision.js\":\"9080523f2991abcc\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/operations.js\":\"42dc6c5094d99cce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/AccountHeaderItem.js\":\"cf95703347132021\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/index.js\":\"f0fdd18d5464da7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"d48d62c6262628d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askAgent.js\":\"7880545cdd03d5be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askedStore.js\":\"8ef4a5d42ddd4474\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6e14d0d0c898ae3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/chipState.js\":\"c5a23e2ba148704b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/dataExtension.js\":\"22e3f2c2298ca1f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/index.js\":\"c4be2aadf436d00a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"99a16613a131a887\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/schema.js\":\"d9b96bbb18b03535\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a8b1cc55e2250b53\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/BridgePairingDialog.js\":\"7d179692b74a96d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/addMedia.js\":\"42fd27103277f6bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/backlinks.js\":\"62477c0db3d29301\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/block.js\":\"df8c3400a3b1cac6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/context.js\":\"f9280957b20fc93d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/displayIds.js\":\"f01072f885c907cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/index.js\":\"dc1582184e3aadca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/outline.js\":\"4141c1eb55c2aca6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/properties.js\":\"767a1725005eb7f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/refs.js\":\"b6c20038ba32854b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"31707b19c9f0128b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/search.js\":\"1ef981c58cb244af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/shared.js\":\"15f8dd4636767d3c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"11537887fa0244f5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/text.js\":\"8b68831eff5a6dd4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentWrites.js\":\"c6e41b3dddee6e9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/authoringCatalog.js\":\"f8645ee846004808\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/blockRefTargets.js\":\"af53e23838101368\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridge.js\":\"1764c494906561ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridgeLoop.js\":\"254152216a9bb420\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/changeHistory.js\":\"0c90eba106956596\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commands.js\":\"0e1994c26ec2d08c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commentsCommands.js\":\"d6b52ae1cee0f639\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataExtension.js\":\"23587d027a393726\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataModelGuide.js\":\"be99bfc702aa1008\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dayPropertyInputs.js\":\"db0b23e031927883\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/describeRuntime.js\":\"79312871be7cd38f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/extensionLint.js\":\"a1d441ed60ff750d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/grainAudit.js\":\"5437a9ac40dee2e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/healthCommand.js\":\"741ee6772b2446b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/index.js\":\"688cecdba14a452a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/presetIdentity.js\":\"72af3944d8fbd1bc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"b7dc47d249ec71e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/readMedia.js\":\"71749001c80713d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/schema.js\":\"87d55e33c49d0faa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/serialization.js\":\"f3920870fbbd362e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/targets.js\":\"1d77dd0e23278f7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/tokens.js\":\"bcdb79a64f36e87c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/watchEvents.js\":\"9d87d3279f311852\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/workspaceGuard.js\":\"d46f6480b062fee7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/writeCommands.js\":\"a7d5013b22f6f6b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/AliasCollisionToast.js\":\"c2f5960cb482c4ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/DuplicateNameBanner.js\":\"19153bde38f88381\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/collisionMerge.js\":\"f0e361f8690b865f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/dataExtension.js\":\"68c8c5e847b61423\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/index.js\":\"7849b89f4cd42c8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/mergeCollisionAction.js\":\"a32383fe882fbef2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/pageStyling.js\":\"f35f20e01b48c120\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/rejectionToast.js\":\"a188d9c60467bdfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/syncProcessor.js\":\"1d2c0c80a6ce5ac0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/actions.js\":\"29a09ef3b9dbb3e8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/addComment.js\":\"8ea65c4a89cf190c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchor.js\":\"0985e4c961cd6c26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchorState.js\":\"e6992920c83233e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/commentLinks.js\":\"e21a25237c171a94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/confirmThreadDeletion.js\":\"681d44c7708d534d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/container.js\":\"8afb36c56720e4b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/dataExtension.js\":\"6e291b41f0f877fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/deleteComment.js\":\"c5db5aacab5b7338\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/highlights.js\":\"c67919fa773a2c0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/index.js\":\"eb81f8f66e2a6b92\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/linkedCommentsPill.js\":\"4a00b937e576d280\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/margin.js\":\"fb7f7659795735b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginAnchorLinks.js\":\"4c7beb08810d0c3b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginSchema.js\":\"7712acf82807cacd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/newComment.js\":\"1e3c4dbe14f5bb57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ownThreadPicker.js\":\"dceab27cd4e7542d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/placement.js\":\"6de34b7401f33986\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/queries.js\":\"a52b1d78e563c3b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotePosition.js\":\"84e9a1a6e810dffb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedIn.js\":\"c3f5f79cb69571a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedRange.js\":\"d64ed38045aa4c2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/rangeRefs.js\":\"efad530ac216d098\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readHighlights.js\":\"92a7125b87f59fee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelection.js\":\"d0eab40944f70d1d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelectionUi.js\":\"060a2d23ad126849\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/reanchor.js\":\"33eb14ced79c21be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/schema.js\":\"6afa724bc0eade0d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scope.js\":\"3196d450ae612353\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scopeThreads.js\":\"df8ac915a1ddbef9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/splitRetarget.js\":\"3b31704292fd7b66\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestionCard.js\":\"eac9e3a7a5b9a257\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestions.js\":\"bf2920c77f398694\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaries.js\":\"c4d07f6dd63a8004\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaryBatch.js\":\"da964f9b2af3697e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/surface.js\":\"2a3894ba67be03e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threadNavigation.js\":\"1eb87385f7910083\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threads.js\":\"079f8cbd26890601\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ui.js\":\"59dc8ad1e2343bfb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/uiStore.js\":\"41651978763ca3f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/appIntents.js\":\"f23073056afd736b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/index.js\":\"9c0be73cf38c76e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/index.js\":\"8fc8486d4174ddce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/status.js\":\"d59783a3e21e49b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"c1e350d2dc66e55b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaBlockRenderer.js\":\"e2fe04fc9155a257\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaDownLaneReplicator.js\":\"6b1461cc8688e84d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaUploadReconciler.js\":\"72de13fe67570404\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetDownLane.js\":\"c5bb9bb95f98f100\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetResolver.js\":\"b506ea83186de99b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetUpload.js\":\"5eba83c97e8c01a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/attachmentCleanerIO.js\":\"a021e1c3f91e021f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f0aa415120fefb82\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/blobStore.js\":\"fada8c76cecc2ead\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/browserMedia.js\":\"3e54897f584e08e8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/byteStore.js\":\"f6986c023c0b778c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanerIO.js\":\"4d7fcdd2c53636b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanupAttachments.js\":\"e231170de7e07965\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/dataExtension.js\":\"da830229ea2677b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/downLane.js\":\"124d7a9c9b258c20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/index.js\":\"4b82e64f90d2c005\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/insertImageContribution.js\":\"dda701c4689f2eda\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneArming.js\":\"f36b0be81e495803\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneLock.js\":\"c3ba2f013b057b44\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaBlock.js\":\"9e29ed63a91ff469\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaCapture.js\":\"9f31fa536dfb1461\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaLanes.js\":\"259d7ea3229cad42\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewers.js\":\"caa0918bb3d848b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewersFacet.js\":\"c0e64b205c17c880\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/pasteCapture.js\":\"a14078e1473219b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/resolver.js\":\"5d3615d871e43b7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/retryUploadsAction.js\":\"bedb760d5bfee574\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/storagePaths.js\":\"fba64f9e22859c67\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadDrain.js\":\"e4a9c108c1a36b81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadLaneStatus.js\":\"a2fb4013e0d0eb8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadReconcile.js\":\"9c7aa7833e75181d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadRecovery.js\":\"86e8c7eecdd299d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadStore.js\":\"62838cd69d00da4d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/useAssetObjectUrl.js\":\"ea621180be1256f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"4bb4e606c19b65c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksViewSection.js\":\"bc899ecc0072950c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/facet.js\":\"d5ec1932e2dd5340\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/index.js\":\"15454c493a74c2f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/prop.js\":\"457b1a43e3647e87\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinkFilters.js\":\"14e16c94679d408e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"d6ad43cb328ab4ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BlockEntry.js\":\"63aa895ab2529050\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/LinkedReferences.js\":\"1eac9a28dca4a2d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"e76b6f828838a694\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dailyNoteDefaults.js\":\"9006bd32fad85370\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dataExtension.js\":\"f49fe81b9b5052fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/edgeExclusions.js\":\"1b21605a109b4afa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/filterProperty.js\":\"af687f807c19ceac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/index.js\":\"f5edeaae8091734c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"779aada370d1901e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/applies.js\":\"342dd515608055ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/countQuery.js\":\"d905dd5864002e6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/expansionStore.js\":\"be8604bebf7bbfff\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/index.js\":\"9519337a7e6e2033\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"05175412d43304c6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/presentationInvalidation.js\":\"3f5e77c27492cab1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyEditorOverride.js\":\"db05e275c2f2d9e4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyFilter.js\":\"4872827f745bad5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/query.js\":\"bdf7edac817009c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/resolveFilter.js\":\"658952dce2e06e4b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sourceBatch.js\":\"b2f4618fc5990bea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sources.js\":\"3a95bbe4252c8309\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useBacklinks.js\":\"069d8f9f9b0e63f6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"bc933b36e514b24e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayCelebration.js\":\"719f89c283f4adfe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayOverlay.js\":\"ceddf63ac09ec29c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/gate.js\":\"186bb9bd947153e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/index.js\":\"7ac0cb13e6a85a4d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/wolfTheme.js\":\"bf5c4ffca4ccd6bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/BlockDragLayer.js\":\"3fc03ab343951bcc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dragController.js\":\"30d51f2c9a567e10\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dropTarget.js\":\"4c66b7181083cbf8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/index.js\":\"58b518ce00d23dfc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/projection.js\":\"d8ff0c429b1863a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/BlockMetaCard.js\":\"3a2b353054e44472\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/index.js\":\"bf2a7cf4430065c0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/AddTagDialog.js\":\"f4fc8f74248d6339\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"00e6b5b9125466fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/TagNameIssueHint.js\":\"54fb7b0ccd62358f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/addTagAction.js\":\"78802b04174075a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/appendTag.js\":\"697302b474016b06\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/config.js\":\"fdc9ef3eaa67d26b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/dataExtension.js\":\"5c4b3b772680015b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/index.js\":\"0021697bc499d175\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/propertyEditorOverride.js\":\"39b33ae3ec6a7905\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbList.js\":\"6bf8a2537dbccdda\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"3deda8bc33735c0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/Breadcrumbs.js\":\"28953b0a5b437fd7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a51ae1c60ca92639\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"9dae2bd333d249b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/index.js\":\"1067f20bdd454329\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"6093456bdf90b4b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/CharacterCountItem.js\":\"5783fff47bdcf306\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3427b35d1f3a210b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/actions.js\":\"4870946407af7895\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/blockType.js\":\"9edb420ea473ba28\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/charCount.js\":\"e27dd652e9150629\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/dataExtension.js\":\"339f8df351315b4f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/index.js\":\"9fcbf7107151df09\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/profiles.js\":\"f8c7d0901f15af33\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/properties.js\":\"eacb579663021e48\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/subtree.js\":\"fb6d98a84457c36c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/textCounts.js\":\"24d35b3d0f3b331a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/colemak-keybindings/index.js\":\"05e3ca7ebf2e9a96\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/CommandPalette.js\":\"d16d1f32f177d2d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/HeaderItem.js\":\"01219317b482af23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/context.js\":\"9d706684f79aca1b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/index.js\":\"4fff8cd3a0e44c61\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/selection.js\":\"70ff0d9c51b8be72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/toggleStore.js\":\"e3b3e09f35cc7f80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/useCommandPaletteActions.js\":\"c7bba1e72a0efeec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ContributorBadges.js\":\"e0c8b09c667af245\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ProfilePicture.js\":\"3e5c42d3cda053c6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/author.js\":\"d4b406a52c1ea34a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/codeMirrorExtensions.js\":\"c97fe86c872a0a72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/dataExtension.js\":\"644b32ba6985197a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/index.js\":\"daf7a9257ad5603c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/mentionAutocomplete.js\":\"e829e48307e5644a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/processor.js\":\"688f778f80ce8c46\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/profiles.js\":\"d2e7afdcaced3d29\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/queries.js\":\"864f3ea497e0052f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/schema.js\":\"c5ed55f1cdec9e83\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/useCommentAuthor.js\":\"b1e9715d47de8299\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"474d784459a5e703\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/followOrigin.js\":\"d1b021c6455b4231\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/index.js\":\"e32ccae31548c32b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"aba459b3c6df859c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"62f476df9ace11fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/CalendarGrid.js\":\"19f658f0bf21d203\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DailyNotePicker.js\":\"958f158fbc46cb94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"22fcc21d00e1e276\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateNavDecorator.js\":\"76307714cd2a5542\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateScrubOverlay.js\":\"ab3ad4352fcb8b6b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayPropertyControl.js\":\"7816a06a7fee04e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayValueReferenceControl.js\":\"29729e2bd9944c1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/HeaderItem.js\":\"9e854e4d1fff6658\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/ReschedulePicker.js\":\"c6820894780a02d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/SpreadDatesDialog.js\":\"9ef6119ed75df156\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/actions.js\":\"f11529adce1c8a13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/blockDateAdapter.js\":\"621ce93cbebcd2e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/calendar.js\":\"f9a58f6b081b80c0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dailyNotes.js\":\"b5f24decc10931f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dataExtension.js\":\"51abb455d07406d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubActions.js\":\"aca1ee46f37e68df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGesture.js\":\"5f4c21a4c3eed1c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGestureActions.js\":\"53867cbe904be727\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ee02b3298b19f44f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayProperty.js\":\"386e5e298d57a317\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"6c859b2024d67c66\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/deletionGuard.js\":\"909cd2b5190c1dd2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dueQuery.js\":\"a08f6424d9d39c7c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/index.js\":\"610a3cf5f994778d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/landing.js\":\"172493773f2ad122\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/localSchema.js\":\"aeed5504bb575d9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/referenceDateAdapter.js\":\"793da493d90a1ad0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/rescheduleAction.js\":\"082c8caa3a5659e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/schema.js\":\"5803c61e043abbd6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadBlockDates.js\":\"a8a0b5505dfa3c2a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadDatesAction.js\":\"c5cf15b97acf0dde\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/today.js\":\"8b14416b3c7bc50c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"c1e7b6d1b35f3a41\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"3424b252e918133f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/audit.js\":\"9e8e26046b8a109a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditAction.js\":\"c0b7423d89922b95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditRanges.js\":\"d04b0614d02efc03\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/diagnosticsSource.js\":\"2962fc608b8a39b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/divergenceScan.js\":\"7c693565215bb8c2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/index.js\":\"7d7f55141f69ce8b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/propertyChildrenChecks.js\":\"aa243fdf883f8773\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/referencesMirror.js\":\"59027c04f0e93fa8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/rowJson.js\":\"d63cd5ee691f3004\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/schedule.js\":\"b226fd822d7a512a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/store.js\":\"ed1e9e2126ef266d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/action.js\":\"27bfc060a126bcf5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/index.js\":\"1ef070e4a70d2ea2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/plugin.js\":\"dac328d3362ee2a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"3be58a23076dbcf8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/actions.js\":\"11b82ae99bbad8b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/changeMarker.js\":\"14fadd278f6fd70a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/diagnostics.js\":\"4985a1418896fc95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/fileSystemAccess.js\":\"4c75f6232855f0e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/filenames.js\":\"1e14b93cf64064b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/index.js\":\"2ad4c901344ffa2d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/mirror.js\":\"a135d95a6dd350d0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runLock.js\":\"cf9cc0e3c890fca6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runtimeHealth.js\":\"bccb1908ad995d8f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/schedule.js\":\"332eef12f9684f93\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/store.js\":\"86939aa913a09a7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/index.js\":\"d91181ba5972c484\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/themes.js\":\"d49569b4092111ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/facet.js\":\"c490e1c2a8cc6b39\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/useDiagnostics.js\":\"66f229e5e9704750\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/dismissals.js\":\"bd6e76227e254854\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/index.js\":\"176f8cace74f763e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/status.js\":\"8d1554bfdcd26554\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/store.js\":\"0aa3edb0f38ca2df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"df6bdadb789e7c04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5e2bc7a4ca294892\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/actions.js\":\"20519a4c7ff259e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/config.js\":\"5eddd8b82b53ce0a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/dataExtension.js\":\"897d8e28fc3c2e95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/effect.js\":\"2420e1264e1c32bc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/index.js\":\"5ccba3e4cda009d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/propertyEditorOverride.js\":\"443a0d1ae7f9b562\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/useToggleTree.js\":\"1b1eb730ccaf5327\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/ExtractTypeDialog.js\":\"f61ea59111c47413\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"e2e81cab26e8c69f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/PropertyShapePicker.js\":\"1ca8131798bdc4cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/action.js\":\"af8b8f90f77a8e04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/index.js\":\"07072eb0ac63308d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/FindReplaceDialog.js\":\"1b2f7a9f18f0dd26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/HeaderItem.js\":\"4a9f98789a10ab9a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/dataExtension.js\":\"8b8f12f84c3608f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/index.js\":\"1d320a9f7dbaf33d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/search.js\":\"f8db2bb6ac2cf966\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/toggleStore.js\":\"0be4c85bf0ae3c5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/LocationPropertyEditor.js\":\"d154e72fda1ad7f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/MapView.js\":\"f2c1ea913a5dcd47\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/blockTypes.js\":\"6c3870a52ce62796\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/codeMirrorExtensions.js\":\"4634d98e49f8cfd7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/createOrFindPlace.js\":\"b82f5fa0e2b6a408\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/currentLocation.js\":\"d7407d1b15e073be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/dataExtension.js\":\"928156602f4d749b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/geoContentDecorator.js\":\"5c44fc60f78118ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/googlePlacesClient.js\":\"6d0cead609a5337a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/index.js\":\"a623b6489da6ae7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/locationsPage.js\":\"d3e4a1df10ffb14c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/mapViewport.js\":\"114644edbd9bfd20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/pickCurrentLocation.js\":\"17ccf5dfbce698dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeAutocomplete.js\":\"24125f2457f174fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeNameCollision.js\":\"70e253ec5762d72a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/properties.js\":\"639c03bf6a748b85\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/propertyEditorOverrides.js\":\"3f0d0bddfcd2e02a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/query.js\":\"8e7e5ffe5b281379\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/usePlaceSearch.js\":\"7bb6914035277953\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"a8d9400148f0ab5e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"1620e06ded729dfa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"7fdfd00c1e246b2a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/config.js\":\"fa5a5aaf62f0f4a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/dataExtension.js\":\"29213ad6b01ec35e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/facet.js\":\"4da19ffc27c514cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/grouping.js\":\"8b7e3f65c3a9b9fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/index.js\":\"f7c8eac54d7a3592\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"2af1775034c05233\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/query.js\":\"70aaad99f4180a2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/resolveConfig.js\":\"b925de9695458623\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"61e2789bd374e381\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"ff74ad5a3057432e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlDocumentContent.js\":\"d14c54c317b01d1f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlFrame.js\":\"650fac97cf58a97a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/actions.js\":\"1567860de32d272f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/blockType.js\":\"1487d9d3e49a5ae3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/confirmRunScripts.js\":\"1b677a0f323400d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/dataExtension.js\":\"d87f13c9ceafaa0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameAnnotations.js\":\"facb0668fba07631\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameDocument.js\":\"95f40cc265b46ad7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameTheme.js\":\"bb2920aecdd8a026\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/index.js\":\"10e79080fc72f9e4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/scriptConsent.js\":\"1e02358188a1a285\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/sourceMap.js\":\"737883697baf4254\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/useDocumentScripts.js\":\"577a92856bc47161\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/index.js\":\"889203e13e5e8110\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/record.js\":\"7c072e117b010789\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/recordStore.js\":\"e8352264b352f985\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/responsiveness.js\":\"0220c9d43aed55ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/schedule.js\":\"7c8e9691c37b0855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/sessionContext.js\":\"1953c3062760a770\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4d5aecae0d60911d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e5e748571a5ef28f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/actions.js\":\"836d3f32da576141\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/config.js\":\"61e3c41b491adc79\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/dataExtension.js\":\"5435cfa83ae64b78\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/effect.js\":\"61bb67aef3fc3f52\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/index.js\":\"17db425cf580d6ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/keyCapture.js\":\"1511e2496f8a228d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/overrideStore.js\":\"5b829594f1346d6f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3dd6ab15b816a7dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/HeaderItem.js\":\"753fb8ca84911f97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/LeftSidebar.js\":\"c356f59c199aadf9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/actions.js\":\"00b37d8bb2697e79\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/facet.js\":\"d01339e391a09e5f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/index.js\":\"29455048492707ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/shortcuts.js\":\"a6260668a8a6d7cd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/toggleStore.js\":\"83c8784c6161719f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/MergePicker.js\":\"22beab159317d593\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/index.js\":\"57e179ec0f18b62e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/mergeAction.js\":\"b2d2db4ed1751aa8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/strategy.js\":\"9570a329a18fb809\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/Button.js\":\"42bc87a2a97327ac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"bdf8d0e20219e643\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/defaultItems.js\":\"8834f067f6868305\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/facet.js\":\"b3b70f0a8376a2f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/index.js\":\"02f0ff6a03b486cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"9eae338a524efef4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/actions.js\":\"ec89f06ef3709b84\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"966964a05c2e8e3c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/facet.js\":\"d453e33fbe30ed0b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/index.js\":\"40353a4a345ed7f2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/MoveDestinationPicker.js\":\"a11e9b02e60bab88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/blockSubtreeMembership.js\":\"e0da7a8bc0829808\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/contextMenuItem.js\":\"4c1daf01e1e3fc2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/index.js\":\"1e07c7292c9239e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveAction.js\":\"c004d67054bcc9f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveBlocks.js\":\"9b6874727aa80ba5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/selectionAfterMove.js\":\"fd2a184d72254458\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/TutorialBanner.js\":\"91d4ba800b122280\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/action.js\":\"b5027617600b983f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/bannerDismissal.js\":\"88f5e31b057380e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/documents/cheatSheet.js\":\"fbeab27afd054baa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/index.js\":\"b6e6435984b76672\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/keys.js\":\"4aeac32830e245b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/landing.js\":\"baed36d2efcb1688\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/outline.js\":\"9af14ddf03ae30ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/seed.js\":\"5f5dbe6268b31881\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/PerfTrendDialog.js\":\"613069224fa70526\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/analyze.js\":\"717265b010194acb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/diagnosticsSource.js\":\"cc65879063aa5d11\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/index.js\":\"66bebe3e88194893\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/load.js\":\"0e9b43dc8906a0ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/monitorRun.js\":\"21cffdd69308be37\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/schedule.js\":\"9a4cd6724cbb9657\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/series.js\":\"73425ea245da3f83\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/store.js\":\"9fefa25b2d2ecd54\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/trendAction.js\":\"5b4aeb79f086a86d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/verdict.js\":\"44868aefd4b75eb8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/clickToEditAction.js\":\"fad4f5ab1cbca90b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/index.js\":\"136588390ddd1aa1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/interactions.js\":\"dd1a0f95dba72ca8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"d82146fc72552a71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGate.js\":\"88b35721ab5867a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGateDialog.js\":\"c5fe641a1f3b2fe3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/action.js\":\"773739eb23af9992\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/index.js\":\"722453f5b0084730\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/localRunMessage.js\":\"1dfb3d1a1d8ce732\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/plugin.js\":\"1d624a638a44d38f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/progressReport.js\":\"b5f8e07e89b67d4d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/sweepProgress.js\":\"ef91099dea0837dc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/FieldRowRenderer.js\":\"1fe0640b1260e6e4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/ValueRowRenderer.js\":\"9b8221ef956a5b1c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/actions.js\":\"866bf3db7f8edc0b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/autocomplete.js\":\"43aac3d71aaf7a13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/fieldRow.js\":\"aa4f7ddb07583370\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/index.js\":\"ed915287676a7aa5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/referenceWarning.js\":\"2b600429562009d4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueAutocomplete.js\":\"9a6947bcd4dc0ed0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueSchema.js\":\"0672060825c1bd7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/HeaderItem.js\":\"a4acc37a51f08550\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/QuickFind.js\":\"7e38676b8b2c3965\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/index.js\":\"02e7d85eaa6f1730\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/recents.js\":\"0dc46238aec637ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/resultItems.js\":\"efed9f7ced93591a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/selection.js\":\"bb423e47ed67e1a9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/toggleStore.js\":\"1afb13fe1958b868\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/HeaderItem.js\":\"7adab2b82f7a6f3b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/RecentsPageBlockRenderer.js\":\"b0c0f42d6ea17bc1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/grouping.js\":\"b6349040399b3659\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/index.js\":\"097e3dc3a8816cfe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/target.js\":\"b14893c8ef1f0d49\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/codeMirrorExtensions.js\":\"c2dda27b01b8ad80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/contentPrefill.js\":\"ff4a3c914fdeb2bc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/dataExtension.js\":\"b87ecc9d9cf2b6b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/index.js\":\"5e29f21f790f622d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"413c1ceb27f0d691\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/invalidation.js\":\"1ea1894991a5943c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/localSchema.js\":\"4c385c66d659935c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/index.js\":\"1a53a16c16ad27c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"3259ad10be45c416\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/index.js\":\"36d142cfbb79f916\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/referenceNode.js\":\"9ef502f3e4e8f73b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/remark-reference-occurrences.js\":\"65762858644e9e97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"20587f66acfc4895\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/index.js\":\"0241721dff177333\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"44c8f9e8ed3454bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a271935b034f10e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/mergeRetargetProcessor.js\":\"4d45f0458e83615c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/parseFence.js\":\"25e0a0259bce9c33\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceParser.js\":\"a07d7430b356cfd1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceProjection.js\":\"bee10716c0372cef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referencesProcessor.js\":\"0a114e9362edddca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/renameProcessor.js\":\"a095b3d1dae10ba9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/spanReplacement.js\":\"383856da25abda12\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/htmlToOutline.js\":\"4576d4f1c216b747\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/index.js\":\"7b537bb836f90bec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/normalizeClipboardDom.js\":\"677c3725897e7bca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/pasteDecision.js\":\"2028c8101f199da8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/action.js\":\"c1ccb6c1f70877de\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/blockIds.js\":\"871df51bb0a6d081\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/content.js\":\"153b4c982e9e1210\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/effect.js\":\"67ba0ee72ba55877\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/ids.js\":\"11a87ce4411368b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/import.js\":\"3513709ef5e8e558\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/index.js\":\"08cfd6ddc863544e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plan.js\":\"1339f4b68159b100\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plugin.js\":\"bbe25f9ca8e9e728\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/promotion.js\":\"c2ac8bdde2ac1140\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/properties.js\":\"43e935b71dae827b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/references.js\":\"53c372b674d750b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/report.js\":\"fd8e1ce03a0d9947\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/roamMemo.js\":\"339877f5f2a7657a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/runtime.js\":\"6f130c3af39e7112\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/schemaReconciliation.js\":\"214234c362daee7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/srsMarkers.js\":\"f65bf72656af7f55\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/todo.js\":\"dcba5e46db07ad9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/typeCandidates.js\":\"e9a764c26144a17e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/types.js\":\"8cb262d571e5454f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/index.js\":\"21560e10b0b367f8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/store.js\":\"851fdf9bc553f256\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/HeaderItem.js\":\"80e3dd8f205d10f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"07426eb2337be0e9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/index.js\":\"33db890deea98b7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/model.js\":\"6a55306b0173c811\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/toggleStore.js\":\"4ff7e8f369bd86f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/useKeyInspector.js\":\"aa114437fd594577\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"abca6c5bec60866e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/ShellDecorator.js\":\"74841bb11d0cb9c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/actions.js\":\"74396d401ae40e10\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4d796c361f459541\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/index.js\":\"cc439edf901d6547\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/shell.js\":\"5f3ff2cdf2c7a9b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/surface.js\":\"e5cff61d6d7d9f17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/walker.js\":\"b6a03f53a9b9f315\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/RescheduleToast.js\":\"7e64fb1c65392559\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/dataExtension.js\":\"03bd3f00bc5fae64\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/index.js\":\"af89569ac82a0376\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/indicator.js\":\"80c154f13a11cb6d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/moveSrsState.js\":\"7797b3892b4204bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"11ecc451f1e0e1eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/scheduler.js\":\"81ae6d9a63148b80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/schema.js\":\"b4287c960b6751a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f67f0f67612f578f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsClipboard.js\":\"00accc4a57175927\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5e90a4f27c954d20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DailyNoteReviewHint.js\":\"649485d815ce0fad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DeckPicker.js\":\"3582df39843258e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewControls.js\":\"5c8732fc5857091a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewDeckRenderer.js\":\"8f0eb1fae15c3775\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewSession.js\":\"437e3b9b179fa39d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/actions.js\":\"6036ab41d891a2fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/archive.js\":\"f11ae67edb2af815\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dataExtension.js\":\"51c270a5029cb8d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/deck.js\":\"ac08f63b3c512970\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dueQuery.js\":\"eb429dcaac91b984\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/gradeDecision.js\":\"2f88830377856b41\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/index.js\":\"ec0cd7f1f3895c76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/keyHints.js\":\"f9faaed8c29cf950\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewCardLayout.js\":\"390624408d15fde7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewProgress.js\":\"c3bd45b2a25231b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/schema.js\":\"7aafc03d212a881c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/useDueCards.js\":\"3e2fd0bd87413b26\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/index.js\":\"11c774a7134c84b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/record.js\":\"1e24b907794e7d29\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/index.js\":\"cb60eae0a1366617\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/persistenceStatus.js\":\"6cb26e7ce7c024c0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/requestAction.js\":\"0d49d0d82f44aeb9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/TypeChipsDecorator.js\":\"b08ad60aefcc66b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/codeMirrorExtensions.js\":\"6f0ffa778fa358ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/index.js\":\"4384384e27a713ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/typeAutocomplete.js\":\"fba939fad6ce0831\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"4aaffce7981123c7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/actions.js\":\"7aad7a4cdff0beaa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/anchor.js\":\"06c1ff2802bfca64\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/events.js\":\"c6f3f74b5aa242e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/gestureActions.js\":\"9361e09cc926d88f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/index.js\":\"9f26931ea8e74b09\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"66a72db6c86704cf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/collect.js\":\"0f115475f8182538\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/index.js\":\"e090eb7fbc8dc181\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/record.js\":\"a0805c661f624a56\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/RejectionDialog.js\":\"1d160ddc258dbea7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5273fdac9be5487d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/index.js\":\"1932913da938b497\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/model.js\":\"c62c0630e824dab6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/queueCounts.js\":\"baa988fd596a702e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rejectedHelpers.js\":\"b4524f159c6c58c4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rematerializeAction.js\":\"91255dbeaa9df5e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/useHysteresis.js\":\"29f9e81454da811c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/ColumnHeaders.js\":\"278eb88ee040e679\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/QueryUi.js\":\"a6c1431c674c8542\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/TableLayout.js\":\"1e95836872a049da\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/actions.js\":\"e488423ac07c62b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/cellEdits.js\":\"8180a1091625519a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/childrenViews.js\":\"0919bb96567f6c46\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/columns.js\":\"405688b87469998c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/controller.js\":\"cc4a5fc028f3f743\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/convert.js\":\"60b219e07fe2fb84\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/dataExtension.js\":\"ca0d9044f7a9d22b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/index.js\":\"935b917f3c9c91a5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/keys.js\":\"f8c8cb600594c7c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/model.js\":\"2ec6795ec7cd1f66\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/QueryText.js\":\"034e9a28a383b165\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/backfill.js\":\"09ecb1f24a651d8f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/completion.js\":\"62d475a3c47ed42e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/format.js\":\"d7b6ac8bc2268913\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/parse.js\":\"1aff8b12c0cf80cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/queryValue.js\":\"36898f6aafdfc104\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/registrations.js\":\"2d00af7341d8b2ca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/source.js\":\"30b9643b32347ff4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/registry.js\":\"2fa9a3c1ef092ae9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowGutter.js\":\"9f1a79f5291e6035\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowVerbs.js\":\"2d669abc67f1fcf0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/schema.js\":\"e5855a0420b53b9f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/sort.js\":\"afa05e3ed7b3bc2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/effect.js\":\"06428409342d5eb2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/index.js\":\"33c7fe4bbf1adb00\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/theme.js\":\"b3696fdb9a50c93d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/actions.js\":\"d41567a62a56197d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/dataExtension.js\":\"c474304422b7a347\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/index.js\":\"dfaaa8941731a545\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/schema.js\":\"97f9888551fc4962\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/TouchSelectionLayer.js\":\"e2c8fdd4581291d9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/actions.js\":\"73b9058bfe5083ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/defaultItems.js\":\"34d9e76615be627e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/facet.js\":\"bf17f3049fb1f8ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/holdRecognizer.js\":\"c5a0a10f9885921a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/index.js\":\"e7451e5d8bcd3c13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/UpdateIndicator.js\":\"056128f08c61ebd8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/index.js\":\"79bdc1bc1ca35ad8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/loadTimes.js\":\"f3f6e75cc88d27d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoNotesRenderer.js\":\"cb325d4a6768a489\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoPlayerRenderer.js\":\"eb60fb17311a505b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoTimeStamp.js\":\"b2b71204d5c8efd3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/actions.js\":\"b921417eb8a6c530\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/index.js\":\"444ee436f2f87c8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/markdown.js\":\"5a936f948c8c7b76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/notes.js\":\"aef55b2697764539\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/registry.js\":\"243bfeb4ad4ede4d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/remark-timestamps.js\":\"3ed99c6c0cb423b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/view.js\":\"241ed85aa814888b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/LinkHints.js\":\"fee0cc46dc6a6d2d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/index.js\":\"49289a83629d8cc0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/model.js\":\"faf267ebcf48932a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/settings.js\":\"5c61b0fbecdd8443\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/actions.js\":\"778de7a066ee22ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/index.js\":\"9b9af806bc42b852\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/interactions.js\":\"53316c2d6d28b1db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/workspace-header/index.js\":\"6b9cc5beff5b3b8b\",\"/knowledge-medium/pr-preview/pr-1919/src/registerServiceWorker.js\":\"7c12f6c1c53d82c1\",\"/knowledge-medium/pr-preview/pr-1919/src/requestPersistentStorage.js\":\"5a1f6f907139d888\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authRequestDeadline.js\":\"03c8095a813dcc60\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authStorage.js\":\"35bc0cde08f10516\",\"/knowledge-medium/pr-preview/pr-1919/src/services/powersync.js\":\"e7993ec10eca6f4c\",\"/knowledge-medium/pr-preview/pr-1919/src/services/supabase.js\":\"e23d74f304e5f89e\",\"/knowledge-medium/pr-preview/pr-1919/src/services/uploadErrorClassifier.js\":\"2bf42b30d12da035\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/ActiveContexts.js\":\"303ad26ac388bd1d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/HotkeyReconciler.js\":\"0caddf912680624a\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/WipeLocalDataDialog.js\":\"fa81ff12fd4128e1\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionDispatch.js\":\"3071df747c72cb9d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionRefItems.js\":\"1b2016a4380d2d43\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/applyKeybindingOverrides.js\":\"e5daa4fa81464dbe\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockActions.js\":\"c723173bce165231\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockMergeGesture.js\":\"55e779c4bd97b260\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/canonicalizeChord.js\":\"7afa55595d5fa627\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultContexts.js\":\"95743bc3c217af0b\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultShortcuts.js\":\"dfd8c2cf2bd104e9\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/effectiveActions.js\":\"63dc3dee55071516\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureAction.js\":\"e6ec975b83a543b6\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureBinding.js\":\"3df8f706426847e1\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/holdRegistry.js\":\"47e7a0a90a13fd6f\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingConflicts.js\":\"c98f9265c3d2cf7d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingOverrides.js\":\"a79db4c2d6d99ec7\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/pointerAction.js\":\"9b8a6b853d8fbbd6\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/resolve.js\":\"9019b775d7213d2f\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/runAction.js\":\"9feb5a475173420c\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/sequenceMatcher.js\":\"ddefe7379be72e3e\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/types.js\":\"2a3dbd77ae7f9686\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionContext.js\":\"93b732ff65bb923d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionDiscovery.js\":\"2be8d982e0108ea3\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/utils.js\":\"78a537fc964938cf\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/bootStore.js\":\"194875b98649d115\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/previewDatabases.js\":\"b2cda7e97f4773c8\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/byteTransform.js\":\"d542c8c40cc9d7f1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/attachmentCleaner.js\":\"ce8cc590cc18f827\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/attachmentParts.js\":\"32405a6c40857e31\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleParts.js\":\"d87ca6c899dc3665\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleRecord.js\":\"7963e8ab8cacf460\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/manifest.js\":\"b32dd4ef9e29b646\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/takeBundle.js\":\"ed25f9d3fa61499d\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/verifyBundle.js\":\"cf023af4cb651732\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/cleaningStage.js\":\"4594879e6b0147fc\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionKey.js\":\"2f1f6e2bb0f6003b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionServer.js\":\"ec74a12e2b98ede4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flip.js\":\"74c80d12c68f759a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flipAttempts.js\":\"68dcb028fc65095e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/pages.js\":\"c997e0a51e7d41e6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/preflight.js\":\"0b5c735bd5080b33\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/reseal.js\":\"ec1e08906a0d5ec6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runConversion.js\":\"daad7fc4006ce6ba\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runLock.js\":\"17a814395211f402\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealing.js\":\"5a0bfe2ffa009e57\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealingStage.js\":\"2537afd3dcdc7636\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/stage.js\":\"a9b4ea356044bc3c\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/verifyReseal.js\":\"106748bb35f0192b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aad.js\":\"09ef80fce8c9db76\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aead.js\":\"32256e952332b3c0\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base32.js\":\"3220f33e79540d5a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base64url.js\":\"216c8c935da44d1f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/binaryEnvelope.js\":\"2ddc301b59d39158\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/byteAead.js\":\"f732cadf5233a956\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/canary.js\":\"368b62fe536aeb28\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentHash.js\":\"96a601b243532244\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentKey.js\":\"6f1dcd42821194a5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/derivedIdNamespace.js\":\"77845ccd1bdb67ac\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/envelope.js\":\"82bc66317c0ca384\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/hex.js\":\"fc304260a9068875\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/sha256Hex.js\":\"ac8393bd709ab0e9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/workspaceKey.js\":\"6e3f7c4cb7052dfd\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/conversionState.js\":\"bc7d0687c0e414e0\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/createEncryptedWorkspace.js\":\"38b3aa82fa27378e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/pastedKey.js\":\"21e6ce320b47b5a4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"238023910886544b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/upgradeWorkspacePin.js\":\"c2f97b13d602047e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/keyStore.js\":\"30c661adcbfe8440\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/mintWorkspaceKey.js\":\"129fc99d45d11908\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/modePin.js\":\"9442ec7e1e000015\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/openWorkspaceKeys.js\":\"f2964f25f8205103\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolveWorkspaceEntry.js\":\"eb0ac24906685709\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolver.js\":\"4fa13561b9fa2afb\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/workspaceAccess.js\":\"6a7299ebe2744fe3\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/transform.js\":\"7c46fa288afdd45b\",\"/knowledge-medium/pr-preview/pr-1919/src/themeBootDefaults.js\":\"914893b102b7de53\",\"/knowledge-medium/pr-preview/pr-1919/src/types.js\":\"274b38cc5f83f6c9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/ClientLocalSettings.js\":\"483eb7cf5bd1b45d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/abortableSleep.js\":\"f8c83ba98c06f59a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/array.js\":\"5de781f81c3aac55\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/backlinkAutocomplete.js\":\"60d04d86b9ddaaa8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockCrumbs.js\":\"dda5cc26dbd07dc1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockrefAutocomplete.js\":\"ef363fd52d598ff7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/cadencedIdleJob.js\":\"41ea687b9b825945\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/callbackSet.js\":\"5c37a06585cf3ae5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/clientId.js\":\"689bb43d9222bcd0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirror.js\":\"fab8fe287d1f4a51\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirrorCompletion.js\":\"f5efaf9adbc3b12d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/copy.js\":\"08bc086a5174a6d1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dailyPage.js\":\"516efcd0f13b7c87\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensics.js\":\"fb190eb29740ad7d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensicsHooks.js\":\"b0a4788274f554ac\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/deleteBlockThroughUi.js\":\"92efb96e3fcf0ee0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dialogs.js\":\"f754fee8ee508d9a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dom.js\":\"6b0a05de73b914f6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/downloadBlob.js\":\"e1d2f91f04bd0cd5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/drawnWalk.js\":\"9a1b0422a93be77f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/exportSqliteDb.js\":\"dbeca7997152773d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fileSystemAccess.js\":\"f1286219219de9c5\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/flipSlide.js\":\"c0b8a061a9ea26a1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fnv1a.js\":\"c9880b1099714711\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/formatBytes.js\":\"1173c10faf9acfe2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fuzzyRank.js\":\"29b00a57598df887\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idbKeyedStore.js\":\"4c170baf7f888573\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idleCallbackPolyfill.js\":\"5608e6c65eeebfdb\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardAwareScroll.js\":\"da91f3c18d8ed02c\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardViewport.js\":\"6ddca1ef9a3c5462\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/lastWorkspace.js\":\"d84462d3dbf179dc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutColumns.js\":\"61f7a99194331e8e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionDom.js\":\"05873729ee3d2ad8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionId.js\":\"27539ce9706ffd13\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkClickGestures.js\":\"e1b20968bc083736\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkTargetAutocomplete.js\":\"0fd684df13a9f7e9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbCorruption.js\":\"7ec1099c62e15c14\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbRecovery.js\":\"1e5f78d2cd8decfe\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/markdownParser.js\":\"89b856d71aa42ab9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/memoize.js\":\"da0137ebfd6239fa\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameFieldCommit.js\":\"3d6fa8321e4a1714\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameList.js\":\"18801165e9100ee0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/navigation.js\":\"771ab695b99f06fc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/omnilinerNamespace.js\":\"3e5eaa4c76d63687\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/opfsPageScan.js\":\"13b3787e4cb54091\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelClearance.js\":\"46bf30afe0dab37f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelHistory.js\":\"8be2bbe54f732235\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLanes.js\":\"a03d6c07fd1b60a2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLayoutProjection.js\":\"aaee5ed9d6252785\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelScrollAnchor.js\":\"4f6a39276750291e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelUrlFlags.js\":\"91754b7155237ca3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/platform.js\":\"c0feeac64137a364\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/pluralize.js\":\"4c4589b3c2b3bc0b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyCreation.js\":\"046dfdeabe1db586\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyNavigation.js\":\"f58b32def96f3735\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyValueContext.js\":\"4c58c91db85571a9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/react.js\":\"84517d082e8a3635\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeDate.js\":\"c2af34ce6a1d11d2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeTime.js\":\"f790d14ece9e2024\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/renderScope.js\":\"31a3a3c9235d3d24\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/resolvedThenable.js\":\"ef842d5a0e600f54\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/routing.js\":\"23cd37c58b8e9d53\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/safeMode.js\":\"0982d2267274034e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/scheduleIdle.js\":\"aff7814e39abd3ff\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/screenWakeLock.js\":\"026d10e4337514f3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/selection.js\":\"4c563dc604484d4e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/softKeyboardGrab.js\":\"6a52abb45ad49868\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/startupTimeline.js\":\"d81babb5d2075535\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/state.js\":\"8be4708cd4d873c8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/string.js\":\"23c0f6228657069a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/surfaceZoom.js\":\"97187cb4f5005660\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/time.js\":\"2578ab8097e1a322\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toast.js\":\"d21809383e111daa\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toggleStore.js\":\"908ba6cd7ad75574\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/untilStopped.js\":\"301f60bcc8bf9fd4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/userActivity.js\":\"8a3d42265a6743a0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewTransition.js\":\"9063fa5a4c2e8231\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewport.js\":\"8423abcb3974c12e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/webLock.js\":\"df7358f8f16b3180\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceRecovery.js\":\"42a19da3608738f1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceSnapshotStore.js\":\"7c62f689eb959c22\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-compiler-runtime.js\":\"fd14aba48789e515\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-client.js\":\"f8b49babffca3b90\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server-edge.js\":\"a845e0a578c4763e\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server.js\":\"3887fe413a003a77\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static-edge.js\":\"0e4993ac41cfb4c6\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static.js\":\"2b4670a981a8c8ec\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-test-utils.js\":\"6716f1e9cdb5c47d\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom.js\":\"09b45a550281e21e\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-runtime.js\":\"0a7fbc1367a4462a\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react.js\":\"2fa8f09c93c6498b\",\"/knowledge-medium/pr-preview/pr-1919/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
