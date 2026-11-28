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
		buildId: "6af80c16f6f7-d2bfd190",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/\":\"449cdbbfe8d1722e\",\"/knowledge-medium/pr-preview/pr-1920/index.html\":\"449cdbbfe8d1722e\",\"/knowledge-medium/pr-preview/pr-1920/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1920/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1920/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1920/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1920/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1920/assets/FacadeVFS-Dzprt26q.js\":\"0e0d400c8679cc06\",\"/knowledge-medium/pr-preview/pr-1920/assets/OPFSCoopSyncVFS-DOAtEzXn.js\":\"9423c6c449e14495\",\"/knowledge-medium/pr-preview/pr-1920/assets/OPFSWriteAheadVFS-DkBZ56mq.js\":\"91de7d8d85a34136\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-CQT19RLG.js\":\"824b5a413cee93ce\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1920/assets/wa-sqlite-async-B9AMn7iz.js\":\"c04c3c0fbc2ca21a\",\"/knowledge-medium/pr-preview/pr-1920/assets/worker-CvWTNltW.js\":\"8ecd3efed662a6a2\",\"/knowledge-medium/pr-preview/pr-1920/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1920/chunks/app-BRSevbJc.js\":\"55bfd12e013bb887\",\"/knowledge-medium/pr-preview/pr-1920/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1920/index.js\":\"99d94490e1f6dc7e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1920/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1920/assets/AccessHandlePoolVFS-EAvatuPc.js\":\"4646a520f5e07102\",\"/knowledge-medium/pr-preview/pr-1920/assets/IDBBatchAtomicVFS-C-p3IXAW.js\":\"f494aca4ca24062d\",\"/knowledge-medium/pr-preview/pr-1920/assets/MemoryVFS-DzBdLyQV.js\":\"8811fed281b931f0\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-C0MlZseB.js\":\"2ea6d557dd74ebc5\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-async-DQ3hJZ7u.js\":\"eb7d5db38a1ae1fb\",\"/knowledge-medium/pr-preview/pr-1920/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1920/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1920/chunks/AccessHandlePoolVFS-Dl4nI4F5.js\":\"f778a5888102f22e\",\"/knowledge-medium/pr-preview/pr-1920/chunks/FacadeVFS-Dv9oCZ0j.js\":\"1380ca4f32bc2f7d\",\"/knowledge-medium/pr-preview/pr-1920/chunks/IDBBatchAtomicVFS-Ct4uzIeI.js\":\"25fec18cc17473b0\",\"/knowledge-medium/pr-preview/pr-1920/chunks/MemoryVFS-Bzqg1z_c.js\":\"d4ba700ee6f55017\",\"/knowledge-medium/pr-preview/pr-1920/chunks/OPFSCoopSyncVFS-Krg-dNiB.js\":\"939ef4df0fd50f20\",\"/knowledge-medium/pr-preview/pr-1920/chunks/OPFSWriteAheadVFS-CWJ916iS.js\":\"88ddd3a105f773bf\",\"/knowledge-medium/pr-preview/pr-1920/chunks/Preview-u2TyeeiZ.js\":\"867d554342ed16c7\",\"/knowledge-medium/pr-preview/pr-1920/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1920/chunks/card-D9HuIn2H.js\":\"bdcb136ab9c91f30\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1920/chunks/dist-DGQ9A2KP.js\":\"d0cd82ec41378d0b\",\"/knowledge-medium/pr-preview/pr-1920/chunks/freezeExtensionImports-Xx4ZD40B.js\":\"88e9fa67686ffc58\",\"/knowledge-medium/pr-preview/pr-1920/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1920/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1920/chunks/mc-wa-sqlite-BlpcTRyG.js\":\"f36618f3c75f8f55\",\"/knowledge-medium/pr-preview/pr-1920/chunks/mc-wa-sqlite-async-BVwkYQAM.js\":\"64e537af003b53ac\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-BFXDmZTX.js\":\"f0a7c17babbc35e5\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-BXvidIkh.js\":\"0bb5f65eabf6c67b\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-BmHn6ruQ.js\":\"fa059ff994a1aa8d\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-CS0UUaNY.js\":\"ded5312dc5f38d64\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-DN3Uw7k-.js\":\"94dbbea14a0eab7a\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-DYu-s9_i.js\":\"7c12188ca3c7d6e9\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-Di8Ygm1z.js\":\"adffd9a7fa6817b1\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-RJmPnbiC.js\":\"83df98a48b0ff0e5\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server-legacy.browser.production-xER_SgDE.js\":\"051aa4b682f06eea\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server.browser.production-BxwFF7Z6.js\":\"40348415d4c0e7b5\",\"/knowledge-medium/pr-preview/pr-1920/chunks/react-dom-server.edge.production-BfvXjVn7.js\":\"014733aa2c46f6b8\",\"/knowledge-medium/pr-preview/pr-1920/chunks/server.browser-_ZdrShEe.js\":\"3732f8bc49814051\",\"/knowledge-medium/pr-preview/pr-1920/chunks/textarea-Dj-HiSl_.js\":\"6996c4461489d824\",\"/knowledge-medium/pr-preview/pr-1920/chunks/ui-B8sryy8O.js\":\"3e287e985e522e78\",\"/knowledge-medium/pr-preview/pr-1920/chunks/wa-sqlite-BaLAD3YB.js\":\"af21909fa0ac92ef\",\"/knowledge-medium/pr-preview/pr-1920/chunks/wa-sqlite-async-w5wkQCKx.js\":\"6747ea05bd4b3243\",\"/knowledge-medium/pr-preview/pr-1920/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1920/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1920/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1920/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1920/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1920/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1920/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1920/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1920/src/App.js\":\"def66bb678a48dc6\",\"/knowledge-medium/pr-preview/pr-1920/src/appUpdate.js\":\"c08540ef3ee913df\",\"/knowledge-medium/pr-preview/pr-1920/src/appVersion.js\":\"1b7a4e895c9a6f76\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/initialLayout.js\":\"6e6fce25a90aba51\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/openWorkspaceData.js\":\"263769e892624af7\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/resolveWorkspace.js\":\"56d719331409cfb4\",\"/knowledge-medium/pr-preview/pr-1920/src/bootstrap/workspaceBootstrap.js\":\"5ef8f80afa5ca7b2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockComponent.js\":\"7ba6c626f0c98f37\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockCrumbs.js\":\"cd94aa1c004ae368\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockEditor.js\":\"878349b47fbc6a73\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockLoadingPlaceholder.js\":\"ad4497b64639e041\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockProperties.js\":\"6773853b79bf1b99\",\"/knowledge-medium/pr-preview/pr-1920/src/components/BlockSearchPicker.js\":\"ff859c72680c0c12\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ConfirmBulkDeleteDialog.js\":\"a6f4d25aa1eee27d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/DividerHandle.js\":\"0e6830ef56dd2d7a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/DraftEditor.js\":\"a8acb3b997796a2d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/GutterPill.js\":\"12bce51e4e60f8fe\",\"/knowledge-medium/pr-preview/pr-1920/src/components/Header.js\":\"ecc06a5a21681449\",\"/knowledge-medium/pr-preview/pr-1920/src/components/LazyBlockComponent.js\":\"548286ead440a5c1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/Login.js\":\"293e01cbf4e4dd2e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ZoomableSurface.js\":\"b8bcbe87cebf81b8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/editModeKeepalive.js\":\"178685c87637aa99\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyDisplay/PropertyDisplayScope.js\":\"0b6ab1758dab6be9\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0e70758edd6f00db\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/RefPropertyEditor.js\":\"c979e97dee74b986\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/RefTargetTypePicker.js\":\"b3700300185eb65c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/SelectPropertyEditor.js\":\"13b7a3cd7c702ce2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/TypesPropertyEditor.js\":\"b16c231a22173a06\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/defaults.js\":\"4d19238b0576f810\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/kernelValuePresets.js\":\"1ce3a58dfeddd5f4\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/selectablePresets.js\":\"48ccea0b010a9419\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyEditors/typesPropertyUi.js\":\"2f45bcdcf26d05ac\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/AddPropertyForm.js\":\"35eda1226a3dc006\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/PropertyPicker.js\":\"ff0a2514937f24b3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/PropertyRow.js\":\"7e412c4e104a3960\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/Rows.js\":\"dfd7f741ac228125\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/actions.js\":\"25c1be74879a4245\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/declarationOnly.js\":\"17fa39d0ff1ec333\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/layout.js\":\"f256b0a01ce39587\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/model.js\":\"9229dd2bd10bebf6\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/shapeUi.js\":\"9286aff2af9a3385\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/shapes.js\":\"8e3af5b80069fb50\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/usePropertyEditingActivation.js\":\"2c90d5f4b0143b3c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanel/visibility.js\":\"57f8ced5715de8d4\",\"/knowledge-medium/pr-preview/pr-1920/src/components/propertyPanelSections.js\":\"b4d1df4d4ef512ef\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockEmbed.js\":\"11baeb007595b0d2\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockLink.js\":\"6c36b5db4716a379\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/BlockRef.js\":\"4845c882ba69c1ba\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/CompactReferenceLink.js\":\"e3d0ab76afbb934d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/ReferenceLink.js\":\"67e67245ea0043d3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/cycleGuard.js\":\"ed4cd69d77780c3a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/cycleGuardContext.js\":\"862c983456a48d44\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/linkInteraction.js\":\"00aba35ffe3ec95c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/referenceLayout.js\":\"b2a57b6f573d1089\",\"/knowledge-medium/pr-preview/pr-1920/src/components/references/useBlockRefAncestors.js\":\"576e73b888ac756a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockGutter.js\":\"77f0633e3bec9f2a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockInfoDialog.js\":\"7b10cb6c4c4b4e97\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockReadText.js\":\"d508477b2bd290a0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BlockTypeBlockRenderer.js\":\"28efea1e390b8f0d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/BulletHoverCard.js\":\"793d83e2756cc052\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/CodeMirrorContentRenderer.js\":\"76dcb0f09c26a584\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"518201ab8d2a1ab8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/ColumnResizeHandles.js\":\"c92ca04e3079ff3d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"9452f074c76919e6\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/DefaultBlockRenderer.js\":\"8762098d238ffcbb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/LayoutRenderer.js\":\"63cfbef54aa2a6c0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/MarkdownContentRenderer.js\":\"2f442b70f12a3df3\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/MissingDataRenderer.js\":\"52033bfb5fe06675\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/PanelRenderer.js\":\"ded989378b4a16f1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/PropertySchemaBlockRenderer.js\":\"8d049a7b14381e51\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/TopLevelRenderer.js\":\"a7b86b05f5d1739d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/blockGutterMode.js\":\"5dba1b60874ebfbc\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/blockTitleText.js\":\"038fa1eaef27e842\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/fieldCreationKeydown.js\":\"c96efa0568f6d9c8\",\"/knowledge-medium/pr-preview/pr-1920/src/components/renderer/layoutRootContext.js\":\"8f950b5123f45c73\",\"/knowledge-medium/pr-preview/pr-1920/src/components/typeChip/TypeChip.js\":\"005e62d94a7b5733\",\"/knowledge-medium/pr-preview/pr-1920/src/components/typeChip/chipStyle.js\":\"362bfd3c4ed9de11\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/anchored-floating.js\":\"a5426b21c8526c46\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/button.js\":\"c41aedf49a67f192\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/card.js\":\"ef236738fd58c1bc\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/checkbox.js\":\"c77a2823bce696e7\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/collapsible.js\":\"f29f2e953b366e48\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/command.js\":\"8c0feba92a11ceae\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/context-menu.js\":\"3df96d78840db63a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/dialog.js\":\"c8bf75c244be6b4e\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/dropdown-menu.js\":\"b50ef15a29531021\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/floating-listbox.js\":\"f892e957696c83d1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/index.js\":\"eb26f391f0f2da97\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/input.js\":\"b1b1255aa833d7ce\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/kbd.js\":\"f68a05c6cf9b2eb1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/label.js\":\"e810249d61a4c1fb\",\"/knowledge-medium/pr-preview/pr-1920/src/components/ui/textarea.js\":\"22dccdda21af6200\",\"/knowledge-medium/pr-preview/pr-1920/src/components/useEditModeYieldKeepalive.js\":\"aa7bcc2bdbb40b0c\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/BootFallback.js\":\"243542f11fd67cbc\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/FocusedRowLazyMount.js\":\"0d9ca677540552ff\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/LazyViewportMount.js\":\"48431ce7f65dd474\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/LocalDbCorruptionFallback.js\":\"6cf567171e95500d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/error.js\":\"452e26758327fe23\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/lazyMountRegistry.js\":\"bb0d2c3c8bfa2707\",\"/knowledge-medium/pr-preview/pr-1920/src/components/util/suspense.js\":\"e628ac7c910af112\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/CreateWorkspaceDialog.js\":\"2e62ea5c46db318a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/PendingInvitations.js\":\"b65b02187722ae67\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/SyncProgress.js\":\"f6cc27d2615181a5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/UnlockProgress.js\":\"ad0bf2b49bda9a7b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceKeyGate.js\":\"048e9799589503b1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSettingsDialog.js\":\"e07eea7dfe39b13a\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSwitcher.js\":\"8a988e0a9c9e11b5\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/WorkspaceSyncGate.js\":\"668a90aea8d744bf\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/ConversionFlow.js\":\"0a65d1d7f0cd9c73\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/ConversionFlowHost.js\":\"a752f9fe3705fbe0\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/EncryptionSection.js\":\"388d5c6a1ba4235d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/attachmentPrompts.js\":\"1c13275c6e0caeec\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/bundleFolderPrompts.js\":\"7c7a0dff6d17c923\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/conversionFlowDeps.js\":\"11c75689a99192bc\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/conversionFlowStore.js\":\"ebfae4e61dead31d\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/flowUi.js\":\"76dae5c9bd58ace1\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/conversion/useConversionRun.js\":\"9f385302dd5ca5b9\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/keyUi.js\":\"f8fc4717c0140828\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/useCloseOnKeyLoss.js\":\"93456b4f072d9e41\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/useCloseOnServerE2ee.js\":\"f9ab454cc0bfa65b\",\"/knowledge-medium/pr-preview/pr-1920/src/components/workspace/workspaceUnlocked.js\":\"c12264502b538bd9\",\"/knowledge-medium/pr-preview/pr-1920/src/context/backgroundSubtree.js\":\"1c7cf8e1e8654ca7\",\"/knowledge-medium/pr-preview/pr-1920/src/context/block.js\":\"f8d40b0b45f176bc\",\"/knowledge-medium/pr-preview/pr-1920/src/context/layoutWsContext.js\":\"29e33d47e5826d12\",\"/knowledge-medium/pr-preview/pr-1920/src/context/propertyDisplay.js\":\"463741743264a680\",\"/knowledge-medium/pr-preview/pr-1920/src/context/repo.js\":\"30257b65047496f2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/aliasClaim.js\":\"04f4ef94ff4f3307\",\"/knowledge-medium/pr-preview/pr-1920/src/data/aliasSeatNamespace.js\":\"1037dcdf7f2c8f76\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/blockData.js\":\"c78fa6c64fa78ab4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/blockType.js\":\"08133ba753ba3174\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/changeScope.js\":\"02963f62fa628d97\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/codecs.js\":\"8fa20374243fef20\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/derivedData.js\":\"8ec7d66a475911fe\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/errors.js\":\"7228ac8db7c02c3b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/events.js\":\"71e654ec4cfeab28\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/handle.js\":\"338aa7949116cf6e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/index.js\":\"33b4039a9dc87188\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/mutator.js\":\"57f51cfb700a142a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/processor.js\":\"b5222de52f270427\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/propertySchema.js\":\"f93b9706f978a9e1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/query.js\":\"e9b83c7298634f2c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/sameTxProcessor.js\":\"8056f4c492cf27ff\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/schema.js\":\"338aa7949116cf6e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/tx.js\":\"338aa7949116cf6e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/typedBlockQuery.js\":\"14d3146ea02ce0f9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/user.js\":\"891e0fa79e448266\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/valuePresetCore.js\":\"21f8d1c89574f46f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/api/valuePresets.js\":\"6f83a46ce53bc3d3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/attachmentCleanerIOVerb.js\":\"678d923a356e1258\",\"/knowledge-medium/pr-preview/pr-1920/src/data/block.js\":\"39a861c7e71e1a1d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockCache.js\":\"5319c34a235d8f37\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockId.js\":\"08685f2c1e34a72b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockLiveness.js\":\"dafa82a685607e06\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockMerge.js\":\"2e309a2efb6f237f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockSchema.js\":\"9afc13bc58aa5b00\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockTypeLookup.js\":\"6216ed338e4efcfa\",\"/knowledge-medium/pr-preview/pr-1920/src/data/blockTypes.js\":\"9c43517ce20d391a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/childrenView.js\":\"6f3768b1d64cecaf\",\"/knowledge-medium/pr-preview/pr-1920/src/data/clientContext.js\":\"a33b4653134069a4\",\"/knowledge-medium/pr-preview/pr-1920/src/data/dbFileSiblings.js\":\"6eacfd456f7ef1c8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/definitionSeeds.js\":\"2798a597b1fbb952\",\"/knowledge-medium/pr-preview/pr-1920/src/data/derivedIds.js\":\"50dd620cad2ad290\",\"/knowledge-medium/pr-preview/pr-1920/src/data/drawnSubtree.js\":\"8470171ce17c098e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/facetBridge.js\":\"ea1b0e315ed9677e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/facets.js\":\"e433e7300b31293f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/globalState.js\":\"c6a3eec18dfa3e2b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/aliasClaimRederiveProcessor.js\":\"28cf19604bd9cac9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/ancestorBatch.js\":\"3eb077a90c9c69d0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/blockTypeTypeifyProcessor.js\":\"cfdae28e843863e5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/clientSchema.js\":\"196aa13670ab8dec\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/commitPipeline.js\":\"1adfdf398aa7c40a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/devAssertions.js\":\"e7b697d55e3f2ac7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/firstSync.js\":\"2040b61796387988\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/freshInitialLoad.js\":\"a348a6f4046727ac\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/graphBackfillClaim.js\":\"a826f243c91ffd04\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/handleStore.js\":\"e562402fdad42d82\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/idleMarkerJobs.js\":\"ed003f5eee132963\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/initialDownload.js\":\"878eabc9f4d29879\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/initializeClientDatabase.js\":\"d08a830f7f6716c5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/jsonCanonical.js\":\"285c8e1e0ce3fa40\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelInvalidation.js\":\"399bd4eae3e38551\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelProcessors.js\":\"5f969f71cfdeb0e7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/kernelQueries.js\":\"047bd9f597e2a500\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/mergeTypeMembershipProcessor.js\":\"0cf94c5f7aaaea96\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/normalizeReferencesProcessor.js\":\"cefdb5b2bfc211c7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/poolInstrumentation.js\":\"a3d08fc9d7f9dac2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/processorRunner.js\":\"8b39b98289171780\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyCellBackfill.js\":\"13bad0e9d7fad6e5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyChildMint.js\":\"2123692d6d10acf8\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyChildrenProcessor.js\":\"72ea1445bf5ab457\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyDefinitionChangeProcessor.js\":\"4d743d86da54a386\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyDefinitionSynthesis.js\":\"2699c99fe0ec802a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyKeyScan.js\":\"bcb67aaafe69a7da\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertySchemaResolution.js\":\"6065db7676a24f5f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/propertyValueEdits.js\":\"406275beeba787af\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/raiseProtocol.js\":\"eef92a5587f1ec45\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/readBatch.js\":\"60bad43478e87eac\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/refProjection.js\":\"0d97de80f4d20739\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/referenceTargetLookups.js\":\"021abf1a5367e4c6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/referenceTargetProcessor.js\":\"fbcef7a019ec4da5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/replayMerge.js\":\"9157352ed1101740\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/sqlBinds.js\":\"2c3e144c575477cb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"895911b09db497b3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/arrivalProcessors.js\":\"94eccea834637aad\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/invalidate.js\":\"90f67dfa4a6f5217\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/materialize.js\":\"d46500259ebe6436\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/observer.js\":\"a818628b03d2007a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/syncObserver/reconcile.js\":\"ea955ec93070f086\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/timingMetrics.js\":\"3a4b476c3f67f779\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/treeQueries.js\":\"b5c22b6cc1c1cae3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/txEngine.js\":\"2341e7504f0d6f4c\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/txSnapshots.js\":\"b7b2b6d490a18433\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/typedBlockQuery.js\":\"f7141c96ae32e8d9\",\"/knowledge-medium/pr-preview/pr-1920/src/data/internals/undoManager.js\":\"8af376130ef1aaa7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/invalidation.js\":\"089083769d7326e7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelDataExtension.js\":\"f90cf62095cadb1f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelPage.js\":\"23f7708d0b9420b3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/kernelValuePresetCores.js\":\"b666571a93bd1a28\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbCorruptionSignal.js\":\"fb2e4554dae40146\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbStorage.js\":\"ccad1f275b53f2ae\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localDbVfs.js\":\"cd7600eb70063e59\",\"/knowledge-medium/pr-preview/pr-1920/src/data/localSchema.js\":\"8db94ee4f1274276\",\"/knowledge-medium/pr-preview/pr-1920/src/data/maintenance.js\":\"cb3231b37b9aab34\",\"/knowledge-medium/pr-preview/pr-1920/src/data/mergeProperties.js\":\"786b6c041ced38f2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/metricsConsoleHook.js\":\"9e8fc750fa4e3ccd\",\"/knowledge-medium/pr-preview/pr-1920/src/data/migrationsPage.js\":\"f4ceed3dcaf231cc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/mutators.js\":\"84cda95d9a2e1d93\",\"/knowledge-medium/pr-preview/pr-1920/src/data/orderKey.js\":\"b7e96c9689467950\",\"/knowledge-medium/pr-preview/pr-1920/src/data/orderKeyPlacement.js\":\"186130e23568ee9d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/outlineSurface.js\":\"3a6ce6bc1dc9b406\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pendingEditorContent.js\":\"9a9794d2f79739f2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pendingUploadsSql.js\":\"cddc95da4dd045ec\",\"/knowledge-medium/pr-preview/pr-1920/src/data/pluginStateExtensions.js\":\"c7568f91eaf2d7e6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/powerSyncLogger.js\":\"d8836f709d759966\",\"/knowledge-medium/pr-preview/pr-1920/src/data/projectorRuntime.js\":\"e7b7fda89a69c901\",\"/knowledge-medium/pr-preview/pr-1920/src/data/properties.js\":\"9806da65889a780a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertiesPage.js\":\"93873bc016aa4f1e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyChildren.js\":\"e08047a87f825969\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionFanout.js\":\"cd37d790531f0d5f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionMetadata.js\":\"55b046dce25d0924\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDefinitionRegistry.js\":\"ecc6577f6a9bdcc0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyDisplayMode.js\":\"020c0222177e9282\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertyRowCreation.js\":\"81e077415bc505fe\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertySchemaCreation.js\":\"ec762553f06d0b77\",\"/knowledge-medium/pr-preview/pr-1920/src/data/propertySeeds.js\":\"9f0ec94feff9d2ca\",\"/knowledge-medium/pr-preview/pr-1920/src/data/recentsPage.js\":\"8d25dcbbe8f98abb\",\"/knowledge-medium/pr-preview/pr-1920/src/data/refTargetComparableProperty.js\":\"9900d2f491a9d89b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/referenceBlock.js\":\"ff330d0f1bfc4052\",\"/knowledge-medium/pr-preview/pr-1920/src/data/rejectedUploads.js\":\"520d0f8273ec1717\",\"/knowledge-medium/pr-preview/pr-1920/src/data/releasePowerSyncConnection.js\":\"5f3ce9bcb887f95b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/repo.js\":\"0c266e39fa964d8d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/repoProvider.js\":\"e8dbf42a9c5d58ab\",\"/knowledge-medium/pr-preview/pr-1920/src/data/rowProperty.js\":\"4f8c10870972cbfa\",\"/knowledge-medium/pr-preview/pr-1920/src/data/searchFilter.js\":\"2e5938abd790e8db\",\"/knowledge-medium/pr-preview/pr-1920/src/data/seedIdentityLedger.js\":\"a773defe22da91a7\",\"/knowledge-medium/pr-preview/pr-1920/src/data/stateBlocks.js\":\"258c557a8131a6cc\",\"/knowledge-medium/pr-preview/pr-1920/src/data/structuralEditPolicy.js\":\"f503ffdad7db5731\",\"/knowledge-medium/pr-preview/pr-1920/src/data/structuralInsert.js\":\"58d435f45c78d09a\",\"/knowledge-medium/pr-preview/pr-1920/src/data/subtreeDelete.js\":\"898f40677fd2ad67\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncStreamLock.js\":\"cb4572eaf71bf9a0\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncedTableSqlRecognizer.js\":\"ed1a95644f35e65d\",\"/knowledge-medium/pr-preview/pr-1920/src/data/syncedTableWriteGuard.js\":\"b14e7b6eb1516fa6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/targets.js\":\"1e2ff1ecc6128d58\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeColors.js\":\"926ef08671d8574f\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeDefinitionMetadata.js\":\"9e64084bec4697a6\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeDefinitionRegistry.js\":\"4542349728266409\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeExtraction.js\":\"eaef77780a8fb8fe\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeInitialValues.js\":\"f9e23e64537d43e2\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typePropertyGroups.js\":\"c22cb6a37a072408\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeSeeds.js\":\"7cc9f7dde3343a06\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typeTagger.js\":\"d30cef5bc5940124\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typedRecords.js\":\"03f3a6789dbbea27\",\"/knowledge-medium/pr-preview/pr-1920/src/data/typesPage.js\":\"2d5dc18a877d0105\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userPrefs.js\":\"1a9fb52abb499abf\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userSchemasService.js\":\"5eb22e0c449ac2c3\",\"/knowledge-medium/pr-preview/pr-1920/src/data/userTypesService.js\":\"3ee726fe197caf4e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/valuePresetRegistry.js\":\"5062fd3ef18da3aa\",\"/knowledge-medium/pr-preview/pr-1920/src/data/visibleChildren.js\":\"af2ad066e9bdeb84\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceConversion.js\":\"e5d2fef67af6a0a1\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceFirstSync.js\":\"83fc96177e8cb2bf\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceIdNamespace.js\":\"c368c2e443090ef5\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaceSchema.js\":\"8bdc0f404a5a4a0e\",\"/knowledge-medium/pr-preview/pr-1920/src/data/workspaces.js\":\"1a8f6e1df7dd82bf\",\"/knowledge-medium/pr-preview/pr-1920/src/data/writeAheadLog.js\":\"fcc7fdd11f3ff28b\",\"/knowledge-medium/pr-preview/pr-1920/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/BlockPasteShellDecorator.js\":\"773d2b30c59c1b15\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/atTrigger.js\":\"652876f047e6291a\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/autocomplete.js\":\"59aa2a2fb72ab67a\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/codeMirrorExtensions.js\":\"7a3b63fd3164db9c\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/contentFlush.js\":\"a5dc5e9cb54b3d69\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/defaultInteractions.js\":\"cabad2c19ff1981d\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/editSettleSignal.js\":\"7bbbdcafd329d171\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/insertImage.js\":\"5775d0c260947379\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/referenceCompletionRange.js\":\"2782484286fac62b\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/referenceTargetTypes.js\":\"05c75c72d43f5c88\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/syntaxContext.js\":\"21adf27081b73cbe\",\"/knowledge-medium/pr-preview/pr-1920/src/editor/triggerMatch.js\":\"561974619362e65d\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/AppRuntimeProvider.js\":\"0bd64490f89386e4\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/BlockFocusShellDecorator.js\":\"2ef6202f79fbc786\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/ExtensionRenderBoundary.js\":\"9d869e2a86b95bc6\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/PanelContentRecovery.js\":\"13e3d2bc513672c6\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/apiCatalog.js\":\"9a649da576fc844e\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/appRuntimeController.js\":\"48d0671e13a8be35\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/approveExtensionHere.js\":\"3f5aecfd82084cd1\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/armedCutAppMount.js\":\"6ec9142357d0d369\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/batchableKeyedStore.js\":\"4ae3de127e1cea1b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/blockInteraction.js\":\"20a787df85ceea2f\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/blockSelectionAction.js\":\"8b4749274d5fc809\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/buildApprovalRecord.js\":\"483aa44f77c57b24\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/compileExtensionModule.js\":\"6ce881193b7872f0\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/compiledModuleCache.js\":\"56f57e34b9f8984d\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/continuousGestures.js\":\"21443765821d2127\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/core.js\":\"b0c3305855c4ac04\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/defaultRenderers.js\":\"718d12a0d93300ad\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/definitionFanoutAppMount.js\":\"721b62078f388c7f\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dialogAppMount.js\":\"f22df14e9872d27b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dynamicExtensionSeeds.js\":\"847d6f8b207d32bf\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/dynamicExtensions.js\":\"fac849b054f83bb5\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/exampleExtensions.js\":\"dd972802c6d1da72\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionApprovalStatus.js\":\"cc11a2f906a453b1\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionImportPolicy.js\":\"d1f98618454ffcf7\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLoadErrorToast.js\":\"fb876e09434939d9\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLoadErrors.js\":\"c144a214bdb82c99\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionLookup.js\":\"8dcb1117ca047ac4\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionToggles.js\":\"8eee79c0d050bafb\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/extensionUtilitiesCss.js\":\"da4e4765109f45c5\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/kernelPageDeletionGuard.js\":\"d8e4fe877a047b60\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/liveRuntime.js\":\"167c2f55f94b7bab\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/normalizeExtensionSource.js\":\"319a8748f281d0db\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/openExtensionsSettings.js\":\"9f0e892c8d5afb86\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/overridesCache.js\":\"c951b88b3ac49b37\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/pluginIds.js\":\"8d21acf5746a396b\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/processorRejectionToast.js\":\"3ced6b735828ec52\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/runtimeActions.js\":\"addf51bfd191a15c\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/runtimeContext.js\":\"7b3cd6ed8f070947\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/staticAppExtensions.js\":\"a75a39aa75ac10fe\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/staticDataExtensions.js\":\"04bc4a85c632d108\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/toastAppMount.js\":\"275857e2b890f638\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/transpileExtension.js\":\"73576e4d6b346024\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/useOverrides.js\":\"810ca6115c616b48\",\"/knowledge-medium/pr-preview/pr-1920/src/extensions/useShortcutSurfaceActivations.js\":\"fef9dc1697f7dffd\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/discoverToggleTree.js\":\"d57fba5a82e305b8\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/facet.js\":\"a7912faec739b092\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/resolveAppRuntime.js\":\"22a2b610190dd949\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/runtimeEvents.js\":\"87598f4fafddfa88\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/togglable.js\":\"cc048a2673b5da1f\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/variantFacet.js\":\"ad80ffef29ae2fb0\",\"/knowledge-medium/pr-preview/pr-1920/src/facets/verbFacet.js\":\"0f29a3036225cf25\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/block.js\":\"99a681bb19bcccc4\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/focusedChild.js\":\"fe466d7772d1d8c8\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/propertySchemas.js\":\"0563a9238dacfc63\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/typeRegistry.js\":\"189de8b30c7ef4aa\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useAncestorCrumbs.js\":\"ad04012f7be66121\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useAutocompleteListbox.js\":\"712425c0cf88b8ce\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useDebouncedSearch.js\":\"de490cfa1b0e6d42\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useDebouncedValue.js\":\"b8477abbf10b556f\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useFacetValue.js\":\"9c957e5c2019f244\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useIsFocalRender.js\":\"10ebb59cb8bbed31\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useIsReadOnly.js\":\"1d1c39b770bea3cd\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useMaterializeBacklog.js\":\"7ab611e51d8d2d28\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useMinuteClock.js\":\"9ad0bedcfe1d4a1e\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/usePanelLayoutProjection.js\":\"f5e4537bcc92160d\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/usePendingInvitations.js\":\"04492ebcc71257dc\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useRendererRegistry.js\":\"5614538c27aee8ac\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useRetainedFieldRows.js\":\"4f4a93cb00fded36\",\"/knowledge-medium/pr-preview/pr-1920/src/hooks/useWorkspaces.js\":\"9f30c6cd1f049562\",\"/knowledge-medium/pr-preview/pr-1920/src/lib/utils.js\":\"2780a483abe847cb\",\"/knowledge-medium/pr-preview/pr-1920/src/main.js\":\"927ca3e222e39edb\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/MarkdownImage.js\":\"77353ec29f7f0e6d\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/blockSeparators.js\":\"437a73a7d5bae0dd\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/context.js\":\"e7fdcc4aaff80049\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/defaultMarkdownExtension.js\":\"b526c05f434332a4\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/extensions.js\":\"3acf506e0368f60f\",\"/knowledge-medium/pr-preview/pr-1920/src/markdown/renderMarkdownHtml.js\":\"a20e1d862558faf4\",\"/knowledge-medium/pr-preview/pr-1920/src/minimal-editor.js\":\"ade6117d3f129fc9\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/armedCut.js\":\"00e5e49953944d97\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/captureMediaVerb.js\":\"2053386aad488e3d\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/clipboard.js\":\"43424b0a5cc3aab9\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/decision.js\":\"9f15218f3361e424\",\"/knowledge-medium/pr-preview/pr-1920/src/paste/operations.js\":\"52e1acbf9614de60\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/account-header/AccountHeaderItem.js\":\"c4ac55934611abb0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/account-header/index.js\":\"67caec489aaab572\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"dca7df131cdc08b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/askAgent.js\":\"e06ff82f614308c9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/askedStore.js\":\"78cba502679d48d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"ace6c345b56b1ba9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/chipState.js\":\"38b0c84ddab45ba7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/dataExtension.js\":\"e329b7a7e9218ceb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/index.js\":\"8768cb26eeaa5d4a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8b0b68462ce84e18\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-dispatch-companion/schema.js\":\"116e7c04ebae826b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/AgentTokensDialog.js\":\"b922c05f27592422\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0e2ff5243ad39c12\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/addMedia.js\":\"cf50bc0c30e3ea5e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/backlinks.js\":\"318910e1b32fe790\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/block.js\":\"a9d06ef17e89c732\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/context.js\":\"40a4276cb43dd180\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/displayIds.js\":\"9b05eda49f72d873\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/index.js\":\"26fae05e5f46bef8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/outline.js\":\"cd8cedc738063ec5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/properties.js\":\"94125b31b59aa963\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/refs.js\":\"dca5fc63d7ba0ebb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"d9778ad642cfd300\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/search.js\":\"d8d0c054683f9f06\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/shared.js\":\"92d9c2102f0dd67b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"498d6668d80ec00e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentViews/text.js\":\"1776f7840fc758c7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/agentWrites.js\":\"f754b458e4db7592\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/authoringCatalog.js\":\"9545d605d04832df\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/blockRefTargets.js\":\"6b66668d9946a40d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/bridge.js\":\"14ffc4769d3b1612\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/bridgeLoop.js\":\"220f066d6339985b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/changeHistory.js\":\"ad036eb8d529e5e3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/commands.js\":\"afaf5fd7882f7b98\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/commentsCommands.js\":\"f5ccca41a0f804e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dataExtension.js\":\"5fc53f5cb222a13f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dataModelGuide.js\":\"2ca78d5d88eac280\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/dayPropertyInputs.js\":\"638a9669c0a07b2b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/describeRuntime.js\":\"9cb1c1f9aabeebbe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/extensionLint.js\":\"4b2296d680437ee9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/grainAudit.js\":\"9ec0de6df9991288\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/healthCommand.js\":\"f28ba8890de866dd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/index.js\":\"faab3dba58f9385d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/presetIdentity.js\":\"72135e2af4ee68c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a6a2068b28cc5602\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/readMedia.js\":\"89ec0c4f6013d404\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/schema.js\":\"1176fe93ce64e0c1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/serialization.js\":\"a01751ab0b2e2a34\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/targets.js\":\"f31bef357e809b17\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/tokens.js\":\"70b2195f9c7a4e7a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/watchEvents.js\":\"72c935fce05170f8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/workspaceGuard.js\":\"03d964afd232bf7b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/agent-runtime/writeCommands.js\":\"59b59816705c7871\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/AliasCollisionToast.js\":\"a6c5ca3233162aed\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/DuplicateNameBanner.js\":\"3768f5da7e08a78d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/collisionMerge.js\":\"2f2b43a0c41347c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/dataExtension.js\":\"b3320fba93c17445\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/index.js\":\"b303a68e337ebbe6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/mergeCollisionAction.js\":\"9b1c0e1060c6f41e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/pageStyling.js\":\"2177b16b1dd57b13\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/rejectionToast.js\":\"5c2e7dfa416a5aa8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/alias/syncProcessor.js\":\"fd93dac95e1c06dc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/actions.js\":\"c880c6abc966a36d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/addComment.js\":\"2bfe4b5f1e8ece42\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/anchor.js\":\"90e85946ed7ceff6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/anchorState.js\":\"f4b2ef791f5f1235\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/commentLinks.js\":\"8e932d640b747331\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/confirmThreadDeletion.js\":\"31194b31c898ff50\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/container.js\":\"88e7a21fe4fcdbaa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/dataExtension.js\":\"f1a1688d6a9b2ee7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/deleteComment.js\":\"743805beec7155e3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/highlights.js\":\"70fcbc3e686406d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/index.js\":\"0481194bfb59a11a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/linkedCommentsPill.js\":\"def05230c6b5244c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/margin.js\":\"cfad05ca57511b58\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/marginAnchorLinks.js\":\"3408cd8058f124f8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/marginSchema.js\":\"5ff2ad179381613e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/newComment.js\":\"3e2d207570beef7f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/ownThreadPicker.js\":\"4439e66fa85c1ae0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/placement.js\":\"07e20185d9941ac3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/queries.js\":\"af0488da9e0a5bf9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotePosition.js\":\"3af158cb55e2634d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotedIn.js\":\"d906b2bfad9c7633\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/quotedRange.js\":\"480e1f7c76e6ba11\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/rangeRefs.js\":\"a7447dad41b514bf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readHighlights.js\":\"28ed02afc1f541d0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readSelection.js\":\"093a1db52d73cb6a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/readSelectionUi.js\":\"cc5860c90b0830c0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/reanchor.js\":\"4f7365bdf6c30262\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/schema.js\":\"7512f0a8400306ba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/scope.js\":\"e0f90f08e8d45596\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/scopeThreads.js\":\"29b6251941a8ae98\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/splitRetarget.js\":\"5a03e95fc14b2f94\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/suggestionCard.js\":\"cf51eee350e99eb5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/suggestions.js\":\"a33077e50f52da70\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/summaries.js\":\"ba87ecb664f8d952\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/summaryBatch.js\":\"241077ad46a39e07\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/surface.js\":\"8fc9ea5da7f52b45\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/threadNavigation.js\":\"e161b57412f05730\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/threads.js\":\"38f8d6a21029e558\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/ui.js\":\"757ba48d5fd33838\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/annotations/uiStore.js\":\"5347883a34c4768f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-intents/appIntents.js\":\"dbd9dd62ecf09bf5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-intents/index.js\":\"740274061c6c3640\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-update-prompt/index.js\":\"8f087ffb51de93b9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/app-update-prompt/status.js\":\"d26116ce555a909a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"a664fdaed36f6b95\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaBlockRenderer.js\":\"5f2b59b1994bcf3f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaDownLaneReplicator.js\":\"2ca5e18ecb99aa2a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/MediaUploadReconciler.js\":\"64243325ac3fbedf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetDownLane.js\":\"297e328d8cec967b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetResolver.js\":\"00053f22c2a556d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/assetUpload.js\":\"137288d85ddbd357\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/attachmentCleanerIO.js\":\"0dc3e2dea5c29cc6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2d26c7dd9a692c08\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/blobStore.js\":\"738d99ac63e4dc2e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/browserMedia.js\":\"36d09e625ee4eb1e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/byteStore.js\":\"b52f6c3b9f51c7e6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/cleanerIO.js\":\"ec890c6825a47f77\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/cleanupAttachments.js\":\"d1cd57a87872fe27\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/dataExtension.js\":\"5f637006111069aa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/downLane.js\":\"71a3928b8f5737ba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/index.js\":\"394fd6d77b234b91\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/insertImageContribution.js\":\"81c2749d834d0c4f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/laneArming.js\":\"291fa8130eb16816\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/laneLock.js\":\"5808e4985158d587\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaBlock.js\":\"d37b56295fbcc309\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaCapture.js\":\"15e18dd56c2607ec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaLanes.js\":\"7ed1101eb9267eaa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaViewers.js\":\"5ef271cc0b7191e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/mediaViewersFacet.js\":\"bfa10a36c376509a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/pasteCapture.js\":\"cb3bec228c58352c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/resolver.js\":\"59ea532db4d77cd0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/retryUploadsAction.js\":\"c824dbfb959f804b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/storagePaths.js\":\"7a1cbc995fde3eee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadDrain.js\":\"6ecc3a2764845535\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadLaneStatus.js\":\"11f52f1ef34a885c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadReconcile.js\":\"c3b108ca2669f62b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadRecovery.js\":\"85f2447640120abb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/uploadStore.js\":\"ee76f3a6e0778a62\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/attachments/useAssetObjectUrl.js\":\"1be1304245dde506\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"0890cabcd76b982e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/BacklinksViewSection.js\":\"134859069121707d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/facet.js\":\"bb95d91c2b0655a4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/index.js\":\"84af2abab3b3ef44\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks-view/prop.js\":\"78e98678529cfd89\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BacklinkFilters.js\":\"20e194503db1d937\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"14855ec5073477cd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/BlockEntry.js\":\"8ba93426ed0d7318\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/LinkedReferences.js\":\"dfac26591a633fa8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"48ccd5fd9d78af1d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/dailyNoteDefaults.js\":\"0f2cc2b9ae803183\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/dataExtension.js\":\"a053c2b165215193\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/edgeExclusions.js\":\"5969d88e51054b7b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/filterProperty.js\":\"2607fb7612c2d5ad\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/index.js\":\"c2c18cd3ef9c41ac\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"015492b3a6a134e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/applies.js\":\"b79ec21081f3aaaf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/countQuery.js\":\"d693f3dddb2c9b9c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/expansionStore.js\":\"f9cb0a34eefa2db1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/index.js\":\"d69de527cb3420a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"411dfd08884417c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/presentationInvalidation.js\":\"72655f42e5ed539b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/propertyEditorOverride.js\":\"d69ec34d6c82c990\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/propertyFilter.js\":\"903fe63cedcbe9d6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/query.js\":\"a7e4a00b74ebda8c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/resolveFilter.js\":\"ad25b42932243a78\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/sourceBatch.js\":\"bccc7636409ffcd6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/sources.js\":\"af6a4f344e31706c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/useBacklinks.js\":\"b9beb541dd15d30b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"e96574bfe2a0dc87\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/BirthdayCelebration.js\":\"5dbd6467d651ea71\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/BirthdayOverlay.js\":\"9b19795fb6976b2d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/gate.js\":\"e762b9052ee0bcfe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/index.js\":\"74c627c4f8d02137\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/birthday/wolfTheme.js\":\"c666464db94c7070\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/BlockDragLayer.js\":\"2086a4f8d813809f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/dragController.js\":\"1cd1b8c80bc113a9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/dropTarget.js\":\"3ee37af5b8a5c3c2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/index.js\":\"a2d1efaadef07a6a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-drag/projection.js\":\"6c0b8ad41497bdf5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-info/BlockMetaCard.js\":\"8346b930928bae41\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-info/index.js\":\"f00c09ee79c9ab5d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/AddTagDialog.js\":\"28eb3eaebc18d80e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"da587155cf7826b8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/TagNameIssueHint.js\":\"be412ecf811b3484\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/addTagAction.js\":\"052a671fce83c0e5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/appendTag.js\":\"b2f1b101d61d7cd9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/config.js\":\"ae6c9e7bc799866f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/dataExtension.js\":\"2ad90134076b38e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/index.js\":\"823d87e234446410\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/block-tagging/propertyEditorOverride.js\":\"d9d662c25313fb56\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/BreadcrumbList.js\":\"50b9f3832454ab61\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"24fc07dadd1f2c13\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/Breadcrumbs.js\":\"cefbb6d489584b47\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"b0773adce322676d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"8219e677b839a0ec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/index.js\":\"ba22f5a684ab3c42\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bda86bf9cf0a5d51\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/CharacterCountItem.js\":\"0c64052cc2f271a4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/ProfilePropertyEditor.js\":\"dcad56e4e14eef5e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/actions.js\":\"374f6a34fe3dc518\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/blockType.js\":\"e29ddf733eafa4a6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/charCount.js\":\"712db47cd46db434\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/dataExtension.js\":\"cc85044a78a09c2f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/index.js\":\"5eaf3ffed96270fe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/profiles.js\":\"84a2d99a808ed104\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/properties.js\":\"e22da61deab820ef\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/subtree.js\":\"70b10f7f75ed269e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/character-counter/textCounts.js\":\"e76fa8467f015360\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/colemak-keybindings/index.js\":\"1ee69591c1750326\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/CommandPalette.js\":\"cf11662f4d1735ae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/HeaderItem.js\":\"01c893b3a571b34c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/context.js\":\"738cb5efaa93beb5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/index.js\":\"ccf3fe82740d61fd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/selection.js\":\"8e21fc76cab73a1f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/toggleStore.js\":\"544b27032d7920b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/command-palette/useCommandPaletteActions.js\":\"f12af1e4e1ca57cd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/ContributorBadges.js\":\"f00767804945fca9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/ProfilePicture.js\":\"9ab9ce144e542910\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/author.js\":\"433417232f8b462b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/codeMirrorExtensions.js\":\"0b4c62300d54939b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/dataExtension.js\":\"a14e26a41434ba6e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/index.js\":\"2a275858f5fc27a9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/mentionAutocomplete.js\":\"8338ad7cb20dec0a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/processor.js\":\"86eb304fc85b6000\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/profiles.js\":\"628ec66bfd12396b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/queries.js\":\"8b78c6c4b0b204b2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/schema.js\":\"14a773394f33b8a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/contributors/useCommentAuthor.js\":\"730de9612cb6afca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"ce295737234924a4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/followOrigin.js\":\"13dae76084ff20eb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/index.js\":\"1fdc18cdb3099fd0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0e062e3ba375b9d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"8208042c28e0476a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/CalendarGrid.js\":\"5230f8781583bdbe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DailyNotePicker.js\":\"2366c69a0560934e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"4cac38a76c6934cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateNavDecorator.js\":\"d85f12e4567483d4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DateScrubOverlay.js\":\"c31af4978cc5e6cc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DayPropertyControl.js\":\"c7bb0cb0a5950123\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/DayValueReferenceControl.js\":\"6510c58a77bcbb62\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/HeaderItem.js\":\"69244539d62e1c31\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/ReschedulePicker.js\":\"e503cf3c16506a76\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/SpreadDatesDialog.js\":\"825760629cc620be\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/actions.js\":\"7712f08165b9797e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/blockDateAdapter.js\":\"6c024cf543d81ee0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/calendar.js\":\"0caaf5d4d2d09934\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dailyNotes.js\":\"70d56bf147eb2fba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dataExtension.js\":\"02fdb81b722ea618\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubActions.js\":\"6d74e86e69f44645\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubGesture.js\":\"89162fe147d38497\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubGestureActions.js\":\"ed4d31b4a4b8525b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dateScrubRecognizer.js\":\"f1d3ee18e6162f50\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dayProperty.js\":\"2b058826c445ee27\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"c054be87805dbbc3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/deletionGuard.js\":\"4027ebd3c9c1269c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/dueQuery.js\":\"ebf76d0aae019188\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/index.js\":\"4fef14a3552143b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/landing.js\":\"89877d8663f5ec96\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/localSchema.js\":\"66d02fb6702bd112\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/referenceDateAdapter.js\":\"4eb5037f374b740c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/rescheduleAction.js\":\"a5f1edfcb41bff2a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/schema.js\":\"6f403a697e3f4a6e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/spreadBlockDates.js\":\"a4306a6fa32f9ced\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/spreadDatesAction.js\":\"11c3e6afe39d842d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/today.js\":\"dd923ed700bcd7f3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3e2dc2a8a13a67f3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"c13017d806f63dd6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/audit.js\":\"a89fbb644f3e5630\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/auditAction.js\":\"8d1b81f28a14da3e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/auditRanges.js\":\"95e0b7ee1605a034\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/diagnosticsSource.js\":\"4a05233152bb766a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/divergenceScan.js\":\"af6cbb1c289d79d2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/index.js\":\"1f1539e12a29553d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e4de5aacb600f158\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/referencesMirror.js\":\"1329146d1468de4d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/rowJson.js\":\"ed27abcd891f3106\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/schedule.js\":\"f3c62780ed3bb65c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/data-integrity/store.js\":\"fc3fb0c22287ed76\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/action.js\":\"d8dea37a84e17f39\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/index.js\":\"9f539dca0498982b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-maintenance/plugin.js\":\"9c9d449eafbaaeb9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"b7b6075657a3d6cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/actions.js\":\"c5355d82bebc6b4c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/changeMarker.js\":\"62afac6bb686f884\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/diagnostics.js\":\"674b6f3687623448\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/fileSystemAccess.js\":\"73a8c6d426e64afa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/filenames.js\":\"82236f07dc136e57\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/index.js\":\"0e42557601e2c0cd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/mirror.js\":\"33f7bdce0acab482\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/runLock.js\":\"9ebb697be6a22b90\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/runtimeHealth.js\":\"df068437f7f5e118\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/schedule.js\":\"5f7b17f9287d819d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/db-mirror/store.js\":\"b6673fabcf175f1a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/default-themes/index.js\":\"bb1f30d22dd3f2d7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/default-themes/themes.js\":\"151d85a855cce34f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/diagnostics/facet.js\":\"635630dfc4ec0461\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/diagnostics/useDiagnostics.js\":\"184c50e553986f53\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/dismissals.js\":\"c6b552179cd2c5c0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/index.js\":\"906cc5f90f892652\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/status.js\":\"94e5dc1688488036\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extension-prompts/store.js\":\"2b0cf334e60fa4a8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4dcf8c500c9117a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/ExtensionsSettings.js\":\"5371d5955360eb90\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/actions.js\":\"11611491183287e1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/config.js\":\"4cc0a19f6716fae3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/dataExtension.js\":\"b55975aabafaa4f3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/effect.js\":\"257820acccf0f0e5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/index.js\":\"5f3234d7fa8f5994\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/propertyEditorOverride.js\":\"79837904ede56715\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extensions-settings/useToggleTree.js\":\"0bc9153fe64d684b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/ExtractTypeDialog.js\":\"db8284f3c526ad01\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"5c0a9bcdeb2ac8e0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/PropertyShapePicker.js\":\"2659b5b4a46c3e0b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/action.js\":\"b61d5256f83ca59b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/extract-type/index.js\":\"f6183725839d8878\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/FindReplaceDialog.js\":\"fe3a0fdca0bedbca\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/HeaderItem.js\":\"00a44b986f071b1b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/dataExtension.js\":\"cd9548a99d19b18b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/index.js\":\"6a3a32e9424ea43a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/search.js\":\"84489f26a51494b2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/toggleStore.js\":\"273867e3a0e4b6c5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/LocationPropertyEditor.js\":\"005d0b38d799e4f7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/MapView.js\":\"c5af61f093c9d5b0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/blockTypes.js\":\"25c12b0bf1fbdb58\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/codeMirrorExtensions.js\":\"7c42c719d89fa129\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/createOrFindPlace.js\":\"c8a06d84f860a4ba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/currentLocation.js\":\"63c9181b1a402e59\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/dataExtension.js\":\"a844c69efb310669\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/geoContentDecorator.js\":\"0bb7843d834daedf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/googlePlacesClient.js\":\"000d651258dcdd5f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/index.js\":\"c42078d1249c1222\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/locationsPage.js\":\"ed0d31d8b60ce700\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/mapViewport.js\":\"4858bc1e210e0007\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/pickCurrentLocation.js\":\"48e0ad3b45a16a0b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/placeAutocomplete.js\":\"c9c0626393d1da71\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/placeNameCollision.js\":\"58e033be1269a86a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/properties.js\":\"6f8d2eb6682b2edf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/propertyEditorOverrides.js\":\"34350a1cbcdac424\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/query.js\":\"348df48f75d3a1df\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/geo/usePlaceSearch.js\":\"8c6cc0ce430b7a29\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"5ec548023d3b75f4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"563aec6499ffeb9b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"f16f0f3105c6d0d8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/config.js\":\"167e81cea7bbd777\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/dataExtension.js\":\"9d72ccb6b5bc037b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/facet.js\":\"928a87822e18a9eb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/grouping.js\":\"f0847525fc4505ac\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/index.js\":\"39bd52d294b3a3cb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f06f499a8f08c4fa\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/query.js\":\"d9f561d3b71fd2a0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/resolveConfig.js\":\"22be2744c1fbc5d4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"523e823a69ab93e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6e8430ef82a80c57\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/HtmlDocumentContent.js\":\"34ed97b77c0676ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/HtmlFrame.js\":\"b854d3caa3802535\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/actions.js\":\"56d82c9325670e39\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/blockType.js\":\"8f24f53064dcc010\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/confirmRunScripts.js\":\"45cb0564df0a0bf5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/dataExtension.js\":\"37fa4f46d36b0256\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameAnnotations.js\":\"967fe99e73a7cf92\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameDocument.js\":\"e74fd7e2245005cb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/frameTheme.js\":\"45f92993b7824634\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/index.js\":\"176ba3b030a691c9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/scriptConsent.js\":\"7f53a4bade3701d0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/sourceMap.js\":\"09bb13d4447cd86e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/html-document/useDocumentScripts.js\":\"e3223d35e34770b9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/index.js\":\"512f461acad7fdf1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/record.js\":\"72e66ef777ef1cec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/recordStore.js\":\"b82e5821f442b83d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/responsiveness.js\":\"4e1fb1d9419f88bd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/schedule.js\":\"86d7445b1e65f3cf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/interaction-metrics/sessionContext.js\":\"1e0e78edd99dfb07\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"39d6cc4b2ec4b564\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c01bb6a2f3649769\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/actions.js\":\"20d2a900d9c11935\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/config.js\":\"2157fad3cb0e6dad\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/dataExtension.js\":\"06acd33e24a2c0e2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/effect.js\":\"42bccec22d70a65a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/index.js\":\"8a6ad641158df1ee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/keyCapture.js\":\"792b83c36a1a0e03\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/overrideStore.js\":\"7b8262f8aeaad9dd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"6f6cf82d8eec0009\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/HeaderItem.js\":\"fd9fe46289b770ad\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/LeftSidebar.js\":\"aaeec066a2a3c3f1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/actions.js\":\"ca992a8de78f8bb2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/facet.js\":\"29be9f4a75d4cc16\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/index.js\":\"a4c21ff8a6349213\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/shortcuts.js\":\"1923694f016081fe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/left-sidebar/toggleStore.js\":\"4af5670e1a0697e8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/MergePicker.js\":\"a94ecd6abab25b1a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/index.js\":\"9e2d0378e29f8841\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/mergeAction.js\":\"55430c9c88557e93\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/merge-blocks/strategy.js\":\"fea71a3140d50a8c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/Button.js\":\"0013d03726254d74\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"be2260540ff64957\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/defaultItems.js\":\"89a9547ff5e69e18\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/facet.js\":\"ea35727b7e182872\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-bottom-nav/index.js\":\"1cd8f19097c63ec3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"b5c480b8c700239f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/actions.js\":\"e657449443b29111\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"b33e299ea103c066\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/facet.js\":\"14e30ad7cf53451c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/mobile-keyboard-toolbar/index.js\":\"06ef4c6ad16535c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/MoveDestinationPicker.js\":\"ce429766295e1062\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/blockSubtreeMembership.js\":\"5e7e2ba1d13de7e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/contextMenuItem.js\":\"3ff79772d14de45f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/index.js\":\"ede1b35219654c91\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/moveAction.js\":\"a974eaca5709ef91\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/moveBlocks.js\":\"ec4339234aab590e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/move-blocks/selectionAfterMove.js\":\"daad665985f7e9cc\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/TutorialBanner.js\":\"4ab5e4698ba4c016\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/action.js\":\"bcbfa4d4cad26920\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/bannerDismissal.js\":\"e9fc1d1bc302ecae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/documents/cheatSheet.js\":\"3c7cdae2a955e25d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/index.js\":\"118c288d8aad1ef5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/keys.js\":\"9cee9107476cfd1c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/landing.js\":\"de40bcc406a3c821\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/outline.js\":\"866c23542deea8df\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/onboarding/seed.js\":\"628e2cd94dfdc87b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/PerfTrendDialog.js\":\"63cee55010b34633\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/analyze.js\":\"74453ec36e83fc60\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/diagnosticsSource.js\":\"bc76e20677ba86f5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/index.js\":\"b0483491fa65dd77\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/load.js\":\"d72f8fa05df5481e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/monitorRun.js\":\"20df227f2c3cccb6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/schedule.js\":\"b02df4ac3a51a31a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/series.js\":\"b36205e019502005\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/store.js\":\"6d764414d4815dd6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/trendAction.js\":\"1bb019eca8d6d0b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/perf-monitor/verdict.js\":\"179c35b5a5ca94e4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/clickToEditAction.js\":\"d614665f4641ae83\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/index.js\":\"be7ca77a94e7d6e8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/plain-outliner/interactions.js\":\"73d9a3aae3ed9531\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"faab14a35473ca92\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/MigrationGate.js\":\"9ab9475d562dffe9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/MigrationGateDialog.js\":\"0aaa5446cae94abd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/action.js\":\"cc7435cb3592ede6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/index.js\":\"4f155fe2b2dd25eb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/localRunMessage.js\":\"cf1bd2bd7d7c74b5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/plugin.js\":\"35a6e52d8d5a0206\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/progressReport.js\":\"90582b7e8622f95e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/properties-migration/sweepProgress.js\":\"e9e41a222b3abbf4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/FieldRowRenderer.js\":\"5bd23daf55843987\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/ValueRowRenderer.js\":\"b9b85164ec75c8d2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/actions.js\":\"797c11d52274f822\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/autocomplete.js\":\"5d7a8fd30793e353\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/fieldRow.js\":\"47720034f917a562\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/index.js\":\"7dce2bf44920d2c1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/referenceWarning.js\":\"b3cd07e63b918a65\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/valueAutocomplete.js\":\"a5b069bb5604b7e9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/property-rows/valueSchema.js\":\"1893182e8a1cfeb7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/HeaderItem.js\":\"11d469a6146eee6c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/QuickFind.js\":\"2ba7bfa4c9e8a10d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/index.js\":\"6a1de3e6222f6072\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/recents.js\":\"d45a3f2b97a1bfb3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/resultItems.js\":\"931c101dabf382d2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/selection.js\":\"f802142be7f1680a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/quick-find/toggleStore.js\":\"ea726eb00fbf3b46\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/HeaderItem.js\":\"09651d915d6579ab\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/RecentsPageBlockRenderer.js\":\"1fe7a0f25d8117a4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/grouping.js\":\"5499580dee3513eb\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/index.js\":\"b8bab850c43354c4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/recents/target.js\":\"c2bb5e0cae5bb5f5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/codeMirrorExtensions.js\":\"ee26e8bcd927e340\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/contentPrefill.js\":\"b5a6d8129358c798\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/dataExtension.js\":\"3ba2ff40fa384892\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/index.js\":\"140e387d9574c316\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"9e2252f58fe37277\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/invalidation.js\":\"218b2764f13662f8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/localSchema.js\":\"987f07b09ee5f6db\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/blockrefs/index.js\":\"e0557478d0207507\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"1f7968d1abcb02d6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/index.js\":\"4c671d9f1a65334d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/referenceNode.js\":\"763f0ec3e08fc3d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/remark-reference-occurrences.js\":\"b0763dc44ad03dec\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"25a511fccbda769b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/index.js\":\"f66126a5b069c53f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"992a57dc4fbba0c9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"ccd6b1d25b6ef6e2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/mergeRetargetProcessor.js\":\"5e395cb1a2d0f29b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/parseFence.js\":\"e530835171463776\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referenceParser.js\":\"80aef2e91ea769d1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referenceProjection.js\":\"2a5932ede4362f16\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/referencesProcessor.js\":\"db89533e630a7f80\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/renameProcessor.js\":\"1a3850f1d7ab040c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/references/spanReplacement.js\":\"debce0ac94cfa81e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/htmlToOutline.js\":\"bb21f2f2dd5f4a7c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/index.js\":\"16612365aec4a0e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5cf45e6ef6bfbe55\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/rich-paste/pasteDecision.js\":\"d8b34c1113d5fb74\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/action.js\":\"91ced11ef4aed36b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/blockIds.js\":\"23179e4dc7beb4ae\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/content.js\":\"6533742b8df8fee2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/effect.js\":\"f5bad110fe0821be\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/ids.js\":\"c2fbe2204516ceb5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/import.js\":\"f8cebe5294242898\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/index.js\":\"7527e5cdb73449d9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/plan.js\":\"6d2da4f4366e3cb8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/plugin.js\":\"d2d46f4bdd7492f8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/promotion.js\":\"fac89c3821ff7e2f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/properties.js\":\"465d0325e4b0e4b6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/references.js\":\"b290835c150580bd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/report.js\":\"9e0c801c8027e1ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/roamMemo.js\":\"9b7254c02f470e5d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/runtime.js\":\"ac9b873cb1803e92\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/schemaReconciliation.js\":\"673f7c56b419cd75\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/srsMarkers.js\":\"0e8270571a85bc4d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/todo.js\":\"5d30eb8f051e5915\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/typeCandidates.js\":\"b5f108b3d7771838\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/roam-import/types.js\":\"fe8e12ef6d6a45c6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/search-health/index.js\":\"e3817c3b54cf0fda\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/search-health/store.js\":\"addc1d53a0613160\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/HeaderItem.js\":\"0c6fe652ce02eeda\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"13ddb237e8d949ba\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/index.js\":\"f7c5415f409c1169\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/model.js\":\"f5c0d04325d28437\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/toggleStore.js\":\"58de2718c9033207\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/shortcut-help/useKeyInspector.js\":\"01b2cd4df4f33c86\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"80ee32e73b5e8cbd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/ShellDecorator.js\":\"13d340c6a1451fb3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/actions.js\":\"a52cda92fe97c3b0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/exclusionsFacet.js\":\"4f81860e74992914\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/index.js\":\"85795638c62bbd8e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/shell.js\":\"e97297b34245c30d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/surface.js\":\"ede5d84ee8d8b2e7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/spatial-navigation/walker.js\":\"a7d705f5f78e769a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/RescheduleToast.js\":\"580830a5db58ddfe\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/dataExtension.js\":\"5c91fdcd0a399bd0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/index.js\":\"0f17aa5d89a9e7a1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/indicator.js\":\"2605d5a7b3181f8b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/moveSrsState.js\":\"e8a2cba0043c8c28\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"aeaec2c4483dcce2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/scheduler.js\":\"4c36ce2cdd51503f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/schema.js\":\"c94ac8d76766a9d6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"8b593b9e888b2e0b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/srsClipboard.js\":\"9222e43dd4e356c8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"33048f4516327a28\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/DailyNoteReviewHint.js\":\"cb49e2bed40cd131\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/DeckPicker.js\":\"00287ef192e23b49\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewControls.js\":\"7c60cdf7e4b59bb2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewDeckRenderer.js\":\"90511610692a9fe3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/ReviewSession.js\":\"ada01e0ab3555920\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/actions.js\":\"1aa2cdbd296a28c2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/archive.js\":\"a9d85169ac4dbc65\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/dataExtension.js\":\"27c53b4221732b48\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/deck.js\":\"852d0b3c2b4d7e25\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/dueQuery.js\":\"aa0b2e6833248f23\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/gradeDecision.js\":\"44731f454ac1cf4b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/index.js\":\"011f46d8c64b6671\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/keyHints.js\":\"16cf6a69d102bd32\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/reviewCardLayout.js\":\"5d91217a01b48534\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/reviewProgress.js\":\"4deeae68173be587\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/schema.js\":\"06f48f3d66248aac\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/srs-review/useDueCards.js\":\"6d54d74fccfee116\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/startup-metrics/index.js\":\"0206c0517f3676b0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/startup-metrics/record.js\":\"56519dbb9064bda9\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/index.js\":\"b19176f8a198596d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/persistenceStatus.js\":\"f19eaac3e683b212\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/storage-persistence/requestAction.js\":\"593af05d9e7e7983\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/TypeChipsDecorator.js\":\"b2d78620b51345bf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/codeMirrorExtensions.js\":\"5223cdbed76c6b53\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/index.js\":\"92d7efbf59cb55b4\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/supertags/typeAutocomplete.js\":\"9521b43d69ef4f80\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"fb47c07a53da23e8\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/actions.js\":\"6a1baba4829334b6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/anchor.js\":\"e8257b2295370969\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/events.js\":\"d9b1ffe568ae4146\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/gestureActions.js\":\"d85e7004909cf6ad\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/index.js\":\"5eb06c1b138348b0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e1f6e259594dc6a5\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/collect.js\":\"fff2198a34b4d4cd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/index.js\":\"86c49e0ff57f9e2e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/sync-metrics/record.js\":\"202fd002b243629b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/RejectionDialog.js\":\"eaffc83180948bce\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/SystemStatusHeaderItem.js\":\"d52f7553b91d9fe2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/index.js\":\"287e9e6b7d47e2e6\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/model.js\":\"1576f84210f61b3e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/queueCounts.js\":\"9f1945d4181a1377\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/rejectedHelpers.js\":\"6695a95708e28ab0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/rematerializeAction.js\":\"1b30e0638adb9af2\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/system-status/useHysteresis.js\":\"df21b9b116f34307\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/ColumnHeaders.js\":\"3a3d66f438174899\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/QueryUi.js\":\"fb37cefb4c2f0603\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/TableLayout.js\":\"e7f83abe00cf66ac\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/actions.js\":\"ff0f71dd4aba0c4b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/cellEdits.js\":\"5353a4549db9c26e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/childrenViews.js\":\"ee7f6d4ddf85e89b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/columns.js\":\"d7197328bfaf657d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/controller.js\":\"0102df9e9bae4b85\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/convert.js\":\"35777a66757e3eb0\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/dataExtension.js\":\"25e1d60e56cffe46\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/index.js\":\"012b2799e7308b7d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/keys.js\":\"05c72d980b812a41\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/model.js\":\"da4bcf44e6b1098b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/QueryText.js\":\"ac77570caa34a168\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/backfill.js\":\"55aadcb04e0e2c53\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/completion.js\":\"e612c409e595e570\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/format.js\":\"9bd34b7fe2a0ac91\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/parse.js\":\"4b295e83e8260e0a\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/queryValue.js\":\"fa593650f273f7ff\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/registrations.js\":\"633d04956c691638\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/query/source.js\":\"fa315431ab57c994\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/registry.js\":\"a88e7dc96388af7f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/rowGutter.js\":\"6bd1c07e3182f367\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/rowVerbs.js\":\"848258be00954956\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/schema.js\":\"6f4547f1e5d5a237\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/tables/sort.js\":\"e874aea38b92a0ea\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/effect.js\":\"57adffcacb01946b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/index.js\":\"052cd5a324f06741\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/theme-toggle/theme.js\":\"05c3b62cf62a3994\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/actions.js\":\"b68afbb995809529\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/dataExtension.js\":\"4e99849c83ae8a6f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/index.js\":\"2dec51845655651e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/todo/schema.js\":\"9c62962f7321194f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/TouchSelectionLayer.js\":\"da0a7926e94fc7dd\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/actions.js\":\"13a3bddcf19e218e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/defaultItems.js\":\"e72e429fcdea5563\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/facet.js\":\"55c4f5a110bb82a7\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/holdRecognizer.js\":\"91afc734188c800b\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/touch-selection/index.js\":\"a7ba413f5f2f99ee\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/UpdateIndicator.js\":\"714d9109c4292065\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/index.js\":\"746b14f9262d201e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/update-indicator/loadTimes.js\":\"5eb96136170db318\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoNotesRenderer.js\":\"8de4a994aa443f00\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoPlayerRenderer.js\":\"8c041fd726ab8e46\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/VideoTimeStamp.js\":\"04e2d94aaad6db9c\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/actions.js\":\"36681b03de85927f\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/index.js\":\"658c6ebd5f65b39e\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/markdown.js\":\"a3a185b73033db70\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/notes.js\":\"a954de19c701d579\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/registry.js\":\"d93b5ae796318608\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/remark-timestamps.js\":\"32f982e43b4292f3\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/video-player/view.js\":\"f8cab7a5e8ff9e96\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/LinkHints.js\":\"56d79fef1422ad63\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/index.js\":\"0cd4bed0e7860a3d\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/model.js\":\"577c978c9a1c9b29\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-link-hints/settings.js\":\"0a420a21aa2a0791\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/actions.js\":\"15c59a255aa09cd1\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/index.js\":\"e06735d6fe82b777\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/vim-normal-mode/interactions.js\":\"788741dc73b1bbbf\",\"/knowledge-medium/pr-preview/pr-1920/src/plugins/workspace-header/index.js\":\"373f53900d0e7882\",\"/knowledge-medium/pr-preview/pr-1920/src/registerServiceWorker.js\":\"00dcecf8c5697bd7\",\"/knowledge-medium/pr-preview/pr-1920/src/requestPersistentStorage.js\":\"17c797f1bc2633ea\",\"/knowledge-medium/pr-preview/pr-1920/src/services/authRequestDeadline.js\":\"de15a3ea6d133baf\",\"/knowledge-medium/pr-preview/pr-1920/src/services/authStorage.js\":\"5ba84702602c64df\",\"/knowledge-medium/pr-preview/pr-1920/src/services/powersync.js\":\"2e75aab8d6906a92\",\"/knowledge-medium/pr-preview/pr-1920/src/services/supabase.js\":\"788fdd25efdb4ba8\",\"/knowledge-medium/pr-preview/pr-1920/src/services/uploadErrorClassifier.js\":\"375ec1743670f6c5\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/ActiveContexts.js\":\"4b8c4b2bfb0edf60\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/HotkeyReconciler.js\":\"9d473fdf752bbe5e\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/WipeLocalDataDialog.js\":\"845b012130113259\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/actionDispatch.js\":\"e3769d6b12ab864b\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/actionRefItems.js\":\"23f6b161b8908a5c\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/applyKeybindingOverrides.js\":\"5d78bfc26d564a4e\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/blockActions.js\":\"ee9c356e9baa50d7\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/blockMergeGesture.js\":\"497072d6f98ef948\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/canonicalizeChord.js\":\"27f74f7c897316e8\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/defaultContexts.js\":\"c76817570c31182b\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/defaultShortcuts.js\":\"13e56d66d4ec5920\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/effectiveActions.js\":\"2ad20cc1a46e917f\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/gestureAction.js\":\"4112bf648274b785\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/gestureBinding.js\":\"d216b0a4017a996a\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/holdRegistry.js\":\"57d419e3c91b3918\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/keybindingConflicts.js\":\"b8b73e5e5140e284\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/keybindingOverrides.js\":\"a6aca5c2c6119bb3\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/pointerAction.js\":\"97077ac2f4ace118\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/resolve.js\":\"7f3e31cd8c8469cb\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/runAction.js\":\"08b08ef334ecedb9\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/sequenceMatcher.js\":\"1611da16b7bde185\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/types.js\":\"747d5efa7272474d\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/useActionContext.js\":\"e2c0e98df4412cf3\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/useActionDiscovery.js\":\"0d587f43130e20e5\",\"/knowledge-medium/pr-preview/pr-1920/src/shortcuts/utils.js\":\"6e3e1f2605c3aaf4\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/bootStore.js\":\"149e53e1aaf98694\",\"/knowledge-medium/pr-preview/pr-1920/src/sw/previewDatabases.js\":\"59850d4237a32804\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/byteTransform.js\":\"67e41dc387d4e9dd\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/attachmentCleaner.js\":\"fd498ad5db340010\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/attachmentParts.js\":\"6c6dd3ca4e734c03\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/bundleParts.js\":\"88f4eafe35d9df39\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/bundleRecord.js\":\"4f437ecd7a4434ae\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/manifest.js\":\"dd10afa48e1bf5d9\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/takeBundle.js\":\"b6fa6178804eaf53\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/bundle/verifyBundle.js\":\"0efaab8e8b9d948d\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/cleaningStage.js\":\"458989817879f043\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionKey.js\":\"5e23e131458fbb7c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/conversionServer.js\":\"870121e46a4293f4\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/flip.js\":\"2c9e5310a6f355f0\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/flipAttempts.js\":\"a5088fdab7e425ed\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/pages.js\":\"9585160049538ce1\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/preflight.js\":\"3700d7f299050245\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/reseal.js\":\"ebe3ace782ea64d6\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/runConversion.js\":\"be5028e4a6839e84\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/runLock.js\":\"282c578da0342a9c\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/sealing.js\":\"a06bd8243a61c286\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/sealingStage.js\":\"5331dbab5fd99679\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/stage.js\":\"da57956ca537e655\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/conversion/verifyReseal.js\":\"ca8e7ae857937e05\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/aad.js\":\"e76ee5c7f2607d8e\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/aead.js\":\"7203b9077e87da47\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/base32.js\":\"401144759b96cf7e\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/base64url.js\":\"368a582b6b4cdb5a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/binaryEnvelope.js\":\"0c53fdee9677ee99\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/byteAead.js\":\"31db43fa2cc8ee03\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/canary.js\":\"c66e80924e0e0adf\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/contentHash.js\":\"59d961643a1a4655\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/contentKey.js\":\"3cdfa477ac23accf\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/derivedIdNamespace.js\":\"c81ca58f5dad5bfe\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/envelope.js\":\"53a0a10c7657e29f\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/hex.js\":\"d59f91c0c8fba17f\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/sha256Hex.js\":\"c5b3cc12fb69daf7\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/crypto/workspaceKey.js\":\"722f66fa47f02d42\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/conversionState.js\":\"ea72034dd386d011\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/createEncryptedWorkspace.js\":\"09b5f6e261aa2b6a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/pastedKey.js\":\"f70d080cf7189d2b\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"3230e5fc66fee3cc\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/flows/upgradeWorkspacePin.js\":\"28e581fb03a934e5\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/keyStore.js\":\"6f672e23b2d20c87\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/mintWorkspaceKey.js\":\"a08e250c5d885007\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/modePin.js\":\"dca5d1c8f56beb7a\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/openWorkspaceKeys.js\":\"0af62b729266f9fe\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/resolveWorkspaceEntry.js\":\"bd8d24d89c86cebf\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/resolver.js\":\"8ac694ebf793e45d\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/keys/workspaceAccess.js\":\"382c6d0706e029ce\",\"/knowledge-medium/pr-preview/pr-1920/src/sync/transform.js\":\"4bddacde6704ddf4\",\"/knowledge-medium/pr-preview/pr-1920/src/themeBootDefaults.js\":\"f9433c3624ce45b3\",\"/knowledge-medium/pr-preview/pr-1920/src/types.js\":\"6cb87821b7d311b2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/ClientLocalSettings.js\":\"c9736f0a5f2bb7f4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/abortableSleep.js\":\"f505a2efa1b7d905\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/array.js\":\"1e7d3c33a9b703c0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/backlinkAutocomplete.js\":\"4fcff298c8e7d683\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/blockCrumbs.js\":\"c5f1ce36f220db0a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/blockrefAutocomplete.js\":\"52ec16c1e59542ce\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/cadencedIdleJob.js\":\"0127a9a6bff66a89\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/callbackSet.js\":\"619a096cb7c108ed\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/clientId.js\":\"8f207a5af12fe3e3\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/codemirror.js\":\"647d99478a7030da\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/codemirrorCompletion.js\":\"de245569a8564874\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/copy.js\":\"1879c155ae17f4b6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dailyPage.js\":\"d715947d37130a37\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dbForensics.js\":\"40edda73d129f893\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dbForensicsHooks.js\":\"9dcdbcccf55e2b70\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/deleteBlockThroughUi.js\":\"cc02b956e2ada558\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dialogs.js\":\"464dbc64b38756eb\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/dom.js\":\"00993803025c13a1\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/downloadBlob.js\":\"2c1021cbff1be940\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/drawnWalk.js\":\"122f4e4d1dd048a9\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/exportSqliteDb.js\":\"ccfd6ff386d3f9c0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fileSystemAccess.js\":\"a8fdec513c4e3e2b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/flipSlide.js\":\"99bed779174d0f28\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fnv1a.js\":\"8cc56476c8faf3a5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/formatBytes.js\":\"529a27e76b3413f8\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/fuzzyRank.js\":\"9f3d3aa2370cc098\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/idbKeyedStore.js\":\"96a91185fdeb6429\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/idleCallbackPolyfill.js\":\"de7be4ed59583d23\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/keyboardAwareScroll.js\":\"1b5f9834c8e5b6f6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/keyboardViewport.js\":\"24b5cf91491de8bb\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/lastWorkspace.js\":\"b1d0b0ae19a55d04\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutColumns.js\":\"0e4005285f57558a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutSessionDom.js\":\"3537a8f5f5a308c2\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/layoutSessionId.js\":\"8bd37bcca460998e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/linkClickGestures.js\":\"49436c0e6fb42093\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/linkTargetAutocomplete.js\":\"528ad649a5276da7\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/localDbCorruption.js\":\"0bfeaf0bc565f9b5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/localDbRecovery.js\":\"1391c13afb2ec6c7\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/markdownParser.js\":\"a875a18584eac607\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/memoize.js\":\"7ca45fc0a0d64d8a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/nameFieldCommit.js\":\"059cf924c7e21924\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/nameList.js\":\"887bcd2b7bd83a2d\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/navigation.js\":\"06efcd2bfc69dc1c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/omnilinerNamespace.js\":\"d2217cd4d6b6d50c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/opfsPageScan.js\":\"ff07632c5430d27f\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelClearance.js\":\"00b29caafddf5f71\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelHistory.js\":\"a68cc98ef9d6e36b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelLanes.js\":\"8ec5f278a9615c53\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelLayoutProjection.js\":\"00e3f1bdbb305c1a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelScrollAnchor.js\":\"c087e7d9a1894215\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/panelUrlFlags.js\":\"8871b49c93359b91\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/platform.js\":\"57d892351ee26efd\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/pluralize.js\":\"04b5701432449416\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyCreation.js\":\"fd53cf0c796de980\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyNavigation.js\":\"8503586c9df36bbb\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/propertyValueContext.js\":\"c850e2327e39f85e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/react.js\":\"1da69481a0b66361\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/relativeDate.js\":\"7ee1d418b34e5532\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/relativeTime.js\":\"1164c175e1031e34\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/renderScope.js\":\"291f4a3deb3140ba\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/resolvedThenable.js\":\"e453e46a46079126\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/routing.js\":\"dff287222cf2027c\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/safeMode.js\":\"0d88f27972151e4a\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/scheduleIdle.js\":\"4a0d15af5b31f6d6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/screenWakeLock.js\":\"e42358df3b4533b5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/selection.js\":\"f409a67b897d1ee5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/softKeyboardGrab.js\":\"00cd4d477123754e\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/startupTimeline.js\":\"2122c1f58c31a1d0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/state.js\":\"9ee0abf46f7a30a5\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/string.js\":\"5d53cda98f37a5d0\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/surfaceZoom.js\":\"8a572f3f469e9503\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/time.js\":\"7ef81bc769f548a4\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/toast.js\":\"f288b010034b6d56\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/toggleStore.js\":\"05541282898ec73b\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/untilStopped.js\":\"f06a5efeff68f707\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/userActivity.js\":\"2e7491ed094c0412\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/viewTransition.js\":\"30b2762b78b8dc84\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/viewport.js\":\"aae2df6beac652d6\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/webLock.js\":\"26665556f8ffbfd8\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/workspaceRecovery.js\":\"6cfbb529b239c3d9\",\"/knowledge-medium/pr-preview/pr-1920/src/utils/workspaceSnapshotStore.js\":\"88f7cf64c3360209\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-compiler-runtime.js\":\"b06983d8c40babda\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-client.js\":\"b911a80b0a60328f\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-server-edge.js\":\"9cc084bf98afb2e0\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-server.js\":\"d8c1fd694b20b090\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-static-edge.js\":\"49573605fde2c717\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-static.js\":\"ea0b850c8cb0525b\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom-test-utils.js\":\"b48b3fb086f15289\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-dom.js\":\"30f0615c646d8c89\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react-jsx-runtime.js\":\"0276ab23c359e6c7\",\"/knowledge-medium/pr-preview/pr-1920/src/vendor/react.js\":\"7ffdd6167dec743f\",\"/knowledge-medium/pr-preview/pr-1920/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1920/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1920/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
