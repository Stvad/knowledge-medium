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
		buildId: "84e841766b14-48a1b5f5",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/\":\"45c47dcbb9321973\",\"/knowledge-medium/pr-preview/pr-1920/index.html\":\"45c47dcbb9321973\",\"/knowledge-medium/pr-preview/pr-1920/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1920/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1920/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1920/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1920/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1920/assets/FacadeVFS-Dzprt26q.js\":\"0e0d400c8679cc06\",\"/knowledge-medium/pr-preview/pr-1920/assets/OPFSCoopSyncVFS-DOAtEzXn.js\":\"9423c6c449e14495\",\"/knowledge-medium/pr-preview/pr-1920/assets/OPFSWriteAheadVFS-DkBZ56mq.js\":\"91de7d8d85a34136\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-CQT19RLG.js\":\"824b5a413cee93ce\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-async-B9AMn7iz.js\":\"c04c3c0fbc2ca21a\",\"/knowledge-medium/pr-preview/pr-1920/assets/worker-CvWTNltW.js\":\"8ecd3efed662a6a2\",\"/knowledge-medium/pr-preview/pr-1920/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1920/chunks/app-Jg2pOety.js\":\"bc1c69643aeccac6\",\"/knowledge-medium/pr-preview/pr-1920/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1920/index.js\":\"150b054902760c6e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1920/assets/AccessHandlePoolVFS-EAvatuPc.js\":\"4646a520f5e07102\",\"/knowledge-medium/pr-preview/pr-1920/assets/IDBBatchAtomicVFS-C-p3IXAW.js\":\"f494aca4ca24062d\",\"/knowledge-medium/pr-preview/pr-1920/assets/MemoryVFS-DzBdLyQV.js\":\"8811fed281b931f0\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-C0MlZseB.js\":\"2ea6d557dd74ebc5\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-async-DQ3hJZ7u.js\":\"eb7d5db38a1ae1fb\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1920/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1920/chunks/AccessHandlePoolVFS-l7bSqgkm.js\":\"26f6bb0ff407a0dd\",\"/knowledge-medium/pr-preview/pr-1920/chunks/FacadeVFS-B1mdw5mX.js\":\"00ec14fbf7a934f1\",\"/knowledge-medium/pr-preview/pr-1920/chunks/IDBBatchAtomicVFS-CRXNlwjg.js\":\"e24632e0cbb34a9d\",\"/knowledge-medium/pr-preview/pr-1920/chunks/MemoryVFS-B2MGf_Ih.js\":\"2f96c05c04322f5f\",\"/knowledge-medium/pr-preview/pr-1920/chunks/OPFSCoopSyncVFS-B2-TZWjK.js\":\"c6a0bbf15681afec\",\"/knowledge-medium/pr-preview/pr-1920/chunks/OPFSWriteAheadVFS-Ct-qOzwd.js\":\"ed03562a0b71167a\",\"/knowledge-medium/pr-preview/pr-1920/chunks/Preview-DiJYMoiX.js\":\"c29b4ab28300c7cf\",\"/knowledge-medium/pr-preview/pr-1920/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1920/chunks/card-B1bwtwsN.js\":\"5dc310c6ddc14dcb\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-aahuSCqm.js\":\"3216556e610d3a3c\",\"/knowledge-medium/pr-preview/pr-1920/chunks/freezeExtensionImports-DqE6Az2s.js\":\"c68df68ff9a0813d\",\"/knowledge-medium/pr-preview/pr-1920/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1920/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1920/chunks/mc-wa-sqlite-BlpcTRyG.js\":\"f36618f3c75f8f55\",\"/knowledge-medium/pr-preview/pr-1920/chunks/mc-wa-sqlite-async-BVwkYQAM.js\":\"64e537af003b53ac\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-Bn-4jzIs.js\":\"548995b9f56a039b\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-BnPeiITP.js\":\"f36c82e8c9e742b6\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-C9NN_KNS.js\":\"a9879d5074797329\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-CGmMXG_8.js\":\"7de9dfedbe3a72ab\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-CjlOp1nB.js\":\"0c617b05aadc04c5\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-D9GSLcCz.js\":\"6aa0d411231b824c\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server-legacy.browser.production-B2_dqGfM.js\":\"df05bcc52c165248\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server.browser.production-s9KgQcS_.js\":\"1ca5f2c0effc9cc7\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server.edge.production-DvyBtM6G.js\":\"07bbd9aeced8fd5f\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-h3ejQoOf.js\":\"f9fbd344f651da0f\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-uhQEf7nD.js\":\"f933d3c260988d87\",\"/knowledge-medium/pr-preview/pr-1920/chunks/server.browser-Bs9OFw_N.js\":\"2ebccdc6957fb591\",\"/knowledge-medium/pr-preview/pr-1920/chunks/textarea-BoIxERx6.js\":\"ac5b01465d1277e8\",\"/knowledge-medium/pr-preview/pr-1920/chunks/ui-DzCh39HA.js\":\"c6adf4c82ea9cba2\",\"/knowledge-medium/pr-preview/pr-1920/chunks/wa-sqlite-BaLAD3YB.js\":\"af21909fa0ac92ef\",\"/knowledge-medium/pr-preview/pr-1920/chunks/wa-sqlite-async-w5wkQCKx.js\":\"6747ea05bd4b3243\",\"/knowledge-medium/pr-preview/pr-1920/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1920/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1920/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1920/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1920/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1920/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1920/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1920/src/App.js\":\"4d6ca6c7039f10aa\",\"/knowledge-medium/pr-preview/pr-1920/src/appUpdate.js\":\"50a090f38921ddd1\",\"/knowledge-medium/pr-preview/pr-1920/src/appVersion.js\":\"68f5dd75b8ce38b7\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/initialLayout.js\":\"041dcd3810cab7ba\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/openWorkspaceData.js\":\"6df84ef1bbf3e4bf\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/resolveWorkspace.js\":\"d78af308739df8a9\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/workspaceBootstrap.js\":\"7edc598a3b15195d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockComponent.js\":\"a57641b52bd303fa\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockCrumbs.js\":\"2ff752c0504334c5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockEditor.js\":\"aefb274b05332fa8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockLoadingPlaceholder.js\":\"1f8b16293b125bfd\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockProperties.js\":\"d0b74cd00718cd19\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockSearchPicker.js\":\"95020118fc8d32ca\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ConfirmBulkDeleteDialog.js\":\"9fddd3a283c0e778\",\"/knowledge-medium/pr-preview/pr-1920/src/components/DividerHandle.js\":\"34bed94845146785\",\"/knowledge-medium/pr-preview/pr-1920/src/components/DraftEditor.js\":\"1e57b0e3a98581f7\",\"/knowledge-medium/pr-preview/pr-1920/src/components/GutterPill.js\":\"c056411fd9715790\",\"/knowledge-medium/pr-preview/pr-1920/src/components/Header.js\":\"633d3fb1dcd6de9c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/LazyBlockComponent.js\":\"ba1471c4007fe52c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/Login.js\":\"f2d369ec2964a8a8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ZoomableSurface.js\":\"6e5809af08ab68f1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/editModeKeepalive.js\":\"b6725c220e600528\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyDisplay/PropertyDisplayScope.js\":\"86cd156cbb6b09b8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"aa4aaf2b56d73cc0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/RefPropertyEditor.js\":\"c2240b94e920d67f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/RefTargetTypePicker.js\":\"b12b7475b9919311\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/SelectPropertyEditor.js\":\"30e3cd400920e514\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/TypesPropertyEditor.js\":\"dad02ac0142a126d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/defaults.js\":\"dc76348219e04563\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/kernelValuePresets.js\":\"2bb0f6a4f0c2d0e1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/selectablePresets.js\":\"b665fb2c27861307\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/typesPropertyUi.js\":\"30df78fea4898383\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/AddPropertyForm.js\":\"6d8226f95344d718\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/PropertyPicker.js\":\"390d2a4a01b912c7\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/PropertyRow.js\":\"7f4f763ec6138601\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/Rows.js\":\"660e678628d80b27\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/actions.js\":\"0b8f29e1207e3b4a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/declarationOnly.js\":\"b6e777f5918e23d6\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/layout.js\":\"f4915a5706e9188e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/model.js\":\"42467f1b9f6fca8e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/shapeUi.js\":\"0f4ef5c83f13ba7e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/shapes.js\":\"41cd1a9e73e52a2b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/usePropertyEditingActivation.js\":\"9770f0cc260a4ff5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/visibility.js\":\"20d42590e0415333\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanelSections.js\":\"de3158f22f18a30f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockEmbed.js\":\"17bd8444bb4ee6e3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockLink.js\":\"e9d923660ab568fc\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockRef.js\":\"bdcfa7cef19616b3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/CompactReferenceLink.js\":\"f20f66725a1f5155\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/ReferenceLink.js\":\"fccb5e10a28b876d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/cycleGuard.js\":\"634933a40aa39c7d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/cycleGuardContext.js\":\"2c11fd910f240fc3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/linkInteraction.js\":\"35ada1bdd4494129\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/referenceLayout.js\":\"f7e97082ca54951f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/useBlockRefAncestors.js\":\"f000e0491db4f27c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockGutter.js\":\"034ac0fcfec2ebb4\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockInfoDialog.js\":\"033d862391dacc37\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockReadText.js\":\"3dd275c88ce34bbf\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockTypeBlockRenderer.js\":\"979e3751cf5415db\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BulletHoverCard.js\":\"d383b21819354ceb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/CodeMirrorContentRenderer.js\":\"9ccc6a2ba6f70327\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"b0354db8d1b20475\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/ColumnResizeHandles.js\":\"46dcf03333a6584a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"a93661078e28e227\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/DefaultBlockRenderer.js\":\"40129cca805aa613\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/LayoutRenderer.js\":\"2ee05115d3926db7\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/MarkdownContentRenderer.js\":\"10e140946373f1b8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/MissingDataRenderer.js\":\"7c03d4a90757cf2a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/PanelRenderer.js\":\"834fa61d9bebdbeb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/PropertySchemaBlockRenderer.js\":\"d948b9154ac142f5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/TopLevelRenderer.js\":\"7189d040c524d9d9\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/blockGutterMode.js\":\"ddcde959db6be585\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/blockTitleText.js\":\"f930c0fdac126672\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/fieldCreationKeydown.js\":\"18d5acf5f3abbbe5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/layoutRootContext.js\":\"8333878b34fd1fe4\",\"/knowledge-medium/pr-preview/pr-1920/src/components/typeChip/TypeChip.js\":\"3d59816429dd8b7e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/typeChip/chipStyle.js\":\"2d6a2fc6be71f74d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/anchored-floating.js\":\"867195beb73dac18\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/button.js\":\"395235955fbad553\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/card.js\":\"793d08a81c4c8887\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/checkbox.js\":\"1e88abeb39626b54\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/collapsible.js\":\"3b82aa0b61461368\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/command.js\":\"e11b5f3ae3aeeaa9\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/context-menu.js\":\"a7b05cb53a687a4e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/dialog.js\":\"dc158d301e6a925a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/dropdown-menu.js\":\"a6f45c1fcbe001d3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/floating-listbox.js\":\"d48e8b6ebe266be5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/index.js\":\"d276964997b781cf\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/input.js\":\"3ee989118d6b5496\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/kbd.js\":\"132f20d871f52d15\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/label.js\":\"7eb8b62aaea2f463\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/textarea.js\":\"28eb7c8a1a1a4d64\",\"/knowledge-medium/pr-preview/pr-1920/src/components/useEditModeYieldKeepalive.js\":\"b657bf00bd7ffb7b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/BootFallback.js\":\"f2cda30f9d077145\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/FocusedRowLazyMount.js\":\"37fc7836e081559a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/LazyViewportMount.js\":\"4f53bc13ae066508\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/LocalDbCorruptionFallback.js\":\"72bee06912f43a50\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/error.js\":\"b01e872727a5f697\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/lazyMountRegistry.js\":\"eb3382ef839376f4\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/suspense.js\":\"ab4b0b191fc2c4fe\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/CreateWorkspaceDialog.js\":\"e085089f5751a089\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/PendingInvitations.js\":\"9d7940af16359d88\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/SyncProgress.js\":\"3ba9f4a43688d8df\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/UnlockProgress.js\":\"d8fc2cafb2e56dad\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceKeyGate.js\":\"6e85202bbb4ea090\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSettingsDialog.js\":\"91ab5b6f38b6b002\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSwitcher.js\":\"669eec0dcbdbf46f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSyncGate.js\":\"6d9ce93165c6d417\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/ConversionFlow.js\":\"1a0089b668679909\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/ConversionFlowHost.js\":\"a893f391b9459c16\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/EncryptionSection.js\":\"aef59c0d77008893\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/attachmentPrompts.js\":\"65bd1fbc2edcb7be\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/bundleFolderPrompts.js\":\"82424e7e277fd2eb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/conversionFlowDeps.js\":\"45c399649bb72f3d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/conversionFlowStore.js\":\"237ff18b660d8fcb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/flowUi.js\":\"2daee48fce705aee\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/useConversionRun.js\":\"1a15231d588490ca\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/keyUi.js\":\"af1ef5b21dd9366e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/useCloseOnKeyLoss.js\":\"9e48b6faa4b0abe6\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/useCloseOnServerE2ee.js\":\"a1fb0a51d06b9488\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/workspaceUnlocked.js\":\"0bd72b522372a4d6\",\"/knowledge-medium/pr-preview/pr-1920/src/context/backgroundSubtree.js\":\"536ea94bf840135a\",\"/knowledge-medium/pr-preview/pr-1920/src/context/block.js\":\"e4d86fec381ec9a3\",\"/knowledge-medium/pr-preview/pr-1920/src/context/layoutWsContext.js\":\"c80b98ef8d246f20\",\"/knowledge-medium/pr-preview/pr-1920/src/context/propertyDisplay.js\":\"df3736e061e928bc\",\"/knowledge-medium/pr-preview/pr-1920/src/context/repo.js\":\"9e328c7e86536115\",\"/knowledge-medium/pr-preview/pr-1920/src/data/aliasClaim.js\":\"aa037aeea4920226\",\"/knowledge-medium/pr-preview/pr-1920/src/data/aliasSeatNamespace.js\":\"3e347380a64de256\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/blockData.js\":\"6fb2eba7b82c8034\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/blockType.js\":\"d28fd878643f02a1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/changeScope.js\":\"42900412a1d89d4d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/codecs.js\":\"bc6f3efe3a4113db\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/derivedData.js\":\"db066e3c98650e76\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/errors.js\":\"8749f512d4552704\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/events.js\":\"9bff48a7d98da840\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/handle.js\":\"e77e477519ce6382\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/index.js\":\"01c0c0cebc7e5b43\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/mutator.js\":\"62dd87ab98d60caa\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/processor.js\":\"e8b92a6d7e0b956b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/propertySchema.js\":\"ec26989c6c4cfa22\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/query.js\":\"3283d21c5113a7fb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/sameTxProcessor.js\":\"435ee72648b3d73c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/schema.js\":\"e77e477519ce6382\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/tx.js\":\"e77e477519ce6382\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/typedBlockQuery.js\":\"b9fa5f12736c7cba\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/user.js\":\"04c0334fd1a89562\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/valuePresetCore.js\":\"3ced62e832d8db0a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/valuePresets.js\":\"3be15f9082121be3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/attachmentCleanerIOVerb.js\":\"abc92528fe174a56\",\"/knowledge-medium/pr-preview/pr-1920/src/data/block.js\":\"b557d0d997f37790\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockCache.js\":\"cf382a3854c6004a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockId.js\":\"282835df0101317f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockLiveness.js\":\"9b61fd02aa8e87d1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockMerge.js\":\"d6722b2f539221d9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockSchema.js\":\"faa7341725ff8eed\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockTypeLookup.js\":\"6437cc465fc9b142\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockTypes.js\":\"d0914ceb7d330169\",\"/knowledge-medium/pr-preview/pr-1920/src/data/childrenView.js\":\"3cc44285e685586d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/clientContext.js\":\"38ab3ee647e27084\",\"/knowledge-medium/pr-preview/pr-1920/src/data/dbFileSiblings.js\":\"ca78231b1ebe569c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/definitionSeeds.js\":\"5f4d11ca31e5d58a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/derivedIds.js\":\"ab35f065af1a6778\",\"/knowledge-medium/pr-preview/pr-1920/src/data/drawnSubtree.js\":\"70e3b85bf60537a1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/facetBridge.js\":\"90a0590fe7ed0eb3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/facets.js\":\"a64e23d6a5eed2a3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/globalState.js\":\"c335594ebc8b5dda\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/aliasClaimRederiveProcessor.js\":\"dcc844750640d512\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/ancestorBatch.js\":\"e8a5cddb3af4ae64\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/blockTypeTypeifyProcessor.js\":\"50ded829167d113b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/clientSchema.js\":\"629097b1b8ad8990\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/commitPipeline.js\":\"0da4cce88ee2b32d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/devAssertions.js\":\"96c46c7e38f6566a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/firstSync.js\":\"6ec4b406d6546e76\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/freshInitialLoad.js\":\"be736210511cdc2a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/graphBackfillClaim.js\":\"109fbedc3146965b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/handleStore.js\":\"954859ef3cb5ca9a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/idleMarkerJobs.js\":\"af1f47d8eb55d854\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/initialDownload.js\":\"5e33b848598bdc54\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/initializeClientDatabase.js\":\"3eef64ca64657eb2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/jsonCanonical.js\":\"313206e2cd4e0d64\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelInvalidation.js\":\"76cd644a34f0b1fc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelProcessors.js\":\"adefe0e372aed834\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelQueries.js\":\"8ee1b77a204c9157\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/mergeTypeMembershipProcessor.js\":\"e31b919dbfcea0a1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/normalizeReferencesProcessor.js\":\"4a9dd8cd91364a12\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/poolInstrumentation.js\":\"fae2c18079a8a41e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/processorRunner.js\":\"827a527f746a478c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyCellBackfill.js\":\"f88a7d421d274a01\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyChildMint.js\":\"a379b27e1ef15849\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyChildrenProcessor.js\":\"9e9065c8a5324431\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyDefinitionChangeProcessor.js\":\"b5c1f15197789557\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyDefinitionSynthesis.js\":\"0aa5fafe53b94cc5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyKeyScan.js\":\"9d56a1a680a6de23\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertySchemaResolution.js\":\"dc484e6f98451432\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyValueEdits.js\":\"6449b23427293920\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/raiseProtocol.js\":\"ca1318179e664ca8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/readBatch.js\":\"d0d0ab09450a712b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/refProjection.js\":\"40abdb6d687e2f71\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/referenceTargetLookups.js\":\"56823c5852bfd40f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/referenceTargetProcessor.js\":\"bba46579426f914e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/replayMerge.js\":\"b6da62bc31698904\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/sqlBinds.js\":\"fcd530effd06c4ae\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4855c45d53155eea\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/arrivalProcessors.js\":\"3580b9a2404a6acb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/invalidate.js\":\"8929dab7a46970fe\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/materialize.js\":\"fa6d7bbd2a003603\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/observer.js\":\"56d2c99b201ad69b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/reconcile.js\":\"fb83a467b0f6c78c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/timingMetrics.js\":\"345df505dd4cf501\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/treeQueries.js\":\"e24138222616d6f4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/txEngine.js\":\"576117d5ba1ae070\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/txSnapshots.js\":\"9205ecd128bbc8dd\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/typedBlockQuery.js\":\"9b47e96b27cecb14\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/undoManager.js\":\"6aaa5f995b81efc2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/invalidation.js\":\"71960ea0f3004293\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelDataExtension.js\":\"f6c14e25257731bc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelPage.js\":\"94b5a0cd7dfc1ffd\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelValuePresetCores.js\":\"13691a2d3c7cd75e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbCorruptionSignal.js\":\"dc871e5c07044b81\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbStorage.js\":\"9de381b8fa2f75a4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbVfs.js\":\"37d6714319e7683f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localSchema.js\":\"0cda80426ee49526\",\"/knowledge-medium/pr-preview/pr-1920/src/data/maintenance.js\":\"64f6edda90af8bbe\",\"/knowledge-medium/pr-preview/pr-1920/src/data/mergeProperties.js\":\"02b2b4c0bcbfbf85\",\"/knowledge-medium/pr-preview/pr-1920/src/data/metricsConsoleHook.js\":\"b954ef5efc145b23\",\"/knowledge-medium/pr-preview/pr-1920/src/data/migrationsPage.js\":\"bb8bde936825644b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/mutators.js\":\"124c0e2924c9f3c8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/orderKey.js\":\"eda21c1da4b08abc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/orderKeyPlacement.js\":\"8824d59915bcf42e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/outlineSurface.js\":\"c33f463fd3465ea3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pendingEditorContent.js\":\"ce6ad161237bf9aa\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pendingUploadsSql.js\":\"26b04e571ee0b397\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pluginStateExtensions.js\":\"838819e2df6c82e0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/powerSyncLogger.js\":\"ecec365c23011f0d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/projectorRuntime.js\":\"bad1cf8c9f3850d4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/properties.js\":\"102d23c2cdb4742a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertiesPage.js\":\"7483b69352a88b32\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyChildren.js\":\"8e20f434af7e0a1e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionFanout.js\":\"6f6f45b5cef6067f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionMetadata.js\":\"7a23cc73f7b4ee85\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionRegistry.js\":\"7090c4f5699bccc2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDisplayMode.js\":\"ba886781b7ecf8db\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyRowCreation.js\":\"e6ab6d0542f39713\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertySchemaCreation.js\":\"a33f7031ac9d03b9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertySeeds.js\":\"53f9593804c8de0c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/recentsPage.js\":\"c03f9e2fd84b9810\",\"/knowledge-medium/pr-preview/pr-1920/src/data/refTargetComparableProperty.js\":\"5634506e5547139b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/referenceBlock.js\":\"73e858c811f65d61\",\"/knowledge-medium/pr-preview/pr-1920/src/data/rejectedUploads.js\":\"8901bb70145c2964\",\"/knowledge-medium/pr-preview/pr-1920/src/data/releasePowerSyncConnection.js\":\"0222d3d804bd6f3f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/repo.js\":\"b9c1ed36202355ca\",\"/knowledge-medium/pr-preview/pr-1920/src/data/repoProvider.js\":\"f0c45825e9f0bc94\",\"/knowledge-medium/pr-preview/pr-1920/src/data/rowProperty.js\":\"f13c941025054634\",\"/knowledge-medium/pr-preview/pr-1920/src/data/searchFilter.js\":\"b448d1e2542dac11\",\"/knowledge-medium/pr-preview/pr-1920/src/data/seedIdentityLedger.js\":\"a1deb03bfbb066c0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/stateBlocks.js\":\"8d762d797f731821\",\"/knowledge-medium/pr-preview/pr-1920/src/data/structuralEditPolicy.js\":\"0e431beeef9adf43\",\"/knowledge-medium/pr-preview/pr-1920/src/data/structuralInsert.js\":\"5ba0fc354f25db2b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/subtreeDelete.js\":\"dfe48edbae492c3e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncStreamLock.js\":\"e08f4750e1733625\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncedTableSqlRecognizer.js\":\"152a56234ac67bb1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncedTableWriteGuard.js\":\"df46ff232b8e58b2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/targets.js\":\"bb2ff4a5689cbf63\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeColors.js\":\"7ea4fad505f1e516\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeDefinitionMetadata.js\":\"a2c1d6274ec85332\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeDefinitionRegistry.js\":\"561977023a9e9ef1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeExtraction.js\":\"aece7814198820f5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeInitialValues.js\":\"c5d739cccd197dd3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typePropertyGroups.js\":\"8eb49ca83d50d68b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeSeeds.js\":\"99e58e995cd1006d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeTagger.js\":\"16eb67e7f6cea20b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typedRecords.js\":\"67f0c1b728fcf04c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typesPage.js\":\"a06a76b70f849790\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userPrefs.js\":\"17a8e80758af9fb0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userSchemasService.js\":\"de4bf4a6f0355ee1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userTypesService.js\":\"7b78bec406d3138c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/valuePresetRegistry.js\":\"114f1bd3623f219c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/visibleChildren.js\":\"fdfc92f86fdb2d25\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceConversion.js\":\"7565a8023e57ee77\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceFirstSync.js\":\"7fc178ae32c5d7b7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceIdNamespace.js\":\"070ab5d77c87ef44\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceSchema.js\":\"bfa87b009ba1d59d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaces.js\":\"69f9ccedc9c073c7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/writeAheadLog.js\":\"5f5a003941bf40e3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/BlockPasteShellDecorator.js\":\"60ea0d3d70e8308c\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/atTrigger.js\":\"beed01d19b995ea2\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/autocomplete.js\":\"ea0f21e375fbfc7a\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/codeMirrorExtensions.js\":\"cb38a0cb4530ac4a\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/contentFlush.js\":\"39cf93c3965489fe\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/defaultInteractions.js\":\"f2775b1157bbb7b4\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/editSettleSignal.js\":\"bd65e2114b1e5088\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/insertImage.js\":\"701dceafe48e1880\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/referenceCompletionRange.js\":\"f0fd42b0f6433087\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/referenceTargetTypes.js\":\"bbea5df334f127de\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/syntaxContext.js\":\"acfdbb1fd3707696\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/triggerMatch.js\":\"3ab8a1b9640437e9\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/AppRuntimeProvider.js\":\"d6d752a59c5fafc6\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/BlockFocusShellDecorator.js\":\"57e7942d554b0bf2\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/ExtensionRenderBoundary.js\":\"1ee03f27360ce248\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/PanelContentRecovery.js\":\"201b9de8821f1baf\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/apiCatalog.js\":\"2280631ed23b1975\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/appRuntimeController.js\":\"ade2d60461d8a737\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/approveExtensionHere.js\":\"8b3eaea183463d5f\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/armedCutAppMount.js\":\"6dadbcfbfd32cb2d\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/batchableKeyedStore.js\":\"21671a3aa29e3196\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/blockInteraction.js\":\"ecdb2fc0d6257a4f\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/blockSelectionAction.js\":\"2b2863fc778f20e8\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/buildApprovalRecord.js\":\"b2b331bcc61f6dee\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/compileExtensionModule.js\":\"22149b02a5a0c147\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/compiledModuleCache.js\":\"290aa3057d9fdb73\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/continuousGestures.js\":\"769f53a32bf9b3cc\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/core.js\":\"b4b8bbb751ef79c5\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/defaultRenderers.js\":\"a7ccea56a68ce041\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/definitionFanoutAppMount.js\":\"e0a3facb6469ee5b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dialogAppMount.js\":\"7a77e483336acd30\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dynamicExtensionSeeds.js\":\"a9fcb4afe21aec01\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dynamicExtensions.js\":\"fa5b8c08d94ac230\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/exampleExtensions.js\":\"41fab0df7df24a38\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionApprovalStatus.js\":\"830d1711db3687dd\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionImportPolicy.js\":\"a4e5a9f6e120fbfd\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLoadErrorToast.js\":\"54c1b4f2c813fef2\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLoadErrors.js\":\"87aa25a43a4c1b6f\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLookup.js\":\"f4e0877ba58220b0\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionToggles.js\":\"433d60a9b7467850\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionUtilitiesCss.js\":\"68e3cc4a3a503b95\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/kernelPageDeletionGuard.js\":\"5bb3d3e442bf702a\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/liveRuntime.js\":\"5c0784214ba19a05\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/normalizeExtensionSource.js\":\"91399c79a6d7fcb1\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/openExtensionsSettings.js\":\"3fbf1002e1390f50\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/overridesCache.js\":\"f803f8859486dedd\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/pluginIds.js\":\"1fa2664d8089f4de\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/processorRejectionToast.js\":\"342fa8365f0c603e\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/runtimeActions.js\":\"3d3b3fbb0c4567c4\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/runtimeContext.js\":\"8e14959a2430ad53\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/staticAppExtensions.js\":\"2214e53812b0b01b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/staticDataExtensions.js\":\"361eec4a6e032edc\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/toastAppMount.js\":\"8abb6988d3df1a78\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/transpileExtension.js\":\"f882ae4e64b0a4de\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/useOverrides.js\":\"5111ede5d045ee41\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/useShortcutSurfaceActivations.js\":\"e18edd52a624a369\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/discoverToggleTree.js\":\"204dc11f9d23434f\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/facet.js\":\"5f586802cc1d1737\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/resolveAppRuntime.js\":\"5c13de4e1e39d514\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/runtimeEvents.js\":\"b9a8cd0831d86f04\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/togglable.js\":\"aa2b8e0b9ecc71b5\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/variantFacet.js\":\"838d3be4b00a165d\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/verbFacet.js\":\"bf3474dd35ea98e8\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/block.js\":\"d7f2413dae67540c\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/focusedChild.js\":\"ee1502d0b4ed8a32\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/propertySchemas.js\":\"70659e3b4cc996d3\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/typeRegistry.js\":\"4469866a5d108777\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useAncestorCrumbs.js\":\"608b263b1e6cd971\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useAutocompleteListbox.js\":\"9dfaea36606e4e3d\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useDebouncedSearch.js\":\"ce054ed5156bb494\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useDebouncedValue.js\":\"8ee9d2ebab3164ea\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useFacetValue.js\":\"fd84181848e7b82f\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useIsFocalRender.js\":\"e8604475934ccd09\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useIsReadOnly.js\":\"94f2eea6a11e066a\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useMaterializeBacklog.js\":\"508e7f315e12b1b1\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useMinuteClock.js\":\"7d17182056e628b1\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/usePanelLayoutProjection.js\":\"8468c71e82100471\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/usePendingInvitations.js\":\"867647fa1e1f4fd8\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useRendererRegistry.js\":\"4eca2891b05dbe38\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useRetainedFieldRows.js\":\"d31a20e1bae19606\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useWorkspaces.js\":\"032a0720904742f9\",\"/knowledge-medium/pr-preview/pr-1920/src/lib/utils.js\":\"9d129bd63fce6d78\",\"/knowledge-medium/pr-preview/pr-1920/src/main.js\":\"94979a45e8cc1bea\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/MarkdownImage.js\":\"0c2fbfc436d3267f\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/blockSeparators.js\":\"fb7553a82f845852\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/context.js\":\"d2dad1959f82aa0b\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/defaultMarkdownExtension.js\":\"4a741764de0cd38a\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/extensions.js\":\"0da3122418c02f59\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/renderMarkdownHtml.js\":\"cf8ec83b92f289e8\",\"/knowledge-medium/pr-preview/pr-1920/src/minimal-editor.js\":\"9b5291a674ab33b4\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/armedCut.js\":\"87b79629ef095394\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/captureMediaVerb.js\":\"d0346c31148d3d04\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/clipboard.js\":\"09874aae0a4a670c\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/decision.js\":\"4f242470de910992\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/operations.js\":\"fe23ba731b057481\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/account-header/AccountHeaderItem.js\":\"a0826eee840e7361\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/account-header/index.js\":\"0af9fef5e6409820\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"f41e0c4e280f08dc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/askAgent.js\":\"3e496ef51c4902fd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/askedStore.js\":\"f77614c0ab1314c9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fedc638bb83cfe57\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/chipState.js\":\"45fbd38a9e7c892c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/dataExtension.js\":\"bdc1a40f794f537a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/index.js\":\"7ec079752070459c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"66dd3beb22d809d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/schema.js\":\"f48e5c77fdd11afd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/AgentTokensDialog.js\":\"9be7f6c24ac089d5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/BridgePairingDialog.js\":\"081270645dc61d46\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/addMedia.js\":\"b852c54e1203d9fb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/backlinks.js\":\"32148a58f4d0352f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/block.js\":\"7d13cbc3453fcf8a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/context.js\":\"990fec81f6913544\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/displayIds.js\":\"994bb1d4dcd1934e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/index.js\":\"e52b295ecbd919a2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/outline.js\":\"6d80adfb3c6083fc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/properties.js\":\"81c646e62e42a896\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/refs.js\":\"0798e1d6313b4c73\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"7f84b5dd8022beba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/search.js\":\"3545d6dc913df9ea\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/shared.js\":\"285d978322755191\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"0d222320a7b8caf0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/text.js\":\"11c1c942515fdd50\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentWrites.js\":\"0a5fb1c2d5b49ec0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/authoringCatalog.js\":\"4fa0b79a1066ca98\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/blockRefTargets.js\":\"7342b5f51a1914dc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/bridge.js\":\"dccaad18f7cda370\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/bridgeLoop.js\":\"34077a04ef1e9640\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/changeHistory.js\":\"6b7f7a191a64d2bf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/commands.js\":\"fffef4f0e7287134\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/commentsCommands.js\":\"b2ea438c3b3437e8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dataExtension.js\":\"51209c00503f7f33\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dataModelGuide.js\":\"367c22efe6bdd610\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dayPropertyInputs.js\":\"250ce1e51d56bfca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/describeRuntime.js\":\"a01d1365ab5f6baf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/extensionLint.js\":\"0829a51c006a2b75\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/grainAudit.js\":\"5a165794183275a1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/healthCommand.js\":\"907ddf56cf0a1dd1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/index.js\":\"290b032d1966cd2d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/presetIdentity.js\":\"667592288e0fddb4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"d8954e6f6c69f1eb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/readMedia.js\":\"45b010693f83528b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/schema.js\":\"2708a876a13d5a5f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/serialization.js\":\"a844da8c09d741b2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/targets.js\":\"8141e0b5a3902f4f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/tokens.js\":\"4f4b00a378d25cd2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/watchEvents.js\":\"668f7aad9cb749e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/workspaceGuard.js\":\"793135e8cd042d2f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/writeCommands.js\":\"5bc818f4d7ba8b98\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/AliasCollisionToast.js\":\"6d174fa2879ee13c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/DuplicateNameBanner.js\":\"bcdf2e727e521dab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/collisionMerge.js\":\"7e15c3c54c491eb4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/dataExtension.js\":\"8916282d71da4bea\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/index.js\":\"1bcf173635129c1d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/mergeCollisionAction.js\":\"bbb6d84f63cd80f8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/pageStyling.js\":\"21bb11ec281fdde3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/rejectionToast.js\":\"bcaa1f7d07abcadb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/syncProcessor.js\":\"c640db52d95ca667\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/actions.js\":\"88a34d1e16384ad6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/addComment.js\":\"2d3ca55b759dee2d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/anchor.js\":\"7466fd0c2e38dcbc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/anchorState.js\":\"24839f698e49d224\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/commentLinks.js\":\"1a37a53109f25520\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/confirmThreadDeletion.js\":\"e3fdd7c63e1fe6d7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/container.js\":\"e4d51687572ed6c6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/dataExtension.js\":\"f85924089dc905e5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/deleteComment.js\":\"c62e8bd1367a0685\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/highlights.js\":\"76a9511ce11ac0e9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/index.js\":\"c9f4cb71d4ea0485\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/linkedCommentsPill.js\":\"16f36c418b15e324\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/margin.js\":\"3c5c7019141ed96e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/marginAnchorLinks.js\":\"c27ad5c57a9092f0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/marginSchema.js\":\"766efe184f2f807c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/newComment.js\":\"1f8f98c756e2786e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/ownThreadPicker.js\":\"16e4b72d698621da\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/placement.js\":\"37baeef7b3d9e764\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/queries.js\":\"3d0ae9f360f2c443\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotePosition.js\":\"ac9bc6c9486b08c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotedIn.js\":\"1f2effb3d7a1ff5e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotedRange.js\":\"071ac5a007cafca0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/rangeRefs.js\":\"ac8877fff405be7a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readHighlights.js\":\"cb3988af9ff19a88\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readSelection.js\":\"a402cffa4b96617c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readSelectionUi.js\":\"1cd279d54c7d25e3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/reanchor.js\":\"bc506947131eabcb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/schema.js\":\"cddccd68fc74d07b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/scope.js\":\"8af568f7a9d877bc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/scopeThreads.js\":\"79735899f3cae24d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/splitRetarget.js\":\"ab4b564621d725c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/suggestionCard.js\":\"4597d3da943c8ae6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/suggestions.js\":\"fc7bf2e3b7f8c7cd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/summaries.js\":\"96f157534990d0cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/summaryBatch.js\":\"429b88b494a83e1c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/surface.js\":\"8d0a4e90d27d0b03\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/threadNavigation.js\":\"fdcbae28a31b5a42\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/threads.js\":\"8b5caa5f00734015\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/ui.js\":\"621f2096ffacc72b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/uiStore.js\":\"a24f19bb5ac9270d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-intents/appIntents.js\":\"700d8f2e21db56a4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-intents/index.js\":\"082150fe16fd7779\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-update-prompt/index.js\":\"d77ae98225354eba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-update-prompt/status.js\":\"8a4203681b2dfc86\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e0d28918bd4f00ae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaBlockRenderer.js\":\"1038c971e04f87fe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2b8bcae4d4a1fe9b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaUploadReconciler.js\":\"ba01613c842b981c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetDownLane.js\":\"fea334daa7740885\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetResolver.js\":\"742e7aa32b80536b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetUpload.js\":\"3ef31571ea575495\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/attachmentCleanerIO.js\":\"963d7465b1711cb3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/supabaseAuditIO.js\":\"b6a79a8a88893dbc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/blobStore.js\":\"5e303d33a50b7a2a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/browserMedia.js\":\"40fa73fb01cd7c51\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/byteStore.js\":\"9ca32c0895e78d19\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/cleanerIO.js\":\"649b983e394de8d6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/cleanupAttachments.js\":\"3b0f2895d5d01794\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/dataExtension.js\":\"7cca82e97d22ee83\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/downLane.js\":\"19cc5d481bb7735b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/index.js\":\"44711bba9b30c1fe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/insertImageContribution.js\":\"7ccf062033ff3318\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/laneArming.js\":\"c16e155c28b0fb3d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/laneLock.js\":\"c8b8d57c72230a48\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaBlock.js\":\"07e2e3cb42d34774\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaCapture.js\":\"c461ff95ce610504\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaLanes.js\":\"ee3a891b02e9fe8b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaViewers.js\":\"ad5ec890b85d56db\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaViewersFacet.js\":\"42509057c6568fd8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/pasteCapture.js\":\"ed6c1e6abaeb8226\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/resolver.js\":\"14bc0816edf5844e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/retryUploadsAction.js\":\"afbab32f521bf028\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/storagePaths.js\":\"dba9fef41006c5b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadDrain.js\":\"c1b3163e1fd68f96\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadLaneStatus.js\":\"6fdab0da5386a39a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadReconcile.js\":\"ada8df2ccf416675\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadRecovery.js\":\"d29a20be3acf0b9e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadStore.js\":\"25a4d923b6b02e3e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/useAssetObjectUrl.js\":\"01290a2bac97ad07\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"50d5642cff2894f9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/BacklinksViewSection.js\":\"9cdf7738dd0e5d96\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/facet.js\":\"e9ce55c091eead64\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/index.js\":\"18064a2bc6d5f495\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/prop.js\":\"786314ab3e6467d4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BacklinkFilters.js\":\"439651a8a4f28665\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"637bd97001448385\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BlockEntry.js\":\"6037837571c7b33d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/LinkedReferences.js\":\"fd6f117556d3c695\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"59621a0a97c3b469\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/dailyNoteDefaults.js\":\"350e6e84ecb6b41b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/dataExtension.js\":\"af1c6231f419fd75\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/edgeExclusions.js\":\"8ced839e6e87e5a1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/filterProperty.js\":\"411460580d323c00\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/index.js\":\"21d09cb5e5cd5325\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"0d14ce6db8e8290f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/applies.js\":\"0c4058d98fb9719b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/countQuery.js\":\"396853c5e8953fc4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a2d5d2924733b840\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/index.js\":\"29a9a38bee3327b1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a2552c8ffbae1258\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/presentationInvalidation.js\":\"923acfe0e18e51cc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/propertyEditorOverride.js\":\"49c68ee606860729\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/propertyFilter.js\":\"7d7d2c13efc8b795\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/query.js\":\"fedef9403afdcc5f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/resolveFilter.js\":\"9fca281faabbb130\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/sourceBatch.js\":\"7a12c1b3e02a8a51\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/sources.js\":\"397e4b53971fa1b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/useBacklinks.js\":\"752d238e8b12fc18\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"ab6d16eca0abc5a0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/BirthdayCelebration.js\":\"263a6d310bf33af8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/BirthdayOverlay.js\":\"92a1957b7cd01764\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/gate.js\":\"e72ee376fa63b71b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/index.js\":\"83bc30c17855c913\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/wolfTheme.js\":\"d1774af7e3f50d2f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/BlockDragLayer.js\":\"9841183311c4a656\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/dragController.js\":\"3e9fe4774b2fe23e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/dropTarget.js\":\"308c7e45b76571d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/index.js\":\"543bd0f7719c54f0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/projection.js\":\"e73ff42e03ae92c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-info/BlockMetaCard.js\":\"6b8eec4b90d7be63\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-info/index.js\":\"d9edd4fa012671ef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/AddTagDialog.js\":\"901b3fbd4ab4d901\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"8210f2f97b8ec129\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/TagNameIssueHint.js\":\"bd5b96e2be1e4215\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/addTagAction.js\":\"51f706fda70d4471\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/appendTag.js\":\"adee8721bb429a1d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/config.js\":\"ab7421d29dc4c517\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/dataExtension.js\":\"b3a8bdcb6d8e7106\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/index.js\":\"934a018e661893ae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/propertyEditorOverride.js\":\"14fe87529ad90092\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/BreadcrumbList.js\":\"40faf4ccab8fbb23\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"84b3144f1e234913\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/Breadcrumbs.js\":\"fcb315891c820451\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"735dd343b6aba550\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"3a6ee9ed2e5a5218\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/index.js\":\"208d5b6428640666\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"c098d45625508f8a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/CharacterCountItem.js\":\"fd754d99ecceebb3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/ProfilePropertyEditor.js\":\"741b5ee50e269d27\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/actions.js\":\"c221ed6a2dca5c6d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/blockType.js\":\"e3b1bc5a2d590232\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/charCount.js\":\"7a5fcd0e8be8970a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/dataExtension.js\":\"054e090d02ec85af\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/index.js\":\"ff1ed2523509eb8a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/profiles.js\":\"5fba79a1504e5e07\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/properties.js\":\"f839c592d231d05b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/subtree.js\":\"ccc0e7f93a4a299f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/textCounts.js\":\"752f40950052b389\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/colemak-keybindings/index.js\":\"c4c75f67640e2adb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/CommandPalette.js\":\"3699c7e20bdf8591\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/HeaderItem.js\":\"8e44e1c7bacbce26\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/context.js\":\"419a2f2ed852d246\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/index.js\":\"a5bb3e5d162cbc2c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/selection.js\":\"55ac0eddeccbf377\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/toggleStore.js\":\"142aa463d6a328bc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/useCommandPaletteActions.js\":\"a340459eabc9c6f8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/ContributorBadges.js\":\"f34d1762f8a94bf5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/ProfilePicture.js\":\"6d82a0c371957308\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/author.js\":\"23725d545de40517\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/codeMirrorExtensions.js\":\"96db83f898384229\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/dataExtension.js\":\"5dc431f20bf8fa91\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/index.js\":\"84aabc6763e80fb1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/mentionAutocomplete.js\":\"73d48e3eae67b6af\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/processor.js\":\"e8bdfc2258211dba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/profiles.js\":\"7d1d2c5d7f800278\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/queries.js\":\"21cd56cfc2a1e344\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/schema.js\":\"c2c7e9fe0923d483\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/useCommentAuthor.js\":\"72cf72671aa943cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"7f49558321baac4f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/followOrigin.js\":\"eaa7f4c901cfb85a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/index.js\":\"c2e8ffe15333f78c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"40415a3949d871e5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"4971d8e482e9359c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/CalendarGrid.js\":\"c631a7c20d0b5b43\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DailyNotePicker.js\":\"2838957ff77c8a67\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"5e50769461ddd8dc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateNavDecorator.js\":\"b4c82bdbca57fc08\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateScrubOverlay.js\":\"dfdcdda4a24c3761\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DayPropertyControl.js\":\"f8858c9230b817e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DayValueReferenceControl.js\":\"411428ade2a88525\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/HeaderItem.js\":\"73e68bd8020dae23\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/ReschedulePicker.js\":\"d52a31ff416e1d72\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/SpreadDatesDialog.js\":\"007d57e97825da72\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/actions.js\":\"b51d26865f3d102e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/blockDateAdapter.js\":\"69750162c5144fc6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/calendar.js\":\"fcc49ec12472e0bc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dailyNotes.js\":\"5b2d21638231213c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dataExtension.js\":\"3119619b8f56e9e8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubActions.js\":\"ce1f7d007aa5a2e6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubGesture.js\":\"3b0cc8cb6e54eff3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubGestureActions.js\":\"0a8e0987b935127b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubRecognizer.js\":\"be9d05a11aa58263\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dayProperty.js\":\"fc1acdbb696e618d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"5d57d2a721bc1422\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/deletionGuard.js\":\"4189cfb92df52d73\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dueQuery.js\":\"0411feffc0335397\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/index.js\":\"8fdbf3d9130808af\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/landing.js\":\"9f9ee0c526649cd2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/localSchema.js\":\"e438fa82266d8da5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/referenceDateAdapter.js\":\"9f878c84ecb50784\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/rescheduleAction.js\":\"e61ced9ba6903862\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/schema.js\":\"039875ddff3670ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/spreadBlockDates.js\":\"3a3e0b118072a288\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/spreadDatesAction.js\":\"517cec64a82b385e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/today.js\":\"2037e81e1300e1fa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f7fde679ae62d671\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c51b954977841514\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/audit.js\":\"73713a29eae4e568\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/auditAction.js\":\"51be066fd0587650\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/auditRanges.js\":\"dac3247c13966a24\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/diagnosticsSource.js\":\"daaa9248258b3a61\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/divergenceScan.js\":\"e04f997bde95114d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/index.js\":\"b9db0ce16334a93d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/propertyChildrenChecks.js\":\"47f79f2871e231fe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/referencesMirror.js\":\"61f653db7a5887e9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/rowJson.js\":\"a6b1c5afcdcf66c2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/schedule.js\":\"671be170f5e130ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/store.js\":\"219d000a3086e79d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/action.js\":\"bcd4332cc7317f72\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/index.js\":\"b82e79c9e7281ea6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/plugin.js\":\"161a4110643a423f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"ce7eee2a48c5da6e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/actions.js\":\"f9a19006ca37e2be\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/changeMarker.js\":\"3d6555b6877890f6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/diagnostics.js\":\"13713ae40d7826f9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/fileSystemAccess.js\":\"ab9ad95910ff2b45\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/filenames.js\":\"064a6cce3f94191f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/index.js\":\"62cd9b45c3f7a1fd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/mirror.js\":\"5714161937127eab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/runLock.js\":\"bc21883b044cce56\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/runtimeHealth.js\":\"71175ae2d284ae26\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/schedule.js\":\"2e9edadb5194d31b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/store.js\":\"007f76e4ad3a39dd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/default-themes/index.js\":\"0cb04dd19bf6593c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/default-themes/themes.js\":\"4798098fe319aca0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/diagnostics/facet.js\":\"0626db9009b315f9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/diagnostics/useDiagnostics.js\":\"6ab803f79f27d3ec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/dismissals.js\":\"bf0374b537e801f7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/index.js\":\"281d35c5af51d841\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/status.js\":\"9e24f76bdef9f929\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/store.js\":\"5c99246a50e800b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b57c8f248d12b492\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/ExtensionsSettings.js\":\"77ae2ea951a799a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/actions.js\":\"1fde26a200c26e96\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/config.js\":\"150e6a610ddec8ba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/dataExtension.js\":\"17522417fcaad821\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/effect.js\":\"2b12ef88c5424ad9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/index.js\":\"d7d8e536a992cb85\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/propertyEditorOverride.js\":\"073a3532705f440b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/useToggleTree.js\":\"b4153de768d2734f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/ExtractTypeDialog.js\":\"293ed2ae2c1f7d44\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"41a8f5ed5856f960\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/PropertyShapePicker.js\":\"dabaa14a14452d83\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/action.js\":\"402f674a98b71fd8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/index.js\":\"f78946f0ab2bd935\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/FindReplaceDialog.js\":\"571d44fc5485a243\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/HeaderItem.js\":\"40a3e351ad385e96\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/dataExtension.js\":\"fbb89a7f3befdeaf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/index.js\":\"371fa3655ad7ff58\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/search.js\":\"6dcd2354752067f3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/toggleStore.js\":\"59755aeaccf82d11\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/LocationPropertyEditor.js\":\"251279b1806ea40c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/MapView.js\":\"ddbe229d9dd07947\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/blockTypes.js\":\"766b57ca6846c31a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/codeMirrorExtensions.js\":\"220681b3dd6861d5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/createOrFindPlace.js\":\"67731317625de0d0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/currentLocation.js\":\"b0cae21c86077aaf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/dataExtension.js\":\"8bf6f23e05bbca50\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/geoContentDecorator.js\":\"b9be6332440b9dc1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/googlePlacesClient.js\":\"1b8777473534a19f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/index.js\":\"ca8e3a6ecae07ec2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/locationsPage.js\":\"9bd868f2d0832fbf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/mapViewport.js\":\"d6e3e0b1bbdd261b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/pickCurrentLocation.js\":\"f7d13de2af25bf85\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/placeAutocomplete.js\":\"6f63f2099a14d18c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/placeNameCollision.js\":\"a9cd5b0a725812e8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/properties.js\":\"4cc826fa39afc291\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/propertyEditorOverrides.js\":\"f0da59d9806ec1ec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/query.js\":\"4b57e7bcb128d505\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/usePlaceSearch.js\":\"530a9bcd3327f413\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"d90f5139499ee021\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"62921be0d7c552ae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"cec92e32f5a95ec1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/config.js\":\"ea4c9e5a74a04a17\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/dataExtension.js\":\"4499ad5c6f4a6e47\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/facet.js\":\"5d85218c758c6b73\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/grouping.js\":\"c217f016ede59646\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/index.js\":\"a98d1394e966014f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"7c40eb94962e9934\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/query.js\":\"c421bd4766cbd119\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/resolveConfig.js\":\"56e699d1867129e8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"372f433de9857079\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"93f34865db7c2995\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/HtmlDocumentContent.js\":\"9b018576f6ea1de6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/HtmlFrame.js\":\"c228f97d8eab4985\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/actions.js\":\"91015bfc8ae0645a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/blockType.js\":\"3a37c2dc1c15446f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/confirmRunScripts.js\":\"f3765856ec059e36\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/dataExtension.js\":\"62ec5651e9429496\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameAnnotations.js\":\"98ccab15ce49bb46\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameDocument.js\":\"7b6d0efe39ec8871\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameTheme.js\":\"e62ac048726217ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/index.js\":\"6c01ea9db492f2b0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/scriptConsent.js\":\"2e6102c5f92e4196\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/sourceMap.js\":\"fc207f6242b84222\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/useDocumentScripts.js\":\"7457dda71477da8d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/index.js\":\"63b763532864728b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/record.js\":\"9fe6b52d2b8334d2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/recordStore.js\":\"a25f30a21b660cb2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/responsiveness.js\":\"5606dc8fca4273a6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/schedule.js\":\"47eb6c5acd4f5502\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/sessionContext.js\":\"1fd3e50941be51bf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"f61890da65df178a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"0e7cc28f2aa40718\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/actions.js\":\"f6ac94371a3b9d92\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/config.js\":\"ad88738d697fe420\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/dataExtension.js\":\"78db1bc12c34ed0a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/effect.js\":\"c48b7d02c75d3332\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/index.js\":\"5c6c656e1b126eff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/keyCapture.js\":\"d5c83b5c6fefcfa4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/overrideStore.js\":\"ce09575a5eb21eaa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f041108237c0a6dc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/HeaderItem.js\":\"860e672191073798\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/LeftSidebar.js\":\"f5d14e77f580e37c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/actions.js\":\"d617cf4e421e8d0c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/facet.js\":\"95dbb7472dd0d8c7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/index.js\":\"1520d2b4d9712503\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/shortcuts.js\":\"753675a04e422f62\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/toggleStore.js\":\"73d0cf6fb5fff07f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/MergePicker.js\":\"9163ba356511b9e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/index.js\":\"c492298dbb1073c7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/mergeAction.js\":\"e7ef50dfd875e624\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/strategy.js\":\"3b57a30ef2466ee3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/Button.js\":\"aa77c131c546cd38\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a61f71892f82fcce\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/defaultItems.js\":\"948ea8c366656073\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/facet.js\":\"d8b88388c5526d10\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/index.js\":\"b15fd4d30eeff0ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"2ba67af679cbbf6f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/actions.js\":\"5cb5b23d1a43bdf2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"29d6ef48aec830eb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/facet.js\":\"1ff70a53ba6e6a09\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/index.js\":\"2f4874626be6cb4b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/MoveDestinationPicker.js\":\"8ef6da4dffa5cd0c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/blockSubtreeMembership.js\":\"02b7bed70fc7cb53\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/contextMenuItem.js\":\"cac19fef2e79720a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/index.js\":\"bc5e8690516a3353\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/moveAction.js\":\"022974692bed9417\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/moveBlocks.js\":\"36e4b68a1bf8563a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/selectionAfterMove.js\":\"a9cd18d0d6635330\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/TutorialBanner.js\":\"53c65df35930e495\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/action.js\":\"73995b5f3fbb9b1d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/bannerDismissal.js\":\"2e3ee7d757d73ed4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/documents/cheatSheet.js\":\"89663ead28783a40\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/index.js\":\"ebc795c1041186b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/keys.js\":\"52b270b0986407b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/landing.js\":\"097bcc86d1ac36f5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/outline.js\":\"595e0a6897879b61\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/seed.js\":\"9353848eea5d4294\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/PerfTrendDialog.js\":\"a0926f22c701987f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/analyze.js\":\"99a8ccc820ae8d97\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/diagnosticsSource.js\":\"7bdda8b32b6bfe62\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/index.js\":\"a25bcbdf62d5ecb8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/load.js\":\"59649c140640aed8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/monitorRun.js\":\"fb3d62a92b9e87f0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/schedule.js\":\"1ae259209cdcb8a0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/series.js\":\"24024241af765dde\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/store.js\":\"cc67ef289ed1bdfb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/trendAction.js\":\"1b0fdd9fc19334a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/verdict.js\":\"107dcf10e3c228ae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/clickToEditAction.js\":\"25801c276baa96d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/index.js\":\"15896da7c57c8423\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/interactions.js\":\"50592c47ec54f9d6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"8a6bff52672602f2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/MigrationGate.js\":\"63ee11106d432f1a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/MigrationGateDialog.js\":\"add7d6074d3fe31d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/action.js\":\"f5f031f90eba8802\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/index.js\":\"20ce5a0c74f7342d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/localRunMessage.js\":\"a7bc3e7f01c56089\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/plugin.js\":\"339c805b819e1003\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/progressReport.js\":\"cbffdd9a8b6670d0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/sweepProgress.js\":\"56dba6c7aa8eb8e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/FieldRowRenderer.js\":\"0b686f0615c5664c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/ValueRowRenderer.js\":\"30000a3f053ae4e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/actions.js\":\"db6d99ee70c1d89b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/autocomplete.js\":\"62fb250ae04f1321\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/fieldRow.js\":\"c84371d9bec221d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/index.js\":\"8a989fa9a524b642\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/referenceWarning.js\":\"c20740e30b851a80\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/valueAutocomplete.js\":\"0c923b79cd3046d5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/valueSchema.js\":\"f0ff9cb2fe6e790c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/HeaderItem.js\":\"df37412965498c15\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/QuickFind.js\":\"e23ed64c6833817c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/index.js\":\"20ce7984cc722253\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/recents.js\":\"cf9098cbfb69c7d0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/resultItems.js\":\"62ce34841cdcb130\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/selection.js\":\"049af7891e3264bf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/toggleStore.js\":\"0a31f36abbc963ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/HeaderItem.js\":\"cf0ed1f873f252cb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e5f2332e8bcff20a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/grouping.js\":\"0529b138ee9bcb14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/index.js\":\"25dafc6664dbb522\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/target.js\":\"db9e76ea03479864\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/codeMirrorExtensions.js\":\"f4e7ceb50d0e477d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/contentPrefill.js\":\"ee4323821b036322\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/dataExtension.js\":\"60d1635277aeb527\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/index.js\":\"83ebaf59dd8b3490\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0cb7a7abe95f59b1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/invalidation.js\":\"dd914018b30ef431\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/localSchema.js\":\"1c1c870de8781680\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/blockrefs/index.js\":\"f4f0c5f602ea3319\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"15c582c006600cb1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/index.js\":\"fe48d6e0a101babf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/referenceNode.js\":\"c915a1fe4791ad41\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/remark-reference-occurrences.js\":\"7e487548c59a419e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"e500fcb745179ef7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/index.js\":\"e272b0e2ca96ca0f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"8e08551de840f1e3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"352c14ecb2e961c7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/mergeRetargetProcessor.js\":\"80cfc6607c6dde02\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/parseFence.js\":\"5226deb698a071cd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referenceParser.js\":\"efaf7d05a0c641d6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referenceProjection.js\":\"65fd30cc6ce6f157\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referencesProcessor.js\":\"0bde1476f0113937\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/renameProcessor.js\":\"3bc6cbaec99e88da\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/spanReplacement.js\":\"7363ab5034a0c787\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/htmlToOutline.js\":\"71665df6a23079b6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/index.js\":\"d318149c0c6b550d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/normalizeClipboardDom.js\":\"f23c158bdcea661f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/pasteDecision.js\":\"ccbac10e5717f650\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/action.js\":\"8494597193a55b0f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/blockIds.js\":\"c13e5b806f7ec1a8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/content.js\":\"2b0354970e80cca6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/effect.js\":\"4135d9c6af67fcdb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/ids.js\":\"ee54b20d028ffec8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/import.js\":\"7f0051e59e91e892\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/index.js\":\"8d97f89924f9fcc1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/plan.js\":\"3ca02744cfd85d21\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/plugin.js\":\"0c35577c630bac09\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/promotion.js\":\"a0538264ab33ba70\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/properties.js\":\"fccb430c397cd479\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/references.js\":\"083c7ef9f9ccaafc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/report.js\":\"7628126f97f0f345\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/roamMemo.js\":\"b57cc39a89d60a0d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/runtime.js\":\"36aa8e11dbf65ad2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/schemaReconciliation.js\":\"7737bc60687db5ea\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/srsMarkers.js\":\"cf10698d6dd0546a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/todo.js\":\"cb1d4629dbd10660\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/typeCandidates.js\":\"59975fe545db35ca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/types.js\":\"12db87d22256f626\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/search-health/index.js\":\"896829fdb7ab092a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/search-health/store.js\":\"a6d66dd592e52457\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/HeaderItem.js\":\"1f7b1a02cc74b907\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"3d98c6f517e83c32\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/index.js\":\"39cd76e323f828cc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/model.js\":\"040dd867a5c239e6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/toggleStore.js\":\"8bf71edcccf6a31e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/useKeyInspector.js\":\"eb48f670212a7dd4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"53e685d509bb9cf3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/ShellDecorator.js\":\"212e7db2e387bf0f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/actions.js\":\"6c4f3183f01395bf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/exclusionsFacet.js\":\"0e64f0ca12700e6e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/index.js\":\"fa85ed5f2858fa98\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/shell.js\":\"bc9a632732a13080\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/surface.js\":\"8975209e99026963\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/walker.js\":\"26d2033e43df5f10\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/RescheduleToast.js\":\"39e27ee70dcde081\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/dataExtension.js\":\"64ebfead5eaf5503\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/index.js\":\"82cde9bef33e471e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/indicator.js\":\"80fbb26f08e7b88d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/moveSrsState.js\":\"32012458617258a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"2ee9cd23579fe856\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/scheduler.js\":\"c7b8e1790cab310c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/schema.js\":\"7dbc8a8ed25d55fd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"b52dfbf461a09ef3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/srsClipboard.js\":\"6542ac04fed268ab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"2884a76107954b32\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a4477c40ad66ff29\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/DeckPicker.js\":\"d45db87710218128\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewControls.js\":\"cc0bd42e72579f41\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewDeckRenderer.js\":\"bea3d45fefc71550\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewSession.js\":\"66a56aaaaff84c3b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/actions.js\":\"397c7e4797654a3c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/archive.js\":\"7e07c49f3360d8bb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/dataExtension.js\":\"4bb9c3317bc643cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/deck.js\":\"46ba4297b0bb48c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/dueQuery.js\":\"deb7cdc8181e3701\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/gradeDecision.js\":\"79ef4ed9f3400379\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/index.js\":\"259e18d07bc6f592\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/keyHints.js\":\"96f0d22c61995d7d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/reviewCardLayout.js\":\"929e5afa0fe7f02b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/reviewProgress.js\":\"7a6f83422dbd1f46\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/schema.js\":\"533359664bfa6c4c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/useDueCards.js\":\"74cff0c0ed60b444\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/startup-metrics/index.js\":\"d7ed3473d7b688fb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/startup-metrics/record.js\":\"49d3fcb78e0e1788\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/index.js\":\"0af17cd78cfbf84c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/persistenceStatus.js\":\"ede30c9918e8dd2a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/requestAction.js\":\"284db55c27d00073\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/TypeChipsDecorator.js\":\"ff32a381c6ca06e6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/codeMirrorExtensions.js\":\"c3aaea67dde877d3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/index.js\":\"b1d0f043395e6d5c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/typeAutocomplete.js\":\"8abf43b3389a3bb3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e9ef07c5c8f6944a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/actions.js\":\"b5eb1f12457a7319\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/anchor.js\":\"777971beaeeb56b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/events.js\":\"6d3e4004086df609\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/gestureActions.js\":\"1684be04d5b734b1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/index.js\":\"6c768a4a7bf3f626\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"91acd2466a4f7148\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/collect.js\":\"8fa6e676d489928a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/index.js\":\"aa72b9f85b88d8b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/record.js\":\"33676505625aa16d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/RejectionDialog.js\":\"b7a34e9a85c11c13\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/SystemStatusHeaderItem.js\":\"e2b8aa4305c627c3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/index.js\":\"e15b9e4d5874b81f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/model.js\":\"b333d0ffe548fcab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/queueCounts.js\":\"7629bc676209e8f5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/rejectedHelpers.js\":\"0ffc44b03b7c6f65\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/rematerializeAction.js\":\"c6b2de7620d0dd06\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/useHysteresis.js\":\"e7d308c28d339c20\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/ColumnHeaders.js\":\"dee74fff924a1cc1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/QueryUi.js\":\"71c116cbdcc78f80\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/TableLayout.js\":\"de2ffc2ee0c8ad6f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/actions.js\":\"8b30f310d26f1f18\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/cellEdits.js\":\"0578d68a83499a2a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/childrenViews.js\":\"6822a4ec195c6ce3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/columns.js\":\"bdbd68907849e80f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/controller.js\":\"168161bdc96451f5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/convert.js\":\"0a659f4c7d89034c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/dataExtension.js\":\"d5688224fd3eb5ac\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/index.js\":\"0e94fa76c1016d2f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/keys.js\":\"2afb07bd4d8b4918\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/model.js\":\"803af885216e14be\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/QueryText.js\":\"f8bae006bb330cc9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/backfill.js\":\"f816fcd0b6936d4c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/completion.js\":\"5cb09c7c472be81a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/format.js\":\"212e197a39e29594\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/parse.js\":\"1b214a930fe95819\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/queryValue.js\":\"8bb184d3533573c5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/registrations.js\":\"7520ddc08bad2de5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/source.js\":\"ec8f92563bfeda2d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/registry.js\":\"9752ebe13e922911\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/rowGutter.js\":\"b2142ec81ebdeaa6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/rowVerbs.js\":\"4926f79cd361ddf1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/schema.js\":\"f423f2fec0656704\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/sort.js\":\"b63a9017b881ef96\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/effect.js\":\"be5caaeda1f04da9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/index.js\":\"ed5922ed3203b1a6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/theme.js\":\"3e65f21e18409425\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/actions.js\":\"411fd83ac1dab9ac\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/dataExtension.js\":\"7a553b450061f44a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/index.js\":\"95da23f16a709a2b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/schema.js\":\"534f1563273b82b1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/TouchSelectionLayer.js\":\"8d0bbd0004d8f834\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/actions.js\":\"3670ef36f64a0083\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/defaultItems.js\":\"df52c04ebec67291\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/facet.js\":\"019de7d6f28f13bd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/holdRecognizer.js\":\"a8ebdbdfa6bf5ad4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/index.js\":\"fb012ebc6a3cb4c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/UpdateIndicator.js\":\"7b083957bc687020\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/index.js\":\"3b80a7d84bcb0b6e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/loadTimes.js\":\"a929cbbb429b1f09\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoNotesRenderer.js\":\"c40abd6054799695\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoPlayerRenderer.js\":\"0ea8be38ec7aaa49\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoTimeStamp.js\":\"f27bcb98b6e67f96\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/actions.js\":\"21839c3f8f03eef4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/index.js\":\"c52268965f3218b1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/markdown.js\":\"bc34163d1e7dc37a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/notes.js\":\"b238ec16ab91f247\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/registry.js\":\"10c8ecad5834e86e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/remark-timestamps.js\":\"f7452811fe7d66ca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/view.js\":\"542d07ea536e3e0a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/LinkHints.js\":\"4b62763872f0e3cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/index.js\":\"6a69aad7fc454f23\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/model.js\":\"90deda5e82916f4a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/settings.js\":\"fd956936bb641628\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/actions.js\":\"13f1bd9e2af3cf39\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/index.js\":\"ce8eea9bff04b61c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/interactions.js\":\"83aeeac175974a20\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/workspace-header/index.js\":\"b0114918f4b9a463\",\"/knowledge-medium/pr-preview/pr-1920/src/registerServiceWorker.js\":\"a42c664e89b033c2\",\"/knowledge-medium/pr-preview/pr-1920/src/requestPersistentStorage.js\":\"5214cfbe1bac544d\",\"/knowledge-medium/pr-preview/pr-1920/src/services/authRequestDeadline.js\":\"c32b4e549e170ce1\",\"/knowledge-medium/pr-preview/pr-1920/src/services/authStorage.js\":\"8716a02619a72faf\",\"/knowledge-medium/pr-preview/pr-1920/src/services/powersync.js\":\"24af2eca89b86d9d\",\"/knowledge-medium/pr-preview/pr-1920/src/services/supabase.js\":\"907dcd23b4b7154b\",\"/knowledge-medium/pr-preview/pr-1920/src/services/uploadErrorClassifier.js\":\"ca461dae971dc1d4\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/ActiveContexts.js\":\"65aae499724771c6\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/HotkeyReconciler.js\":\"875d687d52fcde55\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/WipeLocalDataDialog.js\":\"f4d5952395e9c16e\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/actionDispatch.js\":\"c2902ca43ed47f87\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/actionRefItems.js\":\"b518458fb952d2a1\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/applyKeybindingOverrides.js\":\"e6bdd30912257c93\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/blockActions.js\":\"65518a26e6c109df\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/blockMergeGesture.js\":\"b3e5735d656b9c89\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/canonicalizeChord.js\":\"a161ca2770609ef1\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/defaultContexts.js\":\"c8d43d2d270cede4\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/defaultShortcuts.js\":\"23c8142d1a074715\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/effectiveActions.js\":\"d8e16df5fed9fa2c\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/gestureAction.js\":\"cb25b1ed74fcb066\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/gestureBinding.js\":\"94397416fd4f8cce\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/holdRegistry.js\":\"9c82ae64492d0a25\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/keybindingConflicts.js\":\"789424ecf446a4ef\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/keybindingOverrides.js\":\"1cc2b9430844c7f9\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/pointerAction.js\":\"df952e9c3ec40531\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/resolve.js\":\"df737519182f7519\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/runAction.js\":\"cbde2a5da0e02948\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/sequenceMatcher.js\":\"fd734cb48473e264\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/types.js\":\"bc83e3f108c6c863\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/useActionContext.js\":\"f342ceb97d17ec68\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/useActionDiscovery.js\":\"65e686118dc67419\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/utils.js\":\"c6e7f8bd18c42a7c\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/bootStore.js\":\"f466d18e117082d3\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/previewDatabases.js\":\"ae318842e76bfd8e\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/byteTransform.js\":\"42e976b92f34253c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/attachmentCleaner.js\":\"da58203bc5f6f539\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/attachmentParts.js\":\"3e3fecb17107b77f\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/bundleParts.js\":\"8519f27b498b2596\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/bundleRecord.js\":\"17c092793fafbb0c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/manifest.js\":\"cd3298d78619e2e7\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/takeBundle.js\":\"099400a49c1f0755\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/verifyBundle.js\":\"cb793ec1430ca883\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/cleaningStage.js\":\"97578f132bb4cf62\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionKey.js\":\"9ff968c13c4a860d\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionServer.js\":\"c72c036bc2f29b63\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/flip.js\":\"4466726e08953514\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/flipAttempts.js\":\"e1987bb385fa32b0\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/pages.js\":\"9abae1fc32db87cc\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/preflight.js\":\"01cc0915c30ad1c3\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/reseal.js\":\"1026f85cdfdd2bb7\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/runConversion.js\":\"ee222673a1bd9476\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/runLock.js\":\"86adca8ef9a77e17\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/sealing.js\":\"6e0fc51fc2923fc8\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/sealingStage.js\":\"38e7c45d1d803215\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/stage.js\":\"f3167b6f604b38e0\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/verifyReseal.js\":\"71a82ffb0b531c7a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/aad.js\":\"933f077b17a26be4\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/aead.js\":\"eee044e3350ec904\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/base32.js\":\"fb513b05028c4dd3\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/base64url.js\":\"5e1f8d8caf2b7854\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/binaryEnvelope.js\":\"7c0fd37b519ad0ee\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/byteAead.js\":\"7a185e28756730f8\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/canary.js\":\"4bffe0818b9b0046\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/contentHash.js\":\"f900bfa3b01dbd15\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/contentKey.js\":\"f10b1c944a5c6ee7\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/derivedIdNamespace.js\":\"2d9d59b3277096a5\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/envelope.js\":\"922104643cc321f8\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/hex.js\":\"0749e8dc5c18711e\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/sha256Hex.js\":\"c97fbe3356589d5d\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/workspaceKey.js\":\"138570a74702b043\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/conversionState.js\":\"a6bfa3f9100164c1\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/createEncryptedWorkspace.js\":\"9ffe1863129e09c9\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/pastedKey.js\":\"4ee6d873673c1f7e\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"e30956e7d0578e51\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/upgradeWorkspacePin.js\":\"f9f74affae31817c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/keyStore.js\":\"e9532c94b023b57c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/mintWorkspaceKey.js\":\"aa54bf7999e6fa0c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/modePin.js\":\"1773c4b2e1412135\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/openWorkspaceKeys.js\":\"47bd2d17ee708f86\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/resolveWorkspaceEntry.js\":\"37f44d4d945d6ebe\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/resolver.js\":\"6862d2bb244e7cd0\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/workspaceAccess.js\":\"94147c33367ae458\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/transform.js\":\"6d6426525437eb37\",\"/knowledge-medium/pr-preview/pr-1920/src/themeBootDefaults.js\":\"4a83404e96b3793e\",\"/knowledge-medium/pr-preview/pr-1920/src/types.js\":\"e0adce062e07eb5b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/ClientLocalSettings.js\":\"5cdd828b04588ff2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/abortableSleep.js\":\"db95a6517ead6b7c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/array.js\":\"04a1401a2dd56877\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/backlinkAutocomplete.js\":\"2283d877f33f93a5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/blockCrumbs.js\":\"c2c9184739dc3cc1\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/blockrefAutocomplete.js\":\"083519da6e491e50\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/cadencedIdleJob.js\":\"373340dfcb8bc4c9\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/callbackSet.js\":\"b8d1f6749ee8388a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/clientId.js\":\"9e59a671f1a280a5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/codemirror.js\":\"fb7dcd3499f1b67c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/codemirrorCompletion.js\":\"5baad392bcccffce\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/copy.js\":\"db3d3890de618ac4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dailyPage.js\":\"fa8fc6e136871e83\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dbForensics.js\":\"a9e1c0a89c44eb95\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dbForensicsHooks.js\":\"dd2368ccd60be525\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/deleteBlockThroughUi.js\":\"53aa22caa517aae7\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dialogs.js\":\"f5960aeffefc0e8f\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dom.js\":\"e344405ba70ef90b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/downloadBlob.js\":\"3931ac03f23cd324\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/drawnWalk.js\":\"be1966128a438b52\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/exportSqliteDb.js\":\"816f1a99f9e4facb\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fileSystemAccess.js\":\"34af9937dee23e40\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/flipSlide.js\":\"ea3e2689bf6e180b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fnv1a.js\":\"fe428e017215510d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/formatBytes.js\":\"ca4e868d00f86cc7\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fuzzyRank.js\":\"eca819e38eb66cbc\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/idbKeyedStore.js\":\"f07b084578b34271\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/idleCallbackPolyfill.js\":\"33b4dbe43a547170\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/keyboardAwareScroll.js\":\"10e8775a121511b1\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/keyboardViewport.js\":\"97c6010535869cd6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/lastWorkspace.js\":\"f82cf67d588a9ad6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutColumns.js\":\"0f9ae2dd189963a4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutSessionDom.js\":\"66554ed6e63f483c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutSessionId.js\":\"c8ff397836faa8e2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/linkClickGestures.js\":\"072d4b400b3cb91e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/linkTargetAutocomplete.js\":\"e8d78bb7a77b0be7\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/localDbCorruption.js\":\"d6acf4db48f81d3b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/localDbRecovery.js\":\"7c2f858e536276a1\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/markdownParser.js\":\"e265e21546b749df\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/memoize.js\":\"b99d72fa36d1f5f6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/nameFieldCommit.js\":\"2e100d1b7d996410\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/nameList.js\":\"7b2506d627c596e0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/navigation.js\":\"8a2540318c5adf76\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/omnilinerNamespace.js\":\"78c33516c627cdf2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/opfsPageScan.js\":\"9e1957655582557c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelClearance.js\":\"18f6ed04f786c295\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelHistory.js\":\"8c005e0fa69c4fa2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelLanes.js\":\"ee88d868733f57b4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelLayoutProjection.js\":\"fc0da0763e6bffb1\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelScrollAnchor.js\":\"7a8f70d07703f52a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelUrlFlags.js\":\"dfc7c65365b2245c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/platform.js\":\"e125564d90483c55\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/pluralize.js\":\"b956870dc63b4d9e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyCreation.js\":\"4938325bc9b27473\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyNavigation.js\":\"34d9a1b5fe7ecee5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyValueContext.js\":\"9cf43a30f07110c3\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/react.js\":\"6da012e01b03028e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/relativeDate.js\":\"7f6a88a6924969f1\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/relativeTime.js\":\"fff49bf4068dcd66\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/renderScope.js\":\"775866bdf91afd7e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/resolvedThenable.js\":\"97318a612bd870d0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/routing.js\":\"ad3d446f8f1a6355\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/safeMode.js\":\"eabebf61364a7bfa\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/scheduleIdle.js\":\"af6d6cf056712124\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/screenWakeLock.js\":\"8394b547c00b58b3\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/selection.js\":\"7b859c798197961c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/softKeyboardGrab.js\":\"3a3ee04dc85ea651\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/startupTimeline.js\":\"e240099b66961f95\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/state.js\":\"094ca8b1b2a18073\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/string.js\":\"464d76279ebe43f0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/surfaceZoom.js\":\"590f216c9abe8fed\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/time.js\":\"cdc2724f2a16d467\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/toast.js\":\"b41527402c6c1794\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/toggleStore.js\":\"6d8322dfba3f7c4c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/untilStopped.js\":\"206b91c903f65a3b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/userActivity.js\":\"2ea1fc512a72b78c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/viewTransition.js\":\"2b2a3f9a96cc739d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/viewport.js\":\"7364bb2a5daa2573\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/webLock.js\":\"6fd8dddbbbd9e573\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/workspaceRecovery.js\":\"863409d6a8ee1ff7\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/workspaceSnapshotStore.js\":\"0dfad1982c809606\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-compiler-runtime.js\":\"8b32e2c01f5b556b\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-client.js\":\"3c2dcf7752356a20\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-server-edge.js\":\"2f0acb1e5207ecc2\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-server.js\":\"3ddd4c5998f6adac\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-static-edge.js\":\"a886bba2875b78e0\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-static.js\":\"f2826ff075aaefcc\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-test-utils.js\":\"ab4e2edeaf8729f5\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom.js\":\"dca6bdd8b56f4667\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-jsx-runtime.js\":\"603b2a3d6fd9ba72\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react.js\":\"c4889d7fd203196b\",\"/knowledge-medium/pr-preview/pr-1920/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1920/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1920/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
