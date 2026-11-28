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
		buildId: "4e7f5b8f4689-9b7673a0",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/\":\"b56454932ef5958f\",\"/knowledge-medium/pr-preview/pr-1920/index.html\":\"b56454932ef5958f\",\"/knowledge-medium/pr-preview/pr-1920/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1920/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1920/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1920/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1920/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1920/assets/FacadeVFS-Dzprt26q.js\":\"0e0d400c8679cc06\",\"/knowledge-medium/pr-preview/pr-1920/assets/OPFSCoopSyncVFS-DOAtEzXn.js\":\"9423c6c449e14495\",\"/knowledge-medium/pr-preview/pr-1920/assets/OPFSWriteAheadVFS-DkBZ56mq.js\":\"91de7d8d85a34136\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-CQT19RLG.js\":\"824b5a413cee93ce\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-async-B9AMn7iz.js\":\"c04c3c0fbc2ca21a\",\"/knowledge-medium/pr-preview/pr-1920/assets/worker-CvWTNltW.js\":\"8ecd3efed662a6a2\",\"/knowledge-medium/pr-preview/pr-1920/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1920/chunks/app-qRlX8gxn.js\":\"3bc067f5e65c46c7\",\"/knowledge-medium/pr-preview/pr-1920/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1920/index.js\":\"5bd728d9d9c836af\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1920/assets/AccessHandlePoolVFS-EAvatuPc.js\":\"4646a520f5e07102\",\"/knowledge-medium/pr-preview/pr-1920/assets/IDBBatchAtomicVFS-C-p3IXAW.js\":\"f494aca4ca24062d\",\"/knowledge-medium/pr-preview/pr-1920/assets/MemoryVFS-DzBdLyQV.js\":\"8811fed281b931f0\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-C0MlZseB.js\":\"2ea6d557dd74ebc5\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-async-DQ3hJZ7u.js\":\"eb7d5db38a1ae1fb\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1920/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1920/chunks/AccessHandlePoolVFS--AVEVzH2.js\":\"7309e9a157ad0793\",\"/knowledge-medium/pr-preview/pr-1920/chunks/FacadeVFS-BsfTWsiq.js\":\"1c91e155f8d9da89\",\"/knowledge-medium/pr-preview/pr-1920/chunks/IDBBatchAtomicVFS-DbKI99FZ.js\":\"d9fc7a9ccdde7790\",\"/knowledge-medium/pr-preview/pr-1920/chunks/MemoryVFS-CUDvzKkd.js\":\"b7922c5e077328f3\",\"/knowledge-medium/pr-preview/pr-1920/chunks/OPFSCoopSyncVFS-D_M172US.js\":\"8d5a67a1d9dd5acc\",\"/knowledge-medium/pr-preview/pr-1920/chunks/OPFSWriteAheadVFS-CTDA-unX.js\":\"65a13108b8a8dc48\",\"/knowledge-medium/pr-preview/pr-1920/chunks/Preview-W0EmjSCf.js\":\"b4097d10e27a34a0\",\"/knowledge-medium/pr-preview/pr-1920/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1920/chunks/card-CaLV4OEq.js\":\"09f9e17010f9edc7\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-kWzaJ5D1.js\":\"088136cbf43e47a4\",\"/knowledge-medium/pr-preview/pr-1920/chunks/freezeExtensionImports-D7BN9pU6.js\":\"6f0938464823bf50\",\"/knowledge-medium/pr-preview/pr-1920/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1920/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1920/chunks/mc-wa-sqlite-BlpcTRyG.js\":\"f36618f3c75f8f55\",\"/knowledge-medium/pr-preview/pr-1920/chunks/mc-wa-sqlite-async-BVwkYQAM.js\":\"64e537af003b53ac\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-BJQHjHXH.js\":\"a055243ef974a321\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-BQ5LiHou.js\":\"4774dc04891850a0\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-BoJacjZE.js\":\"6e245ff0de5c2c5c\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-CudwoAT2.js\":\"e25b8c62f68b6c0d\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-DsMNJ3lq.js\":\"21abe72856ee7103\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-Ob1Ww05w.js\":\"527b82cdbab7e063\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-d3FzW9Dw.js\":\"6f9432277dfd545b\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server-legacy.browser.production-GLIHmHic.js\":\"4bf0c0f710889352\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server.browser.production-BPZlkITJ.js\":\"46e8507f03753987\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server.edge.production-CseCKvhw.js\":\"447cd3356a56bc1f\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-gU6_RB11.js\":\"ef1d662be06548e1\",\"/knowledge-medium/pr-preview/pr-1920/chunks/server.browser-D8md8Zpo.js\":\"e20e1714d511bf2d\",\"/knowledge-medium/pr-preview/pr-1920/chunks/textarea-DHWiEX0p.js\":\"ee0cd56d09f8bcdb\",\"/knowledge-medium/pr-preview/pr-1920/chunks/ui-CWO0IZ0m.js\":\"d25968e376ac7e61\",\"/knowledge-medium/pr-preview/pr-1920/chunks/wa-sqlite-BaLAD3YB.js\":\"af21909fa0ac92ef\",\"/knowledge-medium/pr-preview/pr-1920/chunks/wa-sqlite-async-w5wkQCKx.js\":\"6747ea05bd4b3243\",\"/knowledge-medium/pr-preview/pr-1920/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1920/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1920/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1920/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1920/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1920/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1920/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1920/src/App.js\":\"0bff8e3608fd95cc\",\"/knowledge-medium/pr-preview/pr-1920/src/appUpdate.js\":\"50078179138e4677\",\"/knowledge-medium/pr-preview/pr-1920/src/appVersion.js\":\"70516503bbdf26d2\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/initialLayout.js\":\"da21abd9bd7f71bb\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/openWorkspaceData.js\":\"e043b5f8568086e1\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/resolveWorkspace.js\":\"5bb80b1bbc598800\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/workspaceBootstrap.js\":\"af55d0eed346e662\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockComponent.js\":\"e721497ef7d5826e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockCrumbs.js\":\"fb41d6593ab93621\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockEditor.js\":\"8e3f5cdc043d2a81\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockLoadingPlaceholder.js\":\"984cf5773c251bb0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockProperties.js\":\"d63b7935d5a325a3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockSearchPicker.js\":\"479af39e9e3fac7b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ConfirmBulkDeleteDialog.js\":\"7df65cb6cb6bdf0d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/DividerHandle.js\":\"1650a4c0f3d10815\",\"/knowledge-medium/pr-preview/pr-1920/src/components/DraftEditor.js\":\"077727c31d128d3f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/GutterPill.js\":\"fd72ddd30450be63\",\"/knowledge-medium/pr-preview/pr-1920/src/components/Header.js\":\"3866ad2d87328170\",\"/knowledge-medium/pr-preview/pr-1920/src/components/LazyBlockComponent.js\":\"24742a4534991476\",\"/knowledge-medium/pr-preview/pr-1920/src/components/Login.js\":\"e14c45b051d667d8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ZoomableSurface.js\":\"8622cf943f60cf9f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/editModeKeepalive.js\":\"91a279cd7a61d7f4\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c2d8846199ba9702\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"40017e744bf054b9\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/RefPropertyEditor.js\":\"0bb8df4d9dd7cce9\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/RefTargetTypePicker.js\":\"cf027f9031887d1e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/SelectPropertyEditor.js\":\"87d96fd67181314e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/TypesPropertyEditor.js\":\"4265d0e178eaa58a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/defaults.js\":\"81df89040a96b63b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/kernelValuePresets.js\":\"81ae131f24b83071\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/selectablePresets.js\":\"0cd768e014bf3a86\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/typesPropertyUi.js\":\"792e432a56a25a1d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/AddPropertyForm.js\":\"3af7efe8eb0c227e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/PropertyPicker.js\":\"02401de8a1cca635\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/PropertyRow.js\":\"fb05802a9c29dcad\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/Rows.js\":\"2eed40f18e5e7d03\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/actions.js\":\"9cc0d95af90309bb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/declarationOnly.js\":\"939d5c78403be973\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/layout.js\":\"6df03c7451621e60\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/model.js\":\"78db041f2ade39d0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/shapeUi.js\":\"15e7cb4e05cb87a3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/shapes.js\":\"c4cc2ae1b5e89b53\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/usePropertyEditingActivation.js\":\"407747959570c136\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/visibility.js\":\"55ed4eb16abcc62e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanelSections.js\":\"b49140b7e1cad1a2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockEmbed.js\":\"56351615830670c6\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockLink.js\":\"870e6f4888a5bd4a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockRef.js\":\"0e9093f0f841e8d8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/CompactReferenceLink.js\":\"79a718d495417f3e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/ReferenceLink.js\":\"4edaf6588677a8d6\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/cycleGuard.js\":\"ff5aab4731b27708\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/cycleGuardContext.js\":\"088e26d5620ea739\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/linkInteraction.js\":\"02875f6973d5501c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/referenceLayout.js\":\"7262bd4b72bc4e70\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/useBlockRefAncestors.js\":\"7160cdac18e682e6\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockGutter.js\":\"1523987726170223\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockInfoDialog.js\":\"18352623cbabb908\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockReadText.js\":\"193118d2e0de51e1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockTypeBlockRenderer.js\":\"d93f035ae5f09f16\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BulletHoverCard.js\":\"7444e34089f5a8b0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/CodeMirrorContentRenderer.js\":\"51702f34a30204c5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"938dd1c4e9efcb40\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/ColumnResizeHandles.js\":\"48ef7f6049522cad\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1b2e55cbcef9c7e5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/DefaultBlockRenderer.js\":\"0023300f3098c942\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/LayoutRenderer.js\":\"77a0e0318a391d04\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/MarkdownContentRenderer.js\":\"ab3531abcc2dcbfe\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/MissingDataRenderer.js\":\"09ce48143dc555c4\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/PanelRenderer.js\":\"4163122a3a5b1c1c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ce47ef7a118a9399\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/TopLevelRenderer.js\":\"eaf864b466745796\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/blockGutterMode.js\":\"9bf69051659733d2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/blockTitleText.js\":\"a795af9efc164c9a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/fieldCreationKeydown.js\":\"a3dd9a198dbb6411\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/layoutRootContext.js\":\"a73fd8e8d504a932\",\"/knowledge-medium/pr-preview/pr-1920/src/components/typeChip/TypeChip.js\":\"1f97e569843e4581\",\"/knowledge-medium/pr-preview/pr-1920/src/components/typeChip/chipStyle.js\":\"f460b3871287c712\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/anchored-floating.js\":\"e6a862d3348b4973\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/button.js\":\"3e3ff628c6492e34\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/card.js\":\"046a49e83fc949e2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/checkbox.js\":\"f279b787cbd65dd2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/collapsible.js\":\"0056a70bf2d9f2c0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/command.js\":\"fad92329953db389\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/context-menu.js\":\"c693be3cef04318e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/dialog.js\":\"d67a4e8fd55ecf65\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/dropdown-menu.js\":\"1cf147b5128ce07e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/floating-listbox.js\":\"423f4ec9adf8966a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/index.js\":\"3cfc860f662cc71c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/input.js\":\"3325c7eecd0b1856\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/kbd.js\":\"245712f8221fcb6f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/label.js\":\"758d965ecdc0b1ed\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/textarea.js\":\"4e607c48d7ec7cc7\",\"/knowledge-medium/pr-preview/pr-1920/src/components/useEditModeYieldKeepalive.js\":\"57cdba5cd864a061\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/BootFallback.js\":\"036bcf53b9f9de0c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/FocusedRowLazyMount.js\":\"748f184626d13836\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/LazyViewportMount.js\":\"02487c609d0ce2f1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/LocalDbCorruptionFallback.js\":\"1a6d69e69681725f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/error.js\":\"815f12d58d6cdc1b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/lazyMountRegistry.js\":\"facc5492425979bb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/suspense.js\":\"f12c57010ad0af5d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/CreateWorkspaceDialog.js\":\"ff7e97b1a8f1715e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/PendingInvitations.js\":\"7091122292bd1de7\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/SyncProgress.js\":\"79e7354f09975a5b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/UnlockProgress.js\":\"37a65baf7422a62d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceKeyGate.js\":\"dcda1f94097bac32\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSettingsDialog.js\":\"d1a03252a286901d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSwitcher.js\":\"df56313a7aa3b38d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSyncGate.js\":\"efd8ad02d791cde1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/ConversionFlow.js\":\"8e10db193601b482\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/ConversionFlowHost.js\":\"8fdf1528930848de\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/EncryptionSection.js\":\"d8eb1a7b3b007792\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/attachmentPrompts.js\":\"39be7088f9d2376f\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/bundleFolderPrompts.js\":\"390ee590f75b2e1b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/conversionFlowDeps.js\":\"663430c2dd12d0cb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/conversionFlowStore.js\":\"db014459e0c7b102\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/flowUi.js\":\"2f7d885ac482c241\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/useConversionRun.js\":\"c97ef694057d7e04\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/keyUi.js\":\"c25afccb18a90788\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/useCloseOnKeyLoss.js\":\"a36393220b8dcca0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/useCloseOnServerE2ee.js\":\"3f47fc408d6c028e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/workspaceUnlocked.js\":\"3af782bc53ed5c85\",\"/knowledge-medium/pr-preview/pr-1920/src/context/backgroundSubtree.js\":\"ba5023e16a921d4f\",\"/knowledge-medium/pr-preview/pr-1920/src/context/block.js\":\"84447aa3450df56e\",\"/knowledge-medium/pr-preview/pr-1920/src/context/layoutWsContext.js\":\"968fd4b5e661e581\",\"/knowledge-medium/pr-preview/pr-1920/src/context/propertyDisplay.js\":\"b62041ad07df7b03\",\"/knowledge-medium/pr-preview/pr-1920/src/context/repo.js\":\"f85c8bb7eed2d6c0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/aliasClaim.js\":\"8c12531c2c661f1c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/aliasSeatNamespace.js\":\"64cd6bd9fe641490\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/blockData.js\":\"6973039e67f40fd8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/blockType.js\":\"c30182568a7e3174\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/changeScope.js\":\"f04a54ccc873e6d3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/codecs.js\":\"0953d4721fa84481\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/derivedData.js\":\"8f7946e182383ec5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/errors.js\":\"7649e8e1ea2ec5a1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/events.js\":\"330e5c56142aaa61\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/handle.js\":\"27014aaf18d00363\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/index.js\":\"1ba229f94fd20477\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/mutator.js\":\"34bf7b722b6ab34d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/processor.js\":\"8833a1d297aa33a5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/propertySchema.js\":\"91f0ec6f48963659\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/query.js\":\"f9cd3a3215c4a54f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/sameTxProcessor.js\":\"513a02887b2bf4f6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/schema.js\":\"27014aaf18d00363\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/tx.js\":\"27014aaf18d00363\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/typedBlockQuery.js\":\"bde68bdd3189c4d6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/user.js\":\"363e63958ade5cc4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/valuePresetCore.js\":\"7678e4fbbd138b1d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/valuePresets.js\":\"b9669867fc5a1e94\",\"/knowledge-medium/pr-preview/pr-1920/src/data/attachmentCleanerIOVerb.js\":\"90c6d30c9b3eecc8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/block.js\":\"843215e08cd4a9d1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockCache.js\":\"f72315db412e9c3d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockId.js\":\"d9ce85d0f28e2c08\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockLiveness.js\":\"292550978830d8d5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockMerge.js\":\"a9696830c42f8326\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockSchema.js\":\"f1f81b5985ba6602\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockTypeLookup.js\":\"1900f68f725314bc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockTypes.js\":\"637e4eb0338afe42\",\"/knowledge-medium/pr-preview/pr-1920/src/data/childrenView.js\":\"680a7744cd9dd668\",\"/knowledge-medium/pr-preview/pr-1920/src/data/clientContext.js\":\"ca6c86c875d7e087\",\"/knowledge-medium/pr-preview/pr-1920/src/data/dbFileSiblings.js\":\"ed0ac91851d9ae09\",\"/knowledge-medium/pr-preview/pr-1920/src/data/definitionSeeds.js\":\"9ea9735d651b8037\",\"/knowledge-medium/pr-preview/pr-1920/src/data/derivedIds.js\":\"dacd785d0abb8119\",\"/knowledge-medium/pr-preview/pr-1920/src/data/drawnSubtree.js\":\"6bd6686eaf7d43a1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/facetBridge.js\":\"5c1449de688085b5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/facets.js\":\"dd6e4f622282724d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/globalState.js\":\"1e3c6ab4adcd5e4a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/aliasClaimRederiveProcessor.js\":\"01746547ab63a3ab\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/ancestorBatch.js\":\"1265bce0b8a883d2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/blockTypeTypeifyProcessor.js\":\"969c1e3157df91e5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/clientSchema.js\":\"078bee5cbf5dc9f9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/commitPipeline.js\":\"3e75e5334efcdb45\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/devAssertions.js\":\"a7f3e5fa445a00e1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/firstSync.js\":\"0cefed3801b3ab7b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/freshInitialLoad.js\":\"20eced8e9be4d5fe\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/graphBackfillClaim.js\":\"c9b52fd312b43810\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/handleStore.js\":\"0df101204eef6f28\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/idleMarkerJobs.js\":\"9da7214a8745fc3f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/initialDownload.js\":\"cb3b3e7d9e474d8c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/initializeClientDatabase.js\":\"2296b04c49fe45c3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/jsonCanonical.js\":\"f9c57bbaceaea6c2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelInvalidation.js\":\"e95e2110e09ded17\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelProcessors.js\":\"4c1d981a18b842ae\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelQueries.js\":\"16d7c9d19b07097e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/mergeTypeMembershipProcessor.js\":\"039812f13cfa3be3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/normalizeReferencesProcessor.js\":\"5ea95ced2b0578ac\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/poolInstrumentation.js\":\"887d3191929e4d60\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/processorRunner.js\":\"6b97845f5546be21\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyCellBackfill.js\":\"5486471cfd7ae4f0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyChildMint.js\":\"2781be4c7b36ee4d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyChildrenProcessor.js\":\"b248153eecf9f187\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e8eb10c9dc042f2f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyDefinitionSynthesis.js\":\"c0d544fd40e3e391\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyKeyScan.js\":\"bfa13033bcf35449\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertySchemaResolution.js\":\"8938c11ee0567ad2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyValueEdits.js\":\"c5b7ee8c9c057858\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/raiseProtocol.js\":\"fa96f88eba87c6d2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/readBatch.js\":\"dad5fdc13506ad24\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/refProjection.js\":\"2100d32ff2d09931\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/referenceTargetLookups.js\":\"c0255f20ebc4fa1f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/referenceTargetProcessor.js\":\"94c58fc700633b12\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/replayMerge.js\":\"9f3f57051100bde7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/sqlBinds.js\":\"58dfdc83db02fce8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"9b2c75f982cfd575\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/arrivalProcessors.js\":\"fb263a54ead106ad\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/invalidate.js\":\"a24c4df7254b67b9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/materialize.js\":\"3167a162749e989e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/observer.js\":\"d133d470b9f5c383\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/reconcile.js\":\"a58ea072a44ac2d5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/timingMetrics.js\":\"cca40417c9c5881a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/treeQueries.js\":\"392c979bcdddf43e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/txEngine.js\":\"cba69512b64ed555\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/txSnapshots.js\":\"b4a51604ad628379\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/typedBlockQuery.js\":\"2e1dce46b4f19b5a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/undoManager.js\":\"866c46e09b5a2197\",\"/knowledge-medium/pr-preview/pr-1920/src/data/invalidation.js\":\"e2c1ea4e4a477d97\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelDataExtension.js\":\"ee5e1f3e52dcbd50\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelPage.js\":\"60c0489b8f87847b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelValuePresetCores.js\":\"21e3afef486fbc10\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbCorruptionSignal.js\":\"8a6b538a1e11f8c5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbStorage.js\":\"076cd16c4aacbd1e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbVfs.js\":\"e08accab75ad9e48\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localSchema.js\":\"7186e89d8f965852\",\"/knowledge-medium/pr-preview/pr-1920/src/data/maintenance.js\":\"0185faa3795bd778\",\"/knowledge-medium/pr-preview/pr-1920/src/data/mergeProperties.js\":\"24310a7c13836663\",\"/knowledge-medium/pr-preview/pr-1920/src/data/metricsConsoleHook.js\":\"7deed431ddc5e2a1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/migrationsPage.js\":\"6358ba3b59dc16e1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/mutators.js\":\"005e756d93a06235\",\"/knowledge-medium/pr-preview/pr-1920/src/data/orderKey.js\":\"87e48ad60f275dae\",\"/knowledge-medium/pr-preview/pr-1920/src/data/orderKeyPlacement.js\":\"4fc7d6c400ec6ef4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/outlineSurface.js\":\"beed63ccdc1d7bd5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pendingEditorContent.js\":\"ea86857d8e3397fe\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pendingUploadsSql.js\":\"e856d36e8b8e3891\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pluginStateExtensions.js\":\"506d85177bfef295\",\"/knowledge-medium/pr-preview/pr-1920/src/data/powerSyncLogger.js\":\"f9a44abdaf37be03\",\"/knowledge-medium/pr-preview/pr-1920/src/data/projectorRuntime.js\":\"3ca190375ccd54c5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/properties.js\":\"2918addffb05d26b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertiesPage.js\":\"67b1fdebbc1fb61a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyChildren.js\":\"34786c6ac7f194da\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionFanout.js\":\"5f1360cd57401c72\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionMetadata.js\":\"3509cbd72fc7e51f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionRegistry.js\":\"fce81a04b75ce5e4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDisplayMode.js\":\"0dddecee11789f01\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyRowCreation.js\":\"d0821d9045966c1d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertySchemaCreation.js\":\"65230b4a62be0a4c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertySeeds.js\":\"cbe8c4942b836f43\",\"/knowledge-medium/pr-preview/pr-1920/src/data/recentsPage.js\":\"ceab14404dad6713\",\"/knowledge-medium/pr-preview/pr-1920/src/data/refTargetComparableProperty.js\":\"a648072aea3f3721\",\"/knowledge-medium/pr-preview/pr-1920/src/data/referenceBlock.js\":\"2f1e7f64323e51fd\",\"/knowledge-medium/pr-preview/pr-1920/src/data/rejectedUploads.js\":\"21391b53b2ce6fba\",\"/knowledge-medium/pr-preview/pr-1920/src/data/releasePowerSyncConnection.js\":\"1eb2039227578ef0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/repo.js\":\"328e1b9a9199ddba\",\"/knowledge-medium/pr-preview/pr-1920/src/data/repoProvider.js\":\"aeb41f606f2ee171\",\"/knowledge-medium/pr-preview/pr-1920/src/data/rowProperty.js\":\"80eb95bdc6b7439f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/searchFilter.js\":\"c6267f092a397b9c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/seedIdentityLedger.js\":\"f56c62c0256f5565\",\"/knowledge-medium/pr-preview/pr-1920/src/data/stateBlocks.js\":\"776fdef1825ca12c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/structuralEditPolicy.js\":\"ad1e67c22416b9bb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/structuralInsert.js\":\"f497e3d534278d6d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/subtreeDelete.js\":\"4c7837e7803cd6d8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncStreamLock.js\":\"95be5be180e9b386\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncedTableSqlRecognizer.js\":\"baf4b089e43795fe\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncedTableWriteGuard.js\":\"4dff7b1ff7391d17\",\"/knowledge-medium/pr-preview/pr-1920/src/data/targets.js\":\"3d22cfdad7d6b327\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeColors.js\":\"1a67476ffaf5eaa2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeDefinitionMetadata.js\":\"4068537000f8d341\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeDefinitionRegistry.js\":\"332e6ddeebbc65cb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeExtraction.js\":\"d90648a1b4aee080\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeInitialValues.js\":\"b057ff33d3056486\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typePropertyGroups.js\":\"76b1570ac0a799b6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeSeeds.js\":\"afb812689da08450\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeTagger.js\":\"a776569873b9df24\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typedRecords.js\":\"91e9f5d0484c860b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typesPage.js\":\"62526143da89a9cb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userPrefs.js\":\"709c349a9da972b7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userSchemasService.js\":\"d5fa13003fe6cd3a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userTypesService.js\":\"598f96afed03ec86\",\"/knowledge-medium/pr-preview/pr-1920/src/data/valuePresetRegistry.js\":\"8988d8e0bac9f73b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/visibleChildren.js\":\"4a78f5d29a5635f4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceConversion.js\":\"dab1bd7796ff8d4a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceFirstSync.js\":\"1aca3666444c401a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceIdNamespace.js\":\"80fb7346fd8c743e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceSchema.js\":\"27d72e3824e9fa94\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaces.js\":\"403194d2045255bc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/writeAheadLog.js\":\"74bdeddc89e9a674\",\"/knowledge-medium/pr-preview/pr-1920/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/BlockPasteShellDecorator.js\":\"5ff0327afcd8ff3c\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/atTrigger.js\":\"309873b4bf0a3b55\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/autocomplete.js\":\"ef5a47017e31352e\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/codeMirrorExtensions.js\":\"1f167ac4591f97f0\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/contentFlush.js\":\"fc02f2f04f7c3d06\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/defaultInteractions.js\":\"53184dad5c83c085\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/editSettleSignal.js\":\"878d4d8e6f1b4eea\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/insertImage.js\":\"3026f746a3e19535\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/referenceCompletionRange.js\":\"a09872605ee5e2bd\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/referenceTargetTypes.js\":\"e047edf1cabc283e\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/syntaxContext.js\":\"f0ea275ff02ad025\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/triggerMatch.js\":\"0a8462011b1e5d0c\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/AppRuntimeProvider.js\":\"2732fba3dd600e22\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/BlockFocusShellDecorator.js\":\"e186693a8fd9671d\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/ExtensionRenderBoundary.js\":\"ea8eb5efeadaabbe\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/PanelContentRecovery.js\":\"23191cfffdcc822b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/apiCatalog.js\":\"590c3464d1175191\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/appRuntimeController.js\":\"8a4f0122da13b5ac\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/approveExtensionHere.js\":\"4937c14ec7055a18\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/armedCutAppMount.js\":\"fb596ef0a8cdb6d2\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/batchableKeyedStore.js\":\"409d5e2bb85e30e2\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/blockInteraction.js\":\"a055f62d23a4a3e2\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/blockSelectionAction.js\":\"2a393fbe6617d8bf\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/buildApprovalRecord.js\":\"7a9a5ae3b535e989\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/compileExtensionModule.js\":\"6ab50ba58eb4dd43\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/compiledModuleCache.js\":\"5169ddc7544a61e9\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/continuousGestures.js\":\"af8a7f7d55377dcd\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/core.js\":\"4a0f8ac173b9a901\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/defaultRenderers.js\":\"e6a7223603d5b9b0\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/definitionFanoutAppMount.js\":\"cf7f20bb29b119ad\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dialogAppMount.js\":\"8675b4cfbdcca531\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dynamicExtensionSeeds.js\":\"c0888a8903e8217c\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dynamicExtensions.js\":\"e066814940e0d9e3\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/exampleExtensions.js\":\"56dc485a7403cf93\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionApprovalStatus.js\":\"8cdfdc1a737d9d5a\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionImportPolicy.js\":\"2e152b1a002be9aa\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLoadErrorToast.js\":\"1798c8ce78f73cb8\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLoadErrors.js\":\"b337dbad4c6b7dca\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLookup.js\":\"dc363606a334db4d\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionToggles.js\":\"dc8e0ffe22836b3b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionUtilitiesCss.js\":\"f5dc0bf1e317a263\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/kernelPageDeletionGuard.js\":\"18dca361ee290819\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/liveRuntime.js\":\"0d3c22e270503785\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/normalizeExtensionSource.js\":\"2932cef1d619f33a\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/openExtensionsSettings.js\":\"4aa45c373c0caedb\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/overridesCache.js\":\"99ec9b5ed6e7ea64\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/pluginIds.js\":\"83601df4516c3246\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/processorRejectionToast.js\":\"12bacbc066a0614c\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/runtimeActions.js\":\"e82beb64ceb9fb1d\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/runtimeContext.js\":\"c609d4a95dd0431b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/staticAppExtensions.js\":\"34512c1c623e64a4\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/staticDataExtensions.js\":\"6eace856c1f34e93\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/toastAppMount.js\":\"b021d4c1496ec107\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/transpileExtension.js\":\"1b9554896df6f212\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/useOverrides.js\":\"8d9a6903a6fd4ec0\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/useShortcutSurfaceActivations.js\":\"d8c1c3bb01ed574b\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/discoverToggleTree.js\":\"3678568b38fc9973\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/facet.js\":\"8acea94c8b42673e\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/resolveAppRuntime.js\":\"34eb4106a2b31dd1\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/runtimeEvents.js\":\"6bfc31927425417c\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/togglable.js\":\"62d41e50147dd61c\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/variantFacet.js\":\"6a461547a80c26b2\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/verbFacet.js\":\"a15063f62b8c0453\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/block.js\":\"d24b1ba0fdaf5e2a\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/focusedChild.js\":\"dda7874e61f325ff\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/propertySchemas.js\":\"bcd727917c366491\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/typeRegistry.js\":\"79d65349d320ea13\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useAncestorCrumbs.js\":\"cd262b8b5d563c2e\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useAutocompleteListbox.js\":\"d6551397e6ef6a28\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useDebouncedSearch.js\":\"eb8550dbf6189a49\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useDebouncedValue.js\":\"fb1664cf4ed01566\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useFacetValue.js\":\"241217d8a685a37c\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useIsFocalRender.js\":\"2815f35efae0270f\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useIsReadOnly.js\":\"35735e9d481f2f31\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useMaterializeBacklog.js\":\"ba4645959d43dbd1\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useMinuteClock.js\":\"bd6f429aff9b461c\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/usePanelLayoutProjection.js\":\"ecb78ac79b739c1e\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/usePendingInvitations.js\":\"dcbba17a8382ec49\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useRendererRegistry.js\":\"672ec98d5cd56fdd\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useRetainedFieldRows.js\":\"bfa4d0c5bf8d4875\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useWorkspaces.js\":\"b7a13960a24982a0\",\"/knowledge-medium/pr-preview/pr-1920/src/lib/utils.js\":\"67e6c76d3a4b499f\",\"/knowledge-medium/pr-preview/pr-1920/src/main.js\":\"5711203b10ce5d3b\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/MarkdownImage.js\":\"fa8bed0f33e372be\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/blockSeparators.js\":\"189ae8ae8f7be0c2\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/context.js\":\"cb55125dee3b91ba\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/defaultMarkdownExtension.js\":\"815612b97fa7e713\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/extensions.js\":\"57b5fe280713961d\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/renderMarkdownHtml.js\":\"0ee3e67f1175c1dc\",\"/knowledge-medium/pr-preview/pr-1920/src/minimal-editor.js\":\"7c1c7dad456a1f46\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/armedCut.js\":\"f003718ea19a635e\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/captureMediaVerb.js\":\"f9d8975f7212b3b7\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/clipboard.js\":\"6604c54491deb1b6\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/decision.js\":\"531ad06614b52cf0\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/operations.js\":\"c55cd2878815190e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/account-header/AccountHeaderItem.js\":\"cc5d4e5bc8f9b17c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/account-header/index.js\":\"71498a97174239cb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"630a320e3b30bab8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/askAgent.js\":\"bcf04881feda90f7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/askedStore.js\":\"26e204df22b52fbd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"fdedc79cc22a67b9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/chipState.js\":\"8b428423b9ca1a2b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/dataExtension.js\":\"3cb2707f621bf318\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/index.js\":\"b65ea3c06a571a29\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"384881d0623a5d9e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/schema.js\":\"8bcb437f10393f4e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a27402be6ddcb105\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/BridgePairingDialog.js\":\"89680dff87d0e621\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/addMedia.js\":\"6b54de2b21b1b784\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/backlinks.js\":\"41dc9e6460ec9371\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/block.js\":\"439912f0f99dda02\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/context.js\":\"d05a5c68320ee9a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/displayIds.js\":\"ea692e2694528474\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/index.js\":\"a6b4ebdd2437fa38\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/outline.js\":\"b3dadeac422890ce\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/properties.js\":\"ab2633ab05bd43ce\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/refs.js\":\"f5a848c5f4912498\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"e7f43722503b6699\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/search.js\":\"1c6c245315b72062\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/shared.js\":\"eff10e34d6f0e594\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"c180a6a3ffa19afc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/text.js\":\"81d108cb06145e28\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentWrites.js\":\"c928db934400c1cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/authoringCatalog.js\":\"38a5968f1db54059\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/blockRefTargets.js\":\"004721f1f8a8e99e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/bridge.js\":\"f285262b502a4537\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/bridgeLoop.js\":\"43f7152de6e59704\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/changeHistory.js\":\"690fae415dced743\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/commands.js\":\"b3752a9d8c18105b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/commentsCommands.js\":\"c9cb169577d4560a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dataExtension.js\":\"1294c7460bb68eaf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dataModelGuide.js\":\"b9fa945de88a74c6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dayPropertyInputs.js\":\"1cb8add8c4d87ca4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/describeRuntime.js\":\"e35b3ee4b58d0dfb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/extensionLint.js\":\"ee5b50104f5eccd7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/grainAudit.js\":\"4a337649026b153d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/healthCommand.js\":\"70e4d9ab427b4c51\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/index.js\":\"5c0c2786962a1e68\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/presetIdentity.js\":\"e3b025f6898627d8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"35fdbac8a65628aa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/readMedia.js\":\"c97ce11afe74a3d2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/schema.js\":\"cf6843b8063a718e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/serialization.js\":\"cc335f0c5549db98\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/targets.js\":\"48d359bfc141fb1b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/tokens.js\":\"6a944540d0878ad3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/watchEvents.js\":\"19008b553fdebef1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/workspaceGuard.js\":\"acfb57f8cdad84b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/writeCommands.js\":\"78b06b93649074a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/AliasCollisionToast.js\":\"9565f31ecfe073fd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/DuplicateNameBanner.js\":\"195942186d25e775\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/collisionMerge.js\":\"4e411c77635eb7e9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/dataExtension.js\":\"f6aa7cbc2c59c13d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/index.js\":\"6cba64ce0a8fac80\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/mergeCollisionAction.js\":\"b061990c7797f369\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/pageStyling.js\":\"2d345dee28857d05\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/rejectionToast.js\":\"caabd076c08bbbb3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/syncProcessor.js\":\"c7033bcfc27ea9bc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/actions.js\":\"769885adf604c8d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/addComment.js\":\"ee96c98f40b597d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/anchor.js\":\"095ef5eda55fe927\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/anchorState.js\":\"9004c40d6cdf9501\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/commentLinks.js\":\"949aebf586c71b32\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/confirmThreadDeletion.js\":\"274a42ad659bcae7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/container.js\":\"f0e12d18a0d5392a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/dataExtension.js\":\"c1153602ac551323\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/deleteComment.js\":\"3cb1371b4f1363d4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/highlights.js\":\"29dcd7e6451485c9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/index.js\":\"6d21f7815f54de74\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/linkedCommentsPill.js\":\"aeddc8a76943ae3f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/margin.js\":\"47c8bd6e9cfa9e68\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/marginAnchorLinks.js\":\"927900bf3be8d561\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/marginSchema.js\":\"299aeb30637a2a03\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/newComment.js\":\"dabe3ac49c841a59\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/ownThreadPicker.js\":\"5a69be9a9de76b08\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/placement.js\":\"ceec5a51bbc0f9d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/queries.js\":\"f08bca3e97048ec6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotePosition.js\":\"985bc99bba667eb7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotedIn.js\":\"c9c8316869cb57aa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotedRange.js\":\"050b5713c62d86cc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/rangeRefs.js\":\"eca874e022bc704d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readHighlights.js\":\"e6a5e63064f4d1a3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readSelection.js\":\"5ddfb7ede5916b13\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readSelectionUi.js\":\"3b125e5d28ad9e57\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/reanchor.js\":\"14e72736a5e9eced\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/schema.js\":\"f91d311319b9a2a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/scope.js\":\"edd259864dc7e382\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/scopeThreads.js\":\"980b268c3a8ccfbc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/splitRetarget.js\":\"de511ed7b822190b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/suggestionCard.js\":\"ea1ae18c7d390893\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/suggestions.js\":\"f5de4e10db7da594\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/summaries.js\":\"d401c972e53943e0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/summaryBatch.js\":\"84a056f5d97f928a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/surface.js\":\"61f20a5d37e7bb9c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/threadNavigation.js\":\"7bdfb3c2f41577ae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/threads.js\":\"ab8804aa8f5d4d64\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/ui.js\":\"6bd00d289cf8ce72\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/uiStore.js\":\"24361eccfc846166\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-intents/appIntents.js\":\"c6e4698ab2e73d4e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-intents/index.js\":\"250cb312d276a893\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-update-prompt/index.js\":\"621cff8be35afc84\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-update-prompt/status.js\":\"373179d53c36023e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"bf3fc5439bf1fa0f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaBlockRenderer.js\":\"36c5197aebe611a3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7c543fd1aaa598da\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaUploadReconciler.js\":\"b910d4a110a2384b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetDownLane.js\":\"75e4bed6a9c1e633\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetResolver.js\":\"8671d19ce31e9c3e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetUpload.js\":\"057a54939c21b07d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/attachmentCleanerIO.js\":\"c0fa35f5b3735c09\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/supabaseAuditIO.js\":\"45f65ab2ccd7b32b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/blobStore.js\":\"0b98950ad91a6465\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/browserMedia.js\":\"485fe278f7ccef03\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/byteStore.js\":\"d251850ff56a4db2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/cleanerIO.js\":\"8148e001a57f64a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/cleanupAttachments.js\":\"d0fc8179dc0c6770\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/dataExtension.js\":\"69ea5dac0d0f7d6e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/downLane.js\":\"bc85d2086c4f7084\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/index.js\":\"24d307c9431b8057\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/insertImageContribution.js\":\"6cc34e66ac43496a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/laneArming.js\":\"7165dc90a657e99d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/laneLock.js\":\"b051c35dc59e7ed2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaBlock.js\":\"ab453972a5abee5b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaCapture.js\":\"93e76c063c168892\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaLanes.js\":\"b33a1e80d70f9b46\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaViewers.js\":\"057cae4f8c2bd101\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaViewersFacet.js\":\"c154dc689719b056\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/pasteCapture.js\":\"95af2c1a04b098bc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/resolver.js\":\"85f3248a1eae163f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/retryUploadsAction.js\":\"0f27de9089724ae2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/storagePaths.js\":\"aef99ba70eea599f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadDrain.js\":\"2447350536ab249b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadLaneStatus.js\":\"b427e4a059b81e13\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadReconcile.js\":\"163d3d88da34a96e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadRecovery.js\":\"03c079ad3b6e98df\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadStore.js\":\"1ccd073e18bac695\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/useAssetObjectUrl.js\":\"eaa7645b3721b8d3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0e1b0f1e440d6389\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/BacklinksViewSection.js\":\"26f12047e29ff6af\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/facet.js\":\"d89f42adc6399b4e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/index.js\":\"96124143703c1963\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/prop.js\":\"a30175e9608ff401\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BacklinkFilters.js\":\"6240acc547b0dbe2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"989bd86056fce930\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BlockEntry.js\":\"6c0b8ac542fb34a0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/LinkedReferences.js\":\"419ab933569c801d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"beaa85d4cd0efef0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/dailyNoteDefaults.js\":\"dd993250adc8af1a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/dataExtension.js\":\"d3fe2ec73ab4bc23\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/edgeExclusions.js\":\"d154d19146f341f2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/filterProperty.js\":\"6750e5d064a62068\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/index.js\":\"c7f20690c8d19ca7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"f72b8623a5eaf117\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/applies.js\":\"2270f14f1ead4cad\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/countQuery.js\":\"4921d745f94c4b80\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/expansionStore.js\":\"612795ffa5f7e107\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/index.js\":\"44ae4f3f9c18e2d2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"64d6ab533c8db451\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/presentationInvalidation.js\":\"0801f8f7e0f684f4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/propertyEditorOverride.js\":\"0bcae53f6af6d23b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/propertyFilter.js\":\"999faba1b82ae39c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/query.js\":\"d03c3a4f30bc57bb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/resolveFilter.js\":\"92292001aa96d031\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/sourceBatch.js\":\"6c0bbabf33846b29\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/sources.js\":\"01894d9b989e1dc0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/useBacklinks.js\":\"5a374aacf45f11db\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"fdf7ca6d2c71da93\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/BirthdayCelebration.js\":\"cde9fa3dadc9b886\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/BirthdayOverlay.js\":\"5239512bf58cb7ab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/gate.js\":\"c97565d14bdb690a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/index.js\":\"52ce366740d2ac3d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/wolfTheme.js\":\"b9cc44310c105419\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/BlockDragLayer.js\":\"35fd3192ceba6460\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/dragController.js\":\"7323d08aed913567\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/dropTarget.js\":\"3d35bffad2482211\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/index.js\":\"4645b892438ed6e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/projection.js\":\"7bc14a3ccf3d3ab3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-info/BlockMetaCard.js\":\"e7cf038b1523e3ee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-info/index.js\":\"43c192d4bd0b1f47\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/AddTagDialog.js\":\"3ed35f1dab29368b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"6857cda8feb6c271\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/TagNameIssueHint.js\":\"56f7be6c5fcd3a6b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/addTagAction.js\":\"192ebcaeada4e23b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/appendTag.js\":\"df40ed961ac98903\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/config.js\":\"699d568234bd2bd0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/dataExtension.js\":\"a140c72c745974f0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/index.js\":\"39f23c62ef08b4b2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/propertyEditorOverride.js\":\"20db70c75270b8bc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/BreadcrumbList.js\":\"098613deb07b0671\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"a0ce605c4cf621a1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/Breadcrumbs.js\":\"743e31e27c4bcf2c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"34613f51dc429fdb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4cb32dbf32819545\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/index.js\":\"958aaafff4bf4c2e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"a10926c9850f3e21\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/CharacterCountItem.js\":\"b85fcf7fb097f537\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/ProfilePropertyEditor.js\":\"da1d68c7c81a138a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/actions.js\":\"3ac9488e36791a62\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/blockType.js\":\"c743a13e2c3c41e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/charCount.js\":\"8e1a811fbcad51d6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/dataExtension.js\":\"b370aca4ff9a7c20\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/index.js\":\"dbb6842e25c8cf27\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/profiles.js\":\"f1648f0a663270fe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/properties.js\":\"5711652fff0d4681\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/subtree.js\":\"71de8b53fc9a3055\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/textCounts.js\":\"eb20c043f6242d1a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/colemak-keybindings/index.js\":\"91ee74d0af6771e2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/CommandPalette.js\":\"036aed37ddb41799\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/HeaderItem.js\":\"9133e2be93edee06\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/context.js\":\"47ec37bdf0e5156c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/index.js\":\"188215a443f23875\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/selection.js\":\"b31ea99c869a1091\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/toggleStore.js\":\"d5e2aa886129b9a9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/useCommandPaletteActions.js\":\"0b5845e50a7af3c5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/ContributorBadges.js\":\"dab24a7d399d3943\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/ProfilePicture.js\":\"8099fa18679579ee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/author.js\":\"96db3bd68d5210bd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/codeMirrorExtensions.js\":\"67dda2286c0fec84\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/dataExtension.js\":\"c75cb40c9dea3b01\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/index.js\":\"8b1d64937f0fd4e6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/mentionAutocomplete.js\":\"21c2246c9377d7c3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/processor.js\":\"948e7b1ca23373a9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/profiles.js\":\"371d991d7b56f8e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/queries.js\":\"1e28ccda2fea59d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/schema.js\":\"0ff684a66f3a7e43\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/useCommentAuthor.js\":\"d41ae30f9f57a7eb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"268523164ffa9ef6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/followOrigin.js\":\"209af57707cee0ef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/index.js\":\"9a07381022f5f307\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"a33fe2624f30235e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"1211869d02767fbf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/CalendarGrid.js\":\"873a6f80f0e88057\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DailyNotePicker.js\":\"164c4216dff9a6fb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"bda5e58c43bc1571\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateNavDecorator.js\":\"ed7c47ac29f1ecbe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateScrubOverlay.js\":\"9e549acb3abc2ba9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DayPropertyControl.js\":\"fc6563f5caa53787\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DayValueReferenceControl.js\":\"024ce207f0d6c1e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/HeaderItem.js\":\"ae1b594ee341717f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/ReschedulePicker.js\":\"086aedd85f92e199\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/SpreadDatesDialog.js\":\"1908110919e98f0a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/actions.js\":\"98a362a383d8ce1c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/blockDateAdapter.js\":\"f4f3cfb9ec94bcec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/calendar.js\":\"4daf16f6b2fd858e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dailyNotes.js\":\"e6f3468ac04f09ca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dataExtension.js\":\"8c55eeaaac6b009b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubActions.js\":\"d8884dfd0d41716d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubGesture.js\":\"8b7a9dae4ce7c7fe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubGestureActions.js\":\"90c0d6e5bffac63d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubRecognizer.js\":\"6951edc3fdc2146e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dayProperty.js\":\"a1adf5b5ad31ac0f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"759fe2f73adea925\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/deletionGuard.js\":\"ef7299f8315109d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dueQuery.js\":\"ee7f4ee0bab45335\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/index.js\":\"9565f7e8118daa4e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/landing.js\":\"f60f7c390f5a03b9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/localSchema.js\":\"3260efc70e585130\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/referenceDateAdapter.js\":\"89415f275f34767b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/rescheduleAction.js\":\"b735815fa9de5252\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/schema.js\":\"c7ef030d077a2df0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/spreadBlockDates.js\":\"c969cda6dfaf11d5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/spreadDatesAction.js\":\"1815363b8ddb4ad3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/today.js\":\"7a594b2dc0f061bf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"36380ce9761f44a2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"8c6bd50f91123bcd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/audit.js\":\"089c0f0318cb4373\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/auditAction.js\":\"4e5bdbd21314d597\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/auditRanges.js\":\"434d7a7ff53de09f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/diagnosticsSource.js\":\"efdbcc3d68aa0196\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/divergenceScan.js\":\"4916b079067efb20\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/index.js\":\"5532f2dd300236bf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/propertyChildrenChecks.js\":\"790e4dff9fe50d5c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/referencesMirror.js\":\"6c90cc7b0cb41842\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/rowJson.js\":\"36a5768acafdb224\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/schedule.js\":\"e1a7bfd04d491bad\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/store.js\":\"40beca3c08f26fc2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/action.js\":\"6b0a022e1aa2cc5e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/index.js\":\"22a955bef9f928f8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/plugin.js\":\"657dde266b5d7238\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"920af054da7c3059\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/actions.js\":\"19ab822e619fb788\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/changeMarker.js\":\"375b6a2b7c6720d5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/diagnostics.js\":\"743318b1f878d552\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/fileSystemAccess.js\":\"11289a2de36d0690\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/filenames.js\":\"4d0eb431206e3d43\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/index.js\":\"4e54863902ef88d3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/mirror.js\":\"0951ff0354e00de0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/runLock.js\":\"979744855d2c8dc1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/runtimeHealth.js\":\"64a1203165bb3d6a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/schedule.js\":\"02a650b77824bfa9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/store.js\":\"f66bfc61ae64d25a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/default-themes/index.js\":\"aaa8655851978aab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/default-themes/themes.js\":\"d5289bdeab670147\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/diagnostics/facet.js\":\"b0fca3bca28fff60\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/diagnostics/useDiagnostics.js\":\"255188819f19e0f7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/dismissals.js\":\"e5a0da8d17c0e650\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/index.js\":\"6af620133b132957\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/status.js\":\"cd27bcd89c2b416f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/store.js\":\"eac62536dbe49968\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"208f378b22451e4f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/ExtensionsSettings.js\":\"4a949aebf7402ce7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/actions.js\":\"0edd0af67ae29c0a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/config.js\":\"8d26e463023017ef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/dataExtension.js\":\"b240f724f3885c76\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/effect.js\":\"600550f0f4f982af\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/index.js\":\"253d1deddfa8eb27\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/propertyEditorOverride.js\":\"6245a97be57a4cb2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/useToggleTree.js\":\"b0f624119a24ea08\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/ExtractTypeDialog.js\":\"99cc7cd6a0d84467\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"fb5648c96ed49428\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/PropertyShapePicker.js\":\"ae1d91822a7e21c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/action.js\":\"f71a73ca6e150137\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/index.js\":\"00e679690deb4dfa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/FindReplaceDialog.js\":\"aadd0aa6336f66d8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/HeaderItem.js\":\"d766d3943c8653c7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/dataExtension.js\":\"c1ea4f0cf03d415d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/index.js\":\"f46d47e863ffb141\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/search.js\":\"be1a6c107d7febf2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/toggleStore.js\":\"9a879cde5d033b5d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/LocationPropertyEditor.js\":\"449ea2f88816e19b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/MapView.js\":\"040f51146cc950dc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/blockTypes.js\":\"a214075c50ced3ef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/codeMirrorExtensions.js\":\"64f0c376ad41ccb9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/createOrFindPlace.js\":\"3e98a6dedab1cf38\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/currentLocation.js\":\"7d82c4a038edf96d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/dataExtension.js\":\"b872ea6444067149\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/geoContentDecorator.js\":\"ec31fb770926b64a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/googlePlacesClient.js\":\"f68d83a59a87c857\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/index.js\":\"a0924d6ec9b4cea1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/locationsPage.js\":\"c6b46465b331ba20\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/mapViewport.js\":\"cb52f26230032173\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/pickCurrentLocation.js\":\"5c9a8356cc8dc3b9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/placeAutocomplete.js\":\"2a0480d90c834bff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/placeNameCollision.js\":\"2a4304b1e8374ac8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/properties.js\":\"62cd354f04d2ac6d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/propertyEditorOverrides.js\":\"d8209b2565b09d3c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/query.js\":\"922775abfcccef2b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/usePlaceSearch.js\":\"1b26077b27f1536e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"da9d40f83f9cb421\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"a32dda7ef80c810f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a6e6af39098f8b8f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/config.js\":\"1ec423700a735b69\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/dataExtension.js\":\"a2bbd01158afeab5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/facet.js\":\"1d5ee57ee8e954aa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/grouping.js\":\"6d8719e7b736ac1e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/index.js\":\"3d64aac7ad2617d5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"8a2aa5b67e174585\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/query.js\":\"df8cd976be02b719\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/resolveConfig.js\":\"3a76542c39657093\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"45704e87b72f1504\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b306265a4eacbe5a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/HtmlDocumentContent.js\":\"76c61041ea4bff7d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/HtmlFrame.js\":\"d22aed676a59a5bd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/actions.js\":\"47646ced0de9e8b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/blockType.js\":\"e7e623664fd54462\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/confirmRunScripts.js\":\"7d6f68255ee2ed12\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/dataExtension.js\":\"c05f15cc690b9021\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameAnnotations.js\":\"7172e23f1cee172e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameDocument.js\":\"ada9dc5adcdd8cf3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameTheme.js\":\"5a5dbe5c9a02c64b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/index.js\":\"2e6b3d578c847a81\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/scriptConsent.js\":\"eb4c7ac4edc34fdf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/sourceMap.js\":\"ebfec8a632dccbdf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/useDocumentScripts.js\":\"d811dc27b8ff62d3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/index.js\":\"757ade38e5d46778\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/record.js\":\"125ee84e366da41f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/recordStore.js\":\"703ae8135dbb7ea4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/responsiveness.js\":\"9a7614721eaa9797\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/schedule.js\":\"44227ef0d74e2c42\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/sessionContext.js\":\"5bc2e08548fd8031\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"ab64a207a58febc7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"3ba57d64d9c6479c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/actions.js\":\"a7fbac37d1c96a56\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/config.js\":\"42a970dc1e28534f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/dataExtension.js\":\"dbd3606d09d1fb1e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/effect.js\":\"d8051da1d260d695\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/index.js\":\"45e3374910d6386c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/keyCapture.js\":\"0eacf2e46c849de3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/overrideStore.js\":\"43effb40eb773457\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8a4876456bff4243\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/HeaderItem.js\":\"1515cd31dd918fdf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/LeftSidebar.js\":\"cc5c6cde35bcab4c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/actions.js\":\"f8de01fc1e633e6b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/facet.js\":\"a3f9629033c5b74f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/index.js\":\"f2f07cdc8fcc32d6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/shortcuts.js\":\"3e2d41c7567140d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/toggleStore.js\":\"082b68144acfc522\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/MergePicker.js\":\"5199add301432789\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/index.js\":\"c7306b82f49ba0c2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/mergeAction.js\":\"45c085872038cd09\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/strategy.js\":\"59659094f8cc7c2e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/Button.js\":\"bdbd025f74047f84\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"d815e42771c53364\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b54a691311ba18ba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/facet.js\":\"43594ec5801f05ab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/index.js\":\"14b30088466ca4d7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"1e0238c1108626b4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/actions.js\":\"8fcc8859669f9293\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"40f5f29599702e27\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b8b6e84de0b02a7d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/index.js\":\"5126d10d6a885c5e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b6c50d968999a615\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/blockSubtreeMembership.js\":\"29224f14e2f76f44\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/contextMenuItem.js\":\"6adabd587735dfc4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/index.js\":\"17e7eaed0a1061c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/moveAction.js\":\"9e83e8061a049932\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/moveBlocks.js\":\"38f4ef45bf482f58\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/selectionAfterMove.js\":\"e60dc8aebeae9bc5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/TutorialBanner.js\":\"c0ef8d1b6b776f6f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/action.js\":\"f29eb037847f7408\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/bannerDismissal.js\":\"07a00eb62538cb1a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/documents/cheatSheet.js\":\"d336ef747f9d5eb6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/index.js\":\"4d255394a8d3cf46\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/keys.js\":\"c15b38b871a3db73\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/landing.js\":\"c3cf926b5f729f36\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/outline.js\":\"face52503cdb0462\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/seed.js\":\"fce6f32ba9551815\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/PerfTrendDialog.js\":\"b469e891b1645807\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/analyze.js\":\"a053fb5e47338d4a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/diagnosticsSource.js\":\"93756282a2793498\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/index.js\":\"fa8c26184c6aa541\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/load.js\":\"a98576ea5b49ce2f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/monitorRun.js\":\"6ce135f144009db1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/schedule.js\":\"594c95a54f7073da\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/series.js\":\"42de59e98300c2d8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/store.js\":\"a9615da4c5a8e7b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/trendAction.js\":\"ead619454c0e07e5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/verdict.js\":\"466fa3f680d877a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/clickToEditAction.js\":\"840d80d7a68acb3d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/index.js\":\"dd581a681f75ffd6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/interactions.js\":\"58a99b6b2050ad01\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"2482cc53bd49fd9e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/MigrationGate.js\":\"4742ba6bee9b97e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/MigrationGateDialog.js\":\"b4b568c96ab5863c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/action.js\":\"01dd473f1e259dd3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/index.js\":\"e7fc1f13ea0f073a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/localRunMessage.js\":\"d195347a7af961bb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/plugin.js\":\"c45a3f81b83a0768\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/progressReport.js\":\"d39869d299757d6f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/sweepProgress.js\":\"db4afb0b5b78f9f5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/FieldRowRenderer.js\":\"cb048edd5ca447c3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/ValueRowRenderer.js\":\"5451b16ec2d4bfa6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/actions.js\":\"c957d6e222e2e131\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/autocomplete.js\":\"0b2f196e2bdd5d40\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/fieldRow.js\":\"34ba04d7366cda45\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/index.js\":\"1fe146bc362e15e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/referenceWarning.js\":\"dec37264c7d6a199\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/valueAutocomplete.js\":\"de74b4f5b028d4a1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/valueSchema.js\":\"eaf16fd0e27be001\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/HeaderItem.js\":\"a4a424b553de39ee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/QuickFind.js\":\"16c7f268d3024bb0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/index.js\":\"8f0981d82b609099\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/recents.js\":\"60a60cf50c0593e5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/resultItems.js\":\"3ffe1294411e62cd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/selection.js\":\"843264f73c08ca09\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/toggleStore.js\":\"0f51f72951a84b16\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/HeaderItem.js\":\"7efdcecb2953db07\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/RecentsPageBlockRenderer.js\":\"4773800f99fa6661\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/grouping.js\":\"a86988f44326745b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/index.js\":\"903c80563ce7c216\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/target.js\":\"63482fa58da80e54\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/codeMirrorExtensions.js\":\"32a71b9ca2b761a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/contentPrefill.js\":\"4e6cb3290ec0b59f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/dataExtension.js\":\"70b8d7bd5f13382b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/index.js\":\"b19d8e92a6cf44ac\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"e54d0b3f2fcecd41\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/invalidation.js\":\"2750c0b3f19ef7d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/localSchema.js\":\"8123ec88fed25fd5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/blockrefs/index.js\":\"dbeaf6538af042ab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"23e3677bbc123c0d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/index.js\":\"df47a59fe13db736\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/referenceNode.js\":\"defe47804a6a89e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b3c5e47e1ed2752f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"3b8635f49a23127b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/index.js\":\"505476ab5d453f2a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"a05bcbe00df7baf6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"e67a0f147900d9a1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/mergeRetargetProcessor.js\":\"87a28629d6e0a72a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/parseFence.js\":\"d6d048499e33319a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referenceParser.js\":\"690cc161b85cbe00\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referenceProjection.js\":\"ccc311fc834b4aac\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referencesProcessor.js\":\"139e55f65688a186\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/renameProcessor.js\":\"4aa7901aae79ce8e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/spanReplacement.js\":\"8225fda26b06a497\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/htmlToOutline.js\":\"8c59361231651f18\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/index.js\":\"e213d895c8a55d76\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/normalizeClipboardDom.js\":\"753786b4dc4445b1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/pasteDecision.js\":\"98645292f3d38a8f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/action.js\":\"4c827daae941d7b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/blockIds.js\":\"5f21d2d3df033aad\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/content.js\":\"84d69e0e4340389f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/effect.js\":\"0e4d925e9a978f15\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/ids.js\":\"32610a0a411c5909\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/import.js\":\"51097206b383884d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/index.js\":\"5db965a9a2e8317e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/plan.js\":\"a4e4945c95c1a9d8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/plugin.js\":\"4fe3954778ea28ae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/promotion.js\":\"63ebf9ffba372df3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/properties.js\":\"0433919c8fd43f19\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/references.js\":\"428ff057fed14985\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/report.js\":\"67c7c9a12714337f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/roamMemo.js\":\"8d5780c9c35cc38a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/runtime.js\":\"08cf915fb51d6609\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/schemaReconciliation.js\":\"ba4b875cd55f3dff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/srsMarkers.js\":\"3e2a7dfaa8074b6c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/todo.js\":\"0183b5ff4bbac865\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/typeCandidates.js\":\"da0386dd293ed78c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/types.js\":\"9989370d53b56333\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/search-health/index.js\":\"55006b1e8317f176\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/search-health/store.js\":\"56d4e8cd144f65c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/HeaderItem.js\":\"3f67d5e057ab94cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"6cdef65b163df312\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/index.js\":\"14ebeeba0ca42e52\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/model.js\":\"c086b5f1e1d214a9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/toggleStore.js\":\"2d914cec85688e2a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/useKeyInspector.js\":\"871835ffcdbc44b7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"06af2698c0814fc9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/ShellDecorator.js\":\"eff06a5dffa7cceb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/actions.js\":\"a1d7529c0b7b890c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e8676a860bef5824\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/index.js\":\"697864f3f413bc70\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/shell.js\":\"13b1533dbb894963\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/surface.js\":\"f46b945cf25c7865\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/walker.js\":\"6d2060feba0ceb41\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e084d8d631486e1f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/dataExtension.js\":\"18040eeb03272929\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/index.js\":\"5d0ef297524a8791\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/indicator.js\":\"b7ad5a47d1fc5b54\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/moveSrsState.js\":\"143c0aaf05281cdb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"43767083a6082770\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/scheduler.js\":\"211d0b1575a797ec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/schema.js\":\"4a05ae0fd8bba49d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"773f931d4fd73861\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/srsClipboard.js\":\"923db644e262695f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1bdc8f0c709e4cf2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/DailyNoteReviewHint.js\":\"3eaffb4fb06ffa1b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/DeckPicker.js\":\"6a205d40c92bd46b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewControls.js\":\"682516136a2514a3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewDeckRenderer.js\":\"1e38eadbd59f1ec6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewSession.js\":\"7f5325414d265bda\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/actions.js\":\"b281028f6006e061\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/archive.js\":\"55c60e8b83df9488\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/dataExtension.js\":\"cead44ab60d74b48\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/deck.js\":\"2e2ef09d760d3d6e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/dueQuery.js\":\"685cb1a2f8c67510\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/gradeDecision.js\":\"402de3a6232718b1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/index.js\":\"961927b69db76f51\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/keyHints.js\":\"afd69e687e3ed0d4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/reviewCardLayout.js\":\"0f1dbdb35a2eeb44\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/reviewProgress.js\":\"f47a76d63806c228\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/schema.js\":\"576021dd9da67e10\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/useDueCards.js\":\"d7b68baa36c137d8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/startup-metrics/index.js\":\"e9f2386320fd6340\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/startup-metrics/record.js\":\"67840acd9a21d86a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/index.js\":\"5de50b4f282e386f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/persistenceStatus.js\":\"30197c4e87f7ffde\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/requestAction.js\":\"825a3d640ff41456\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/TypeChipsDecorator.js\":\"19c7be5742f657a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/codeMirrorExtensions.js\":\"c724bca567e3d4bb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/index.js\":\"a3dc924eba2badbf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/typeAutocomplete.js\":\"f5186dcfafa1bf18\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"11eef5018b6b8652\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/actions.js\":\"134a29f0026addf0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/anchor.js\":\"8af92e3751467644\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/events.js\":\"93e7e86b6a59c7ee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/gestureActions.js\":\"0f303135597e2423\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/index.js\":\"081ff83aa52c2c59\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"74a328e5d9f7b601\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/collect.js\":\"5f6a4a5d44b45c18\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/index.js\":\"67b458dd5f881626\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/record.js\":\"decf8229b12a9a1a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/RejectionDialog.js\":\"3131d3f108a2d01e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/SystemStatusHeaderItem.js\":\"754fbbcec7ea96c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/index.js\":\"c5a4f821d11aff7a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/model.js\":\"87b21e2383c0d717\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/queueCounts.js\":\"e2405da7bed20dab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/rejectedHelpers.js\":\"f9832b50972450cb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/rematerializeAction.js\":\"4f1355b2928fdafb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/useHysteresis.js\":\"46b112f14ca0ae59\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/ColumnHeaders.js\":\"0579f1bdac3e8706\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/QueryUi.js\":\"5ca9e3d892007f27\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/TableLayout.js\":\"db021f586aeee1d8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/actions.js\":\"44ed337c388a06f6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/cellEdits.js\":\"5d5ccbbd93596d35\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/childrenViews.js\":\"efcdbe58a9dc65d3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/columns.js\":\"2cb960ee5268a68c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/controller.js\":\"1b3c088b7850a03e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/convert.js\":\"ea30a21eb725771a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/dataExtension.js\":\"f7e067aac51bd71e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/index.js\":\"d89de5163d67cd51\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/keys.js\":\"91c6f5b978be0c24\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/model.js\":\"7daae104e5999b8d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/QueryText.js\":\"61578aeda2cfc30b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/backfill.js\":\"19a08bbf8675b83e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/completion.js\":\"cc114bb55ecc9541\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/format.js\":\"590cf960919a9d30\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/parse.js\":\"5b61733dc36e69c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/queryValue.js\":\"1b06760c11689873\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/registrations.js\":\"cd49313771e1aa83\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/source.js\":\"2251b19c3efa6278\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/registry.js\":\"cf9c7debb0508fd8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/rowGutter.js\":\"da877f642836ab24\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/rowVerbs.js\":\"e2ddf134a34721a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/schema.js\":\"bcf41a4355638645\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/sort.js\":\"b61beb0efd4d6ce0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/effect.js\":\"af8a4402240a8b82\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/index.js\":\"85b036e51b09188d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/theme.js\":\"7af1d53bfaa78002\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/actions.js\":\"b46ec4e55f3a9c9c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/dataExtension.js\":\"f7febfa7f81641e8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/index.js\":\"dfe6101202eaf85d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/schema.js\":\"9d351dd24f522fab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/TouchSelectionLayer.js\":\"ab95fb460ad7d427\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/actions.js\":\"b244bfc4892481c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/defaultItems.js\":\"11cc9679751fb456\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/facet.js\":\"105e8202c6239e21\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/holdRecognizer.js\":\"890f6c2f1fabdd3a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/index.js\":\"91720f2730e34e64\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/UpdateIndicator.js\":\"f727df0d9ba2c024\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/index.js\":\"23579d8ea7c140e0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/loadTimes.js\":\"b66cd407437dcad9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoNotesRenderer.js\":\"7165e6f5078b9d66\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoPlayerRenderer.js\":\"594a804929d13783\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoTimeStamp.js\":\"27c59bd26a84b64e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/actions.js\":\"e46fdbc604956a11\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/index.js\":\"0f0a9f5c34637be0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/markdown.js\":\"58f4ee008dd79161\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/notes.js\":\"429db7d7544a5b1e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/registry.js\":\"2ff695ee68eeeaa7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/remark-timestamps.js\":\"3a06f0738ec87796\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/view.js\":\"d2a4ed0c91e18649\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/LinkHints.js\":\"aac5a8cc20b7f88f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/index.js\":\"f706b0fc41414b86\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/model.js\":\"d5aaaf6fa3fdd72d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/settings.js\":\"4957511b2ab2f6d4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/actions.js\":\"d8038fb12dc9410a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/index.js\":\"93d674fb8533ff5a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/interactions.js\":\"145e65252334c401\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/workspace-header/index.js\":\"d1c833b7c8b778d6\",\"/knowledge-medium/pr-preview/pr-1920/src/registerServiceWorker.js\":\"0b94ef5c712564ca\",\"/knowledge-medium/pr-preview/pr-1920/src/requestPersistentStorage.js\":\"8fe5f42cede92d72\",\"/knowledge-medium/pr-preview/pr-1920/src/services/authRequestDeadline.js\":\"2e3a036d7cea1b6a\",\"/knowledge-medium/pr-preview/pr-1920/src/services/authStorage.js\":\"a80243870af56dc1\",\"/knowledge-medium/pr-preview/pr-1920/src/services/powersync.js\":\"5db2814739d74519\",\"/knowledge-medium/pr-preview/pr-1920/src/services/supabase.js\":\"8a84647975d9f80c\",\"/knowledge-medium/pr-preview/pr-1920/src/services/uploadErrorClassifier.js\":\"e50a15849fc82ebf\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/ActiveContexts.js\":\"c46426fc7984ef6a\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/HotkeyReconciler.js\":\"52dc0337db9dfa70\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/WipeLocalDataDialog.js\":\"4e8769ee696d1d91\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/actionDispatch.js\":\"12b13026a74438f0\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/actionRefItems.js\":\"33c168d665248441\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/applyKeybindingOverrides.js\":\"4073ca1b74c5bc90\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/blockActions.js\":\"4cf59650c154df99\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/blockMergeGesture.js\":\"37b849cafc977cc7\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/canonicalizeChord.js\":\"e5be1e3de837a25a\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/defaultContexts.js\":\"5f07dd76ecffcde4\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/defaultShortcuts.js\":\"a0f127d90af346e3\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/effectiveActions.js\":\"4a61cccdcf269ac7\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/gestureAction.js\":\"508e15c6225a5854\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/gestureBinding.js\":\"babb344abb5781f6\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/holdRegistry.js\":\"8df344debf511a61\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/keybindingConflicts.js\":\"095aba5c48328243\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/keybindingOverrides.js\":\"22b87ad95d9223da\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/pointerAction.js\":\"37f51599a6f66b78\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/resolve.js\":\"ee3a451e5bb7326d\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/runAction.js\":\"3db1cc9825a65ee4\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/sequenceMatcher.js\":\"a98b1d2c704bc1bd\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/types.js\":\"35b2a54dc66904dc\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/useActionContext.js\":\"7b2eef7adb90ff07\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/useActionDiscovery.js\":\"91c2a25d3820485c\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/utils.js\":\"3b3a481926597e88\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/bootStore.js\":\"331025797135a86f\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/previewDatabases.js\":\"571f452cf14a614d\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/byteTransform.js\":\"104c4bdd917f58b8\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/attachmentCleaner.js\":\"bfbde277a8b0db0c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/attachmentParts.js\":\"aa1a3d1fe608efff\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/bundleParts.js\":\"d91c7f097781c17b\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/bundleRecord.js\":\"62a2902e972239b4\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/manifest.js\":\"0db527a14184ec7a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/takeBundle.js\":\"7fd9c30dc478e1ae\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/verifyBundle.js\":\"6d1e3d546c58bf97\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/cleaningStage.js\":\"fbc02141bbc8f9b5\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionKey.js\":\"5eccdbb35c7aba69\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionServer.js\":\"f4136ec58f16c064\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/flip.js\":\"ce57659aa6a64cf7\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/flipAttempts.js\":\"03e1589c852fb594\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/pages.js\":\"dcf8e4ec7d49bdfe\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/preflight.js\":\"8d7677d7aaf4936a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/reseal.js\":\"10f3fc3082979aa0\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/runConversion.js\":\"baba3ce452057c5c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/runLock.js\":\"6f2636af25228481\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/sealing.js\":\"0cabacd5b6f5e14a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/sealingStage.js\":\"0f7f58725fd73be2\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/stage.js\":\"217ad573fc992ab8\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/verifyReseal.js\":\"fa42843d378e129d\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/aad.js\":\"99cc2b307251e614\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/aead.js\":\"b077c636564d1eee\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/base32.js\":\"25be86e40262ea43\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/base64url.js\":\"2f1ba0d6615b8b6d\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/binaryEnvelope.js\":\"03b291086b1f7a7a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/byteAead.js\":\"2f6529c4e7fd148f\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/canary.js\":\"4fc501526b991e6c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/contentHash.js\":\"b0bddd08fd603002\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/contentKey.js\":\"bcc8fa8e3a24f119\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/derivedIdNamespace.js\":\"97a2ed035389cb4a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/envelope.js\":\"c2d9b0156a78c243\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/hex.js\":\"a4e3170812c72f45\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/sha256Hex.js\":\"99f938efcfeca864\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/workspaceKey.js\":\"8e21980166923821\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/conversionState.js\":\"37c12102d6c692d0\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/createEncryptedWorkspace.js\":\"51a95a3e6c90649c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/pastedKey.js\":\"49dd9da99286970f\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"954954e833f80b4f\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/upgradeWorkspacePin.js\":\"eee014e03e7a5ee1\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/keyStore.js\":\"cb0e3a7021164d47\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/mintWorkspaceKey.js\":\"3501c65420aaee1e\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/modePin.js\":\"57ed2f74d48fb127\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/openWorkspaceKeys.js\":\"4cacfa8518aedf5f\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/resolveWorkspaceEntry.js\":\"2dab8524e6dba103\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/resolver.js\":\"61d7c7669ce04d9f\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/workspaceAccess.js\":\"596bb08d6a373dc6\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/transform.js\":\"ec13ec492c8bf4b6\",\"/knowledge-medium/pr-preview/pr-1920/src/themeBootDefaults.js\":\"180dceac5f742e7d\",\"/knowledge-medium/pr-preview/pr-1920/src/types.js\":\"ebc558fde21bda61\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/ClientLocalSettings.js\":\"a7420eb1d35165e4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/abortableSleep.js\":\"e3f7c4a99dbb019e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/array.js\":\"f1db3190352b01c7\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/backlinkAutocomplete.js\":\"f4dc92c52a8f6e3e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/blockCrumbs.js\":\"5fc1a52d47d7883c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/blockrefAutocomplete.js\":\"35e8dceafa730cee\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/cadencedIdleJob.js\":\"740406e98ce3f1bf\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/callbackSet.js\":\"8adbaedbf94aa9c3\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/clientId.js\":\"7f7583d892291e55\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/codemirror.js\":\"c2982188b4745f50\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/codemirrorCompletion.js\":\"bfdd38775138b069\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/copy.js\":\"3b6d8a63a70898bb\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dailyPage.js\":\"a0a7616f3e9ea00d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dbForensics.js\":\"0cf75dd01932f448\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dbForensicsHooks.js\":\"fd37bcec2e9ff1b3\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/deleteBlockThroughUi.js\":\"066415f3825b133a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dialogs.js\":\"3479aa9397b1da67\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dom.js\":\"63894c7d68b32d48\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/downloadBlob.js\":\"d2271d9d2c7ba965\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/drawnWalk.js\":\"e46db5df1dbdc190\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/exportSqliteDb.js\":\"2d3a3dc18b33b974\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fileSystemAccess.js\":\"77dacc7510757c90\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/flipSlide.js\":\"2baf4fd51857e20a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fnv1a.js\":\"c60fabdf3534275c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/formatBytes.js\":\"d3a7da22042b85d7\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fuzzyRank.js\":\"4fc25cb6699d6506\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/idbKeyedStore.js\":\"3b5e4351f056edb8\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/idleCallbackPolyfill.js\":\"a366387778402b26\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/keyboardAwareScroll.js\":\"cee4cd5b76ee094d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/keyboardViewport.js\":\"451b1697f25f4a56\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/lastWorkspace.js\":\"69b0ed7c369475e0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutColumns.js\":\"440148dc94afe952\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutSessionDom.js\":\"13f06622ab4c9aa3\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutSessionId.js\":\"cfd96c7ec6ca2ad6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/linkClickGestures.js\":\"b63fee57568940f6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/linkTargetAutocomplete.js\":\"ed509382d8a2ca40\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/localDbCorruption.js\":\"df2b8b0828536c29\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/localDbRecovery.js\":\"35d984d32765e4dd\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/markdownParser.js\":\"73b668f658a35e0c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/memoize.js\":\"ae444615765e6070\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/nameFieldCommit.js\":\"e6b7487f9d54cc84\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/nameList.js\":\"70f50d328a5a9d15\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/navigation.js\":\"e2372b186a630f19\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/omnilinerNamespace.js\":\"1c6677fd1674a78e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/opfsPageScan.js\":\"b40e7696e8c6eff8\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelClearance.js\":\"e8507e58e30d3416\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelHistory.js\":\"d671f6f576178db6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelLanes.js\":\"c0ef5d6478c08a0b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelLayoutProjection.js\":\"db739c95352ee0dc\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelScrollAnchor.js\":\"758c5c68526b1912\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelUrlFlags.js\":\"209d6de2c3ee8dcc\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/platform.js\":\"55ec2f705466d6f4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/pluralize.js\":\"815be16479ec64d0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyCreation.js\":\"fbdee16a2181e779\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyNavigation.js\":\"602d2d4bf7bb9867\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyValueContext.js\":\"659dcf9159264a93\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/react.js\":\"5678927ff7d1eee0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/relativeDate.js\":\"210e58b9f44e1260\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/relativeTime.js\":\"691964368746e880\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/renderScope.js\":\"c605d27781230d38\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/resolvedThenable.js\":\"653b5f9a3dd20420\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/routing.js\":\"4cdfdbfd14a277dc\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/safeMode.js\":\"04b35250dbb63c1a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/scheduleIdle.js\":\"93341852e24325ad\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/screenWakeLock.js\":\"38feca518c58640e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/selection.js\":\"e96e71e85b2c8692\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/softKeyboardGrab.js\":\"ec4a71887f3d1841\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/startupTimeline.js\":\"150a9945ed03bc4d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/state.js\":\"63e79e8fa0dd3c8b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/string.js\":\"526908e8ffa73b2f\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/surfaceZoom.js\":\"c8ce50c58592aa9d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/time.js\":\"da6dda73bef25b7a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/toast.js\":\"16de196490307289\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/toggleStore.js\":\"567b6b1cfc19bec2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/untilStopped.js\":\"0d588f943a533f13\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/userActivity.js\":\"ceddaf5b17598951\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/viewTransition.js\":\"157ec111de8c17a7\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/viewport.js\":\"dfac22e71c0fdeda\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/webLock.js\":\"92ecb8074e7d7911\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/workspaceRecovery.js\":\"7a7c2b67642fd580\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/workspaceSnapshotStore.js\":\"f3e029e28c966b0c\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-compiler-runtime.js\":\"841654d67d80c7f1\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-client.js\":\"f61e90cafc027126\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-server-edge.js\":\"8dd7b77308fb1371\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-server.js\":\"acff87947814cd20\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-static-edge.js\":\"e5a866fa10185c5b\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-static.js\":\"5a96cb7818c96d54\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-test-utils.js\":\"979134049491bb5a\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom.js\":\"d1e6c83551c149be\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-jsx-runtime.js\":\"d59c54485eb797d5\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react.js\":\"677b08b8510f9a97\",\"/knowledge-medium/pr-preview/pr-1920/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1920/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1920/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
