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
		buildId: "18b3ce17d85d-dc9358b3",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/\":\"9c5b2371ce0c329f\",\"/knowledge-medium/pr-preview/pr-1920/index.html\":\"9c5b2371ce0c329f\",\"/knowledge-medium/pr-preview/pr-1920/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1920/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1920/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1920/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1920/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1920/assets/FacadeVFS-Dzprt26q.js\":\"0e0d400c8679cc06\",\"/knowledge-medium/pr-preview/pr-1920/assets/OPFSCoopSyncVFS-DOAtEzXn.js\":\"9423c6c449e14495\",\"/knowledge-medium/pr-preview/pr-1920/assets/OPFSWriteAheadVFS-DkBZ56mq.js\":\"91de7d8d85a34136\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-CQT19RLG.js\":\"824b5a413cee93ce\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-async-B9AMn7iz.js\":\"c04c3c0fbc2ca21a\",\"/knowledge-medium/pr-preview/pr-1920/assets/worker-CvWTNltW.js\":\"8ecd3efed662a6a2\",\"/knowledge-medium/pr-preview/pr-1920/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1920/chunks/app-DAdoOGsM.js\":\"9e89a1d3018f28af\",\"/knowledge-medium/pr-preview/pr-1920/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1920/index.js\":\"ae4b28d843445da9\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1920/assets/AccessHandlePoolVFS-EAvatuPc.js\":\"4646a520f5e07102\",\"/knowledge-medium/pr-preview/pr-1920/assets/IDBBatchAtomicVFS-C-p3IXAW.js\":\"f494aca4ca24062d\",\"/knowledge-medium/pr-preview/pr-1920/assets/MemoryVFS-DzBdLyQV.js\":\"8811fed281b931f0\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-C0MlZseB.js\":\"2ea6d557dd74ebc5\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-async-DQ3hJZ7u.js\":\"eb7d5db38a1ae1fb\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1920/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1920/chunks/AccessHandlePoolVFS-5VrGW-Xm.js\":\"85de5987fbb85850\",\"/knowledge-medium/pr-preview/pr-1920/chunks/FacadeVFS-Cat2WiDN.js\":\"3eb927c13fc4ca39\",\"/knowledge-medium/pr-preview/pr-1920/chunks/IDBBatchAtomicVFS-B7f8klU6.js\":\"ff04514c0b46ffcf\",\"/knowledge-medium/pr-preview/pr-1920/chunks/MemoryVFS-B2-A8tHf.js\":\"f17c4b031889be6a\",\"/knowledge-medium/pr-preview/pr-1920/chunks/OPFSCoopSyncVFS-DctjC_M8.js\":\"f08a37cff4e5789c\",\"/knowledge-medium/pr-preview/pr-1920/chunks/OPFSWriteAheadVFS-DNzKcwTg.js\":\"ed6de795143ee059\",\"/knowledge-medium/pr-preview/pr-1920/chunks/Preview-BjCZhSnL.js\":\"ecf9bbcaaaa07b04\",\"/knowledge-medium/pr-preview/pr-1920/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1920/chunks/card-hmx3Vy7L.js\":\"8b0f3e26b7bdb6b7\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-Cij_C6rT.js\":\"af102bad60f8f2e4\",\"/knowledge-medium/pr-preview/pr-1920/chunks/freezeExtensionImports-CeBv_iUY.js\":\"a41f3863ae05e928\",\"/knowledge-medium/pr-preview/pr-1920/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1920/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1920/chunks/mc-wa-sqlite-BlpcTRyG.js\":\"f36618f3c75f8f55\",\"/knowledge-medium/pr-preview/pr-1920/chunks/mc-wa-sqlite-async-BVwkYQAM.js\":\"64e537af003b53ac\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-5GehJVEy.js\":\"8459e2b568ea4719\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-Be9T8VVk.js\":\"ac53f654775d2376\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-BmWzxVjQ.js\":\"83368f05a6b0354f\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-CrBkRdwT.js\":\"f183723ae34e5287\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-DdwJnmQt.js\":\"467e84f121ea5dea\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-DqXEGfRD.js\":\"8ad5dff5632a62ba\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-Dv96KVpg.js\":\"b1517173c9afd4a7\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-KgeK4dWq.js\":\"ba1d93860464446b\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server-legacy.browser.production-CvxeG6mo.js\":\"09f6c9ec5e10ea44\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server.browser.production-0a01yBTw.js\":\"cfd20f1d7f0ed545\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server.edge.production-QHFNlaSG.js\":\"9b936dbda09aa901\",\"/knowledge-medium/pr-preview/pr-1920/chunks/server.browser-DkRd4ZQu.js\":\"0dfc9e2232bba526\",\"/knowledge-medium/pr-preview/pr-1920/chunks/textarea-CT1JKWI1.js\":\"8acbb99f3abad380\",\"/knowledge-medium/pr-preview/pr-1920/chunks/ui-C1IGpupV.js\":\"d169570ab01e0e16\",\"/knowledge-medium/pr-preview/pr-1920/chunks/wa-sqlite-BaLAD3YB.js\":\"af21909fa0ac92ef\",\"/knowledge-medium/pr-preview/pr-1920/chunks/wa-sqlite-async-w5wkQCKx.js\":\"6747ea05bd4b3243\",\"/knowledge-medium/pr-preview/pr-1920/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1920/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1920/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1920/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1920/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1920/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1920/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1920/src/App.js\":\"34931e48eef986d5\",\"/knowledge-medium/pr-preview/pr-1920/src/appUpdate.js\":\"29ea5466ecad0aea\",\"/knowledge-medium/pr-preview/pr-1920/src/appVersion.js\":\"411c6ddb0085773a\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/initialLayout.js\":\"ec8bfaa149350e3c\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/openWorkspaceData.js\":\"443607586d892694\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/resolveWorkspace.js\":\"e08070a6b3f0c8b8\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/workspaceBootstrap.js\":\"bb84745130ab5db3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockComponent.js\":\"962c8fa915ee5b1d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockCrumbs.js\":\"ce51a7f111b4fb6a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockEditor.js\":\"ae6e516547086b2f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockLoadingPlaceholder.js\":\"a8d1a8bb0d71d9d6\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockProperties.js\":\"21055b29e0dadb0b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockSearchPicker.js\":\"91def6d453fbded3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ConfirmBulkDeleteDialog.js\":\"def2a430030e1ba5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/DividerHandle.js\":\"60c8d950a731296e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/DraftEditor.js\":\"2488676a9b6adb22\",\"/knowledge-medium/pr-preview/pr-1920/src/components/GutterPill.js\":\"5fef88d8c063c61d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/Header.js\":\"962baa1d8763f27e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/LazyBlockComponent.js\":\"6794e06371485394\",\"/knowledge-medium/pr-preview/pr-1920/src/components/Login.js\":\"f2d2d63014aa73da\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ZoomableSurface.js\":\"039e052246fd1dd3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/editModeKeepalive.js\":\"a7e697a5bdf369b0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyDisplay/PropertyDisplayScope.js\":\"26904b29c39390a8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"bb61320a97452d0e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/RefPropertyEditor.js\":\"f76e2229a3f23729\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/RefTargetTypePicker.js\":\"a1b517c7e8dc608c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/SelectPropertyEditor.js\":\"771b13f11f666e8e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/TypesPropertyEditor.js\":\"030791f0fd0da708\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/defaults.js\":\"411b29e18a2f4cf5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/kernelValuePresets.js\":\"33b232767986ca0c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/selectablePresets.js\":\"61444d0d944c3b65\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/typesPropertyUi.js\":\"5638579469066c40\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/AddPropertyForm.js\":\"bf2fd64c8d3e1c62\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/PropertyPicker.js\":\"2d1fba518379b8da\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/PropertyRow.js\":\"84f58b78a1f270fc\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/Rows.js\":\"5d6a0ed69198dee0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/actions.js\":\"6bdc81debdb15998\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/declarationOnly.js\":\"97f6554ddeb278e8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/layout.js\":\"034969079c19df47\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/model.js\":\"fbba65def8a54e51\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/shapeUi.js\":\"db4a59aedddc2dcb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/shapes.js\":\"76490f5a303347e2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/usePropertyEditingActivation.js\":\"53a93b78f2b7134f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/visibility.js\":\"3f048431f7521db3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanelSections.js\":\"e9df9fb2159c0f98\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockEmbed.js\":\"71c5c77e4440efac\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockLink.js\":\"e431fab7b1388f5a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockRef.js\":\"fa158a0fb788cf77\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/CompactReferenceLink.js\":\"7f42adaacd148172\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/ReferenceLink.js\":\"2cdce52039ad3dee\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/cycleGuard.js\":\"575b876657a67655\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/cycleGuardContext.js\":\"d7f2c84df314845e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/linkInteraction.js\":\"395c822f8ba71d96\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/referenceLayout.js\":\"0c4571a00f14372d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/useBlockRefAncestors.js\":\"4ecdf2f1a4a0a69b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockGutter.js\":\"7ef247ff442cdadc\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockInfoDialog.js\":\"0285111672df10cd\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockReadText.js\":\"4149cb8f140862e5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockTypeBlockRenderer.js\":\"b701c39e5fe063be\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BulletHoverCard.js\":\"3bd18a49be782ec5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/CodeMirrorContentRenderer.js\":\"e27102fdfc263a00\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"52d3c13ba72f63df\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/ColumnResizeHandles.js\":\"60730aeb89024fcb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"918f395ce265820e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/DefaultBlockRenderer.js\":\"b72b0b95cd5fc5f8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/LayoutRenderer.js\":\"d58aceb302b49580\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/MarkdownContentRenderer.js\":\"1b6dffea2ffd8fa7\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/MissingDataRenderer.js\":\"0722bf0a0db8c41e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/PanelRenderer.js\":\"f06b92d8edfeb808\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0e12f0c2f59c032c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/TopLevelRenderer.js\":\"702b70eb9f922f2b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/blockGutterMode.js\":\"810b944121710dbb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/blockTitleText.js\":\"5b43d96dfbda22ab\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/fieldCreationKeydown.js\":\"8842200708347e9b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/layoutRootContext.js\":\"0e00dcf6e144183a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/typeChip/TypeChip.js\":\"36df49e42c2283ca\",\"/knowledge-medium/pr-preview/pr-1920/src/components/typeChip/chipStyle.js\":\"d763fe7754592e8a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/anchored-floating.js\":\"7a9349fd22af8551\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/button.js\":\"7e4220df8b89befc\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/card.js\":\"719769907b1a94a2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/checkbox.js\":\"a25dd9b625d3862a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/collapsible.js\":\"3ce0473aeb7e320a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/command.js\":\"6322aaa49ec2b8e5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/context-menu.js\":\"56a5caf08a9efdc9\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/dialog.js\":\"88b4e2c436695b97\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/dropdown-menu.js\":\"9ec7e8732060e0fc\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/floating-listbox.js\":\"2754a7d864bb8ba4\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/index.js\":\"b282d7f9a996679a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/input.js\":\"38c527e6c48d8e0e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/kbd.js\":\"425741d89d99c6c3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/label.js\":\"644a2daab8828c29\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/textarea.js\":\"99c57273c0a894e1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/useEditModeYieldKeepalive.js\":\"411c6d354c90f5a1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/BootFallback.js\":\"6bece8f3788b7020\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/FocusedRowLazyMount.js\":\"7d058a65e9a6199b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/LazyViewportMount.js\":\"a5e2f07f3f0ae636\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/LocalDbCorruptionFallback.js\":\"56b0111982b8dbf8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/error.js\":\"df3e54bb90d6c4f2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/lazyMountRegistry.js\":\"ecd2a7b1634ccea7\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/suspense.js\":\"ba091ff4ed8d0096\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/CreateWorkspaceDialog.js\":\"f497a1947db5b680\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/PendingInvitations.js\":\"94cd963cea8944c1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/SyncProgress.js\":\"351a90192bbaa717\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/UnlockProgress.js\":\"788e733b7c14083d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceKeyGate.js\":\"191dbafe42ba7a88\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSettingsDialog.js\":\"dad3dd676f98c244\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSwitcher.js\":\"952aaa92568136e0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSyncGate.js\":\"8c6433a5d98c86c2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/ConversionFlow.js\":\"03fd20782ffef433\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/ConversionFlowHost.js\":\"0d7d2110a89cc6c5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/EncryptionSection.js\":\"cf501da59ac56e6e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/attachmentPrompts.js\":\"aad65bc5601c6233\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/bundleFolderPrompts.js\":\"41a607c75dc15a66\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/conversionFlowDeps.js\":\"fa0cb1be2a0f43a9\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/conversionFlowStore.js\":\"6f8de1a7cea6deb9\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/flowUi.js\":\"d738fd5a7ad59ebf\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/useConversionRun.js\":\"e7b425d388f888f8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/keyUi.js\":\"ffbf591b88df1f50\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/useCloseOnKeyLoss.js\":\"406e27a11ca42586\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/useCloseOnServerE2ee.js\":\"3a5d19f4ca120d4a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/workspaceUnlocked.js\":\"4238850ab1ed03f0\",\"/knowledge-medium/pr-preview/pr-1920/src/context/backgroundSubtree.js\":\"23edbb493d02c9e4\",\"/knowledge-medium/pr-preview/pr-1920/src/context/block.js\":\"bf78d436f8fba5dd\",\"/knowledge-medium/pr-preview/pr-1920/src/context/layoutWsContext.js\":\"f79f79e06cb42155\",\"/knowledge-medium/pr-preview/pr-1920/src/context/propertyDisplay.js\":\"af961270c8958afd\",\"/knowledge-medium/pr-preview/pr-1920/src/context/repo.js\":\"886d33e2c424dfa5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/aliasClaim.js\":\"2abd0427a592df0c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/aliasSeatNamespace.js\":\"cdb199d0bc4dac1c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/blockData.js\":\"0e92b0f1d99c13bf\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/blockType.js\":\"aea30916317863be\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/changeScope.js\":\"bc5c224c01ad4e90\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/codecs.js\":\"8de83f2be6a0599a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/derivedData.js\":\"17eab46aeb38da2a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/errors.js\":\"7b9fa37d405fa0ef\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/events.js\":\"f6973771f758e617\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/handle.js\":\"96d417a5e8c3b6d8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/index.js\":\"a88c867eaa4787d1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/mutator.js\":\"371eb06bb7336509\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/processor.js\":\"ee8e755d4a3462c6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/propertySchema.js\":\"c3ec7850c363ed52\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/query.js\":\"f774e5dd8251a339\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/sameTxProcessor.js\":\"4fabb042fa8042b8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/schema.js\":\"96d417a5e8c3b6d8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/tx.js\":\"96d417a5e8c3b6d8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/typedBlockQuery.js\":\"ccdc7bcbee39a4ff\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/user.js\":\"cc4f9ca19305cdf7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/valuePresetCore.js\":\"f5f3787902eff875\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/valuePresets.js\":\"58b032ad92fb2a0c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/attachmentCleanerIOVerb.js\":\"6efeeab2c66d69f3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/block.js\":\"49f192f332cd3c74\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockCache.js\":\"6b3cdf60693108ca\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockId.js\":\"56a8b423e9e04ffc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockLiveness.js\":\"fb34eb95344b1bf0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockMerge.js\":\"37eec30a590120f3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockSchema.js\":\"0fa97fa1f25c6840\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockTypeLookup.js\":\"da91d93eaa463285\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockTypes.js\":\"bc8f364e9484801f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/childrenView.js\":\"eaa4b57255c4f249\",\"/knowledge-medium/pr-preview/pr-1920/src/data/clientContext.js\":\"e98ba27ff065a564\",\"/knowledge-medium/pr-preview/pr-1920/src/data/dbFileSiblings.js\":\"0b0832b6ca74bc56\",\"/knowledge-medium/pr-preview/pr-1920/src/data/definitionSeeds.js\":\"9de2419e6aa3d55e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/derivedIds.js\":\"a96fef098cdde4ec\",\"/knowledge-medium/pr-preview/pr-1920/src/data/drawnSubtree.js\":\"d862417019ce9b5e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/facetBridge.js\":\"ebeaf587be901b6c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/facets.js\":\"943399bd1bc5368c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/globalState.js\":\"c47255d077073789\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/aliasClaimRederiveProcessor.js\":\"5afebccee44fa211\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/ancestorBatch.js\":\"8c377b5f26bf0794\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/blockTypeTypeifyProcessor.js\":\"8c78308c30f36acc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/clientSchema.js\":\"3fff4fd012276592\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/commitPipeline.js\":\"d6eb52d465c95aaa\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/devAssertions.js\":\"a7b193d91df251c5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/firstSync.js\":\"5c0b614f0beedbeb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/freshInitialLoad.js\":\"4c71c4c51101f9c9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/graphBackfillClaim.js\":\"580990aacee01733\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/handleStore.js\":\"0b4048acf09072b6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/idleMarkerJobs.js\":\"6a6b1cea43cbffd1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/initialDownload.js\":\"3c9d58741fb5d6eb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/initializeClientDatabase.js\":\"fd93eb6e3399e2a4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/jsonCanonical.js\":\"b20475ffacf98e83\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelInvalidation.js\":\"7b0722e1fd7f89e3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelProcessors.js\":\"506bf635af9fe232\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelQueries.js\":\"23e7dfb69d0c8f6e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/mergeTypeMembershipProcessor.js\":\"995240a548c5d838\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/normalizeReferencesProcessor.js\":\"944c9f172cda8ff5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/poolInstrumentation.js\":\"45b7bdbe82d39cb0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/processorRunner.js\":\"a247f7a20ff3cce9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyCellBackfill.js\":\"8f6a7ebae04fde85\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyChildMint.js\":\"9656de6e180ee880\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyChildrenProcessor.js\":\"36116b26de438c0d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyDefinitionChangeProcessor.js\":\"18f0d69ef7b62dda\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyDefinitionSynthesis.js\":\"913cfe83eb69b92b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyKeyScan.js\":\"58f7af3d215be032\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertySchemaResolution.js\":\"503e9dc9b389d0a4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyValueEdits.js\":\"1a22e8781a0ed93b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/raiseProtocol.js\":\"c51e71014f888e96\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/readBatch.js\":\"8cb30aa17721e9f1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/refProjection.js\":\"e6195d6e8c13af63\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/referenceTargetLookups.js\":\"e1df7e16f293b713\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/referenceTargetProcessor.js\":\"3d0c61f35d6df81e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/replayMerge.js\":\"16ed42783e9c82d6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/sqlBinds.js\":\"aad2b19feeb8465c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4ca7d666517a341b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/arrivalProcessors.js\":\"c8b053e50e574c0d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/invalidate.js\":\"d8d21c80410d3924\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/materialize.js\":\"4c9541c289024cf9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/observer.js\":\"66781646c042bcb1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/reconcile.js\":\"fc6d839f270884ef\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/timingMetrics.js\":\"9e35862404617511\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/treeQueries.js\":\"5b864bcba973ac5b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/txEngine.js\":\"e7c465f75c873bcf\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/txSnapshots.js\":\"ceb9ebbd5da0d8ea\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/typedBlockQuery.js\":\"5c91ab94a695ce7e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/undoManager.js\":\"8267862d5d302514\",\"/knowledge-medium/pr-preview/pr-1920/src/data/invalidation.js\":\"f835383b48de23f7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelDataExtension.js\":\"5b7f9546e52a7bcf\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelPage.js\":\"00fab788d015a8c4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelValuePresetCores.js\":\"38e31b2eaea16e1f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbCorruptionSignal.js\":\"e7d3619e1978af0f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbStorage.js\":\"7130fe9e4767dd3f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbVfs.js\":\"696db6e3c0073638\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localSchema.js\":\"dbc02aa36b03992f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/maintenance.js\":\"ca43db9a632f8bba\",\"/knowledge-medium/pr-preview/pr-1920/src/data/mergeProperties.js\":\"63ff939ed8ce766a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/metricsConsoleHook.js\":\"9d1a35dfa711f919\",\"/knowledge-medium/pr-preview/pr-1920/src/data/migrationsPage.js\":\"ab61d5eda1641961\",\"/knowledge-medium/pr-preview/pr-1920/src/data/mutators.js\":\"6635ed69d42703e6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/orderKey.js\":\"b917bf9946195c33\",\"/knowledge-medium/pr-preview/pr-1920/src/data/orderKeyPlacement.js\":\"74ba0c684337a0fe\",\"/knowledge-medium/pr-preview/pr-1920/src/data/outlineSurface.js\":\"c2599f841a3193b2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pendingEditorContent.js\":\"7fa48525787184ca\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pendingUploadsSql.js\":\"0cad028e33bea8de\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pluginStateExtensions.js\":\"5396ed704eb2d778\",\"/knowledge-medium/pr-preview/pr-1920/src/data/powerSyncLogger.js\":\"e532b05ec9dafdac\",\"/knowledge-medium/pr-preview/pr-1920/src/data/projectorRuntime.js\":\"a29781713ebb8e27\",\"/knowledge-medium/pr-preview/pr-1920/src/data/properties.js\":\"a8172e7746d4e912\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertiesPage.js\":\"db242593ee6c9415\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyChildren.js\":\"f8a0e6fafb395c96\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionFanout.js\":\"969aa54d675e2c2b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionMetadata.js\":\"3603e3fd0a81269e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionRegistry.js\":\"96b8ae9d04d7a0e6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDisplayMode.js\":\"12a01ee4d316a4ea\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyRowCreation.js\":\"17d609d50091f230\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertySchemaCreation.js\":\"5d1e2a8daa58b4f5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertySeeds.js\":\"0d83a1a2e649f06e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/recentsPage.js\":\"cc14dd039fd1fb95\",\"/knowledge-medium/pr-preview/pr-1920/src/data/refTargetComparableProperty.js\":\"031763816d38d06c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/referenceBlock.js\":\"fb905f34b34b65a7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/rejectedUploads.js\":\"d91a76683192c63e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/releasePowerSyncConnection.js\":\"31abaed7eb5a96cf\",\"/knowledge-medium/pr-preview/pr-1920/src/data/repo.js\":\"4be4ad95d6bccfd3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/repoProvider.js\":\"59b4e716be6e3f9e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/rowProperty.js\":\"2ed40839323e65f5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/searchFilter.js\":\"11eea57cd04dfc80\",\"/knowledge-medium/pr-preview/pr-1920/src/data/seedIdentityLedger.js\":\"279491b381c60538\",\"/knowledge-medium/pr-preview/pr-1920/src/data/stateBlocks.js\":\"64a9e11cd5b53b71\",\"/knowledge-medium/pr-preview/pr-1920/src/data/structuralEditPolicy.js\":\"2370defe181a2e45\",\"/knowledge-medium/pr-preview/pr-1920/src/data/structuralInsert.js\":\"1f5c5c08351bb2ac\",\"/knowledge-medium/pr-preview/pr-1920/src/data/subtreeDelete.js\":\"7003267b270d7cfb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncStreamLock.js\":\"7dc4b98e0dc744ab\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncedTableSqlRecognizer.js\":\"5a12c0dd1105369c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncedTableWriteGuard.js\":\"360a4fedfb2b3a67\",\"/knowledge-medium/pr-preview/pr-1920/src/data/targets.js\":\"540dae9e86f58255\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeColors.js\":\"c25e0401ec17b481\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeDefinitionMetadata.js\":\"9822c607444e4bf5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeDefinitionRegistry.js\":\"a7ba867fcb0ce1e7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeExtraction.js\":\"17d4b11713701c1e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeInitialValues.js\":\"2685151329d20010\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typePropertyGroups.js\":\"006165954bedeffc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeSeeds.js\":\"28fac5b3cd9b856c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeTagger.js\":\"0379643905bcc939\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typedRecords.js\":\"9ba18efe23a9722e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typesPage.js\":\"3c9872bbadefd7b0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userPrefs.js\":\"4eb61710f2821c3c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userSchemasService.js\":\"376a65b7fc758a7a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userTypesService.js\":\"189860cffc582a1c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/valuePresetRegistry.js\":\"551d6fdd69a6f56a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/visibleChildren.js\":\"af5fe57599977f2f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceConversion.js\":\"4c482d883c803418\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceFirstSync.js\":\"2bbbeb6cb316ad69\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceIdNamespace.js\":\"39286ada8eb73c67\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceSchema.js\":\"6f2be84c7dcec418\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaces.js\":\"5f2ea09cfaf0147a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/writeAheadLog.js\":\"4f6cf0014ae38e6e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/BlockPasteShellDecorator.js\":\"47151ea8a5619e84\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/atTrigger.js\":\"c91bc36ce13ea6b7\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/autocomplete.js\":\"28769d9b76e0cc23\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/codeMirrorExtensions.js\":\"deecc323be1925d5\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/contentFlush.js\":\"f3011715088f9360\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/defaultInteractions.js\":\"146147a8b4bde7a7\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/editSettleSignal.js\":\"7b6f6cb8ccd0eae9\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/insertImage.js\":\"b611ebce76ddd485\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/referenceCompletionRange.js\":\"3e716e7645e4078b\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/referenceTargetTypes.js\":\"6e2b6d5a384c385a\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/syntaxContext.js\":\"c18c57e00821a976\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/triggerMatch.js\":\"679352d1e8ea00f8\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/AppRuntimeProvider.js\":\"3f45f1ab05f14b99\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/BlockFocusShellDecorator.js\":\"0838314330236f77\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/ExtensionRenderBoundary.js\":\"fdf006d9e21a123b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/PanelContentRecovery.js\":\"0434ccb1d6cf20cd\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/apiCatalog.js\":\"04657de1376b7699\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/appRuntimeController.js\":\"9a1ac8eca76e1c17\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/approveExtensionHere.js\":\"795fe56080134017\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/armedCutAppMount.js\":\"a02474a7e48effb2\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/batchableKeyedStore.js\":\"7d70449b68674b0b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/blockInteraction.js\":\"7002beb937ad59e4\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/blockSelectionAction.js\":\"5ca9abeab0febeff\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/buildApprovalRecord.js\":\"9f909afd9080ed5e\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/compileExtensionModule.js\":\"01ebf88af8bd0ba9\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/compiledModuleCache.js\":\"0d5b3ec843569353\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/continuousGestures.js\":\"625357c2191887bd\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/core.js\":\"1d14dbe8eb35247d\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/defaultRenderers.js\":\"b0779e25ad0be55a\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/definitionFanoutAppMount.js\":\"28bf0a3c25e5b62f\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dialogAppMount.js\":\"67b1e87a8b87780e\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dynamicExtensionSeeds.js\":\"d243bea4575736e9\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dynamicExtensions.js\":\"9afdd9b0c54e99d4\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/exampleExtensions.js\":\"5c1008ec65efbfc3\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionApprovalStatus.js\":\"25f64472551484fb\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionImportPolicy.js\":\"cd6a5bd51bc25873\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLoadErrorToast.js\":\"b80ace59ed388ff4\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLoadErrors.js\":\"3a76e5e2103bd142\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLookup.js\":\"111df40d520bfdba\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionToggles.js\":\"40ab946972ca4692\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionUtilitiesCss.js\":\"ffc83ce495d49cd4\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/kernelPageDeletionGuard.js\":\"374d4e5f2a30d54c\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/liveRuntime.js\":\"cd88dd6641382cd5\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/normalizeExtensionSource.js\":\"c48a81500ae53ec5\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/openExtensionsSettings.js\":\"f945efb3ba541a69\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/overridesCache.js\":\"132abcb5bc38cd1b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/pluginIds.js\":\"c2e61cc07b05c5fe\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/processorRejectionToast.js\":\"1c9ac191dd489358\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/runtimeActions.js\":\"4e68798f61afd66b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/runtimeContext.js\":\"addebed361616efb\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/staticAppExtensions.js\":\"f4e6130eaa4a1943\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/staticDataExtensions.js\":\"2d2a851037b039be\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/toastAppMount.js\":\"8b98f03722c00104\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/transpileExtension.js\":\"7809c6ab6ee72b4b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/useOverrides.js\":\"4bc9e3eba317dde2\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/useShortcutSurfaceActivations.js\":\"e94de4c4210be272\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/discoverToggleTree.js\":\"7adde34ddc0a0839\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/facet.js\":\"d78437e2567f0c1f\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/resolveAppRuntime.js\":\"4297e958a846988e\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/runtimeEvents.js\":\"727c050b4e4bd0c4\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/togglable.js\":\"0e310205f338b1e3\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/variantFacet.js\":\"a013fd50d87fe7ba\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/verbFacet.js\":\"957a42b777dbbc6f\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/block.js\":\"b1e260cee4d875c2\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/focusedChild.js\":\"2fb28a9627e682e1\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/propertySchemas.js\":\"9f9537529c40854c\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/typeRegistry.js\":\"1335ab7ecc1026d7\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useAncestorCrumbs.js\":\"f68a65bdd5753832\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useAutocompleteListbox.js\":\"22ee09bffe27aebc\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useDebouncedSearch.js\":\"15a321d9a103ac91\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useDebouncedValue.js\":\"1cab03e514dca003\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useFacetValue.js\":\"a03b9ac43595b02e\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useIsFocalRender.js\":\"4739a1c595814a37\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useIsReadOnly.js\":\"1bff6380eb7d33b9\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useMaterializeBacklog.js\":\"f5e97340dfa0ed2d\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useMinuteClock.js\":\"5415127fe36220e1\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/usePanelLayoutProjection.js\":\"9b231734e2d80355\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/usePendingInvitations.js\":\"215f397b8e78b0e3\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useRendererRegistry.js\":\"bc2c548f875651d3\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useRetainedFieldRows.js\":\"6b629a3de7ff8ee2\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useWorkspaces.js\":\"ae2de3ca6636f778\",\"/knowledge-medium/pr-preview/pr-1920/src/lib/utils.js\":\"5b62288bdbdb874a\",\"/knowledge-medium/pr-preview/pr-1920/src/main.js\":\"731943bca1a715ad\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/MarkdownImage.js\":\"6c44cdc511a0e458\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/blockSeparators.js\":\"2108f741a6cd5b80\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/context.js\":\"187662a6b80b1cb0\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/defaultMarkdownExtension.js\":\"e856c37e1cae53b4\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/extensions.js\":\"01d421ecf7897275\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/renderMarkdownHtml.js\":\"04bde808801e2c5f\",\"/knowledge-medium/pr-preview/pr-1920/src/minimal-editor.js\":\"e61597c82a3dd6b6\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/armedCut.js\":\"3c14b56db37af7b3\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/captureMediaVerb.js\":\"4a3e9707e04b5534\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/clipboard.js\":\"9599f3832d8e7203\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/decision.js\":\"7fcd8ba8169dcbdf\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/operations.js\":\"1dc3a37d4e6fafee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/account-header/AccountHeaderItem.js\":\"c0e6075c1690790a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/account-header/index.js\":\"b3edee2327013e1e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"8b08494874c349b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/askAgent.js\":\"f349d6d3f5b23ce2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/askedStore.js\":\"280c186b720f3d5f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"850f64235ad565ca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/chipState.js\":\"a6a62bc04aca2931\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/dataExtension.js\":\"67d89ed3e12f405a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/index.js\":\"2b833273faa49256\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"071818573edba121\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/schema.js\":\"ab56782e9e4aae94\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d4a8360cfbb33c98\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/BridgePairingDialog.js\":\"4e72c31ae0a99641\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/addMedia.js\":\"e501b934c3da57c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1cb6b64e9e434c03\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/block.js\":\"b965ec160a492321\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/context.js\":\"71f4e39cb63e6d1b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/displayIds.js\":\"efda4d84688372f5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/index.js\":\"0db461074843324d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/outline.js\":\"392e8dd77494fabb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/properties.js\":\"e1f2b115fb97f988\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/refs.js\":\"a6d98915d56eafd6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"2da5aa68ed0e1019\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/search.js\":\"303880ffe5253779\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/shared.js\":\"919f5a54840c685f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6ef4894479e6abaf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/text.js\":\"040d5313b1ee49f9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentWrites.js\":\"b9766c63df6410ba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/authoringCatalog.js\":\"c83df670cf0dd738\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/blockRefTargets.js\":\"7d3090e1e6800b6b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/bridge.js\":\"b11c2526bf823b21\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/bridgeLoop.js\":\"ea4f3830f19e1ff6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/changeHistory.js\":\"1826141166c02075\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/commands.js\":\"b4be28e5cf3efb3c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/commentsCommands.js\":\"6f76d8289301d0d2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dataExtension.js\":\"87b8ac0ba81bb212\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dataModelGuide.js\":\"74e2e5aa2c47a238\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dayPropertyInputs.js\":\"90cf31564a86e947\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/describeRuntime.js\":\"5711bb065cc8a4fd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/extensionLint.js\":\"85958dcb148c5c32\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/grainAudit.js\":\"08c74c0b6e55ac94\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/healthCommand.js\":\"e2556e74a3d0914a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/index.js\":\"23a90059e9c40801\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/presetIdentity.js\":\"a5884e1fc4649eee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"aed5b147204293f3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/readMedia.js\":\"d66c89a708221d1b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/schema.js\":\"4b56808a98c8e7e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/serialization.js\":\"4d5b0a3f5f8f75e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/targets.js\":\"aa55d4626276b485\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/tokens.js\":\"fe44e6395b78dc30\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/watchEvents.js\":\"935d5d9b83fb07de\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/workspaceGuard.js\":\"452ee7fdb99b8ebe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/writeCommands.js\":\"4f6d76d01e4f8336\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/AliasCollisionToast.js\":\"3e9b8068b43bbd22\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/DuplicateNameBanner.js\":\"ee1bbe66a96d91a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/collisionMerge.js\":\"505ba54b1144a5a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/dataExtension.js\":\"a73d794006561454\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/index.js\":\"e6a82aee956c4a6b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/mergeCollisionAction.js\":\"256feb73a27be32e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/pageStyling.js\":\"4e47f515b0dc6437\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/rejectionToast.js\":\"fab1eed499ef66e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/syncProcessor.js\":\"6af89aabee1826e0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/actions.js\":\"9bbd7f2e21917f16\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/addComment.js\":\"f6221f617cb8606b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/anchor.js\":\"d0ee52cd4a3e257f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/anchorState.js\":\"b3714e1e28c8e9f6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/commentLinks.js\":\"9fe8117291de3645\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/confirmThreadDeletion.js\":\"d05a38221ba1a775\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/container.js\":\"132141e3ee51ec6b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/dataExtension.js\":\"d50c570a180759f7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/deleteComment.js\":\"ccccd9a4f5f89f1e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/highlights.js\":\"3e6b82ab84509660\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/index.js\":\"c9fe84482f7c1f77\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/linkedCommentsPill.js\":\"8349f92faba6914b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/margin.js\":\"bdf98a9cfdc5105a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/marginAnchorLinks.js\":\"8d2fbb5c89e65f3d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/marginSchema.js\":\"4ec6f091bd176094\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/newComment.js\":\"0fc60897ebefb11f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/ownThreadPicker.js\":\"a12cbfcf2e6ff250\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/placement.js\":\"40c1be68782896e9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/queries.js\":\"933494871b7d76a2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotePosition.js\":\"fba55ac8dfc79bbd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotedIn.js\":\"7f2063c82376ef7c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotedRange.js\":\"06359e802f89f275\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/rangeRefs.js\":\"1d149916e7b43c74\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readHighlights.js\":\"a65cfb0a93cedbc3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readSelection.js\":\"e0248afc0b8b0678\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readSelectionUi.js\":\"e18e0d6d0a6d2658\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/reanchor.js\":\"5fa2a7f20526e58e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/schema.js\":\"5acab7c381b7b9fd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/scope.js\":\"523b2f71219fc8b9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/scopeThreads.js\":\"4dbaf8be94ea69e2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/splitRetarget.js\":\"1c4422760f7b87d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/suggestionCard.js\":\"183c1068d5c5f7fc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/suggestions.js\":\"2d57a64e818226cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/summaries.js\":\"25def243c546d6e9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/summaryBatch.js\":\"66e1b11fea16c478\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/surface.js\":\"89e210645d8613ed\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/threadNavigation.js\":\"a6317c576d7f93db\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/threads.js\":\"b7610d60c8a2f8db\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/ui.js\":\"9339fe6510c0d73b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/uiStore.js\":\"5df86a2bac1168a9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-intents/appIntents.js\":\"8ca2366cc286c86b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-intents/index.js\":\"e00d0b9a0ee22695\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-update-prompt/index.js\":\"e3f6d018cafb3b21\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-update-prompt/status.js\":\"996662cee261f118\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"015d0ed3ace3f0f6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaBlockRenderer.js\":\"54c9f313a51adc0c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaDownLaneReplicator.js\":\"0e90e5b40df0bb5a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaUploadReconciler.js\":\"b9a84eeffa962f44\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetDownLane.js\":\"13d6dc026dec5534\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetResolver.js\":\"18289580fd682e6a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetUpload.js\":\"0fcf5b9e4788d1a4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/attachmentCleanerIO.js\":\"a76bfb22a21c97d0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/supabaseAuditIO.js\":\"16e06e8c485b234d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/blobStore.js\":\"c280cd3d0b5bdafb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/browserMedia.js\":\"ecd351df335d1a4e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/byteStore.js\":\"df94cc33975e1e3b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/cleanerIO.js\":\"748375c31cddb8dc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/cleanupAttachments.js\":\"85e5ccb58056949a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/dataExtension.js\":\"922a502a67136905\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/downLane.js\":\"73305615754a7b5c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/index.js\":\"1040a40f3887c1d4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/insertImageContribution.js\":\"79be12c76ccd8a71\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/laneArming.js\":\"db19238414921a47\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/laneLock.js\":\"768f8bc40c1d7366\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaBlock.js\":\"6d85260b53a739d0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaCapture.js\":\"5f5c59af1d54227d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaLanes.js\":\"20126607a844400e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaViewers.js\":\"fffc881a6617ed79\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaViewersFacet.js\":\"4e0fd6bd0de66f8d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/pasteCapture.js\":\"7b5bbf4fd0c6c980\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/resolver.js\":\"0e0c34e4f2f1ccd2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/retryUploadsAction.js\":\"659d63e08d16d429\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/storagePaths.js\":\"7e3c0db1930585e5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadDrain.js\":\"ea579eb6f9b841a4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadLaneStatus.js\":\"6b3d0e6d7a2fb1e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadReconcile.js\":\"c93d6acb0e8f8d0b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadRecovery.js\":\"ba3b5ad94e4bab1d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadStore.js\":\"720cc5c5b03d7d56\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/useAssetObjectUrl.js\":\"04d743078c7e778e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d92aacb3864c74ef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/BacklinksViewSection.js\":\"70fdc533d8699227\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/facet.js\":\"58a1e5d2e1279b9e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/index.js\":\"12e00d7733e8cd97\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/prop.js\":\"94a0bf0225be83ec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BacklinkFilters.js\":\"096006cdd47ea4a6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"883af4340f5dbb55\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BlockEntry.js\":\"22c2395bd8649613\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/LinkedReferences.js\":\"e2b2b645223212e6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"22cf792efdae6b68\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/dailyNoteDefaults.js\":\"16c379d5e6e2e38d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/dataExtension.js\":\"d91881e65e9da045\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/edgeExclusions.js\":\"e56d412c144b2bd0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/filterProperty.js\":\"a89990589dd54895\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/index.js\":\"99929562cc5755f6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"9eb1b7738069d52d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/applies.js\":\"8180c6da2afd8a0a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/countQuery.js\":\"343ba379802018e3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/expansionStore.js\":\"636913a417a9d234\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/index.js\":\"2e8e142ddb8b9b1a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"16fc16ab240df231\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/presentationInvalidation.js\":\"17297222f85a1f61\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/propertyEditorOverride.js\":\"d5f8e3249f519cb7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/propertyFilter.js\":\"7316da3e3ea6d8f8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/query.js\":\"3d6fe4a1afc4391d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/resolveFilter.js\":\"79c9b1c02c506044\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/sourceBatch.js\":\"b8db812a27146fc7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/sources.js\":\"ae5cc5b115c3461e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/useBacklinks.js\":\"6968d03f22d4c02a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"bedff6f35d9f8d90\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/BirthdayCelebration.js\":\"1c4f9c2fe8c56b69\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/BirthdayOverlay.js\":\"b58e055e51154d9e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/gate.js\":\"7bea88568861fd05\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/index.js\":\"3dd7bdf14a16495d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/wolfTheme.js\":\"f794fe47f7dccf64\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/BlockDragLayer.js\":\"b144ade931a8ba28\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/dragController.js\":\"c33e0b4fd227e001\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/dropTarget.js\":\"e0a5c54bd49fd180\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/index.js\":\"f177637fda201d2e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/projection.js\":\"7dcfb75bd6b14645\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-info/BlockMetaCard.js\":\"93a442c9547fa0df\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-info/index.js\":\"4d192f131a88509e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/AddTagDialog.js\":\"2554735d53051ca6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"f6cf20692401db6c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/TagNameIssueHint.js\":\"a358af0e98278a4f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/addTagAction.js\":\"ffbdc7a93d5aa223\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/appendTag.js\":\"7c898a2580652704\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/config.js\":\"76b4eb5198c5e8be\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/dataExtension.js\":\"56d9257d5a6e0bcd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/index.js\":\"8deaa5653e2cc8aa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/propertyEditorOverride.js\":\"d9bd9e2d74163056\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/BreadcrumbList.js\":\"61e360abe6c28586\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a994186729e8ae4b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/Breadcrumbs.js\":\"01bd6138d726b47b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"9982ac4423b24a63\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4272375fdd9855dd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/index.js\":\"c206ed98bd8565f3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"e591b3e79e5d358f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/CharacterCountItem.js\":\"443e6c945b320dd2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/ProfilePropertyEditor.js\":\"b11d45733505d2e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/actions.js\":\"a6a9af36779a2436\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/blockType.js\":\"3368ac0d706230f2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/charCount.js\":\"88fec5e1d7b0ecb8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/dataExtension.js\":\"b2be0c9ebaa2ff21\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/index.js\":\"abc21ad24414af31\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/profiles.js\":\"14022d534bdf22a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/properties.js\":\"eacfdbcaf15e2ca0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/subtree.js\":\"76821cb57ca1959f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/textCounts.js\":\"edbc222e2c5ab317\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/colemak-keybindings/index.js\":\"fa3db11cb011c1cd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/CommandPalette.js\":\"0c285df61121fbcd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/HeaderItem.js\":\"bae94e5916845ecc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/context.js\":\"d3aab29d9851b850\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/index.js\":\"e333ddb3a299083d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/selection.js\":\"562b0eb26babe074\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/toggleStore.js\":\"0740cd26ac6f8ad1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/useCommandPaletteActions.js\":\"bfe041ea13c27da5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/ContributorBadges.js\":\"330888a4e01b987c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/ProfilePicture.js\":\"0e44b42ffb496301\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/author.js\":\"419a2b2cb418b2ef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/codeMirrorExtensions.js\":\"98c8324fafadb976\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/dataExtension.js\":\"066906c0c1c9fc28\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/index.js\":\"8753ae6b51591b3a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/mentionAutocomplete.js\":\"e5bec8d4e75d4381\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/processor.js\":\"5677f0833aa6d9e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/profiles.js\":\"5c027dfec1916550\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/queries.js\":\"8eebe603cac7342c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/schema.js\":\"3a999d816ddb6f86\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/useCommentAuthor.js\":\"f6ed178255568317\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"942fedc26f0a3ee7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6addec7cdeb9724e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/index.js\":\"47f7a30b5f335444\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"facc8560abd6aa26\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"24f92cb5632f37a1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/CalendarGrid.js\":\"20c99a52bb07ee9e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DailyNotePicker.js\":\"707b08aa39371739\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"9d054d60f8cd1e0c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateNavDecorator.js\":\"3b444bb9c3ec7ff3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateScrubOverlay.js\":\"39ff7f39cd4e5924\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DayPropertyControl.js\":\"32129eefc64dbbef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DayValueReferenceControl.js\":\"f16e800ca3379511\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/HeaderItem.js\":\"cf0ed857dfe0ea8f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/ReschedulePicker.js\":\"ba02733a348cd3ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/SpreadDatesDialog.js\":\"977fa9db264b63c5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/actions.js\":\"ec8a69cfce99343a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/blockDateAdapter.js\":\"86c55a6def5d000b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/calendar.js\":\"bd583d4c90044f1d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dailyNotes.js\":\"2a82d45bbd3cc9c5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dataExtension.js\":\"51f0118dd06f251c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubActions.js\":\"2cb4427c64a1611e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubGesture.js\":\"fa58bb95d3261626\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubGestureActions.js\":\"94873f53bc6f7f79\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1b47ef0e70e38f51\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dayProperty.js\":\"8d9e146e2b6e6d09\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"c1dcb39be885668b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/deletionGuard.js\":\"7c6b4834025ef0c6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dueQuery.js\":\"bb8a2263d8078e54\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/index.js\":\"6a8c069fb6ad4a18\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/landing.js\":\"0ac75d85da1dff4c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/localSchema.js\":\"df2785ee8c41c6db\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/referenceDateAdapter.js\":\"06f399bfafa5fd31\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/rescheduleAction.js\":\"74c2bc34c44b4cec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/schema.js\":\"e5e74d8e866bc725\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/spreadBlockDates.js\":\"c3afa5a756034411\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/spreadDatesAction.js\":\"7db9985260bdbb03\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/today.js\":\"a71527cc9388f9f9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"76b89e0751b84f4a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"51a98bcb4feb808b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/audit.js\":\"7b560d7fcb244eab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/auditAction.js\":\"b23c37449c743e5a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/auditRanges.js\":\"73af3efb1c26c206\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/diagnosticsSource.js\":\"ecbdc1625594f661\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/divergenceScan.js\":\"0069417fdf7ffeef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/index.js\":\"17b0da2c22492904\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/propertyChildrenChecks.js\":\"5dcb68b88b73935e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/referencesMirror.js\":\"5518279bd720282f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/rowJson.js\":\"c2e49d9a8cf7a232\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/schedule.js\":\"4984404693caaf04\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/store.js\":\"53099f16e4d1c5c0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/action.js\":\"85126c025bc9102b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/index.js\":\"78be3110e909d403\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/plugin.js\":\"0c10b04ab2a17f64\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"1c22617dd1473de5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/actions.js\":\"473e1dcfcf74c209\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/changeMarker.js\":\"20ca0629d64282df\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/diagnostics.js\":\"b08290f5c6430c6c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/fileSystemAccess.js\":\"671fb633cef01081\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/filenames.js\":\"979a29180d775162\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/index.js\":\"35738f4e8a289a52\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/mirror.js\":\"490aaec10c053a1d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/runLock.js\":\"02f849432255d62f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/runtimeHealth.js\":\"3cf6cebb22a63684\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/schedule.js\":\"53666d0e5b49e549\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/store.js\":\"a8f54f738b1a5563\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/default-themes/index.js\":\"0117ae4aeb0b8857\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/default-themes/themes.js\":\"82510ad8d6c196e0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/diagnostics/facet.js\":\"432a13c743fb407d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/diagnostics/useDiagnostics.js\":\"6d5c38acfc1bd252\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/dismissals.js\":\"af9444cd2fd965e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/index.js\":\"16262d8c2ffc3f1c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/status.js\":\"996d87ef653303dc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/store.js\":\"d6162ea89c898c3d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"89b651dbd4e2f1d7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/ExtensionsSettings.js\":\"7af3b51f5435af6d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/actions.js\":\"cafeb58421201b3e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/config.js\":\"7dca65c40cd85291\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/dataExtension.js\":\"213ee8fff8b14066\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/effect.js\":\"893396f3d54c1be0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/index.js\":\"7afd145d563000c9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/propertyEditorOverride.js\":\"a5e21011c73ebce7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/useToggleTree.js\":\"f1301dfffc02c847\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/ExtractTypeDialog.js\":\"706773187239ef2b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5dee8603e7d27afb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/PropertyShapePicker.js\":\"a2b90024345a3e39\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/action.js\":\"1457a4ad29d3e9cd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/index.js\":\"cdf2b1630e49af03\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/FindReplaceDialog.js\":\"9fc22e56aa2ee5c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/HeaderItem.js\":\"374fc60226f84363\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/dataExtension.js\":\"fdf989ba08b0d7fc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/index.js\":\"c128810b851c0407\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/search.js\":\"2535e7a11af000d3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/toggleStore.js\":\"d67060c8c8d764c6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/LocationPropertyEditor.js\":\"9ade16771e9846f2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/MapView.js\":\"8e7492ab0deabfe9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/blockTypes.js\":\"09d18b8ab11bc597\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/codeMirrorExtensions.js\":\"0c8fbba786188df0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/createOrFindPlace.js\":\"9f6fddc6813191e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/currentLocation.js\":\"46ecc9fa212249a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/dataExtension.js\":\"bcc54088ef366ba5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/geoContentDecorator.js\":\"daf2cf1a37a95441\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/googlePlacesClient.js\":\"32b1ff4cc0ab5434\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/index.js\":\"597f945211bfb7d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/locationsPage.js\":\"38c58afd79d83361\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/mapViewport.js\":\"e2a91c73a8639050\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/pickCurrentLocation.js\":\"3c22a099505176ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/placeAutocomplete.js\":\"7b0c4b7c2d638c8f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/placeNameCollision.js\":\"ab6527a2fcf0222f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/properties.js\":\"1da03fa6836c9b94\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/propertyEditorOverrides.js\":\"aa70a8cc0c46cc38\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/query.js\":\"bb7a5d66708de798\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/usePlaceSearch.js\":\"7a55bf68cdae2b4c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"334b32eb1c6f36fc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"7f7c994451bd7204\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"9f61ce4f0a455d3f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/config.js\":\"5c7e43a51e724d86\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/dataExtension.js\":\"85e68d7d5514f297\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/facet.js\":\"9f1bc34a0668c2ee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/grouping.js\":\"e080d3715c555a3d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/index.js\":\"9477ce18e58be1df\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"8d906ec6cdf1c671\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/query.js\":\"95c7aa06a10712c7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/resolveConfig.js\":\"d6ef14ef6c8fd856\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"c37a74cc60cf1877\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"02d89d726e2a69d8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/HtmlDocumentContent.js\":\"8b29b17a62c16400\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/HtmlFrame.js\":\"3896fd61a9411e3a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/actions.js\":\"3f87ffbf4399687b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/blockType.js\":\"4ccc5b2931242a8b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/confirmRunScripts.js\":\"708052a84cccce17\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/dataExtension.js\":\"d1d371b61c01807a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameAnnotations.js\":\"70ca97e850a2f11a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameDocument.js\":\"2e7e1c1fc7a91b23\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameTheme.js\":\"8288ff124fe803c7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/index.js\":\"9d95def4381e1664\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/scriptConsent.js\":\"4d439d11694418e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/sourceMap.js\":\"a2ec12b9562c4741\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/useDocumentScripts.js\":\"156a6cc5000e0513\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/index.js\":\"f6de48eac4cb1fbe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/record.js\":\"d72a2219a8a16106\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/recordStore.js\":\"116e0285395af136\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/responsiveness.js\":\"1de93d090ffdb9f3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/schedule.js\":\"770e875f90e98430\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/sessionContext.js\":\"d0f34b25c2431f63\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"e6ce8b4c7325c40d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3dcd8a38313a0aff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/actions.js\":\"2866c8a716fd1f10\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/config.js\":\"58154a54b0828409\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/dataExtension.js\":\"72557df39c3275bb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/effect.js\":\"9b32c099008723ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/index.js\":\"2d15e2fb241ebccd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/keyCapture.js\":\"f4e7c485a99c283a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/overrideStore.js\":\"979e11b9596cf46e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"cc3b6115a5fe9477\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/HeaderItem.js\":\"0763c41653a4ff7b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/LeftSidebar.js\":\"2eb7cf9b69d12ffd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/actions.js\":\"3106d3e95cf9f2c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/facet.js\":\"5dd1b653c2f15793\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/index.js\":\"f8abee2356f8adaf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/shortcuts.js\":\"d1f78fcb4f091275\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/toggleStore.js\":\"98e78b2a44907029\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/MergePicker.js\":\"1d273ffe4659e213\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/index.js\":\"3fb691e95af45aca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/mergeAction.js\":\"27e458f49dfdbb50\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/strategy.js\":\"0f585a9d618f2724\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/Button.js\":\"62320da556788158\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"7076e3cbd8718242\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/defaultItems.js\":\"d845570f406f916f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/facet.js\":\"52983adba0b22b64\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/index.js\":\"d2bcea8ec41d209b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"c6d8132335436403\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/actions.js\":\"09bdb9679019758a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b72abf086b729b3a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/facet.js\":\"8853697ae43688d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/index.js\":\"581e43e3c2b518fe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/MoveDestinationPicker.js\":\"50552c8bb2112031\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b4a1748e104a3a99\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/contextMenuItem.js\":\"c9a2f1fde302b5ea\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/index.js\":\"f1b628c1def13a95\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/moveAction.js\":\"7e2a5e7aa67bd38c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/moveBlocks.js\":\"6f0b58e4a4d9b14f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/selectionAfterMove.js\":\"f003ca04fdeaec53\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/TutorialBanner.js\":\"9b8b4bb73e35288c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/action.js\":\"c0e3c60a5563d23c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/bannerDismissal.js\":\"6c8dc171692b9cfe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/documents/cheatSheet.js\":\"1dd79e5da65aafca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/index.js\":\"da646977b821b620\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/keys.js\":\"5108ad8f6a585d19\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/landing.js\":\"ce09eaf2e1b11d1b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/outline.js\":\"ee4a29f1e3314d1b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/seed.js\":\"1771c2a61a0eabfc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/PerfTrendDialog.js\":\"6c3859cf5213f01a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/analyze.js\":\"8864b5bd3072629d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/diagnosticsSource.js\":\"0a255ee566ce06ee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/index.js\":\"218700ee527732e3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/load.js\":\"f03a18c34a2ad004\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/monitorRun.js\":\"237b1508c61eb948\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/schedule.js\":\"29539362e1874e2e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/series.js\":\"4ced55742d49fa4e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/store.js\":\"c05ba139e9c3afcb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/trendAction.js\":\"de5de8d4e7ec4545\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/verdict.js\":\"62a9fef43c4bf7b9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/clickToEditAction.js\":\"c23780b66acdb44b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/index.js\":\"c54707775a6a59e2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/interactions.js\":\"05b079ec05d9c31c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"9b9d34ac8549fbf5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/MigrationGate.js\":\"9c332a5e446afe0f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/MigrationGateDialog.js\":\"ceb3830819cdf484\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/action.js\":\"6ba8249baa07e4fc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/index.js\":\"e6fc989a42151e35\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/localRunMessage.js\":\"36d797b538a59eb0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/plugin.js\":\"90e63a9205c51c1b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/progressReport.js\":\"bab939c5da7ecbf4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/sweepProgress.js\":\"8c56c40d55bc398d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/FieldRowRenderer.js\":\"6e81964bcadee01d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/ValueRowRenderer.js\":\"658a9815684f1d1b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/actions.js\":\"af9aceca80cd0667\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/autocomplete.js\":\"57265084a824fdd2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/fieldRow.js\":\"06f08e5d2c044f30\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/index.js\":\"8584862c6e6246e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/referenceWarning.js\":\"24e95cea6a2593e8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/valueAutocomplete.js\":\"4f32b02c44908d49\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/valueSchema.js\":\"1445428610f5c5a8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/HeaderItem.js\":\"ae812fb498de34d3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/QuickFind.js\":\"431dd0f8a91707e0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/index.js\":\"78d7185f2220fa60\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/recents.js\":\"8cb0137d1a6811b3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/resultItems.js\":\"7ddaab202535520b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/selection.js\":\"c939c0a321d30bb2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/toggleStore.js\":\"87a10fdfb8f18a85\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/HeaderItem.js\":\"ddca834f7816a792\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/RecentsPageBlockRenderer.js\":\"7bd49cd8ad79a7c5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/grouping.js\":\"07775d5da623b3b0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/index.js\":\"cefb27887ecfd767\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/target.js\":\"99ea2f3cd222e94c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/codeMirrorExtensions.js\":\"bd4f2fd40049d84f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/contentPrefill.js\":\"77682e68417a7561\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/dataExtension.js\":\"dc90efae1da5e729\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/index.js\":\"7584e3b374bc2dc0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e6ced0a08d6e5749\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/invalidation.js\":\"1f7e208ff7b2782a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/localSchema.js\":\"ddc43e2dff417557\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/blockrefs/index.js\":\"4c86e67f4680421f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"b7ee8a13b7cadcf5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/index.js\":\"d4f88129ec3eadd3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/referenceNode.js\":\"2b5b4ad3210fb1fb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/remark-reference-occurrences.js\":\"6acb0e7e5e23ada5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"1765a03033ebaf9c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/index.js\":\"b86dd93b14a43fcc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"c303b9f70e658d9a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a2006926158dc17c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/mergeRetargetProcessor.js\":\"bdf4a1be9d3c3836\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/parseFence.js\":\"f91a4cb538c42346\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referenceParser.js\":\"dd64b87effa4e7a4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referenceProjection.js\":\"33a636c4a5131053\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referencesProcessor.js\":\"1bd1cf8c4a785238\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/renameProcessor.js\":\"36bef7caf47d88f1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/spanReplacement.js\":\"09bf0ddb37e54128\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/htmlToOutline.js\":\"1e0e0acea87bcf7a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/index.js\":\"cfbfc95080a88a6b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/normalizeClipboardDom.js\":\"8798806ffea3df1e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/pasteDecision.js\":\"81387adcc0da3cfb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/action.js\":\"9b84ba71509cc482\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/blockIds.js\":\"b3624eaa6764b953\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/content.js\":\"048fa474bc361605\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/effect.js\":\"4327bd6adcc4570d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/ids.js\":\"d7befde51b913095\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/import.js\":\"13cae1c43837e6b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/index.js\":\"3bf5224058e64db6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/plan.js\":\"6e4035f2a80594cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/plugin.js\":\"26c3d9d75a290e84\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/promotion.js\":\"75feecc98a8e17e6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/properties.js\":\"87c33c44168850af\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/references.js\":\"e4a98172ee671e41\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/report.js\":\"e1af7bd238fcdf4c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/roamMemo.js\":\"05713d6b9e96fae6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/runtime.js\":\"836ce7005fdcdb57\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/schemaReconciliation.js\":\"4f8169c157919695\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/srsMarkers.js\":\"a306fb4b6c88a8ab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/todo.js\":\"b532613fae6bf288\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/typeCandidates.js\":\"a16908575615a38e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/types.js\":\"22efc9bde1eae700\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/search-health/index.js\":\"9fc52361264c7a53\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/search-health/store.js\":\"2a3527b21c0feb6a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/HeaderItem.js\":\"d3b90c367cf3d3a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"16144e10fd3f466b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/index.js\":\"a8a5212d40a182bd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/model.js\":\"0a88c8a40da50491\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/toggleStore.js\":\"bd50111eb008d892\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/useKeyInspector.js\":\"52bffa9ac29ed7bb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"bf800a23eea8a9d2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/ShellDecorator.js\":\"050ec3a9f3342326\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/actions.js\":\"18a446970b2df3eb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/exclusionsFacet.js\":\"b7c94bea2d6d47ce\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/index.js\":\"99ee818993199dd1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/shell.js\":\"0c8bf98cc411cef2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/surface.js\":\"923787cb8ab7c66b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/walker.js\":\"d0248e76fcfab028\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/RescheduleToast.js\":\"0d096d3889a7f5be\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/dataExtension.js\":\"721ef2d24c822d63\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/index.js\":\"38064f4d86e58f23\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/indicator.js\":\"af228485130ca5a9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/moveSrsState.js\":\"fcfed689f334880e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"0c46f98f599512af\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/scheduler.js\":\"7d4d2b8ddaaf1b77\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/schema.js\":\"2fa7ffdf52880566\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"f8160d6a3e2502d4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/srsClipboard.js\":\"4098058a7c2ca4ec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"3f3e3dce09dbc85a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e2421adb98151829\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/DeckPicker.js\":\"58fad853e7ffae8e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewControls.js\":\"25b1b84298a6187c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewDeckRenderer.js\":\"2780f36766215186\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewSession.js\":\"38614c6039f8b704\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/actions.js\":\"368f88db4e9bafb0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/archive.js\":\"1e2aca5b08ba2fca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/dataExtension.js\":\"cb467103d92cb4b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/deck.js\":\"c9549747428930b2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/dueQuery.js\":\"27ec07a2d964431f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/gradeDecision.js\":\"ef34c7ff6082ba64\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/index.js\":\"41c08f9fd12abeac\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/keyHints.js\":\"a4990ef8cfecf970\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/reviewCardLayout.js\":\"dfd965c85226ff76\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/reviewProgress.js\":\"6b010bfe7d82a740\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/schema.js\":\"52c42a8d5428f0d7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/useDueCards.js\":\"29e772b49a06e4a3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/startup-metrics/index.js\":\"7bb0a1f5eb3df584\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/startup-metrics/record.js\":\"a12a08c41fb79ad2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/index.js\":\"dc761946220d7469\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/persistenceStatus.js\":\"0f90cc622876fb5b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/requestAction.js\":\"e59d53b7f6802498\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/TypeChipsDecorator.js\":\"171e0e6f2b1f99d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/codeMirrorExtensions.js\":\"74bd87862da3f083\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/index.js\":\"206bef1678f1d5de\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/typeAutocomplete.js\":\"8a4a0d9818ffe7f5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"448eb2ecdd0b9cc2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/actions.js\":\"818a2c08de07af7f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/anchor.js\":\"c1b1d4a376a09534\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/events.js\":\"be22f91b5913ac41\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/gestureActions.js\":\"8237c4c917f23665\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/index.js\":\"b2a459994df5d780\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"cce40e116b347899\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/collect.js\":\"fd4e0082b6eb6cdf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/index.js\":\"dcc84ee7e493d685\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/record.js\":\"bfe88c831c1ccda0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/RejectionDialog.js\":\"bdb88188742f4779\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/SystemStatusHeaderItem.js\":\"30a57a8cfd7bec96\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/index.js\":\"21b6539087443815\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/model.js\":\"bc60247b6b2ee6ae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/queueCounts.js\":\"8c640300c168e4b3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/rejectedHelpers.js\":\"75d9162168890b81\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/rematerializeAction.js\":\"a708fdb55e442a6d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/useHysteresis.js\":\"62593966af6f463e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/ColumnHeaders.js\":\"faa1050d7cc09536\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/QueryUi.js\":\"22e3cf570a0a7e07\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/TableLayout.js\":\"4cbbb8254b5a599c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/actions.js\":\"aad661620b5739fc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/cellEdits.js\":\"7992d9af3e8c9df5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/childrenViews.js\":\"8deea06a0ba285eb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/columns.js\":\"2fa99f5660d7e5f1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/controller.js\":\"ade20683548b6491\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/convert.js\":\"d3a00495459270db\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/dataExtension.js\":\"cddb5b8bde5fbb80\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/index.js\":\"4214f9101317a5de\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/keys.js\":\"87f29571903deb70\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/model.js\":\"d8b2ac0c8c81cee9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/QueryText.js\":\"a4d095a4dc691f5d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/backfill.js\":\"baa0d522a81edfc5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/completion.js\":\"6c577247bb8e04ea\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/format.js\":\"02bf6fd20554bce7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/parse.js\":\"fb4044c356742c09\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/queryValue.js\":\"a48436c4e0aa3241\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/registrations.js\":\"1f87491a879d86ef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/source.js\":\"e0590f5c1be781a1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/registry.js\":\"a98630f9d8c25424\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/rowGutter.js\":\"43022bb30b9903e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/rowVerbs.js\":\"9d4ad5e7240cc0da\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/schema.js\":\"46ba51e6efc0361f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/sort.js\":\"3cab036ff6a2638c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/effect.js\":\"ae9636887a291524\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/index.js\":\"b7496109033cb47f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/theme.js\":\"2a932f4ee1608087\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/actions.js\":\"faa0d0feb775bd35\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/dataExtension.js\":\"7046baee002df3e2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/index.js\":\"de24475cce6a7bbd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/schema.js\":\"9762ddb14e8d564a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/TouchSelectionLayer.js\":\"75841dee868146de\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/actions.js\":\"2480d1827123dc8c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/defaultItems.js\":\"17d64e5fadf09596\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/facet.js\":\"df45b6189999b324\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/holdRecognizer.js\":\"b0a99e960903b2e6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/index.js\":\"8189d311f7041c6d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/UpdateIndicator.js\":\"0def11c3c0589165\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/index.js\":\"385dd43ae6d375f5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/loadTimes.js\":\"ca2318356c6038a1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoNotesRenderer.js\":\"6a2c295453f89186\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoPlayerRenderer.js\":\"2194f678f9906e9f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoTimeStamp.js\":\"43ae7bf884e8012a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/actions.js\":\"44164114a238c4c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/index.js\":\"436cb71fb5751774\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/markdown.js\":\"04e41aac22c70461\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/notes.js\":\"e70538e90ede6e32\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/registry.js\":\"fd6973742bffc3e9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/remark-timestamps.js\":\"30c946f5033c9911\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/view.js\":\"ef3f99e565588d48\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/LinkHints.js\":\"969666fd5e8f2198\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/index.js\":\"81d375c7b197b581\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/model.js\":\"73c1344dba50fd80\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/settings.js\":\"36f25446d837c879\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/actions.js\":\"1e97765ab1a8c205\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/index.js\":\"ef6504c595bb448b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/interactions.js\":\"bee51a5c162e937b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/workspace-header/index.js\":\"9970ba15ee49b45d\",\"/knowledge-medium/pr-preview/pr-1920/src/registerServiceWorker.js\":\"6ad969c7a3ca063f\",\"/knowledge-medium/pr-preview/pr-1920/src/requestPersistentStorage.js\":\"41361def4b65c51c\",\"/knowledge-medium/pr-preview/pr-1920/src/services/authRequestDeadline.js\":\"46fcc0959900ece3\",\"/knowledge-medium/pr-preview/pr-1920/src/services/authStorage.js\":\"0966ca015113c2a7\",\"/knowledge-medium/pr-preview/pr-1920/src/services/powersync.js\":\"de926edcc71f9095\",\"/knowledge-medium/pr-preview/pr-1920/src/services/supabase.js\":\"13a78d01b5bebc4d\",\"/knowledge-medium/pr-preview/pr-1920/src/services/uploadErrorClassifier.js\":\"80982bf8804735f2\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/ActiveContexts.js\":\"f8c4effea2650956\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/HotkeyReconciler.js\":\"dcbcd4bcd49aaafb\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/WipeLocalDataDialog.js\":\"64b1983d09b609f5\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/actionDispatch.js\":\"9b2c0361b05ecaf1\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/actionRefItems.js\":\"e133e68dcb609e20\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/applyKeybindingOverrides.js\":\"91004058ca56db58\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/blockActions.js\":\"a04dd6df85edaaeb\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/blockMergeGesture.js\":\"938bbf77b0188edb\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/canonicalizeChord.js\":\"18737e7a03a2ebdd\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/defaultContexts.js\":\"e135676298372148\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/defaultShortcuts.js\":\"7ff866b4132081c2\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/effectiveActions.js\":\"67524203d0a44bd8\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/gestureAction.js\":\"568af10f289639d5\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/gestureBinding.js\":\"b0981da8613e82e8\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/holdRegistry.js\":\"6d2085740b166044\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/keybindingConflicts.js\":\"45589007921284a8\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/keybindingOverrides.js\":\"58f38561590cb733\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/pointerAction.js\":\"0c9e16deb8be75a0\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/resolve.js\":\"377e3a89133ba482\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/runAction.js\":\"b95af2c61aebf0a8\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/sequenceMatcher.js\":\"d7255f019ea253a8\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/types.js\":\"1871b2612a66bbe7\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/useActionContext.js\":\"d27f219fe3d977cf\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/useActionDiscovery.js\":\"b22365ff6da87456\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/utils.js\":\"2109359868c0ed39\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/bootStore.js\":\"a63573c9c36a26da\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/previewDatabases.js\":\"cca24e43956a9d84\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/byteTransform.js\":\"7641695ffa3064c3\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/attachmentCleaner.js\":\"372631009d728698\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/attachmentParts.js\":\"c018e9390662bdfa\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/bundleParts.js\":\"a9d34560dc1c0e57\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/bundleRecord.js\":\"c9001bcb2e15f278\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/manifest.js\":\"53307b6f6e8bbd22\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/takeBundle.js\":\"724c4c62379208af\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/verifyBundle.js\":\"a419dd1e8a9168b2\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/cleaningStage.js\":\"7cec0c1333ef5009\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionKey.js\":\"66cde8d5272f985e\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionServer.js\":\"6a3cada56331708b\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/flip.js\":\"ca1d099afb3de1a3\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/flipAttempts.js\":\"0419a75e795ea839\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/pages.js\":\"9515d386c106e246\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/preflight.js\":\"ac77ea09ec556a74\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/reseal.js\":\"53ec065aeab9ba2c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/runConversion.js\":\"96e54904d238f79e\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/runLock.js\":\"d40154fad58c7195\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/sealing.js\":\"cd9f9d0da10fdaae\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/sealingStage.js\":\"f5f66f72bc664158\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/stage.js\":\"f7de20e5c62505d4\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/verifyReseal.js\":\"05c1580b5df94503\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/aad.js\":\"e9a0816dde66665b\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/aead.js\":\"012b78d903af200c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/base32.js\":\"72658eb102d27944\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/base64url.js\":\"ab3b45b76f6d26d3\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/binaryEnvelope.js\":\"496bc3fe85d4a2d9\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/byteAead.js\":\"0bbc5169e7d15c02\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/canary.js\":\"d82c45012a31ac63\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/contentHash.js\":\"b4cfc18715ec7a7c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/contentKey.js\":\"d936826c2bf95c1d\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/derivedIdNamespace.js\":\"3a4e72f4f4229c0c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/envelope.js\":\"0575a01075f46332\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/hex.js\":\"01941fb3bb67d81a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/sha256Hex.js\":\"cff5ec02c4217275\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/workspaceKey.js\":\"1091cb919c22b39c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/conversionState.js\":\"5145c80a53add029\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/createEncryptedWorkspace.js\":\"a47be6833ac50dd9\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/pastedKey.js\":\"d3d071ae6c39a09b\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"0b14f0c8a60c0f17\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/upgradeWorkspacePin.js\":\"12bc186061666fbe\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/keyStore.js\":\"3cf13b62833e21b4\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/mintWorkspaceKey.js\":\"5d2aecfa639a3e39\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/modePin.js\":\"5d50b38efeed8c52\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/openWorkspaceKeys.js\":\"fe9a70deb0c414be\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/resolveWorkspaceEntry.js\":\"005e738b4503c1c7\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/resolver.js\":\"1c7516092e103d25\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/workspaceAccess.js\":\"b0bfa1ab1c9a7b71\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/transform.js\":\"6c0febff26bcea42\",\"/knowledge-medium/pr-preview/pr-1920/src/themeBootDefaults.js\":\"47bad1220363546a\",\"/knowledge-medium/pr-preview/pr-1920/src/types.js\":\"ee5296756b3f70f5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/ClientLocalSettings.js\":\"1c82f930f941d8a1\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/abortableSleep.js\":\"87a1121120399fb3\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/array.js\":\"c5917530fd801c25\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/backlinkAutocomplete.js\":\"5598e76aae192a42\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/blockCrumbs.js\":\"7fc653ec26f7b8e0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/blockrefAutocomplete.js\":\"e2774743a39386d4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/cadencedIdleJob.js\":\"a57c2c92e15388db\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/callbackSet.js\":\"86403633a949b731\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/clientId.js\":\"0d36768baaa8bf77\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/codemirror.js\":\"9db334307b8ce65f\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/codemirrorCompletion.js\":\"e3f57ba9c5540bba\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/copy.js\":\"c48a80d2bfd391cd\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dailyPage.js\":\"c08cea307098edd9\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dbForensics.js\":\"128837907ed5b10f\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dbForensicsHooks.js\":\"77e549e71a18ac0d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/deleteBlockThroughUi.js\":\"05ed83da3deea324\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dialogs.js\":\"730d64c696cabf4c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dom.js\":\"c94ff6c10c3c358f\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/downloadBlob.js\":\"b15261b974acd44b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/drawnWalk.js\":\"5b2d45b458ffeaab\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/exportSqliteDb.js\":\"207be943b7575a93\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fileSystemAccess.js\":\"224065193e0fe6de\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/flipSlide.js\":\"ea67c72221259ecc\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fnv1a.js\":\"68a56bbd3123fadd\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/formatBytes.js\":\"09662164d8159a43\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fuzzyRank.js\":\"8502042bb3594a36\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/idbKeyedStore.js\":\"71a0b420b9cf9321\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/idleCallbackPolyfill.js\":\"93125db1f20f9ee8\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/keyboardAwareScroll.js\":\"ad545c446aa3c0d9\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/keyboardViewport.js\":\"298f75a9b0ef7842\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/lastWorkspace.js\":\"e9b00eaf54748b0c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutColumns.js\":\"84ee3c3fc50c092f\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutSessionDom.js\":\"4e7232425c8a8ba2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutSessionId.js\":\"5d4385a17a6523fd\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/linkClickGestures.js\":\"dcdd41bb4b996a56\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/linkTargetAutocomplete.js\":\"70e5ddc7d9d4814e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/localDbCorruption.js\":\"e2bf312d47819943\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/localDbRecovery.js\":\"8930e69263d03054\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/markdownParser.js\":\"0154e2da6068f12d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/memoize.js\":\"3560c35a8ad2f7a4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/nameFieldCommit.js\":\"9098560a336b8e1a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/nameList.js\":\"a3f81e687c3f02c8\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/navigation.js\":\"55802fa5c8c8905b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/omnilinerNamespace.js\":\"e99eec245d3cb77e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/opfsPageScan.js\":\"1bc053ff454022ec\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelClearance.js\":\"7fd8e37efc230044\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelHistory.js\":\"f44a253094d2e2c2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelLanes.js\":\"9cc15a0029377c08\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelLayoutProjection.js\":\"7e947c75b94d3064\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelScrollAnchor.js\":\"5624d7879fcafbb4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelUrlFlags.js\":\"3511438e23bd8f5b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/platform.js\":\"2217487fa7921650\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/pluralize.js\":\"15e2984900fb3d75\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyCreation.js\":\"b07675a332808e13\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyNavigation.js\":\"6bb581ba44f15a6b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyValueContext.js\":\"d8d7fc3681383d37\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/react.js\":\"b5131a4c6b39d03a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/relativeDate.js\":\"7b8859b80fec6696\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/relativeTime.js\":\"ed7b2216a1a39307\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/renderScope.js\":\"fbb2a2b44642b977\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/resolvedThenable.js\":\"9366a5f2f66cc348\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/routing.js\":\"a5e70adffe2a3f3e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/safeMode.js\":\"878e1608013acd76\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/scheduleIdle.js\":\"b252448eac083f30\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/screenWakeLock.js\":\"d5e09ae0f0881c0f\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/selection.js\":\"39e9cb28461cd66d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/softKeyboardGrab.js\":\"a53c0012690207e4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/startupTimeline.js\":\"6161cb18942abc45\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/state.js\":\"5868f96b53005a71\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/string.js\":\"329702c022f820af\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/surfaceZoom.js\":\"1db54cc96d7a5bd5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/time.js\":\"31e0fefe219f73a9\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/toast.js\":\"ae9746382c0c44c2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/toggleStore.js\":\"ad1877afb57e249a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/untilStopped.js\":\"a7a249202d91b133\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/userActivity.js\":\"f4d3533d5f65434c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/viewTransition.js\":\"7e058de2ea5db23e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/viewport.js\":\"598b8f61f912513d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/webLock.js\":\"7116d81347239263\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/workspaceRecovery.js\":\"7f56eb767e8ef64d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/workspaceSnapshotStore.js\":\"2849ddfdf3e3f117\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-compiler-runtime.js\":\"7feafd9cc6c6f380\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-client.js\":\"c99b02c2680f2e07\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-server-edge.js\":\"e3600432a51cdc19\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-server.js\":\"c7a4d807b480f296\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-static-edge.js\":\"6255eb90ee7bed97\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-static.js\":\"8f620c63aca32283\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-test-utils.js\":\"8ba1ff0de96952be\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom.js\":\"d427f82f61814f92\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-jsx-runtime.js\":\"4de115a0461bd79e\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react.js\":\"7540cea6b99cf87f\",\"/knowledge-medium/pr-preview/pr-1920/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1920/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1920/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
