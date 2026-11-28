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
		buildId: "68228bac60f8-3ef76b0e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/\":\"de942cb448737e50\",\"/knowledge-medium/pr-preview/pr-1919/index.html\":\"de942cb448737e50\",\"/knowledge-medium/pr-preview/pr-1919/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1919/assets/FacadeVFS-B6uLEty6.js\":\"7aa41e036a00e54b\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSCoopSyncVFS-BlTQX9s3.js\":\"ffc531704362af47\",\"/knowledge-medium/pr-preview/pr-1919/assets/OPFSWriteAheadVFS-DsJdPs12.js\":\"3fd95c23c610ef98\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-DlROgey1.js\":\"6939b26e849b016a\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/assets/wa-sqlite-async-lncq_ybC.js\":\"f7158d941bcb478b\",\"/knowledge-medium/pr-preview/pr-1919/assets/worker-fGhfelCd.js\":\"9944ebf8edc89357\",\"/knowledge-medium/pr-preview/pr-1919/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1919/chunks/app-DdaBqYYK.js\":\"e7f6549bd7e37407\",\"/knowledge-medium/pr-preview/pr-1919/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1919/index.js\":\"6487101f2689b2be\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1919/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1919/assets/AccessHandlePoolVFS-BoGPYxRf.js\":\"74f37af66f9474f7\",\"/knowledge-medium/pr-preview/pr-1919/assets/IDBBatchAtomicVFS-B8u5ZU6X.js\":\"20b6f1e29b5b097a\",\"/knowledge-medium/pr-preview/pr-1919/assets/MemoryVFS-DNXLA_-D.js\":\"9cc0d305448017b6\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-U-fIfgwd.js\":\"7a17c6f49a224a15\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-C3avf6-K.js\":\"a60cd44b1039984d\",\"/knowledge-medium/pr-preview/pr-1919/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1919/chunks/AccessHandlePoolVFS-CyLgFEgX.js\":\"fbec0bc8bae7b89a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/FacadeVFS-Bd6qF09Q.js\":\"ce30e6f296539ea7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/IDBBatchAtomicVFS-aznK2GLi.js\":\"8bb0f9d1d87b4941\",\"/knowledge-medium/pr-preview/pr-1919/chunks/MemoryVFS-Y6T8ThT3.js\":\"42923fde9edaa347\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSCoopSyncVFS-BKH8vD0o.js\":\"14970ebf5716bcea\",\"/knowledge-medium/pr-preview/pr-1919/chunks/OPFSWriteAheadVFS-CoVhRWLR.js\":\"d7e59c3e6b94cf3f\",\"/knowledge-medium/pr-preview/pr-1919/chunks/Preview-B1u637wf.js\":\"70e51d3ba145d5eb\",\"/knowledge-medium/pr-preview/pr-1919/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1919/chunks/card-D9cB-pnq.js\":\"a158217a93d2e407\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-Billmlmy.js\":\"2834c729ae1ea6c8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1919/chunks/freezeExtensionImports-2C8fC9qD.js\":\"5bd7e5e2507c85c9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1919/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-BKvlS76w.js\":\"a6f1a6c1d089a1c7\",\"/knowledge-medium/pr-preview/pr-1919/chunks/mc-wa-sqlite-async-B6EbCSq7.js\":\"663bca6c76ee6da8\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-BWHsTH9C.js\":\"c0c8d8e37a35aeee\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Bx5fIwRi.js\":\"24a69ad2b1027611\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-C4eOQ-ja.js\":\"f22b740ce8e5ace9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CLKNSDSN.js\":\"7542711bf8dc9045\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-CWMKE_uV.js\":\"93239098678e09b0\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Ce8tCftb.js\":\"7879a2aa61a4a789\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-DNMCnhRb.js\":\"27c8292b926094cb\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-Dob7mVPy.js\":\"a78316e531ad23c2\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server-legacy.browser.production-Q0Vpxw4u.js\":\"d8131814146a326d\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.browser.production-Cd60gFSp.js\":\"3e4cccedd81ea289\",\"/knowledge-medium/pr-preview/pr-1919/chunks/react-dom-server.edge.production-DINRms6a.js\":\"9d7b94e6810ddcd2\",\"/knowledge-medium/pr-preview/pr-1919/chunks/server.browser-CSxpHZFF.js\":\"6ab028b5e432ff31\",\"/knowledge-medium/pr-preview/pr-1919/chunks/textarea-BXG_1sCC.js\":\"ae7bdf5285768f02\",\"/knowledge-medium/pr-preview/pr-1919/chunks/ui-BaB5GYdN.js\":\"186096522fa53b2e\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-DiMwuaFR.js\":\"dc46ccc9a5bb52b9\",\"/knowledge-medium/pr-preview/pr-1919/chunks/wa-sqlite-async-DAMXKp9v.js\":\"fe5b0a07c6c5a12a\",\"/knowledge-medium/pr-preview/pr-1919/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1919/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1919/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1919/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1919/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1919/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1919/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1919/src/App.js\":\"f4974dc5474da3ba\",\"/knowledge-medium/pr-preview/pr-1919/src/appUpdate.js\":\"d0e1fbc5e35636a7\",\"/knowledge-medium/pr-preview/pr-1919/src/appVersion.js\":\"9251a83db7737250\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/initialLayout.js\":\"73b997806a742234\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/openWorkspaceData.js\":\"b4ac6f03bcc0970a\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/resolveWorkspace.js\":\"15822c0280c5877d\",\"/knowledge-medium/pr-preview/pr-1919/src/bootstrap/workspaceBootstrap.js\":\"91316a044f8d0e63\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockComponent.js\":\"40625e437f4eaa70\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockCrumbs.js\":\"06e0a2cf576e5bf3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockEditor.js\":\"ffc823150bd3fa6c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockLoadingPlaceholder.js\":\"26c9df11b4bb0d78\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockProperties.js\":\"b8275cdaffb7cecf\",\"/knowledge-medium/pr-preview/pr-1919/src/components/BlockSearchPicker.js\":\"236f967b6ef4e041\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ConfirmBulkDeleteDialog.js\":\"45626e9225a6ca66\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DividerHandle.js\":\"6a71c3756669c166\",\"/knowledge-medium/pr-preview/pr-1919/src/components/DraftEditor.js\":\"0d122bfb503ef581\",\"/knowledge-medium/pr-preview/pr-1919/src/components/GutterPill.js\":\"3af724d87c70a472\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Header.js\":\"b9b15d8340eb7686\",\"/knowledge-medium/pr-preview/pr-1919/src/components/LazyBlockComponent.js\":\"72047f1766956d59\",\"/knowledge-medium/pr-preview/pr-1919/src/components/Login.js\":\"a97d8d4b40c6b05c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ZoomableSurface.js\":\"b5dc2cf50487bdeb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/editModeKeepalive.js\":\"3f3b0491b13c3082\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyDisplay/PropertyDisplayScope.js\":\"e0636b16b5e2a51b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8a0faed83ee180df\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefPropertyEditor.js\":\"8b61408b6006d2e7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/RefTargetTypePicker.js\":\"a61e951c2318915e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/SelectPropertyEditor.js\":\"617164fd414699d4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/TypesPropertyEditor.js\":\"1afa922d971453c0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/defaults.js\":\"9e16b4b6a29a383a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/kernelValuePresets.js\":\"9af989074fed6362\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/selectablePresets.js\":\"e0bdc0d73910ccd4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyEditors/typesPropertyUi.js\":\"d41c226165a40391\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/AddPropertyForm.js\":\"5bc216fc0372b3a8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyPicker.js\":\"8e045bb425dcb64d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/PropertyRow.js\":\"1b1fab6fe8e9aa0c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/Rows.js\":\"867879f89e3b82e0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/actions.js\":\"3ece5b14b6ebc640\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/declarationOnly.js\":\"85f4a69aff505ae8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/layout.js\":\"1757b108c5e24949\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/model.js\":\"8dc35ebe701e8b17\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapeUi.js\":\"2d54f7354f33044f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/shapes.js\":\"22ff988ec12d6979\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/usePropertyEditingActivation.js\":\"174c7469dd4d798b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanel/visibility.js\":\"24fd9633edca74e0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/propertyPanelSections.js\":\"bedfa4b4a7577a3d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockEmbed.js\":\"c230cfc4ea4f3501\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockLink.js\":\"9f8c38005ef1e001\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/BlockRef.js\":\"6e570dab6f983c8e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/CompactReferenceLink.js\":\"9e5bf66d4ac952ec\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/ReferenceLink.js\":\"5eb1c323f6f1e39f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuard.js\":\"8e90c75d38dba0bb\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/cycleGuardContext.js\":\"f11b85bb5e9c246f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/linkInteraction.js\":\"48e7e824f2ec8f16\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/referenceLayout.js\":\"fc87e2491e9d5bcc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/references/useBlockRefAncestors.js\":\"b3e5ddfada2450dc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockGutter.js\":\"e6537d28daedcefc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockInfoDialog.js\":\"9557c03ab0bb8b0d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockReadText.js\":\"13ce7e6a03d03b6d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BlockTypeBlockRenderer.js\":\"28d301cde58637f0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/BulletHoverCard.js\":\"d1c800ffcc6a947c\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorContentRenderer.js\":\"99fbfb2daf595e58\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"6780a4b7f66f2cda\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ColumnResizeHandles.js\":\"33b20f1187d93f3a\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"f9b73975c28d051b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/DefaultBlockRenderer.js\":\"09ea4e0d1f171b04\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/LayoutRenderer.js\":\"06fc523bde6ed04b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MarkdownContentRenderer.js\":\"b93c3416d66bb509\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/MissingDataRenderer.js\":\"761e9ac67bbdcb00\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PanelRenderer.js\":\"62bf617838456aac\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/PropertySchemaBlockRenderer.js\":\"3f2a4ed5b67e9245\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/TopLevelRenderer.js\":\"49eb869bac525eb0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockGutterMode.js\":\"feebf4c354365ab1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/blockTitleText.js\":\"7f965a91f48014be\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/fieldCreationKeydown.js\":\"3620de3aa6f39999\",\"/knowledge-medium/pr-preview/pr-1919/src/components/renderer/layoutRootContext.js\":\"022a834eb006c231\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/TypeChip.js\":\"302dd8a7821ed7d8\",\"/knowledge-medium/pr-preview/pr-1919/src/components/typeChip/chipStyle.js\":\"318395aa00fe4b59\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/anchored-floating.js\":\"ededa2fba2f84289\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/button.js\":\"e48e4a81877bb698\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/card.js\":\"ad68313359ba385d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/checkbox.js\":\"6f49787faaf8f19e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/collapsible.js\":\"28fed3e167c61ace\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/command.js\":\"0b6c2a89cd5422e7\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/context-menu.js\":\"00fd74ac339ee8e4\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dialog.js\":\"049c6d64bce64aa3\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/dropdown-menu.js\":\"2157141d07ae7735\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/floating-listbox.js\":\"77492e3f9e543284\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/index.js\":\"b4696483deced4fd\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/input.js\":\"c51f1de74028a08e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/kbd.js\":\"ca6b5dcf9bb7a531\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/label.js\":\"6a49ca9683b03b79\",\"/knowledge-medium/pr-preview/pr-1919/src/components/ui/textarea.js\":\"f1e786896914f5f0\",\"/knowledge-medium/pr-preview/pr-1919/src/components/useEditModeYieldKeepalive.js\":\"a4b9d70640b9cc16\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/BootFallback.js\":\"c5a38d823ea290d1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/FocusedRowLazyMount.js\":\"1e50dc62ff2cf924\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LazyViewportMount.js\":\"53b8bfa346eb9b54\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/LocalDbCorruptionFallback.js\":\"aad7c8a1bc2e7c35\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/error.js\":\"94e31ab929b06960\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/lazyMountRegistry.js\":\"652355204b54c588\",\"/knowledge-medium/pr-preview/pr-1919/src/components/util/suspense.js\":\"29a6b6b88e31d636\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/CreateWorkspaceDialog.js\":\"ebfb5e6fe6ee396b\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/PendingInvitations.js\":\"5da6afb88fab25c5\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/SyncProgress.js\":\"249a60c19a85bd67\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/UnlockProgress.js\":\"e6189acb826d4aa6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceKeyGate.js\":\"28ae28ae07424e7d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSettingsDialog.js\":\"3c0fad20c6842642\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSwitcher.js\":\"3688f8c52e240d25\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/WorkspaceSyncGate.js\":\"2701ce43be7c6e05\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlow.js\":\"0b6f1ee5ea2765a2\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/ConversionFlowHost.js\":\"ce9bb2bd3eb570a1\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/EncryptionSection.js\":\"780bb22ae2c0c8a6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/attachmentPrompts.js\":\"f04e08bd23c09b30\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/bundleFolderPrompts.js\":\"3a8e0ad75ba6c1bc\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowDeps.js\":\"c21bf5be6faa911d\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/conversionFlowStore.js\":\"ab046f67b4372117\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/flowUi.js\":\"458d48735e0635e6\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/conversion/useConversionRun.js\":\"f0ee688d52c1857f\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/keyUi.js\":\"d603ba9f23b5c920\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnKeyLoss.js\":\"8e4a774e9c3b3505\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/useCloseOnServerE2ee.js\":\"e4ea267a54906d3e\",\"/knowledge-medium/pr-preview/pr-1919/src/components/workspace/workspaceUnlocked.js\":\"dd52e4712f8054c0\",\"/knowledge-medium/pr-preview/pr-1919/src/context/backgroundSubtree.js\":\"9a04aedc837cabfb\",\"/knowledge-medium/pr-preview/pr-1919/src/context/block.js\":\"86add942b62a576c\",\"/knowledge-medium/pr-preview/pr-1919/src/context/layoutWsContext.js\":\"9cc3b138809aacb5\",\"/knowledge-medium/pr-preview/pr-1919/src/context/propertyDisplay.js\":\"d1b069714e2e8e40\",\"/knowledge-medium/pr-preview/pr-1919/src/context/repo.js\":\"3dcdea853e736973\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasClaim.js\":\"6be81aa79acaffeb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/aliasSeatNamespace.js\":\"28a85c2e7972c4be\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockData.js\":\"6f3aa30f1e3bf631\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/blockType.js\":\"88bfb775d779a805\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/changeScope.js\":\"2d4a7aa5b3194808\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/codecs.js\":\"6c785afb7fb11b1a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/derivedData.js\":\"d16192d2476266f5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/errors.js\":\"ae10942801329298\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/events.js\":\"e94b65c492530eac\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/handle.js\":\"09f13771e148f3e3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/index.js\":\"7064288d2b3a7ac9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/mutator.js\":\"cc592459d247473a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/processor.js\":\"42d272577df3fa41\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/propertySchema.js\":\"79be99960e218ab1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/query.js\":\"2cb81e15f48f06a3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/sameTxProcessor.js\":\"7951918391a033b0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/schema.js\":\"09f13771e148f3e3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/tx.js\":\"09f13771e148f3e3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/typedBlockQuery.js\":\"83415fe36bfe683d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/user.js\":\"61058e2e89111af2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresetCore.js\":\"b61d43573d81e67f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/api/valuePresets.js\":\"142b90723e50d8c3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/attachmentCleanerIOVerb.js\":\"0da89d8133368aa0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/block.js\":\"51b86a4ac5c92cd7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockCache.js\":\"f0f980a8511e76aa\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockId.js\":\"2f7df09225752183\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockLiveness.js\":\"c7addae66767c342\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockMerge.js\":\"a5e1ea8b9565b6e1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockSchema.js\":\"504adcec73eb6baf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypeLookup.js\":\"726376c9754c3d84\",\"/knowledge-medium/pr-preview/pr-1919/src/data/blockTypes.js\":\"14f6bbd0fbcaf524\",\"/knowledge-medium/pr-preview/pr-1919/src/data/childrenView.js\":\"81ea1b5ea63b0134\",\"/knowledge-medium/pr-preview/pr-1919/src/data/clientContext.js\":\"56f8700ec64bd6f9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/dbFileSiblings.js\":\"889b5cec039d9b88\",\"/knowledge-medium/pr-preview/pr-1919/src/data/definitionSeeds.js\":\"9ce404b9b0cfacfe\",\"/knowledge-medium/pr-preview/pr-1919/src/data/derivedIds.js\":\"6ff1da6c4f59998a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/drawnSubtree.js\":\"dc4afbc0167c3171\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facetBridge.js\":\"9472cc6d7e94e585\",\"/knowledge-medium/pr-preview/pr-1919/src/data/facets.js\":\"0ef12a7974b268ce\",\"/knowledge-medium/pr-preview/pr-1919/src/data/globalState.js\":\"64e4ebd836c98acd\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/aliasClaimRederiveProcessor.js\":\"780771da92dfd290\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/ancestorBatch.js\":\"4b14b8f024efed61\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/blockTypeTypeifyProcessor.js\":\"dcb0471030cbe9fc\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/clientSchema.js\":\"649fecd1c625c35c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/commitPipeline.js\":\"58a54cb27e331e36\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/devAssertions.js\":\"adf873e6a3e40624\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/firstSync.js\":\"9c6957551b5b7f08\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/freshInitialLoad.js\":\"a2ae398c5a306493\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/graphBackfillClaim.js\":\"19cbf96b4bf92663\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/handleStore.js\":\"2c8217a6a1991c7f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/idleMarkerJobs.js\":\"8de18759d7d0c9f2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initialDownload.js\":\"60278aae6fe582e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/initializeClientDatabase.js\":\"d0277cc137284a0b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/jsonCanonical.js\":\"094a92366258c18a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelInvalidation.js\":\"c93755b9a38b288a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelProcessors.js\":\"387ebdcb4e96a708\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/kernelQueries.js\":\"986162fcea9ab768\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/mergeTypeMembershipProcessor.js\":\"7e2b4323391f562d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/normalizeReferencesProcessor.js\":\"5088d00a8ae6cf22\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/poolInstrumentation.js\":\"5cfd28a9491f2db7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/processorRunner.js\":\"39353d8fe04e137b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyCellBackfill.js\":\"a9cbc19a579e70b3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildMint.js\":\"1ca1d2418027fe7d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyChildrenProcessor.js\":\"5e2e8ff342c0b7a9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionChangeProcessor.js\":\"c28fb19bc60f365e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyDefinitionSynthesis.js\":\"2781bdc3a3230f52\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyKeyScan.js\":\"d22e93d215c8d12e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertySchemaResolution.js\":\"79b9026c861e3683\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/propertyValueEdits.js\":\"1397e7946a619a28\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/raiseProtocol.js\":\"f0c81c166bb23556\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/readBatch.js\":\"f4313d5d6314f048\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/refProjection.js\":\"3e7b2cba524c25c3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetLookups.js\":\"02f5cb5c29be529f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/referenceTargetProcessor.js\":\"a42d06f586356393\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/replayMerge.js\":\"bf42822d2b7b4bf2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/sqlBinds.js\":\"b0ef03c86b375adf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"476cdea50e1e45be\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/arrivalProcessors.js\":\"e52a1ca1296aab60\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/invalidate.js\":\"255ce884d4f21059\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/materialize.js\":\"c764136b93d750b5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/observer.js\":\"f294686634d9cdb8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/syncObserver/reconcile.js\":\"6bef7ed359500cca\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/timingMetrics.js\":\"966d1690212514a4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/treeQueries.js\":\"4557d354c96c385b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txEngine.js\":\"7d0e609d435cad7e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/txSnapshots.js\":\"abd6506f17f6ac43\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/typedBlockQuery.js\":\"f12c7b2a605caa3d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/internals/undoManager.js\":\"7810c8accacb2d62\",\"/knowledge-medium/pr-preview/pr-1919/src/data/invalidation.js\":\"d692f2e08c9973f2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelDataExtension.js\":\"39682b8092fc5135\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelPage.js\":\"461bada6f11f28a3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/kernelValuePresetCores.js\":\"15f8e488cc7c7a39\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbCorruptionSignal.js\":\"b6ad0c5ab384c7c4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbStorage.js\":\"c9c23c70ce23b349\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localDbVfs.js\":\"7d56cea10019d81b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/localSchema.js\":\"8fd89b67248b944c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/maintenance.js\":\"7a39f2b0a51420ac\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mergeProperties.js\":\"966d1f6b679bbc23\",\"/knowledge-medium/pr-preview/pr-1919/src/data/metricsConsoleHook.js\":\"6de26709ec46c365\",\"/knowledge-medium/pr-preview/pr-1919/src/data/migrationsPage.js\":\"43a41ce2c55111f1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/mutators.js\":\"6a1d4706db33d50c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKey.js\":\"d91cf7fb72e590c4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/orderKeyPlacement.js\":\"2a99ab5579ed9358\",\"/knowledge-medium/pr-preview/pr-1919/src/data/outlineSurface.js\":\"5b176216694c7f49\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingEditorContent.js\":\"203e9f796fff1c44\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pendingUploadsSql.js\":\"7bd4504a7f5981ee\",\"/knowledge-medium/pr-preview/pr-1919/src/data/pluginStateExtensions.js\":\"a922f9cebc04e19d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/powerSyncLogger.js\":\"69b1c462336a4a65\",\"/knowledge-medium/pr-preview/pr-1919/src/data/projectorRuntime.js\":\"7c50ce43cb616f30\",\"/knowledge-medium/pr-preview/pr-1919/src/data/properties.js\":\"dcb89ee59940ac6d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertiesPage.js\":\"de71745f9a3066cf\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyChildren.js\":\"b92472b127ce8c9c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionFanout.js\":\"dea80678ede6377a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionMetadata.js\":\"3b7fa80241b736e7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDefinitionRegistry.js\":\"ee5f33687842a0e3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyDisplayMode.js\":\"0835a9d5a437a9c7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertyRowCreation.js\":\"41cd8cef03649aa0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySchemaCreation.js\":\"390900c3ba14851e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/propertySeeds.js\":\"a424f846058479e1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/recentsPage.js\":\"6992e4c9925a091b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/refTargetComparableProperty.js\":\"e4f63776895142c6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/referenceBlock.js\":\"dd57d1828854ca26\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rejectedUploads.js\":\"6f472aee20133cc6\",\"/knowledge-medium/pr-preview/pr-1919/src/data/releasePowerSyncConnection.js\":\"e0cc792c4070c58e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repo.js\":\"abeba7bb463a7a15\",\"/knowledge-medium/pr-preview/pr-1919/src/data/repoProvider.js\":\"ddf30da93d801b51\",\"/knowledge-medium/pr-preview/pr-1919/src/data/rowProperty.js\":\"4a506badd5468388\",\"/knowledge-medium/pr-preview/pr-1919/src/data/searchFilter.js\":\"4fa47b3154362e7d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/seedIdentityLedger.js\":\"d213f776eda13f9e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/stateBlocks.js\":\"5280b51cea7002ad\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralEditPolicy.js\":\"db5505758ce890a7\",\"/knowledge-medium/pr-preview/pr-1919/src/data/structuralInsert.js\":\"53db93346c286b5c\",\"/knowledge-medium/pr-preview/pr-1919/src/data/subtreeDelete.js\":\"27f9101ae70fc64d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncStreamLock.js\":\"75aaa5a7ab56557b\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableSqlRecognizer.js\":\"0fa4f84fa9f72b13\",\"/knowledge-medium/pr-preview/pr-1919/src/data/syncedTableWriteGuard.js\":\"21f2b832f7d1440a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/targets.js\":\"04dd67637a47d835\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeColors.js\":\"d45975ae93f6b344\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionMetadata.js\":\"641ca4c186c112f3\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeDefinitionRegistry.js\":\"f7e202219dfe04f9\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeExtraction.js\":\"e4c206f6e8d97de5\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeInitialValues.js\":\"777e2c15994ec5e1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typePropertyGroups.js\":\"70fa017efe4b9552\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeSeeds.js\":\"6db655a38c8d5e1e\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typeTagger.js\":\"52d7be96fd8225c4\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typedRecords.js\":\"c3467f17fbcc3374\",\"/knowledge-medium/pr-preview/pr-1919/src/data/typesPage.js\":\"3ec6ba1d2a1e1f2f\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userPrefs.js\":\"0945a5351f1760b8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userSchemasService.js\":\"f675d820f6af5f4a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/userTypesService.js\":\"98ec81ddf04296f8\",\"/knowledge-medium/pr-preview/pr-1919/src/data/valuePresetRegistry.js\":\"7bfd5b0d5412a385\",\"/knowledge-medium/pr-preview/pr-1919/src/data/visibleChildren.js\":\"02a6fd1f618a02b1\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceConversion.js\":\"8da8845d3e8e1649\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceFirstSync.js\":\"a4274692d7d70fb2\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceIdNamespace.js\":\"69f1e5f3981c02bb\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaceSchema.js\":\"eb7c1a72aec6bad0\",\"/knowledge-medium/pr-preview/pr-1919/src/data/workspaces.js\":\"2ea41b02c9ee3a5a\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadLog.js\":\"bce52dbd7dcf234d\",\"/knowledge-medium/pr-preview/pr-1919/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/BlockPasteShellDecorator.js\":\"53962bb215948e81\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/atTrigger.js\":\"b5f36e889bb047f6\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/autocomplete.js\":\"2685cbb7ed98bafa\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/codeMirrorExtensions.js\":\"39ae2fc401bbd212\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/contentFlush.js\":\"a7dc878cf1ee1929\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/defaultInteractions.js\":\"8195b83c97d48b7c\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/editSettleSignal.js\":\"e0493d067a7197e3\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/insertImage.js\":\"6555a2bf2e163ed3\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceCompletionRange.js\":\"a7605e6888300922\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/referenceTargetTypes.js\":\"df47793bd683559c\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/syntaxContext.js\":\"c5fc525a3fb03e9d\",\"/knowledge-medium/pr-preview/pr-1919/src/editor/triggerMatch.js\":\"104bbc1c724e5191\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/AppRuntimeProvider.js\":\"bf9fdaae35d3d26b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/BlockFocusShellDecorator.js\":\"ea73fb67a06a9583\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/ExtensionRenderBoundary.js\":\"04ee814152969185\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/PanelContentRecovery.js\":\"e1ef34ff604394c8\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/apiCatalog.js\":\"0067cef64d501ec3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/appRuntimeController.js\":\"7693a8d0f475c37a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/approveExtensionHere.js\":\"3240a46abbca649f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/armedCutAppMount.js\":\"0d7181caac18853a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/batchableKeyedStore.js\":\"afe2b7925241d879\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockInteraction.js\":\"3f05c245be9a0c85\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/blockSelectionAction.js\":\"e965b7ace895242e\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compileExtensionModule.js\":\"16a640ca22be9fee\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/compiledModuleCache.js\":\"fdd073984335f0d2\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/continuousGestures.js\":\"74e7c11d81542ecf\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/core.js\":\"9cc1111d64874411\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/defaultRenderers.js\":\"3d635d9fb7a32b1f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/definitionFanoutAppMount.js\":\"7f6ea5ad2d64942f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dialogAppMount.js\":\"ca3e0a11b94085d5\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensionSeeds.js\":\"fdd7f94b9348e7ae\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/dynamicExtensions.js\":\"b422f42a4c08031a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/exampleExtensions.js\":\"f3b07d736a19fb48\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionApprovalStatus.js\":\"fe0c993f4aab88f3\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionImportPolicy.js\":\"f0414beb14480ee9\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrorToast.js\":\"7192ca1853b06a6c\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLoadErrors.js\":\"988df62c2855a155\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionLookup.js\":\"a745675c4d16b25a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionToggles.js\":\"3729b4aba61314a1\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/extensionUtilitiesCss.js\":\"0fcae49f748aa653\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/kernelPageDeletionGuard.js\":\"7a54c2532101740f\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/liveRuntime.js\":\"cce256d80d51267a\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/normalizeExtensionSource.js\":\"3e6483a32170e5b9\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/openExtensionsSettings.js\":\"cfa2577253a61196\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/overridesCache.js\":\"fdffeb18c5b8df04\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/pluginIds.js\":\"58c813fd01605601\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/processorRejectionToast.js\":\"f0e0800a9dcebc74\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeActions.js\":\"fca3725588a80fda\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/runtimeContext.js\":\"e84d9ec0be3b8a97\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticAppExtensions.js\":\"54530e43c35ce0b6\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/staticDataExtensions.js\":\"414d850bfecbaa46\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/toastAppMount.js\":\"488adefb81f7e531\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/transpileExtension.js\":\"32e96fcff010481b\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useOverrides.js\":\"cf5476a154c12ff7\",\"/knowledge-medium/pr-preview/pr-1919/src/extensions/useShortcutSurfaceActivations.js\":\"ddbf81845184d606\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/discoverToggleTree.js\":\"b1a4d16f8e237713\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/facet.js\":\"19226d36ff3fa817\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/resolveAppRuntime.js\":\"83f3275b2844063b\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/runtimeEvents.js\":\"383bace29068f492\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/togglable.js\":\"83d46595be2c7d96\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/variantFacet.js\":\"ba8a9bb098781c63\",\"/knowledge-medium/pr-preview/pr-1919/src/facets/verbFacet.js\":\"733c0d692cea9a54\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/block.js\":\"aa27bfa6360ac3b3\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/focusedChild.js\":\"2e4162cd3f51ec0e\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/propertySchemas.js\":\"63771c6e89a364da\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/typeRegistry.js\":\"5a6602510ebf43ec\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAncestorCrumbs.js\":\"5d1e0129c9cb7d37\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useAutocompleteListbox.js\":\"5fbb890635847460\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedSearch.js\":\"fad93e3dbcc02225\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useDebouncedValue.js\":\"01b2b1b1a1cca4e6\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useFacetValue.js\":\"ce088f5ba042b5fe\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsFocalRender.js\":\"e934beeba3fd5990\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useIsReadOnly.js\":\"60d053b3feb91239\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMaterializeBacklog.js\":\"70aa05b32d545a6d\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useMinuteClock.js\":\"f0721d3c0c25ef19\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePanelLayoutProjection.js\":\"e0ddded8505ec3ec\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/usePendingInvitations.js\":\"96801f49ba2c4174\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRendererRegistry.js\":\"b38583356e04ca24\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useRetainedFieldRows.js\":\"5dc8b88088c8d753\",\"/knowledge-medium/pr-preview/pr-1919/src/hooks/useWorkspaces.js\":\"07f5809e7c52e3e5\",\"/knowledge-medium/pr-preview/pr-1919/src/lib/utils.js\":\"0eb4a4487a9dca6e\",\"/knowledge-medium/pr-preview/pr-1919/src/main.js\":\"928441e3365c4c03\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/MarkdownImage.js\":\"5923c1d734f3c679\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/blockSeparators.js\":\"6fea697cef7191f3\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/context.js\":\"2dd4da63264f8ac3\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/defaultMarkdownExtension.js\":\"f01dd55043be52ae\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/extensions.js\":\"6ddc4c02e1635cfc\",\"/knowledge-medium/pr-preview/pr-1919/src/markdown/renderMarkdownHtml.js\":\"0dd9bd2fbd5502c7\",\"/knowledge-medium/pr-preview/pr-1919/src/minimal-editor.js\":\"1cf5c77defa94389\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/armedCut.js\":\"649926c0f55256d6\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/captureMediaVerb.js\":\"564988df79928b11\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/clipboard.js\":\"f82766f738ed059f\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/decision.js\":\"c14433b59b7ff7db\",\"/knowledge-medium/pr-preview/pr-1919/src/paste/operations.js\":\"02d7aa6a0cd170d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/AccountHeaderItem.js\":\"f3bc65d7193184e0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/account-header/index.js\":\"a5af8889d2521521\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"35557a5987bcdddb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askAgent.js\":\"bd6aa701577a8ca5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/askedStore.js\":\"5d4af2c949b68bd9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"b4c32dc9fcae9359\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/chipState.js\":\"4fccf1fee3c9b78c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/dataExtension.js\":\"992b655dc7bc477b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/index.js\":\"30602d674c40f98e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"5517f38978c77bf8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-dispatch-companion/schema.js\":\"2d3bb4fcf430d275\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a338acb9fdf1621f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/BridgePairingDialog.js\":\"2cb8349f3d6041be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/addMedia.js\":\"e9eba2fad1a8dc3b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a6fbc00f36808fde\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/block.js\":\"4c988bd8e56791fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/context.js\":\"569fd183ee3beabc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/displayIds.js\":\"99235955aca87669\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/index.js\":\"5b721a46cec45bc6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/outline.js\":\"9ec4624ece06fefb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/properties.js\":\"9a41348b553615b2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/refs.js\":\"b255386e709aa66c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d6afbad261372ba9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/search.js\":\"15660d0a37897191\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/shared.js\":\"2e43f6de95d48675\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"5186ff2beb187a38\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentViews/text.js\":\"638f30fdbb23af0f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/agentWrites.js\":\"f6c1368f6b9e153c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/authoringCatalog.js\":\"9f002c286c4d8a6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/blockRefTargets.js\":\"6a1a4a3b4b461c27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridge.js\":\"5b18ffd3502374c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/bridgeLoop.js\":\"341e8e8270579a6d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/changeHistory.js\":\"1afea05864079111\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commands.js\":\"d3e4aeafaf4fc18d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/commentsCommands.js\":\"c9daa49a3b4bf45b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataExtension.js\":\"e78c08141b37f175\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dataModelGuide.js\":\"a0d4027dc1aaa18c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/dayPropertyInputs.js\":\"9a0fbb9f97e197c6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/describeRuntime.js\":\"3945358e73a37b97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/extensionLint.js\":\"78e6aa5a8e62e2f7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/grainAudit.js\":\"30ebd8663e87bb33\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/healthCommand.js\":\"53f099562d116a4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/index.js\":\"947c4297f14f5e8c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/presetIdentity.js\":\"b490f1170dabe187\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"e53fcd88ed21aebd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/readMedia.js\":\"7aa598821387cf04\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/schema.js\":\"575530735372d194\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/serialization.js\":\"f8b254ff44f63730\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/targets.js\":\"95b14821509a9479\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/tokens.js\":\"df37a92601ac2b62\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/watchEvents.js\":\"04e7941b2ccf7569\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/workspaceGuard.js\":\"6e1ea91d7bdc829f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/agent-runtime/writeCommands.js\":\"4f7d7e3d677a3e24\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/AliasCollisionToast.js\":\"9035c1d10ff48fbb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/DuplicateNameBanner.js\":\"44339a7f72f5ed76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/collisionMerge.js\":\"8296e4f6e4d0621b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/dataExtension.js\":\"abd2710becfd7c84\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/index.js\":\"e9f3d123a30e4e3d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/mergeCollisionAction.js\":\"d5f883ba038cc64c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/pageStyling.js\":\"1ac96ee4c52cb2b7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/rejectionToast.js\":\"9c796d77308d5659\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/alias/syncProcessor.js\":\"6c33806cbce11a65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/actions.js\":\"dd340928bdaeb38c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/addComment.js\":\"287cbae23141e049\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchor.js\":\"019efd09738ea8d2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/anchorState.js\":\"f6e6ed89de8e1acf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/commentLinks.js\":\"d4bda4413a3ed125\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/confirmThreadDeletion.js\":\"3c11253d9cea3311\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/container.js\":\"2c253ae6ca25dd9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/dataExtension.js\":\"1959b2333e110310\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/deleteComment.js\":\"e61ee208085a0145\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/highlights.js\":\"993ffa9966f6e6f0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/index.js\":\"f8705d44e423ecd3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/linkedCommentsPill.js\":\"b4a33a514fe6d7cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/margin.js\":\"c7f084ad53b1d702\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginAnchorLinks.js\":\"d50db24f7c7c5e8a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/marginSchema.js\":\"93600fa8deccfda1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/newComment.js\":\"2c2b5d75af6fcab4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ownThreadPicker.js\":\"d53bb8325031da5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/placement.js\":\"f889558589046ac2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/queries.js\":\"f7c89a18f282045b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotePosition.js\":\"99ada8854976ce11\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedIn.js\":\"08f08a84c01ad0e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/quotedRange.js\":\"76cc30a4580fbdf4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/rangeRefs.js\":\"2a9709c793b16aa1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readHighlights.js\":\"740c93c90d531de1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelection.js\":\"7660c01d58dba68c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/readSelectionUi.js\":\"1a949a6189466427\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/reanchor.js\":\"93702748501796a6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/schema.js\":\"c71b13bab2fa0a9c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scope.js\":\"376f1d59a22167f5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/scopeThreads.js\":\"c47775ac037fae0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/splitRetarget.js\":\"2eb6620ecc4d431a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestionCard.js\":\"0afd341b1d656b2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/suggestions.js\":\"d0f192b0242ea7ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaries.js\":\"0187d79b7dd8c21b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/summaryBatch.js\":\"36bbfef1abbfc143\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/surface.js\":\"04e671236cc22135\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threadNavigation.js\":\"9bd8d249e338424b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/threads.js\":\"1ac47d3f24bd155c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/ui.js\":\"ea0028a836426550\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/annotations/uiStore.js\":\"7ef97c4c2111b0bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/appIntents.js\":\"fd39de7a453f67d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-intents/index.js\":\"ece529d9c7edc3f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/index.js\":\"729c90655e082d60\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/app-update-prompt/status.js\":\"67e526daea235aa4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"056f782f13e1b849\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaBlockRenderer.js\":\"8fa9ceff34a880ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaDownLaneReplicator.js\":\"a57b4a9b662325c9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/MediaUploadReconciler.js\":\"772ad1d4167831fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetDownLane.js\":\"3bc91ac58e31dbd2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetResolver.js\":\"5117da5de9e34f19\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/assetUpload.js\":\"58a5f0d89a82f812\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/attachmentCleanerIO.js\":\"83ef322525f1e948\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/supabaseAuditIO.js\":\"67ea2608a406a808\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/blobStore.js\":\"cef16474f9877734\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/browserMedia.js\":\"7fc34bc38c9828ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/byteStore.js\":\"7d8b988c4d3f5d4a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanerIO.js\":\"f3ed271a1b829d0a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/cleanupAttachments.js\":\"401bfe0225902e32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/dataExtension.js\":\"d0c0fde55a60cecc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/downLane.js\":\"38c6d47ecd07a39d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/index.js\":\"9fbf7d504e2f840f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/insertImageContribution.js\":\"66ba961a8a07c99a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneArming.js\":\"37b85d9b197183e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/laneLock.js\":\"b5dd1cca3c8c1e7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaBlock.js\":\"5bc5c0cecc3fe10b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaCapture.js\":\"fd9380133dc38dc1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaLanes.js\":\"9f1973307ff29de8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewers.js\":\"8807fcf8dd8b0f78\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/mediaViewersFacet.js\":\"a2b667c45c53eafd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/pasteCapture.js\":\"721d1e334f0fe374\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/resolver.js\":\"82598ab707a909a1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/retryUploadsAction.js\":\"23e50f67226e8aa8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/storagePaths.js\":\"3301dd487ca1acab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadDrain.js\":\"f402bc027b2630e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadLaneStatus.js\":\"c190c0c65afc6781\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadReconcile.js\":\"95c6265af39f9efd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadRecovery.js\":\"58130140831c586c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/uploadStore.js\":\"b2b9ef4c3631f508\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/attachments/useAssetObjectUrl.js\":\"a51b4f489f83340e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"52e2680cb61c73e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/BacklinksViewSection.js\":\"c103226de4ce4cf7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/facet.js\":\"8319f4b0d0f2749b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/index.js\":\"b90b452ca0768e33\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks-view/prop.js\":\"be9e67e34a8cc023\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinkFilters.js\":\"cdb0d57ea17223e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"ad573a629bab1158\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/BlockEntry.js\":\"a5681246f8a7dbe3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/LinkedReferences.js\":\"98f2e8b97d4452dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"11037149854d2515\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dailyNoteDefaults.js\":\"78bab9e48c696eba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/dataExtension.js\":\"7c3c3e1e0b007bb8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/edgeExclusions.js\":\"532eb3286a2dd820\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/filterProperty.js\":\"f4441a9d3ce16030\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/index.js\":\"7ef4dc9b38a9ad13\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"5d1675d99445483c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/applies.js\":\"ecf15f6545837ff2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/countQuery.js\":\"6839b342a97c79ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/expansionStore.js\":\"87933a06b4db90ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/index.js\":\"eada8b4ae01bffce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"c683e73e503ca5af\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/presentationInvalidation.js\":\"59d2acd346153ae3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyEditorOverride.js\":\"4690d10a56356afe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/propertyFilter.js\":\"4f125a51e4425745\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/query.js\":\"b83c34e530b706a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/resolveFilter.js\":\"663c95a6966aeeb2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sourceBatch.js\":\"b44191db87b499b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/sources.js\":\"489d69fb95992d70\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useBacklinks.js\":\"efbbbd461bfded4c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"6ff25fb3999d4c0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayCelebration.js\":\"94f6be3ab0ca3776\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/BirthdayOverlay.js\":\"e39b973692a9e936\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/gate.js\":\"b956cea6d0c3d0b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/index.js\":\"e5f9769ab1dda753\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/birthday/wolfTheme.js\":\"9cbf4ea3c5163a77\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/BlockDragLayer.js\":\"d439ceb4d8a7fb16\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dragController.js\":\"e7125ca483da4db3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/dropTarget.js\":\"58bac24292c35af7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/index.js\":\"2cd3c2e0128cb330\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-drag/projection.js\":\"94595fdd5cc7c852\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/BlockMetaCard.js\":\"5b4aa50ebace34b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-info/index.js\":\"ee7d4c9c4e9b3a05\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/AddTagDialog.js\":\"aecc27f21987bae2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"9318ad4688685d7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/TagNameIssueHint.js\":\"fbe57cdb7fed203c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/addTagAction.js\":\"36892467a5268536\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/appendTag.js\":\"2135a52da8ddf634\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/config.js\":\"cca72b40992f5eab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/dataExtension.js\":\"20e25f4ca3a3bb7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/index.js\":\"a024cde8d58aa0fe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/block-tagging/propertyEditorOverride.js\":\"007fc6be6c24e61f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbList.js\":\"e26a2e46b6adc233\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"895b35b29b987249\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/Breadcrumbs.js\":\"7f892be4faea0ee0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a1c3da019ab18834\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"e87496e8c109a305\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/index.js\":\"7c40be0cc47c8a15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"eeade0563af85a8f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/CharacterCountItem.js\":\"89ed92a3ea8f7321\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/ProfilePropertyEditor.js\":\"6d5b68d4895e66c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/actions.js\":\"93528e8c338222b3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/blockType.js\":\"b6cb8d7d0dcfd00a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/charCount.js\":\"ad355d8cc87eb77a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/dataExtension.js\":\"72e29abcf67d6192\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/index.js\":\"69d53874666e9cc1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/profiles.js\":\"524d3d265a9db93a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/properties.js\":\"b4005f2087e10b80\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/subtree.js\":\"af0254ab27bcb6df\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/character-counter/textCounts.js\":\"f473984fdaff4023\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/colemak-keybindings/index.js\":\"ed88cb9f29fbda15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/CommandPalette.js\":\"e099cf3fd16dc0eb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/HeaderItem.js\":\"0b1cf3ba8b929e37\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/context.js\":\"cbd7a28310ec8e2e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/index.js\":\"93e5490ba61fc6a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/selection.js\":\"e3de7debc1097fdd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/toggleStore.js\":\"be7df3f7711f1f18\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/command-palette/useCommandPaletteActions.js\":\"ac2d678e680ad632\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ContributorBadges.js\":\"4b1a06316c373432\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/ProfilePicture.js\":\"ea51af8e1b719aac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/author.js\":\"b07b0c241b0153b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/codeMirrorExtensions.js\":\"6d5e5d38bc6cb584\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/dataExtension.js\":\"6cc8b8170bc21bbf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/index.js\":\"864c0fb0f3d65051\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/mentionAutocomplete.js\":\"2c6ad52fb14c0f00\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/processor.js\":\"2fe1b4fed25508c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/profiles.js\":\"5129cead8bc56f90\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/queries.js\":\"8b9c3998bb914e0a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/schema.js\":\"0b1307c83ada8c30\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/contributors/useCommentAuthor.js\":\"70cde28c6862d32c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"26c9caa8e1424dca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/followOrigin.js\":\"a6387acb40220e7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/index.js\":\"e09343cdb561159d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"4fb3ba57761066e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4727d38bd52a16fd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/CalendarGrid.js\":\"eb9b803095b8abe6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DailyNotePicker.js\":\"42e8c009ea7b4821\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"7713e0318bd4bb03\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateNavDecorator.js\":\"0b50066168002b71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DateScrubOverlay.js\":\"a1cc9e3e4cbb2187\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayPropertyControl.js\":\"2149b2f945245fea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/DayValueReferenceControl.js\":\"3e99d0c0908db5c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/HeaderItem.js\":\"6e1aa62162a75e5d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/ReschedulePicker.js\":\"e5064ec8f254f4ef\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/SpreadDatesDialog.js\":\"661ca0f1e9fe1554\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/actions.js\":\"7d39f0423e7153c5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/blockDateAdapter.js\":\"1526eacae024f307\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/calendar.js\":\"b377faf0cbb12d8d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dailyNotes.js\":\"879e52ed6fe54ac4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dataExtension.js\":\"fb367e3ddf224171\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubActions.js\":\"aff2c3733b779725\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGesture.js\":\"a9a7749e0b609072\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubGestureActions.js\":\"62c5761a56be1e23\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dateScrubRecognizer.js\":\"8074e2e23fd8e288\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayProperty.js\":\"4e0c992f204c98ad\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"2541b37bf6bb01f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/deletionGuard.js\":\"8faef7b9e4c35057\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/dueQuery.js\":\"05593e910505b364\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/index.js\":\"8cc51fb1e9569acd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/landing.js\":\"83f9f8cd252d36fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/localSchema.js\":\"d4ad5186db9ddfe5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/referenceDateAdapter.js\":\"3fe55fee412c1298\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/rescheduleAction.js\":\"fb5c7a44e493d54a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/schema.js\":\"7be7d2c4d031562a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadBlockDates.js\":\"08cc2b625e3dd637\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/spreadDatesAction.js\":\"0b90e5d8d7ff4fac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/today.js\":\"0ca665bd0784cb9d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"8c9cb0737a2f36ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"1a5b329e89778ec0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/audit.js\":\"41ee29e775e3acee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditAction.js\":\"63ba45edafea0ca0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/auditRanges.js\":\"5517db208f2a642b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/diagnosticsSource.js\":\"1386cda67e8fdd88\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/divergenceScan.js\":\"d8b1ab5190e5a159\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/index.js\":\"283e07af439f0f76\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/propertyChildrenChecks.js\":\"15168b3cebdb446e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/referencesMirror.js\":\"268f5656b13e67c3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/rowJson.js\":\"feb1b8dbbc26c8b4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/schedule.js\":\"74f25fb3139b333d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/data-integrity/store.js\":\"ab290f49eb9fde82\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/action.js\":\"0f652e26f13f2307\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/index.js\":\"2d5275bc1d834232\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-maintenance/plugin.js\":\"9b323763a0418e0e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f897e37ad9e4c749\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/actions.js\":\"7a5257a129dc9e1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/changeMarker.js\":\"28c98257768c6c1a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/diagnostics.js\":\"47e522972e76e99c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/fileSystemAccess.js\":\"360421cece31b6fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/filenames.js\":\"a83b7d830dc2294a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/index.js\":\"77d67b36165140d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/mirror.js\":\"977c9a748b01eb40\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runLock.js\":\"51424d75c32ba968\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/runtimeHealth.js\":\"099084f9b6950f9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/schedule.js\":\"3e3c298b3159f697\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/db-mirror/store.js\":\"9a078c783277cd6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/index.js\":\"0518cb8abc3460a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/default-themes/themes.js\":\"b19b4f0e19d6df0a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/facet.js\":\"1e2998b23d531ff5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/diagnostics/useDiagnostics.js\":\"87cdc46f6aa6cbc6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/dismissals.js\":\"83012e7b94c5d5ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/index.js\":\"3f7a3500a73e4421\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/status.js\":\"5e9bdf9029cc2e66\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extension-prompts/store.js\":\"c03dc99ba3d8fc94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"9dd2f0ce9b448ec0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7d57646cbcc7fb3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/actions.js\":\"95d5659830106f57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/config.js\":\"7d707fdeace1b83d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/dataExtension.js\":\"06553521fa9fab6e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/effect.js\":\"d47314ceb80aa736\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/index.js\":\"6260c930c9c75b7e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/propertyEditorOverride.js\":\"b9ad9c6c731d3198\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extensions-settings/useToggleTree.js\":\"06ef77681fb69f94\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/ExtractTypeDialog.js\":\"f7e1aa4644f1f0a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"415d38fb863223a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/PropertyShapePicker.js\":\"1783f45e8a5666a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/action.js\":\"473e426f6b080f81\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/extract-type/index.js\":\"3d4c0c44d9e3ef2f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/FindReplaceDialog.js\":\"f2a27c28731206ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/HeaderItem.js\":\"6efca97891228efd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/dataExtension.js\":\"b17573da75f6c709\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/index.js\":\"2125f704ad0f8816\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/search.js\":\"6e653c7ea275d182\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/toggleStore.js\":\"3d53b334eb403de1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/LocationPropertyEditor.js\":\"cfbbfd4595600785\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/MapView.js\":\"31dd19f6098fe605\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/blockTypes.js\":\"6e5f960f2df584f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/codeMirrorExtensions.js\":\"b5f64d42cb3b874b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/createOrFindPlace.js\":\"9ea3663d3268ffc1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/currentLocation.js\":\"81d3c11065bc836f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/dataExtension.js\":\"4965ca9001705e56\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/geoContentDecorator.js\":\"755e92f0e4350033\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/googlePlacesClient.js\":\"58d3f4484b38d327\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/index.js\":\"e10bafd54b8bc258\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/locationsPage.js\":\"640d9a9874eceba0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/mapViewport.js\":\"a76bdd4d49f6f428\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/pickCurrentLocation.js\":\"74a04527a0838fa8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeAutocomplete.js\":\"60fab3892dc18926\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/placeNameCollision.js\":\"30314f6d196b5e2a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/properties.js\":\"b44c195cdf767f39\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/propertyEditorOverrides.js\":\"b48cbb82d62b8afc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/query.js\":\"d720404db8f30623\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/geo/usePlaceSearch.js\":\"e64c06e17bc8e243\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"ead82e32fc02e405\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"871d5fd1f84a06e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"0bd4a984de39cf36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/config.js\":\"f40add7909bab59f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/dataExtension.js\":\"69d610a288c87034\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/facet.js\":\"12993853ce87b43d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/grouping.js\":\"c60a7976876f8395\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/index.js\":\"df730bb081b5a85c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"bf0bf40b5b5136ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/query.js\":\"9bcae99810fd0aa4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/resolveConfig.js\":\"3d20d82300c7d27c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"2cc9be4a98376ef5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"d5185026b4a378ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlDocumentContent.js\":\"a3041ce281c1ebca\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/HtmlFrame.js\":\"3c68ca4b98e487ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/actions.js\":\"6113b4b17d601f32\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/blockType.js\":\"314bc50851301a15\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/confirmRunScripts.js\":\"d11cdb4c8db89959\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/dataExtension.js\":\"a8ccf3fd619a66b5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameAnnotations.js\":\"353c915ac3f6c472\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameDocument.js\":\"dd4e36e221164a66\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/frameTheme.js\":\"6bce0642dc32fe33\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/index.js\":\"4c04453725cd64c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/scriptConsent.js\":\"cf7edff1c78486ec\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/sourceMap.js\":\"d1dfab86d52254e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/html-document/useDocumentScripts.js\":\"f91506fb4f42d93d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/index.js\":\"dd67a4b2ab57441f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/record.js\":\"8b5c8edca234df45\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/recordStore.js\":\"09965ca8529d2d00\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/responsiveness.js\":\"d425233517ae8a51\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/schedule.js\":\"d7974de1428beff5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/interaction-metrics/sessionContext.js\":\"d404f68e38f36b9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"85f2319ce8d23064\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"86abc6c5042c9c65\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/actions.js\":\"6572da1f40266b72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/config.js\":\"5d9c3208b88a9f9b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/dataExtension.js\":\"9d55121b8dfd9453\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/effect.js\":\"2cf75be1bed72e3c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/index.js\":\"f4bb12cb016c2ee2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/keyCapture.js\":\"914d03c099016bae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/overrideStore.js\":\"5edc217c7ecaf47a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"975be9b9e1725699\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/HeaderItem.js\":\"efef36533628c3f1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/LeftSidebar.js\":\"362b2106bc5b30f9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/actions.js\":\"dfcdea931ce1eb3a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/facet.js\":\"3d1330bbe3cd6e7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/index.js\":\"35e1a16a81cc035e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/shortcuts.js\":\"f82ba1cec2335600\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/left-sidebar/toggleStore.js\":\"89b25678072dabf3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/MergePicker.js\":\"873e567d883dff3f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/index.js\":\"c2ea6ec2c3e0e784\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/mergeAction.js\":\"95fb3829002000d5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/merge-blocks/strategy.js\":\"5f45d5c0f594089a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/Button.js\":\"f470576a2c9aa3b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"decd256182235039\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/defaultItems.js\":\"3e2c96d46b50ca73\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/facet.js\":\"5acf139d1cb0e96e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-bottom-nav/index.js\":\"5b7abf9a35ea344b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"788e791d3243ee72\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5c2b8ea4d3713e98\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"ced7f1494b2fe901\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7d1f4a7188c668e2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/mobile-keyboard-toolbar/index.js\":\"a728a2b76a6f48ab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/MoveDestinationPicker.js\":\"afba0a42a4c05f2b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/blockSubtreeMembership.js\":\"28af04949aa695cc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/contextMenuItem.js\":\"7206b8ac0d002bfe\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/index.js\":\"b09d801eecaca9a2\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveAction.js\":\"590d2159f7c625bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/moveBlocks.js\":\"1de846a7e00e4d63\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/move-blocks/selectionAfterMove.js\":\"3cfc9e13ed808e7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/TutorialBanner.js\":\"88ed07bbc03ae6e3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/action.js\":\"24d82715fad9e829\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/bannerDismissal.js\":\"4e8f93b920e0fb7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/documents/cheatSheet.js\":\"334b249da1a6d115\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/index.js\":\"5d56d9a769477d43\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/keys.js\":\"bcc9eeb0ad435a36\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/landing.js\":\"eeef188f9099e1a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/outline.js\":\"ff93581ff4063090\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/onboarding/seed.js\":\"b19e13b53368b3bf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b51eaccd11f6c126\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/analyze.js\":\"b567a9a8798c7ca7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/diagnosticsSource.js\":\"b75576bdbfbdb01a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/index.js\":\"840cbf022b1d5661\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/load.js\":\"294224cf0ad6aae0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/monitorRun.js\":\"0bcf1aa05db09903\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/schedule.js\":\"0178440d77b873ea\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/series.js\":\"0dee26ce9f48eeb6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/store.js\":\"65a8250a0420f00c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/trendAction.js\":\"80d441428eeb8afc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/perf-monitor/verdict.js\":\"788b31bc474db011\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/clickToEditAction.js\":\"efd2d50205474ec5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/index.js\":\"563487e0c34e0625\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/plain-outliner/interactions.js\":\"b6c5f51bfe97c1a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"f081b6e804c82838\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGate.js\":\"a0f8b105575ea541\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/MigrationGateDialog.js\":\"927a076d0be95aa1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/action.js\":\"cf29dac83310799a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/index.js\":\"911d9b03123537fc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/localRunMessage.js\":\"4a6ac1dcf443acae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/plugin.js\":\"7f61e8fb97ca5eb0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/progressReport.js\":\"735229ca6fda23c1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/properties-migration/sweepProgress.js\":\"2e8dec8f1eb33ef7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/FieldRowRenderer.js\":\"faca6c12edbf81b8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/ValueRowRenderer.js\":\"f527626119e33f7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/actions.js\":\"9fec682c2900ace3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/autocomplete.js\":\"77ada0e4f36f634d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/fieldRow.js\":\"4a2033de0f54b727\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/index.js\":\"826dbf15c790867c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/referenceWarning.js\":\"3a2958e6bdcf1fd7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueAutocomplete.js\":\"fb8f0f484c3ac689\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/property-rows/valueSchema.js\":\"322c573ac5f92692\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/HeaderItem.js\":\"5febc62037d425b1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/QuickFind.js\":\"4f674eb0dfdeb573\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/index.js\":\"b7d3dae0cae80868\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/recents.js\":\"349fe4136daf3b46\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/resultItems.js\":\"7780136e464bdbab\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/selection.js\":\"4f119413e3eafa0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/quick-find/toggleStore.js\":\"31277d68b747ef97\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/HeaderItem.js\":\"dafab1c952fa7336\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2db4af676f7fd5be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/grouping.js\":\"e2765b9273ad5835\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/index.js\":\"78bc2b11895138b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/recents/target.js\":\"a538f70c2ef32b22\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/codeMirrorExtensions.js\":\"b76978954495d4be\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/contentPrefill.js\":\"c68c3e4ce6a22ede\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/dataExtension.js\":\"7b93b991865484b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/index.js\":\"463763cfeb312979\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"771bc23ae94f2145\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/invalidation.js\":\"e811604e7d9c6daf\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/localSchema.js\":\"8c2dafea8203fa75\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/index.js\":\"f204fa97e2d60726\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e65700d41f09236b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/index.js\":\"e067207080790640\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/referenceNode.js\":\"76fa5cb5bfba024b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/remark-reference-occurrences.js\":\"51826249029ab789\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"f0b28d5cd055f64f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/index.js\":\"3fef16a168760b51\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"2e16ea1b53fccf0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"7936dc95d848a414\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/mergeRetargetProcessor.js\":\"02ac8cc2e14e9c78\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/parseFence.js\":\"52e44eb70cfdaf39\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceParser.js\":\"050745117fc692db\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referenceProjection.js\":\"06999fe474b01ea4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/referencesProcessor.js\":\"2c4f812703ba70d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/renameProcessor.js\":\"5fae1ae68a3cc69d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/references/spanReplacement.js\":\"fb7e72061277ad9f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/htmlToOutline.js\":\"12d94790d7b99266\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/index.js\":\"e5dec2e3ac2eee6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/normalizeClipboardDom.js\":\"2d3289a0dd3a5c19\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/rich-paste/pasteDecision.js\":\"c1d898e9ace0aa57\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/action.js\":\"d8f5a4916c405eb1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/blockIds.js\":\"25296de207438f68\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/content.js\":\"2d8b24ce5f7c98b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/effect.js\":\"2c37a4033c8c6164\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/ids.js\":\"eb2a62d0f84831d7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/import.js\":\"65d648e5e1519761\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/index.js\":\"4e7ca0d5ac6b0612\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plan.js\":\"5aa4db4764ac1907\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/plugin.js\":\"273a7dcb5443a7e6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/promotion.js\":\"08603cb6e1d32ce6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/properties.js\":\"5228ad732c516db8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/references.js\":\"478a81883453e5ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/report.js\":\"81aa193c3494a657\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/roamMemo.js\":\"3852feb0fd326380\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/runtime.js\":\"b85f2f97213c547f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/schemaReconciliation.js\":\"d693a9560ed68b5b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/srsMarkers.js\":\"bf5c353224239f2a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/todo.js\":\"18defb320f3d67bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/typeCandidates.js\":\"ae35c18cd40e2d7a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/roam-import/types.js\":\"3f580f288e9e651f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/index.js\":\"b8c53b42161c1777\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/search-health/store.js\":\"4ac4b63fed850608\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/HeaderItem.js\":\"035e6529bb2fa321\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"66a37583d35e8982\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/index.js\":\"ccd7cbefc28dcd17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/model.js\":\"a31ac11c7250dc20\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/toggleStore.js\":\"3bb0cfeddb3cedaa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/shortcut-help/useKeyInspector.js\":\"d1e47e7a5eefe44b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3f7921ca39595867\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/ShellDecorator.js\":\"21108ccd79bac6a8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/actions.js\":\"7a969bcacb76f348\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/exclusionsFacet.js\":\"61ab40c5661d60ba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/index.js\":\"0b3794a3ffb2e6d3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/shell.js\":\"e8397a9c91608463\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/surface.js\":\"c62e552aec158d6c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/spatial-navigation/walker.js\":\"f870cd3cadeb7fa7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e6899eeb74c1bcd6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/dataExtension.js\":\"7f5e0bb339c684f4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/index.js\":\"a493317ffb53efaa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/indicator.js\":\"31eddfdbe927f588\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/moveSrsState.js\":\"34f7a87b68af2696\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"36a5ac158094468c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/scheduler.js\":\"9862dd6e59bb9271\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/schema.js\":\"b222b0d25b8adf5c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"da2c32687b0cd4a0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/srsClipboard.js\":\"fc76a3e2920a5705\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"9fe19bacd0644c4f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DailyNoteReviewHint.js\":\"00df68e0034fda05\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/DeckPicker.js\":\"f20b99d1c44d2164\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewControls.js\":\"3be3fcb95ba75e17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewDeckRenderer.js\":\"06765f9aa9ff2150\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/ReviewSession.js\":\"d4a4788dce99d0a4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/actions.js\":\"26ca5ada9f3cd880\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/archive.js\":\"e00660dfa2545eb5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dataExtension.js\":\"bd6bd63f1226cdbc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/deck.js\":\"215d41f4b23d344d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/dueQuery.js\":\"4a291a4834ac6c03\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/gradeDecision.js\":\"8b5ab60bb2319f55\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/index.js\":\"7f3f7afcde103fac\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/keyHints.js\":\"3abb244f5873c705\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewCardLayout.js\":\"c5e56c2e47b01bc4\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/reviewProgress.js\":\"b7dea1a9d45d57e7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/schema.js\":\"3d08acf1147babfc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/srs-review/useDueCards.js\":\"94a30f2cb49bfc0c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/index.js\":\"1c0380c9f1b87a24\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/startup-metrics/record.js\":\"e67fa1440d1144ae\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/index.js\":\"3a1e2d1f464d17ce\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/persistenceStatus.js\":\"100258e1bac29cd7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/storage-persistence/requestAction.js\":\"20b9564ce2adeccc\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/TypeChipsDecorator.js\":\"ec5f2ec601da82f6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/codeMirrorExtensions.js\":\"838ebf1cd6fca47a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/index.js\":\"ecd6b7c16aa0db9e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/supertags/typeAutocomplete.js\":\"3b603a70134a75dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e12e4fc65ddd3d37\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/actions.js\":\"bb709380beb9af95\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/anchor.js\":\"5879c40da8864c6a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/events.js\":\"6ef6207de3735502\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/gestureActions.js\":\"af3be89d6d86748b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/index.js\":\"65ea6d6afdffcad7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"af3c5724add8c0b6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/collect.js\":\"75e9d5f2bec979e5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/index.js\":\"7ca0e44484474892\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/sync-metrics/record.js\":\"cb4af4745a342b31\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/RejectionDialog.js\":\"8c29b941baa00009\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/SystemStatusHeaderItem.js\":\"a42481dc49f99547\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/index.js\":\"36c03f0d5fe8b759\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/model.js\":\"5551cdadb76037cb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/queueCounts.js\":\"396a8c84a3a208ed\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rejectedHelpers.js\":\"eee78b3f8347a075\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/rematerializeAction.js\":\"749d5eaa90eb0924\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/system-status/useHysteresis.js\":\"d464b0e38e5d54aa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/ColumnHeaders.js\":\"64bd45221357fd3c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/QueryUi.js\":\"c8fccdf2a18adf91\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/TableLayout.js\":\"ad4b409a2e3a5544\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/actions.js\":\"993886fa2d79614d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/cellEdits.js\":\"1b86933a9268e89b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/childrenViews.js\":\"d910869a8601048e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/columns.js\":\"a3a518d2baa22e71\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/controller.js\":\"90a19a97141ecae3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/convert.js\":\"4d03a0728d455dba\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/dataExtension.js\":\"3cf6ac0e855d0675\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/index.js\":\"7c961e2ebedc07c8\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/keys.js\":\"7ece08422a4db27b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/model.js\":\"e6c3800926aadd7d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/QueryText.js\":\"15ba81f2bcaac2fa\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/backfill.js\":\"7a98588c1638624d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/completion.js\":\"2e989a07b4ecfaf0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/format.js\":\"b521cb37e5b967ee\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/parse.js\":\"65c4fee2e1c156bd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/queryValue.js\":\"797e38ac0740532f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/registrations.js\":\"40be694f5630066f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/query/source.js\":\"c0568d2cc33970d6\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/registry.js\":\"3635486a89103208\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowGutter.js\":\"29200373bade3a7b\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/rowVerbs.js\":\"363a75f2a33bc1fb\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/schema.js\":\"0b74042f88a7505d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/tables/sort.js\":\"cf373452d99b2f58\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/effect.js\":\"8783246295ccf885\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/index.js\":\"82068cad9e67d401\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/theme-toggle/theme.js\":\"7d99a898cc98de17\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/actions.js\":\"1cf06d356baea832\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/dataExtension.js\":\"ea9219a6ea9426b9\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/index.js\":\"56880a27aba73698\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/todo/schema.js\":\"4c3a9508e4cb38dd\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/TouchSelectionLayer.js\":\"2249b7aa1722be86\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/actions.js\":\"aba624bdb451597f\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/defaultItems.js\":\"accbd9aedbf6fdd3\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/facet.js\":\"494ce584efce1a27\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/holdRecognizer.js\":\"f2aecf37e05acb69\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/touch-selection/index.js\":\"eecb67e989739f98\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/UpdateIndicator.js\":\"05747848650851a7\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/index.js\":\"7c479e907cd801f5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/update-indicator/loadTimes.js\":\"b633aebef82a7ead\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoNotesRenderer.js\":\"66604e2b6152c21c\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoPlayerRenderer.js\":\"929a15dd8de248b0\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/VideoTimeStamp.js\":\"3413ba9704ac4836\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/actions.js\":\"063d3f6cb82bef69\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/index.js\":\"2e8517c8344de116\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/markdown.js\":\"a4b7b742f3627b86\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/notes.js\":\"7fbafe5c627f4b31\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/registry.js\":\"fce1aaff1689f1d1\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/remark-timestamps.js\":\"28c20a44bc8c796d\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/video-player/view.js\":\"48c33e7d3c12f537\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/LinkHints.js\":\"bb72e22dfaaf8f0a\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/index.js\":\"ebe5b7c394f466f5\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/model.js\":\"c38f80fe25043c54\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-link-hints/settings.js\":\"fd8b03b40d0ca104\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/actions.js\":\"187edafde99c235e\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/index.js\":\"a7021c7412b7ab61\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/vim-normal-mode/interactions.js\":\"03cbce8d86bdbb78\",\"/knowledge-medium/pr-preview/pr-1919/src/plugins/workspace-header/index.js\":\"cc652011aeea2a1b\",\"/knowledge-medium/pr-preview/pr-1919/src/registerServiceWorker.js\":\"24246999593cd1b7\",\"/knowledge-medium/pr-preview/pr-1919/src/requestPersistentStorage.js\":\"0e1b6fb2b191b930\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authRequestDeadline.js\":\"2cc2197d57df3dad\",\"/knowledge-medium/pr-preview/pr-1919/src/services/authStorage.js\":\"912c5cc1b8c4587d\",\"/knowledge-medium/pr-preview/pr-1919/src/services/powersync.js\":\"107262eb6f9d88fe\",\"/knowledge-medium/pr-preview/pr-1919/src/services/supabase.js\":\"f49bcf7c7ad62344\",\"/knowledge-medium/pr-preview/pr-1919/src/services/uploadErrorClassifier.js\":\"ae2033ccceb16739\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/ActiveContexts.js\":\"0bf2ba8c55765520\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/HotkeyReconciler.js\":\"d1187642de4f4087\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/WipeLocalDataDialog.js\":\"216f4b2c603bc634\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionDispatch.js\":\"057aa1491175d386\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/actionRefItems.js\":\"484630b716d8f0ee\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/applyKeybindingOverrides.js\":\"001cc8c24ff04209\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockActions.js\":\"f52cda26477aa838\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/blockMergeGesture.js\":\"0a0288f32c1b4d7d\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/canonicalizeChord.js\":\"b75cc49ef05e94d9\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultContexts.js\":\"1d9a6b156e887be6\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/defaultShortcuts.js\":\"6d825a5e906c9540\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/effectiveActions.js\":\"7c7dd867457bd483\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureAction.js\":\"d7a277efaefa8bee\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/gestureBinding.js\":\"6b453e10a30637c3\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/holdRegistry.js\":\"44eb6cf130092bca\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingConflicts.js\":\"46bb8e231e0f6672\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/keybindingOverrides.js\":\"9a8b39f0581ff8b9\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/pointerAction.js\":\"8f076daeb46982cf\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/resolve.js\":\"adf3731fb9c9d164\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/runAction.js\":\"e50a1967e3af0361\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/sequenceMatcher.js\":\"1970f8331cfcf772\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/types.js\":\"8e426976a22cc93c\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionContext.js\":\"6e2f0c9a2381b100\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/useActionDiscovery.js\":\"ca9414b5fb7503f5\",\"/knowledge-medium/pr-preview/pr-1919/src/shortcuts/utils.js\":\"0e35fd40fef82fe5\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/bootStore.js\":\"fb48c7fc2fcfac18\",\"/knowledge-medium/pr-preview/pr-1919/src/sw/previewDatabases.js\":\"faf94444c81ac256\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/byteTransform.js\":\"ef0432cd249deff4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/attachmentCleaner.js\":\"0b9379fa3de60dd1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/attachmentParts.js\":\"ef71e14badf9b1fe\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleParts.js\":\"1536b71eda966970\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/bundleRecord.js\":\"0cdf0a24c294418a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/manifest.js\":\"25800ec4b7a681f0\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/takeBundle.js\":\"52079a0f9c52f650\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/bundle/verifyBundle.js\":\"9d7dcbd76a1c42ac\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/cleaningStage.js\":\"a688fce1fb65556e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionKey.js\":\"e0e81e84d555455b\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/conversionServer.js\":\"bd3a0f1f278a3fc4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flip.js\":\"00fed1b60658d049\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/flipAttempts.js\":\"22db43382509f2fe\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/pages.js\":\"ef22cc744cfbfbdd\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/preflight.js\":\"ea993ce509ecdc47\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/reseal.js\":\"d0cd298e6e29891f\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runConversion.js\":\"dff81678c3a667aa\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/runLock.js\":\"f5b4d4a25bc4e221\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealing.js\":\"54757d0b315357c3\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/sealingStage.js\":\"eb1ca3fdd3c0886a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/stage.js\":\"2f08f062ecaf940e\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/conversion/verifyReseal.js\":\"377b84b7c793f965\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aad.js\":\"e6d7f31e61c4c297\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/aead.js\":\"777fedc69299a764\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base32.js\":\"ed2a8b6577d87d53\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/base64url.js\":\"7fb973d7ae2a7f89\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/binaryEnvelope.js\":\"9db6bc1a6c010ac4\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/byteAead.js\":\"c3d817baf7cef5ba\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/canary.js\":\"fc592ed84453b308\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentHash.js\":\"0e3bd8fac137f527\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/contentKey.js\":\"d729f8b15d81e0dd\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/derivedIdNamespace.js\":\"fbe03c3e099ecb76\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/envelope.js\":\"15db020f8cccc069\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/hex.js\":\"18aa5539ab02ef7a\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/sha256Hex.js\":\"235f9978fe5828b9\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/crypto/workspaceKey.js\":\"87f8f39cc7766795\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/conversionState.js\":\"0457db76f74b1691\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/createEncryptedWorkspace.js\":\"23cf5d9a68489434\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/pastedKey.js\":\"554410d7e52200d1\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"d3c1a1afd7dfebfe\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/flows/upgradeWorkspacePin.js\":\"ed9523dc12847f40\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/keyStore.js\":\"bccd1c73f21ea759\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/mintWorkspaceKey.js\":\"0151691f115740fa\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/modePin.js\":\"4d2d08dfa0e3eec6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/openWorkspaceKeys.js\":\"d9c5e5f3c567dec6\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolveWorkspaceEntry.js\":\"34e5c051f99f1eff\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/resolver.js\":\"ef7da110d1189d88\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/keys/workspaceAccess.js\":\"708c688ab214e4c5\",\"/knowledge-medium/pr-preview/pr-1919/src/sync/transform.js\":\"4f58841679683e77\",\"/knowledge-medium/pr-preview/pr-1919/src/themeBootDefaults.js\":\"1cd29b0950b14c88\",\"/knowledge-medium/pr-preview/pr-1919/src/types.js\":\"be8206445c57a407\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/ClientLocalSettings.js\":\"678cb179764ad350\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/abortableSleep.js\":\"09dc389e01814560\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/array.js\":\"4c38778f64c8a8c6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/backlinkAutocomplete.js\":\"42be994884b0fe4f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockCrumbs.js\":\"912c73ad5de442c0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/blockrefAutocomplete.js\":\"fdb895e0f3284fc2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/cadencedIdleJob.js\":\"ddc61d6e03cbbefe\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/callbackSet.js\":\"a8df2edeaa824cea\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/clientId.js\":\"017764f2d7c7b72d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirror.js\":\"705f10321bf52083\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/codemirrorCompletion.js\":\"bc03cafdc0d8debd\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/copy.js\":\"84e2f39af9bb5d27\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dailyPage.js\":\"8e1f738c8f9b5ba3\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensics.js\":\"788438f09188589d\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dbForensicsHooks.js\":\"d7b472de3ca74f9a\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/deleteBlockThroughUi.js\":\"a3352b5062cff7e9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dialogs.js\":\"86d86ed82f260cce\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/dom.js\":\"1269d1fef3e50aed\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/downloadBlob.js\":\"380511405892fb43\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/drawnWalk.js\":\"cb1e5b344d094919\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/exportSqliteDb.js\":\"c336043efbe098af\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fileSystemAccess.js\":\"5f66c1291a47e7de\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/flipSlide.js\":\"2e54665e497e80be\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fnv1a.js\":\"6b670e84c0a37b52\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/formatBytes.js\":\"0d09ddcfd1c75f20\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/fuzzyRank.js\":\"b9db00ebf6354552\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idbKeyedStore.js\":\"a81c0f28b350fb82\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/idleCallbackPolyfill.js\":\"1e74d32db1e7dd98\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardAwareScroll.js\":\"a76a22f236b04d02\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/keyboardViewport.js\":\"1dcbe283b3ee7572\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/lastWorkspace.js\":\"ecdb1c1326ff0bfb\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutColumns.js\":\"1b10e147254b4395\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionDom.js\":\"cb332557241cac63\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/layoutSessionId.js\":\"6fb8a8e9adb14f33\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkClickGestures.js\":\"01885c9cf57885a2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/linkTargetAutocomplete.js\":\"98cf4490c5b033c0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbCorruption.js\":\"a88949f89503e4dc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/localDbRecovery.js\":\"3987fae1d54c9468\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/markdownParser.js\":\"71d2f0994f01657f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/memoize.js\":\"828d569f011396a8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameFieldCommit.js\":\"2009fae5048f6303\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/nameList.js\":\"3c9cae6b3da62698\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/navigation.js\":\"d35301d45b06e5f1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/omnilinerNamespace.js\":\"5939bd83e6562369\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/opfsPageScan.js\":\"2ab178b41c77bbd8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelClearance.js\":\"7271f07449ecc287\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelHistory.js\":\"177b9c6e2fa40d89\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLanes.js\":\"c3b5da9f0f579581\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelLayoutProjection.js\":\"d2b29e6217cabe9f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelScrollAnchor.js\":\"185e571fe0a58ccf\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/panelUrlFlags.js\":\"e681ca99cacb1e13\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/platform.js\":\"bfb0a0625c3a537b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/pluralize.js\":\"ab5de0b158d41084\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyCreation.js\":\"46da69dafadbf0ab\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyNavigation.js\":\"bac247741427ebd4\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/propertyValueContext.js\":\"78ba283c1ffc90e9\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/react.js\":\"4bb0be5bd6335c34\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeDate.js\":\"69a6ab8319b8d6ad\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/relativeTime.js\":\"577271dd35c7a6a0\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/renderScope.js\":\"9c7eac8d40510da2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/resolvedThenable.js\":\"f6dd0d4f414cf408\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/routing.js\":\"5340c9c92c06a4d7\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/safeMode.js\":\"2de6f270ac2a3ecc\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/scheduleIdle.js\":\"b54f2f99e87be3e8\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/screenWakeLock.js\":\"4d254ed46d2c12e1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/selection.js\":\"9ecfd2a6197955a1\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/softKeyboardGrab.js\":\"492593582269fe03\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/startupTimeline.js\":\"1c8a2ccfda0ece8b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/state.js\":\"44a59dab05696154\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/string.js\":\"4cabc22680689b45\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/surfaceZoom.js\":\"f598020a8caf015f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/time.js\":\"bf67d6e99bcffe2f\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toast.js\":\"87f09152768d2ed2\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/toggleStore.js\":\"bf3b0db33909eb9b\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/untilStopped.js\":\"85cd79951ab4b499\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/userActivity.js\":\"d5ae94ddf11e7292\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewTransition.js\":\"c4d8b695855b6093\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/viewport.js\":\"be6fc16b6644b93e\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/webLock.js\":\"9d010548e74769da\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceRecovery.js\":\"54fde12fac604a55\",\"/knowledge-medium/pr-preview/pr-1919/src/utils/workspaceSnapshotStore.js\":\"f6ea49da7e36bb6c\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-compiler-runtime.js\":\"434a38a2222b592d\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-client.js\":\"3424f4a49d995613\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server-edge.js\":\"9dbd8e1cf176ad29\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-server.js\":\"c9a430f216f4e677\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static-edge.js\":\"ad8608571a6db4f3\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-static.js\":\"2b2c47a405608401\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom-test-utils.js\":\"c309309d63bb054d\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-dom.js\":\"678ee2d420bfa9f9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react-jsx-runtime.js\":\"181a8195024593d4\",\"/knowledge-medium/pr-preview/pr-1919/src/vendor/react.js\":\"0301bd4c9c4d525f\",\"/knowledge-medium/pr-preview/pr-1919/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1919/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
