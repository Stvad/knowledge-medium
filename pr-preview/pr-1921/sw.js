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
		buildId: "140f806e3a26-1107000e",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1921/\":\"27492db1e1b0ba92\",\"/knowledge-medium/pr-preview/pr-1921/index.html\":\"27492db1e1b0ba92\",\"/knowledge-medium/pr-preview/pr-1921/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1921/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1921/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1921/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1921/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1921/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1921/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1921/assets/FacadeVFS-BSSFManE.js\":\"5fc209f8909bbd04\",\"/knowledge-medium/pr-preview/pr-1921/assets/OPFSCoopSyncVFS-BWYhYPoN.js\":\"a67dc3aa987e26ac\",\"/knowledge-medium/pr-preview/pr-1921/assets/OPFSWriteAheadVFS-DB5pqBw9.js\":\"5fe1ba94d607c545\",\"/knowledge-medium/pr-preview/pr-1921/assets/wa-sqlite-B8aphSl5.js\":\"703651b05f6bea52\",\"/knowledge-medium/pr-preview/pr-1921/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1921/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1921/assets/wa-sqlite-async-D64yV3qD.js\":\"01cbeba0fccf8bbd\",\"/knowledge-medium/pr-preview/pr-1921/assets/worker-Ck7hjOUP.js\":\"73869b210ad51017\",\"/knowledge-medium/pr-preview/pr-1921/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1921/chunks/app-CcTNgYAa.js\":\"bcc86250128217b6\",\"/knowledge-medium/pr-preview/pr-1921/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1921/index.js\":\"ca2ece289c3fc684\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1921/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1921/assets/AccessHandlePoolVFS-AsI7DUzD.js\":\"7626f7d1a56f24db\",\"/knowledge-medium/pr-preview/pr-1921/assets/IDBBatchAtomicVFS-Cc0Oqw0F.js\":\"55c7f3a865b8a4c0\",\"/knowledge-medium/pr-preview/pr-1921/assets/MemoryVFS-Dp9vGCDl.js\":\"29f6dc13ec2d97bb\",\"/knowledge-medium/pr-preview/pr-1921/assets/mc-wa-sqlite-Bx6eVRBz.js\":\"54cb7f77acbd34ae\",\"/knowledge-medium/pr-preview/pr-1921/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1921/assets/mc-wa-sqlite-async-ClkCeJ0m.js\":\"d72f02038007f076\",\"/knowledge-medium/pr-preview/pr-1921/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1921/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1921/chunks/AccessHandlePoolVFS-BSA2cVoW.js\":\"e7b1ba67bd3d85fa\",\"/knowledge-medium/pr-preview/pr-1921/chunks/FacadeVFS-DTQOhkeH.js\":\"4dd65c0c690e8522\",\"/knowledge-medium/pr-preview/pr-1921/chunks/IDBBatchAtomicVFS-B9G6CDJk.js\":\"f906448402758aea\",\"/knowledge-medium/pr-preview/pr-1921/chunks/MemoryVFS-1MjvGCIZ.js\":\"bed3d4c954a7e5c1\",\"/knowledge-medium/pr-preview/pr-1921/chunks/OPFSCoopSyncVFS-BeypIr3p.js\":\"397eae5592a52377\",\"/knowledge-medium/pr-preview/pr-1921/chunks/OPFSWriteAheadVFS-CqHEf9Ly.js\":\"3a06ec7588e45f36\",\"/knowledge-medium/pr-preview/pr-1921/chunks/Preview-CbVq5vp_.js\":\"6294b20d655750f9\",\"/knowledge-medium/pr-preview/pr-1921/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1921/chunks/card-iVk1v_2Q.js\":\"177eb8c048b6a581\",\"/knowledge-medium/pr-preview/pr-1921/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1921/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1921/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1921/chunks/dist-hPoWwgSW.js\":\"7050171905878a88\",\"/knowledge-medium/pr-preview/pr-1921/chunks/freezeExtensionImports-BthjTNMK.js\":\"e4eb377bc33f889c\",\"/knowledge-medium/pr-preview/pr-1921/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1921/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1921/chunks/mc-wa-sqlite-CxdNIsVX.js\":\"f36580c5247eea11\",\"/knowledge-medium/pr-preview/pr-1921/chunks/mc-wa-sqlite-async-C4_YJ2Kx.js\":\"f2b50794c0f7cc2b\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-B7oHcvZT.js\":\"7d9aa579e9c87301\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-BTSijSVA.js\":\"b3ce62e5c2847f23\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-Cltp069p.js\":\"28c47572138ba2f9\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-D6RzpdDD.js\":\"f0291fa12e66347c\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-DHBiMNqt.js\":\"c10ae0f79aedcdec\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-DcZ5E-UE.js\":\"3f95623943372976\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-dom-server-legacy.browser.production-BddAVY4J.js\":\"3ca80e257fc6bf6b\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-dom-server.browser.production-rD5ids8L.js\":\"738eba3b3d716c11\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-dom-server.edge.production-CvTX7R8R.js\":\"c010155020986a2f\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-qrV_H8y6.js\":\"51de4f54d72c5908\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-vHnNOHjS.js\":\"ccd357c84736e18a\",\"/knowledge-medium/pr-preview/pr-1921/chunks/server.browser-CIqEUzdF.js\":\"daf09e546e3b87d9\",\"/knowledge-medium/pr-preview/pr-1921/chunks/textarea-C1G_g8dv.js\":\"93e2897b68b60902\",\"/knowledge-medium/pr-preview/pr-1921/chunks/ui-1eoCJkSx.js\":\"e9c9a599ef5a4d1a\",\"/knowledge-medium/pr-preview/pr-1921/chunks/wa-sqlite-BkY7Qq5_.js\":\"48372a220e1c05b9\",\"/knowledge-medium/pr-preview/pr-1921/chunks/wa-sqlite-async-CAgCCju9.js\":\"a230a835efe7b4b5\",\"/knowledge-medium/pr-preview/pr-1921/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1921/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1921/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1921/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1921/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1921/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1921/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1921/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1921/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1921/src/App.js\":\"c9f202d26c5e5e6c\",\"/knowledge-medium/pr-preview/pr-1921/src/appUpdate.js\":\"0c4aecbc1fe842e9\",\"/knowledge-medium/pr-preview/pr-1921/src/appVersion.js\":\"ec71ac384b55e218\",\"/knowledge-medium/pr-preview/pr-1921/src/bootstrap/initialLayout.js\":\"c4857f8168ec10e9\",\"/knowledge-medium/pr-preview/pr-1921/src/bootstrap/openWorkspaceData.js\":\"0e2162f52a0d8988\",\"/knowledge-medium/pr-preview/pr-1921/src/bootstrap/resolveWorkspace.js\":\"3146f0796c8a6dfb\",\"/knowledge-medium/pr-preview/pr-1921/src/bootstrap/workspaceBootstrap.js\":\"1da30c6ee3cf62f8\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockComponent.js\":\"4312f583e6be9db8\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockCrumbs.js\":\"95c518ae1d60e163\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockEditor.js\":\"39f68950d89a8446\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockLoadingPlaceholder.js\":\"8ee70375bf2855a6\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockProperties.js\":\"78558493f7ffc2fd\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockSearchPicker.js\":\"c07275f2690f6c55\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ConfirmBulkDeleteDialog.js\":\"c04c4f2399542596\",\"/knowledge-medium/pr-preview/pr-1921/src/components/DividerHandle.js\":\"a509a9c92786f045\",\"/knowledge-medium/pr-preview/pr-1921/src/components/DraftEditor.js\":\"8b103b0f25e5762f\",\"/knowledge-medium/pr-preview/pr-1921/src/components/GutterPill.js\":\"6c21e312e15843eb\",\"/knowledge-medium/pr-preview/pr-1921/src/components/Header.js\":\"6f50ca34db0c0894\",\"/knowledge-medium/pr-preview/pr-1921/src/components/LazyBlockComponent.js\":\"77e3344dd4b0c1e2\",\"/knowledge-medium/pr-preview/pr-1921/src/components/Login.js\":\"f3d25f39aea56c26\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ZoomableSurface.js\":\"f2b139211f760702\",\"/knowledge-medium/pr-preview/pr-1921/src/components/editModeKeepalive.js\":\"da4dcf13369c4516\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyDisplay/PropertyDisplayScope.js\":\"2ef0d3280761a363\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"70e9b7be70b4742e\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/RefPropertyEditor.js\":\"cff27be8907158f1\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/RefTargetTypePicker.js\":\"332e065bddcaa72d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/SelectPropertyEditor.js\":\"22432b9b86325c5a\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/TypesPropertyEditor.js\":\"2610469b8dd60333\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/defaults.js\":\"fe1896030a9d977f\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/kernelValuePresets.js\":\"f31f7b9d8e4481ba\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/selectablePresets.js\":\"6d8c3a39f68dd005\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/typesPropertyUi.js\":\"e534c896c55da85e\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/AddPropertyForm.js\":\"dd7e92d0776063f0\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/PropertyPicker.js\":\"388a14d3c1fc85ee\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/PropertyRow.js\":\"3af8fbeb64a77f48\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/Rows.js\":\"dacd287766577546\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/actions.js\":\"53fc842e6334ed14\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/declarationOnly.js\":\"a585f05b7308b2cd\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/layout.js\":\"0bf5d31bac9d5384\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/model.js\":\"91325727019365b9\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/shapeUi.js\":\"b45b277e7d527e4b\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/shapes.js\":\"113fd7a2e6b04c31\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/usePropertyEditingActivation.js\":\"c0039c2011bd55af\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/visibility.js\":\"0156cfa8502ec748\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanelSections.js\":\"5fd5666fc59c5288\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/BlockEmbed.js\":\"cf6c5008ac88cffb\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/BlockLink.js\":\"b9cdf34bf0573d28\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/BlockRef.js\":\"3e6018ae3b6d1c4d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/CompactReferenceLink.js\":\"50ba362fff198e9e\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/ReferenceLink.js\":\"b3dfa1c6ab78f9e1\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/cycleGuard.js\":\"97ea3a7da564d666\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/cycleGuardContext.js\":\"6305789445704270\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/linkInteraction.js\":\"5fc33e49c1a62f17\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/referenceLayout.js\":\"7bc9d32aa677945b\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/useBlockRefAncestors.js\":\"f962f754f83528f4\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BlockGutter.js\":\"9af19c68f3d4ba54\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BlockInfoDialog.js\":\"87202d55650e070a\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BlockReadText.js\":\"6d8034a8943291e0\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BlockTypeBlockRenderer.js\":\"98fda072043e0628\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BulletHoverCard.js\":\"f4ce426966406581\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/CodeMirrorContentRenderer.js\":\"7283587a552d81a9\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"8102d97e49c9dcc9\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/ColumnResizeHandles.js\":\"d922f7fb796f4546\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"1d4476bb62d2b162\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/DefaultBlockRenderer.js\":\"c3c3164e7274ab40\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/LayoutRenderer.js\":\"65456b478cc45816\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/MarkdownContentRenderer.js\":\"db1bfccbf1dfb7bc\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/MissingDataRenderer.js\":\"f214fd9ff9ad5b38\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/PanelRenderer.js\":\"4e074d6258ba91b9\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/PropertySchemaBlockRenderer.js\":\"0e22787b4210f3bb\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/TopLevelRenderer.js\":\"993117302e172dd2\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/blockGutterMode.js\":\"711aca4d11654926\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/blockTitleText.js\":\"db9cd29f0272eacb\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/fieldCreationKeydown.js\":\"7715b1b9b4f01b11\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/layoutRootContext.js\":\"c1ad80ed80b72c4d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/typeChip/TypeChip.js\":\"5ab7841c14c7c86a\",\"/knowledge-medium/pr-preview/pr-1921/src/components/typeChip/chipStyle.js\":\"7b5009314d78ef2c\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/anchored-floating.js\":\"e7a611cc3b5789a1\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/button.js\":\"883a7129d838d297\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/card.js\":\"3fcf1a59a233d581\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/checkbox.js\":\"890d4afb63d48ef3\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/collapsible.js\":\"056a67d503294f7b\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/command.js\":\"32562dccf7b7172d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/context-menu.js\":\"c42c4082990b3515\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/dialog.js\":\"bd506625493379de\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/dropdown-menu.js\":\"1531398f961146af\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/floating-listbox.js\":\"ccac1e9e478b8973\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/index.js\":\"9bc8570880ebfc22\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/input.js\":\"c656cfccd797f71d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/kbd.js\":\"3af61fc749b70d31\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/label.js\":\"72dea69f16239d3f\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/textarea.js\":\"311461ac842382aa\",\"/knowledge-medium/pr-preview/pr-1921/src/components/useEditModeYieldKeepalive.js\":\"ddab61053181168d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/BootFallback.js\":\"82d538dc345cd5af\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/FocusedRowLazyMount.js\":\"ac8ea90a3c43604d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/LazyViewportMount.js\":\"6b226cc8f6f11eb3\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/LocalDbCorruptionFallback.js\":\"35a249329d55b49a\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/error.js\":\"1bbc8d48ba7c45ad\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/lazyMountRegistry.js\":\"00ca0c2901aebef3\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/suspense.js\":\"c5410a25132c15f5\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/CreateWorkspaceDialog.js\":\"5cc5065f6fd7c4b3\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/PendingInvitations.js\":\"8d47c0e3cf1fd5ab\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/SyncProgress.js\":\"d67de61f5766c883\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/UnlockProgress.js\":\"1638d12b0f555151\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/WorkspaceKeyGate.js\":\"80f81ebf1e2c3075\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/WorkspaceSettingsDialog.js\":\"169d70a77311b3c2\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/WorkspaceSwitcher.js\":\"4bfbf134dab0df62\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/WorkspaceSyncGate.js\":\"0fb5e445b5b8c0a5\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/ConversionFlow.js\":\"781b4707de845c20\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/ConversionFlowHost.js\":\"0956377981b24410\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/EncryptionSection.js\":\"40096efffbe79772\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/attachmentPrompts.js\":\"2c0f6d7006efe1f5\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0cbd295d2095b721\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/conversionFlowDeps.js\":\"998b0d0b622b1dd9\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/conversionFlowStore.js\":\"49e76aa32700ee91\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/flowUi.js\":\"79071ad51cc60b61\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/useConversionRun.js\":\"3fea0fc2e0ce3673\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/keyUi.js\":\"6fd3417a7d6c144e\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/useCloseOnKeyLoss.js\":\"03e25be0e7bd0317\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/useCloseOnServerE2ee.js\":\"dfb160ab4d7e3c53\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/workspaceUnlocked.js\":\"191971eff9b1ab39\",\"/knowledge-medium/pr-preview/pr-1921/src/context/backgroundSubtree.js\":\"d3a54ddec499a453\",\"/knowledge-medium/pr-preview/pr-1921/src/context/block.js\":\"59eaa1a7416c46a6\",\"/knowledge-medium/pr-preview/pr-1921/src/context/layoutWsContext.js\":\"4291aea56f915d00\",\"/knowledge-medium/pr-preview/pr-1921/src/context/propertyDisplay.js\":\"7a481e4e3fd8bb0b\",\"/knowledge-medium/pr-preview/pr-1921/src/context/repo.js\":\"643743183ec68f6f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/aliasClaim.js\":\"e9f979acfcf19590\",\"/knowledge-medium/pr-preview/pr-1921/src/data/aliasSeatNamespace.js\":\"5a38b1105b82c21a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/blockData.js\":\"875d86a8506998a9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/blockType.js\":\"9f78001061297ec8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/changeScope.js\":\"f18010e9713edb57\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/codecs.js\":\"2885b0e4da4ec8c4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/derivedData.js\":\"5ec15df365f5fc42\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/errors.js\":\"782f4e645b89a185\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/events.js\":\"40bc20bdea9bd111\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/handle.js\":\"fed61e3ec33dc921\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/index.js\":\"b77b144a6323ec74\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/mutator.js\":\"3d3dc1341bfa983e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/processor.js\":\"92a43afe42c89baa\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/propertySchema.js\":\"d2e9a2cdafe08acd\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/query.js\":\"0a704b41e43f0b0d\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/sameTxProcessor.js\":\"ee8bfeea6ad589b3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/schema.js\":\"fed61e3ec33dc921\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/tx.js\":\"fed61e3ec33dc921\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/typedBlockQuery.js\":\"158a4c6b19533e71\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/user.js\":\"0f57fe91fa9974c4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/valuePresetCore.js\":\"73e7e248234bee3c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/valuePresets.js\":\"d51fa3f7627df7c0\",\"/knowledge-medium/pr-preview/pr-1921/src/data/attachmentCleanerIOVerb.js\":\"ea140a66fe261480\",\"/knowledge-medium/pr-preview/pr-1921/src/data/block.js\":\"5eaac925d2a762e4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockCache.js\":\"69cde5c95f7459f8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockId.js\":\"d8a6179ffc974f4a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockLiveness.js\":\"c7c9902b6911bf1f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockMerge.js\":\"823c7b695e7722c5\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockSchema.js\":\"75e98a26d9532d03\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockTypeLookup.js\":\"e842fff7775d13a9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockTypes.js\":\"05e20a29687f5b1c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/childrenView.js\":\"84c2f703c2cd0891\",\"/knowledge-medium/pr-preview/pr-1921/src/data/clientContext.js\":\"6d7ceb78540f7043\",\"/knowledge-medium/pr-preview/pr-1921/src/data/dbFileSiblings.js\":\"8a24ffc323bf30f5\",\"/knowledge-medium/pr-preview/pr-1921/src/data/definitionSeeds.js\":\"f1f2bc4011598ce1\",\"/knowledge-medium/pr-preview/pr-1921/src/data/derivedIds.js\":\"ecb16ca1c3c2b4fd\",\"/knowledge-medium/pr-preview/pr-1921/src/data/drawnSubtree.js\":\"58ae9ca9d837ba62\",\"/knowledge-medium/pr-preview/pr-1921/src/data/facetBridge.js\":\"d9063c07415cf6cd\",\"/knowledge-medium/pr-preview/pr-1921/src/data/facets.js\":\"57f1569fa6509d62\",\"/knowledge-medium/pr-preview/pr-1921/src/data/globalState.js\":\"0050d2b641d10c2e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/aliasClaimRederiveProcessor.js\":\"a976752d345b1865\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/ancestorBatch.js\":\"da0f49cb19603abb\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/blockTypeTypeifyProcessor.js\":\"61cc42f13a3271f4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/clientSchema.js\":\"878ba73938981b4c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/commitPipeline.js\":\"fd9c227e30ab3e9e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/devAssertions.js\":\"fbbe59d1941ea520\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/firstSync.js\":\"87c666bcc1df7524\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/freshInitialLoad.js\":\"3fd856dcb1a09185\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/graphBackfillClaim.js\":\"b6805816056531cd\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/handleStore.js\":\"05448f5bc96e015e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/idleMarkerJobs.js\":\"cb12b61989c73fa0\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/initialDownload.js\":\"6c40ca1a1ee005f2\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/initializeClientDatabase.js\":\"612588720f60b32a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/jsonCanonical.js\":\"e7157d092fae2828\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/kernelInvalidation.js\":\"d5d13dbb38f3ae70\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/kernelProcessors.js\":\"5a93cd4f59ba313b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/kernelQueries.js\":\"0bbd6ec24ac5c778\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/mergeTypeMembershipProcessor.js\":\"e5adf0c4890ad54e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/normalizeReferencesProcessor.js\":\"d4e6075f9ab3ace4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/poolInstrumentation.js\":\"b87b6e4e8f16f608\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/processorRunner.js\":\"6aee44491b0d9e90\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyCellBackfill.js\":\"ee9ba5abb1903981\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyChildMint.js\":\"74ddad5c300f3ec9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyChildrenProcessor.js\":\"cd89555856944acc\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyDefinitionChangeProcessor.js\":\"8d95e5ce05c2ee74\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyDefinitionSynthesis.js\":\"0390af3ad18ad843\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyKeyScan.js\":\"fc607a1365fb5566\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertySchemaResolution.js\":\"a0277643e6a965eb\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyValueEdits.js\":\"9438f4ea5c034d86\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/raiseProtocol.js\":\"a0c3f81318c28c3b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/readBatch.js\":\"6dd23a990f21931c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/refProjection.js\":\"e1107dc950139719\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/referenceTargetLookups.js\":\"975592855e55bd9f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/referenceTargetProcessor.js\":\"658b7c7a79fbbe0c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/replayMerge.js\":\"bb1b2206e65bc734\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/sqlBinds.js\":\"6fb48968adc0b618\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"6db4dfcbaef9591b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/arrivalProcessors.js\":\"0e8e32e9fd78790f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/invalidate.js\":\"318bd5731d521a53\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/materialize.js\":\"9ef374e7fc0311a7\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/observer.js\":\"9fd236ec6151d966\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/reconcile.js\":\"e949baeeabdb37f3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/timingMetrics.js\":\"52532c7ba3c0eb8e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/treeQueries.js\":\"31b885ac5b58d1e8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/txEngine.js\":\"cf820e456ba8382a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/txSnapshots.js\":\"7de49b2a79ff666e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/typedBlockQuery.js\":\"53ea4a6419f20850\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/undoManager.js\":\"912d631bd20fe78f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/invalidation.js\":\"0eb36840b4400c26\",\"/knowledge-medium/pr-preview/pr-1921/src/data/kernelDataExtension.js\":\"85e9b7daefdf241b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/kernelPage.js\":\"2b63d6a2bd9d7c4b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/kernelValuePresetCores.js\":\"45056cc3f4bca4b8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/localDbCorruptionSignal.js\":\"6152597ab2961aa3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/localDbStorage.js\":\"662269bfa320b551\",\"/knowledge-medium/pr-preview/pr-1921/src/data/localDbVfs.js\":\"d19959c6d4a07e2c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/localSchema.js\":\"ccc4d4b2afc7d2a2\",\"/knowledge-medium/pr-preview/pr-1921/src/data/maintenance.js\":\"c7b6987361400480\",\"/knowledge-medium/pr-preview/pr-1921/src/data/mergeProperties.js\":\"b9d59dcb18a4f33b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/metricsConsoleHook.js\":\"ebd0cc94c0c0f6b3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/migrationsPage.js\":\"50ff1f1cfc69ef78\",\"/knowledge-medium/pr-preview/pr-1921/src/data/mutators.js\":\"f0771763d4b4eaf4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/orderKey.js\":\"31d19347e4aa6b20\",\"/knowledge-medium/pr-preview/pr-1921/src/data/orderKeyPlacement.js\":\"bf9593971f6ed737\",\"/knowledge-medium/pr-preview/pr-1921/src/data/outlineSurface.js\":\"93064cd3a55bd72f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/pendingEditorContent.js\":\"946ca10fd8da1815\",\"/knowledge-medium/pr-preview/pr-1921/src/data/pendingUploadsSql.js\":\"404e3bef3f890d5d\",\"/knowledge-medium/pr-preview/pr-1921/src/data/pluginStateExtensions.js\":\"c9611618bf65fc0b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/powerSyncLogger.js\":\"41053b6e65695e06\",\"/knowledge-medium/pr-preview/pr-1921/src/data/projectorRuntime.js\":\"07986ae7b3562239\",\"/knowledge-medium/pr-preview/pr-1921/src/data/properties.js\":\"72fe53f682435f85\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertiesPage.js\":\"f788b019ac728e54\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyChildren.js\":\"1f2428ed0c3ddc9c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyDefinitionFanout.js\":\"358d41fcc5d0d0fb\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyDefinitionMetadata.js\":\"a5a02f154b281594\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyDefinitionRegistry.js\":\"024c5107793df4f1\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyDisplayMode.js\":\"952a6abbdd2aebbc\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyRowCreation.js\":\"2081c848efbdab12\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertySchemaCreation.js\":\"964e0e36196ce062\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertySeeds.js\":\"9530a1652259aeb9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/recentsPage.js\":\"a6fd1fbc6476f837\",\"/knowledge-medium/pr-preview/pr-1921/src/data/refTargetComparableProperty.js\":\"51515f1e1ed59c12\",\"/knowledge-medium/pr-preview/pr-1921/src/data/referenceBlock.js\":\"14d07753e531a544\",\"/knowledge-medium/pr-preview/pr-1921/src/data/rejectedUploads.js\":\"a1e84160339cd539\",\"/knowledge-medium/pr-preview/pr-1921/src/data/releasePowerSyncConnection.js\":\"3abad9b5656523f7\",\"/knowledge-medium/pr-preview/pr-1921/src/data/repo.js\":\"42d397a64174ef59\",\"/knowledge-medium/pr-preview/pr-1921/src/data/repoProvider.js\":\"3f6f9a47c37d911f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/rowProperty.js\":\"9754ec90ac6509ce\",\"/knowledge-medium/pr-preview/pr-1921/src/data/searchFilter.js\":\"6610072088b8f2be\",\"/knowledge-medium/pr-preview/pr-1921/src/data/seedIdentityLedger.js\":\"3fbee59359ce0de3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/stateBlocks.js\":\"364fe9692ece31c7\",\"/knowledge-medium/pr-preview/pr-1921/src/data/structuralEditPolicy.js\":\"60bf6dd4fe9a8dcf\",\"/knowledge-medium/pr-preview/pr-1921/src/data/structuralInsert.js\":\"86c4d3bb45913c6f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/subtreeDelete.js\":\"273a98dd4f84533a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/syncStreamLock.js\":\"5aa82b7e404ab7e4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/syncedTableSqlRecognizer.js\":\"305ca915942edf2d\",\"/knowledge-medium/pr-preview/pr-1921/src/data/syncedTableWriteGuard.js\":\"99815a6b9f8f48fe\",\"/knowledge-medium/pr-preview/pr-1921/src/data/targets.js\":\"e7aea90920c6159d\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeColors.js\":\"d4da96e064b156ad\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeDefinitionMetadata.js\":\"2838911cf99205b9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeDefinitionRegistry.js\":\"cffd36fda500097f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeExtraction.js\":\"13b42958fc503443\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeInitialValues.js\":\"a9a0a129392c86ec\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typePropertyGroups.js\":\"08a63187d9d9d749\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeSeeds.js\":\"eef3f73a13ca98b9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeTagger.js\":\"72c0c592e8707ede\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typedRecords.js\":\"444895c75e9400b8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typesPage.js\":\"a371a0b9bd9bfa3f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/userPrefs.js\":\"22fe6b5b860009ce\",\"/knowledge-medium/pr-preview/pr-1921/src/data/userSchemasService.js\":\"842c7c3ba7d5790e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/userTypesService.js\":\"0182f081d48cfbf5\",\"/knowledge-medium/pr-preview/pr-1921/src/data/valuePresetRegistry.js\":\"62c92f6dd5416bd8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/visibleChildren.js\":\"e3969316453b0030\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaceConversion.js\":\"8c43f88601675fbf\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaceFirstSync.js\":\"554bc4262c0bc9a4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaceIdNamespace.js\":\"8762d5c656f06177\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaceSchema.js\":\"3c9aca6bdded624f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaces.js\":\"7c37040c80f1a1d7\",\"/knowledge-medium/pr-preview/pr-1921/src/data/writeAheadLog.js\":\"707ef8da9e47e141\",\"/knowledge-medium/pr-preview/pr-1921/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/BlockPasteShellDecorator.js\":\"4d23a73d175d3a78\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/atTrigger.js\":\"e7f07f1a29cc5a4b\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/autocomplete.js\":\"6188be9a29da2f33\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/codeMirrorExtensions.js\":\"08c27c02c4c72ffd\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/contentFlush.js\":\"de787af2d45bb200\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/defaultInteractions.js\":\"3875416e3c266a4f\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/editSettleSignal.js\":\"6bf2b6d44e7b7450\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/insertImage.js\":\"345cef85b3de3e0d\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/referenceCompletionRange.js\":\"6c66ea23c52e15b5\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/referenceTargetTypes.js\":\"45d500c33733a779\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/syntaxContext.js\":\"dd4799c30e09c7ad\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/triggerMatch.js\":\"45c26ba28d823f7e\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/AppRuntimeProvider.js\":\"d0a7b4b39ce97a0a\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/BlockFocusShellDecorator.js\":\"6e23b0ce9e03b57d\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/ExtensionRenderBoundary.js\":\"477aacf991d1461e\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/PanelContentRecovery.js\":\"d3d1bd3ccf6d887f\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/apiCatalog.js\":\"bca3a713680bb0fa\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/appRuntimeController.js\":\"4bc2d585b15b81c1\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/approveExtensionHere.js\":\"61ea8c6835c6f30d\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/armedCutAppMount.js\":\"ca4a55d3ca00e3f7\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/batchableKeyedStore.js\":\"c0a3fa5f63b07665\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/blockInteraction.js\":\"62388f0246829557\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/blockSelectionAction.js\":\"0dbbda7a074a7da1\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/compileExtensionModule.js\":\"2527f363bfac1a12\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/compiledModuleCache.js\":\"3ff46ab84364f50d\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/continuousGestures.js\":\"0aee80279417ef3a\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/core.js\":\"a85d0177bcb01a65\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/defaultRenderers.js\":\"b75bdb9960875290\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/definitionFanoutAppMount.js\":\"ff4808884bfd9b39\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/dialogAppMount.js\":\"ac8d409fb8ddbdc5\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/dynamicExtensionSeeds.js\":\"5173a077558b19ed\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/dynamicExtensions.js\":\"a34b1d17d2180d6d\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/exampleExtensions.js\":\"d0576e939062f610\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionApprovalStatus.js\":\"e31e7aa19523b5bc\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionImportPolicy.js\":\"3d4444ecfcc7d797\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionLoadErrorToast.js\":\"3c61279f551bf125\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionLoadErrors.js\":\"035b74b6c1c811a7\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionLookup.js\":\"3544827195857072\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionToggles.js\":\"5d84fe6190f676ab\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionUtilitiesCss.js\":\"9c6a00a6496939a1\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/kernelPageDeletionGuard.js\":\"b1a0d2bbb2cc6bc8\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/liveRuntime.js\":\"1af3991fda2068c0\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/normalizeExtensionSource.js\":\"8b13016e11b7b66e\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/openExtensionsSettings.js\":\"0ffaa5e22193fe39\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/overridesCache.js\":\"9a2894e2f2ea8cbd\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/pluginIds.js\":\"02f9d304afe60833\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/processorRejectionToast.js\":\"ec996145a052cf47\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/runtimeActions.js\":\"7dc2e4010c7d9efb\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/runtimeContext.js\":\"6958c99716509683\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/staticAppExtensions.js\":\"cc1b92407a5cb384\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/staticDataExtensions.js\":\"d1c32ab20a1d8629\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/toastAppMount.js\":\"a0e7bf574be367d4\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/transpileExtension.js\":\"4e73547809c95542\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/useOverrides.js\":\"5e59d46b01feb50f\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/useShortcutSurfaceActivations.js\":\"0b5043f9b61f4772\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/discoverToggleTree.js\":\"48509d8e243c12e5\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/facet.js\":\"cad2ad65c082f594\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/resolveAppRuntime.js\":\"d19910e771dee7ca\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/runtimeEvents.js\":\"1c88344a60db9cb2\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/togglable.js\":\"e8ee50c1de3d14c8\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/variantFacet.js\":\"82bc17d7eb8b4869\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/verbFacet.js\":\"9ca35ca1281bedad\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/block.js\":\"db582a44b628a130\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/focusedChild.js\":\"9eeab3053b240933\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/propertySchemas.js\":\"f43dd75ffa462387\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/typeRegistry.js\":\"a712d0d813dba8c9\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useAncestorCrumbs.js\":\"7a0cc2177fee6103\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useAutocompleteListbox.js\":\"47b770d8b234ae8f\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useDebouncedSearch.js\":\"a9d309111b0486a6\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useDebouncedValue.js\":\"cc4b2f3a76a7c6bc\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useFacetValue.js\":\"508850b24229470c\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useIsFocalRender.js\":\"9398415a27be5ef4\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useIsReadOnly.js\":\"67845ee37222b9bd\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useMaterializeBacklog.js\":\"dcaab4aa4ae87d89\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useMinuteClock.js\":\"73bd977db3df4d4c\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/usePanelLayoutProjection.js\":\"fbb06fea4cbdddc2\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/usePendingInvitations.js\":\"fcf0eabe068f47c9\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useRendererRegistry.js\":\"2a16fd09a427cc40\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useRetainedFieldRows.js\":\"f1472de3b1896f87\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useWorkspaces.js\":\"29930c098687db4b\",\"/knowledge-medium/pr-preview/pr-1921/src/lib/utils.js\":\"0756bc8a4ca83038\",\"/knowledge-medium/pr-preview/pr-1921/src/main.js\":\"b70eadfb2d74e171\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/MarkdownImage.js\":\"955e69b9c72a3808\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/blockSeparators.js\":\"ad2829ec933de8af\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/context.js\":\"398166d67303ecd6\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/defaultMarkdownExtension.js\":\"ae954308feb5b848\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/extensions.js\":\"d04cd9d9d743d334\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/renderMarkdownHtml.js\":\"f1b4585a24b3ab1f\",\"/knowledge-medium/pr-preview/pr-1921/src/minimal-editor.js\":\"046437be6a263b6a\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/armedCut.js\":\"dd75b5a42b6ff7d5\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/captureMediaVerb.js\":\"688be33de038dc36\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/clipboard.js\":\"912d5fed13391745\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/decision.js\":\"4dfd307ec88ee006\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/operations.js\":\"f9c89238adada3bc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/account-header/AccountHeaderItem.js\":\"2f7f301c9711aa11\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/account-header/index.js\":\"d9f98603a85b9231\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"61327f14e587582d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/askAgent.js\":\"a78e448e3e64687f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/askedStore.js\":\"a9933d6b2f7edd45\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"6bca31479e252cf0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/chipState.js\":\"4c917ddd42aed092\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/dataExtension.js\":\"acbdbef073f9497f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/index.js\":\"787a2bf004206b03\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8a9e1db5e56fc5cf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/schema.js\":\"225abc5d2a3c8db0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/AgentTokensDialog.js\":\"e08f9ac3ddb8d607\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a5259ea5dace67b0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/addMedia.js\":\"187d9e32a847c106\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/backlinks.js\":\"526cb555115e83d2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/block.js\":\"f38ac6c3516733ee\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/context.js\":\"f3ecd20928c0a95e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/displayIds.js\":\"b48f7faa3180467c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/index.js\":\"d1bf1cdd27037515\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/outline.js\":\"d32fe3534c030eaf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/properties.js\":\"5a8fb2e98865b90c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/refs.js\":\"d2aec193b6da8ec1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"984d99aa9887b39c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/search.js\":\"bd07fb68a72d68df\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/shared.js\":\"a251170e196c3ef9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"72d9dbc93aec90da\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/text.js\":\"5a32d86a3980ce88\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentWrites.js\":\"eb53037356569bc1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/authoringCatalog.js\":\"ef84e0928c0a66e9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/blockRefTargets.js\":\"47adddc63ff1f449\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/bridge.js\":\"531ba746ac534c5f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/bridgeLoop.js\":\"6332ab91fe9fbdd4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/changeHistory.js\":\"b1c0ac14c33428bd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/commands.js\":\"130734d8f01407f0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/commentsCommands.js\":\"f6547608dc85d4a9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/dataExtension.js\":\"ee36a9d39954c952\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/dataModelGuide.js\":\"60cdbbae21ba53f8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/dayPropertyInputs.js\":\"a51484708b782bcb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/describeRuntime.js\":\"34961f6160c52c4d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/extensionLint.js\":\"460a34f5edd31b40\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/grainAudit.js\":\"ae803219c2d74408\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/healthCommand.js\":\"040ea1294477eba1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/index.js\":\"6657100b59ce6de2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/presetIdentity.js\":\"f83998d13936701d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"85692291edb903d7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/readMedia.js\":\"ac2db0aae03d1291\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/schema.js\":\"a53b8e27eec6f04e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/serialization.js\":\"d71c642d9d9f0090\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/targets.js\":\"f71794602920683a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/tokens.js\":\"95c1c4e897b8a1b7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/watchEvents.js\":\"cf332d3c818210fe\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/workspaceGuard.js\":\"a43e7a292a4f9609\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/writeCommands.js\":\"78f7fe6a82e3eade\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/AliasCollisionToast.js\":\"93e92ac4e5709ee6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/DuplicateNameBanner.js\":\"9fcbd3f90e40b432\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/collisionMerge.js\":\"1226b60e4a7fd3e4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/dataExtension.js\":\"9c388e2661722598\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/index.js\":\"358f3b7f417a4335\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/mergeCollisionAction.js\":\"af648ea3a9ddfc40\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/pageStyling.js\":\"f9db99bc240f48e8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/rejectionToast.js\":\"4a6e520c2bac52fe\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/syncProcessor.js\":\"b065745300d4cac2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/actions.js\":\"a1c4b2211ed43414\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/addComment.js\":\"9e624db72c234574\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/anchor.js\":\"61d1ec6ef65f25c8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/anchorState.js\":\"e6cd0b4e7095359e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/commentLinks.js\":\"35f55c166d9022be\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/confirmThreadDeletion.js\":\"01d5ee139c22b0c8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/container.js\":\"35b17204efd52545\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/dataExtension.js\":\"7d775263660f90ed\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/deleteComment.js\":\"2e0df2a0c950285e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/highlights.js\":\"22b6a6ee55e504d6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/index.js\":\"9f470ad29e2cba04\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/linkedCommentsPill.js\":\"be8d6de459594b8f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/margin.js\":\"1a7dc7d6a5e5b160\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/marginAnchorLinks.js\":\"787925f4b215873e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/marginSchema.js\":\"ea26eaf4a739350e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/newComment.js\":\"fa94226229f5d69c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/ownThreadPicker.js\":\"c6da0dbb33642aba\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/placement.js\":\"5a51727d3f57893d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/queries.js\":\"02327baf83d6329c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/quotePosition.js\":\"398a737a1a5e7c3a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/quotedIn.js\":\"dd3ddb4c8b6df21b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/quotedRange.js\":\"b7d05f12414a8b8c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/rangeRefs.js\":\"2b3a39bc74d1a5b4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/readHighlights.js\":\"4d4a9b0a44d7853c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/readSelection.js\":\"9357f31e1b30a66b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/readSelectionUi.js\":\"e30c72474be7d47a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/reanchor.js\":\"4c1a95c3a76e77b2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/schema.js\":\"4bb9d6871b9c8bec\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/scope.js\":\"f343e9741f6873af\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/scopeThreads.js\":\"91fc27c87c2da0b0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/splitRetarget.js\":\"876cef83b7ae90fb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/suggestionCard.js\":\"d7bbf80fa2b05103\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/suggestions.js\":\"3ca9fb05b1cec404\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/summaries.js\":\"3e30f29c9ccc097a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/summaryBatch.js\":\"41de93f4cfccbded\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/surface.js\":\"57152665c7fa8035\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/threadNavigation.js\":\"3aa81880700b3035\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/threads.js\":\"4de7512a6b0f4852\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/ui.js\":\"5f94395647aa475f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/uiStore.js\":\"bea80a124af4111d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/app-intents/appIntents.js\":\"883cabc089e6bcd1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/app-intents/index.js\":\"a0dbaf5afda621a5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/app-update-prompt/index.js\":\"1c7c46fe162ee59d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/app-update-prompt/status.js\":\"3c431904392dbea7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"6b49f5c72db5bda5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/MediaBlockRenderer.js\":\"967d42b81de186b5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/MediaDownLaneReplicator.js\":\"9a5aaaecb6b3c7f1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/MediaUploadReconciler.js\":\"971644c5e6f21848\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/assetDownLane.js\":\"2dca32db588b879d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/assetResolver.js\":\"e8e3b89c5459e091\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/assetUpload.js\":\"eada4a6beaaedf63\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/attachmentCleanerIO.js\":\"1dd8b4bd2c643a7a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/supabaseAuditIO.js\":\"2b8e923f32c4f1d7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/blobStore.js\":\"634d59fbc346c890\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/browserMedia.js\":\"2ad6036839f8fbd8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/byteStore.js\":\"c4048bc3af92e355\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/cleanerIO.js\":\"7f6bcf28e5cc1f72\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/cleanupAttachments.js\":\"7adc5c320dcb816c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/dataExtension.js\":\"86dad61b25168138\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/downLane.js\":\"bbdbd8e574cb504b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/index.js\":\"7b17b9ceb2c66c7c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/insertImageContribution.js\":\"75ecec38db9fb07d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/laneArming.js\":\"72a3120184499849\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/laneLock.js\":\"34811e997bd9f908\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaBlock.js\":\"a1a5f69c339d1bd4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaCapture.js\":\"df4c90ee90fcd382\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaLanes.js\":\"7565c6cd8387461b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaViewers.js\":\"9a7f8e03a0ac131d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaViewersFacet.js\":\"60c1d8e34ef68127\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/pasteCapture.js\":\"f044bb5bbe6d6a3f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/resolver.js\":\"847b377725c6303e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/retryUploadsAction.js\":\"19048f09f4437860\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/storagePaths.js\":\"9dd113931ee4567d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadDrain.js\":\"af342086d9a08fa4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadLaneStatus.js\":\"3f1f22063fe41317\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadReconcile.js\":\"84be51e287d1e2eb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadRecovery.js\":\"a682a08e5b5bcb3e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadStore.js\":\"d0d0b011fb307953\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/useAssetObjectUrl.js\":\"768957ad74538e31\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"5398b3e4749318d0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/BacklinksViewSection.js\":\"59c76559f292ed87\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/facet.js\":\"b536bb84dbc96f9f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/index.js\":\"e42c2dbff0cd424d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/prop.js\":\"7d14b944a81304d5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/BacklinkFilters.js\":\"b0f2e7c3e104711b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a2be03b27e7a18f6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/BlockEntry.js\":\"5994eb85cd5f6d79\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/LinkedReferences.js\":\"93a50ec5fd68f81f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"8e145ac0b9e93956\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/dailyNoteDefaults.js\":\"05152a109f60f6e7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/dataExtension.js\":\"ea1a5c9ca49d286e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/edgeExclusions.js\":\"66b35d94a57b63e2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/filterProperty.js\":\"94adf8769371d569\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/index.js\":\"4cc4fde560d673a3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"97734fd9c2353843\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/applies.js\":\"7e9a57dcd6d4ddec\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/countQuery.js\":\"c24b0087f39ff3f7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/expansionStore.js\":\"a0e8580988f9ffdf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/index.js\":\"a7f3791bbd4dc36c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"2bd8d884de8d6f7e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/presentationInvalidation.js\":\"8d226fbcba2dd337\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/propertyEditorOverride.js\":\"73f2c2bfd85eb6a6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/propertyFilter.js\":\"70b65f4c07c1907a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/query.js\":\"1bd0c9aab02e63d4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/resolveFilter.js\":\"304ab9f41e4e24cd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/sourceBatch.js\":\"71dbb6d0cddfd7ef\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/sources.js\":\"fbe26b226246b3b9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/useBacklinks.js\":\"7a1f41b092c6213f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"09079cd092a87f56\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/BirthdayCelebration.js\":\"f1c2d7cfb92a0d13\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/BirthdayOverlay.js\":\"917747d172912503\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/gate.js\":\"e413eb754b86d8f0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/index.js\":\"d4cacd57a9a9f953\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/wolfTheme.js\":\"6bee9d0f9eb6018b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/BlockDragLayer.js\":\"190f75dbffab1025\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/dragController.js\":\"56fd73122c782c8c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/dropTarget.js\":\"4a08ac2ae30fffec\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/index.js\":\"8bf85dc68ba89f6a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/projection.js\":\"73e961cb323a816d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-info/BlockMetaCard.js\":\"ba5023b9e511e566\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-info/index.js\":\"d290bec1b787dbb7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/AddTagDialog.js\":\"583fab8595f8f91d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"b445c93a03648409\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/TagNameIssueHint.js\":\"9d501f697a9521a8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/addTagAction.js\":\"b40e1a8173fd496e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/appendTag.js\":\"60a315001dcdc432\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/config.js\":\"57d958dd83cf9b66\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/dataExtension.js\":\"a630b27c2e886d4a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/index.js\":\"a06e4a3f6a6e3b83\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/propertyEditorOverride.js\":\"722f69dd9db98f02\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/BreadcrumbList.js\":\"7702fd342d539ce7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"37af215ccbf85392\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/Breadcrumbs.js\":\"103ca3c86b333ed1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"a78742e4567350ef\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"4ef182a85bfc96d8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/index.js\":\"34d4be46dd69afe2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"50594e20112a46c7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/CharacterCountItem.js\":\"75940b0542335928\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/ProfilePropertyEditor.js\":\"730cccd11bc797e7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/actions.js\":\"0799e54e165d89ac\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/blockType.js\":\"56a95ba2ee43d3aa\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/charCount.js\":\"63cb400df3f19c66\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/dataExtension.js\":\"558c14cbf6ea1364\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/index.js\":\"b77b344a855462a2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/profiles.js\":\"52dc12d25630991c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/properties.js\":\"827eede6b475451f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/subtree.js\":\"20b665f038dadceb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/textCounts.js\":\"3da0b5cd5eb7e177\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/colemak-keybindings/index.js\":\"0a52f9c6d901857d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/CommandPalette.js\":\"5fb4776073d5c956\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/HeaderItem.js\":\"058fda8a66700889\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/context.js\":\"5dfb364db4098aa8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/index.js\":\"f6b38e7494831a0c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/selection.js\":\"d059d795e156c68b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/toggleStore.js\":\"096c1f7684ae3023\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/useCommandPaletteActions.js\":\"10157c5e81b9716f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/ContributorBadges.js\":\"03c510516b63711d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/ProfilePicture.js\":\"33d447cf66b4bffb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/author.js\":\"a50d7053bb3693d1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/codeMirrorExtensions.js\":\"b88f4f4fc9854131\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/dataExtension.js\":\"a53f7357d65afe46\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/index.js\":\"3a9814bed53532eb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/mentionAutocomplete.js\":\"cf0279c093639236\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/processor.js\":\"3f17867de8f0a1ba\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/profiles.js\":\"1b9074dea3da2345\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/queries.js\":\"5e7facd8a342df7b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/schema.js\":\"6b027136d49fc824\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/useCommentAuthor.js\":\"5e56a87172ee9f1f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"fc04e37360e36c65\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/followOrigin.js\":\"8a3afc92a97aa825\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/index.js\":\"f14d2f36dbf9c736\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1c9117fab06a5e9d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b5d7fecf6f0b1792\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/CalendarGrid.js\":\"a38ca3a193c5e9a7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DailyNotePicker.js\":\"40957b215e11222e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"2dcf820ce843bf4b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DateNavDecorator.js\":\"1e5b65f0f241fa06\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DateScrubOverlay.js\":\"04da93eb85a6667d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DayPropertyControl.js\":\"e589d4c147539f8c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DayValueReferenceControl.js\":\"9a1664b3435a01ac\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/HeaderItem.js\":\"bee70cc7a9a18b6f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/ReschedulePicker.js\":\"c2111d9f05e84881\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/SpreadDatesDialog.js\":\"72aafe3cb72338e2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/actions.js\":\"d866e332374be918\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/blockDateAdapter.js\":\"3a8ee5f9dc9e63cd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/calendar.js\":\"f4d8b264befb9e65\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dailyNotes.js\":\"8cba3fb00b9c455f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dataExtension.js\":\"f781da8cb30a6597\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dateScrubActions.js\":\"54f21da3ccb50087\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dateScrubGesture.js\":\"2bf344a164a90a2d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c1be5ba650738983\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dateScrubRecognizer.js\":\"b6b7d07b12e7837c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dayProperty.js\":\"e8552b28f78b28ce\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"96fe17e5dbe8ec09\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/deletionGuard.js\":\"d6c59a175b5d53dc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dueQuery.js\":\"32f44a4864b8ffdf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/index.js\":\"775d5daeabf1d1c5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/landing.js\":\"0c16b05b8da6cd72\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/localSchema.js\":\"f17321395657c678\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/referenceDateAdapter.js\":\"6a6d88b68785d39f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/rescheduleAction.js\":\"7059cbdb15a17b15\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/schema.js\":\"d731c0af6fcd7844\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/spreadBlockDates.js\":\"522a1624fcbfdc6b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/spreadDatesAction.js\":\"c7f9521a706b0953\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/today.js\":\"f419c8ae9e5851b8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"35817ce30723b01c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"ca5ee85e03afa879\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/audit.js\":\"aa54395092428531\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/auditAction.js\":\"9395ea9a1bf8efd7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/auditRanges.js\":\"9e634cf30494d908\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/diagnosticsSource.js\":\"126de2a6bc212885\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/divergenceScan.js\":\"2ea02930cce2186f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/index.js\":\"a661af4989f47c20\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/propertyChildrenChecks.js\":\"0a71c7d1a35de791\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/referencesMirror.js\":\"33e19a68561e8be3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/rowJson.js\":\"15e21fa48dbaf058\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/schedule.js\":\"0aedbbd26d637793\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/store.js\":\"0b57bfdc302ba8f1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-maintenance/action.js\":\"ee92dfdc5c81d4e8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-maintenance/index.js\":\"25506bef9de7cce0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-maintenance/plugin.js\":\"db224d95e9ed0cb2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"432ca63f3e21e7de\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/actions.js\":\"41bc0d412ac90736\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/changeMarker.js\":\"1389199c751c9a77\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/diagnostics.js\":\"9bc711fc0acc8b4a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/fileSystemAccess.js\":\"9052317fdd9a2c42\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/filenames.js\":\"be585eab486313b3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/index.js\":\"bdcdff3add9c1c91\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/mirror.js\":\"0d01d34718514b1d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/runLock.js\":\"98bf44979a03a087\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/runtimeHealth.js\":\"3fbb55be973627d0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/schedule.js\":\"2306d51312acc8ef\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/store.js\":\"902d86f935b98811\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/default-themes/index.js\":\"28b41f1f19ffb650\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/default-themes/themes.js\":\"94d14c02aa40c439\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/diagnostics/facet.js\":\"f382aa53295f0f5a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/diagnostics/useDiagnostics.js\":\"c6714f9eaa53db5a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extension-prompts/dismissals.js\":\"a40737bb3451bf80\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extension-prompts/index.js\":\"99c2ba50884cb272\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extension-prompts/status.js\":\"8633f4da5dffbe12\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extension-prompts/store.js\":\"0025429ae1b1b746\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"98b99552ba5499de\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/ExtensionsSettings.js\":\"cbdbb2df7669baba\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/actions.js\":\"0dfa75f5cf299273\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/config.js\":\"660b73f308608464\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/dataExtension.js\":\"9b17669c9bac15d8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/effect.js\":\"f421f2f307653bc4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/index.js\":\"8f9d282c49322b68\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/propertyEditorOverride.js\":\"bef8ae554c78684e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/useToggleTree.js\":\"a09f0155201578f6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/ExtractTypeDialog.js\":\"9d1703cef2e239db\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"de7d22a42662935b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/PropertyShapePicker.js\":\"4755b0e0c5301998\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/action.js\":\"efb58c0ed11c0e5e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/index.js\":\"77501ed2a7c1507a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/FindReplaceDialog.js\":\"9d698f636bacd890\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/HeaderItem.js\":\"714270635a0a9a06\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/dataExtension.js\":\"311046e87be6d1fa\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/index.js\":\"a1d498e00f95a7ae\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/search.js\":\"1f7aebfdc1044a7a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/toggleStore.js\":\"1e2fdd4a0a440d02\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/LocationPropertyEditor.js\":\"c285be9b7c62a803\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/MapView.js\":\"47c0fffdf2cb4ed5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/blockTypes.js\":\"f1fe2c537706ffe2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/codeMirrorExtensions.js\":\"12ebc6e7e2f15ae4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/createOrFindPlace.js\":\"ced58b8c9735d73d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/currentLocation.js\":\"100da5778771148d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/dataExtension.js\":\"be654b13e87e74af\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/geoContentDecorator.js\":\"69a7cb947a8b56bc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/googlePlacesClient.js\":\"d8ead810f7d2e3d0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/index.js\":\"2ac5e98b94b4f209\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/locationsPage.js\":\"27cad0980fda3ba8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/mapViewport.js\":\"f041f333b9301755\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/pickCurrentLocation.js\":\"7fb83cd536b7c60b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/placeAutocomplete.js\":\"7d6c965d738ae029\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/placeNameCollision.js\":\"0820e579a61e3a22\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/properties.js\":\"c7c696ffa86f7789\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/propertyEditorOverrides.js\":\"a6a7b6158bda694c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/query.js\":\"c6a14da657b81684\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/usePlaceSearch.js\":\"93d9d46d470e131a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"66d7e678f85b05ab\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c7540e33bcd0750f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"cd29acc2fb3264ee\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/config.js\":\"5a92f926317eb58c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/dataExtension.js\":\"ff8a0bb4dd11ecca\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/facet.js\":\"5b55887a192ddc92\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/grouping.js\":\"ac83e57f157f51c1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/index.js\":\"d76aa6f3a68cecd1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"cc2496eb1c4c53a9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/query.js\":\"b1dc7d0e89a426d4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/resolveConfig.js\":\"3f2eebf097bf0da9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"eb2946bab59e561e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"4a3e967b3537d82c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/HtmlDocumentContent.js\":\"91a2719b1e404089\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/HtmlFrame.js\":\"3d58dbcafdfd3136\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/actions.js\":\"3892acdb638bdac7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/blockType.js\":\"c9f7ec85d7448823\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/confirmRunScripts.js\":\"784a798f6b55e16f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/dataExtension.js\":\"a85ae4f7b7791272\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/frameAnnotations.js\":\"cb5b0eec89a95d96\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/frameDocument.js\":\"c0fe6868a4b083f5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/frameTheme.js\":\"32a205d962d5f062\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/index.js\":\"22750ab05091532e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/scriptConsent.js\":\"e7ce5467e29dee2f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/sourceMap.js\":\"00e8dd7f9d276706\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/useDocumentScripts.js\":\"38d1284dbd1f5204\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/index.js\":\"5be5ff67ebce9458\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/record.js\":\"c371429d3bcf50ef\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/recordStore.js\":\"b5d5baa9db56ecbc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/responsiveness.js\":\"7ffcb421fb4d4f9b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/schedule.js\":\"e6d7c9c3301a4118\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/sessionContext.js\":\"077068219d9eb00c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"90e2c3e1d515ff97\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"70d4a817c9f0b605\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/actions.js\":\"33c32d97aa18b979\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/config.js\":\"b9ed180e73a2eb19\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/dataExtension.js\":\"28810d736c0cc45e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/effect.js\":\"b60035a810a62cbd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/index.js\":\"5ae39de4b4d27ae9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/keyCapture.js\":\"4604a6d8135643d8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/overrideStore.js\":\"b2a40c735b0ec99f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3df60fea5f5d713e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/HeaderItem.js\":\"f1b2f0c171b22d29\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/LeftSidebar.js\":\"131ba8a7cceef080\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/actions.js\":\"d85e8fa5114bcb4d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/facet.js\":\"32f1b8c562d909fd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/index.js\":\"7ed0e77dc858ad01\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/shortcuts.js\":\"5114374c4831af8d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/toggleStore.js\":\"b187547deb0f0bcd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/merge-blocks/MergePicker.js\":\"0811fa86f97496e0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/merge-blocks/index.js\":\"f01ef1a4ccd7aa4c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/merge-blocks/mergeAction.js\":\"aba378a5f08d3886\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/merge-blocks/strategy.js\":\"732c3bbdf5015072\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/Button.js\":\"0f09c655c72220a6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"b6e5e8d8f7a1e0f5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/defaultItems.js\":\"65e1a4441b5505fc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/facet.js\":\"ce0c042e131783a5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/index.js\":\"8dc55afdbada7bfc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"364ce1ce5ffeeef4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/actions.js\":\"74edc88298f45fc4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"20b917fe51294eba\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/facet.js\":\"b98fb758b823ebe0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/index.js\":\"3056249a6291eed8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/MoveDestinationPicker.js\":\"802d80943133f71b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/blockSubtreeMembership.js\":\"69702e27827e9823\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/contextMenuItem.js\":\"5112dd10d7dd36ce\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/index.js\":\"008587b56c6846fb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/moveAction.js\":\"3fff5eda1d1b2a9d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/moveBlocks.js\":\"c14fc3bf54292263\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/selectionAfterMove.js\":\"d837dda96c415d22\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/TutorialBanner.js\":\"304cb5c48b7bb9df\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/action.js\":\"973a0d5acffe214a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/bannerDismissal.js\":\"ad21a40fa8a3d2df\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/documents/cheatSheet.js\":\"e3450bd88c0289f9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/index.js\":\"9b47cb3c8a3f07fd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/keys.js\":\"3e56bde4eac9f687\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/landing.js\":\"85333a5ed06526af\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/outline.js\":\"cbd86018e8c3dc35\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/seed.js\":\"f7f24ab80d1ad454\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/PerfTrendDialog.js\":\"8463e5c96937edb2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/analyze.js\":\"c96c334a9ed89a93\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/diagnosticsSource.js\":\"13b063077c9b8f9b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/index.js\":\"735b87449a7b1ad3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/load.js\":\"fb253dccc3b95cc6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/monitorRun.js\":\"acb9558f82659be8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/schedule.js\":\"13ee51c82fc4ba9e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/series.js\":\"c980d93f7282c689\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/store.js\":\"f053df97b06bec81\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/trendAction.js\":\"f1721354394ed3da\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/verdict.js\":\"ef2e88963662adec\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/plain-outliner/clickToEditAction.js\":\"be76d5fc7c78b307\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/plain-outliner/index.js\":\"36876d739b1182ed\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/plain-outliner/interactions.js\":\"3c3408a5697635d5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ad4d67efd9b8202a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/MigrationGate.js\":\"b2ed75d3adac62f1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/MigrationGateDialog.js\":\"e95ee5bcc6063f5f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/action.js\":\"9a1c65791e2b36e8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/index.js\":\"24953644779db71d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/localRunMessage.js\":\"ebe4c5fa50b8c830\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/plugin.js\":\"ee93d0b1b90705d6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/progressReport.js\":\"003df2eb1667571e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/sweepProgress.js\":\"03d089a68a90dbc3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/FieldRowRenderer.js\":\"a1c2f5949aa7ec5e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/ValueRowRenderer.js\":\"54fea0c3140e4471\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/actions.js\":\"b4306501e66a2d5f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/autocomplete.js\":\"40c02c285521170d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/fieldRow.js\":\"4daa338a7ae1b639\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/index.js\":\"97710f4a21147318\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/referenceWarning.js\":\"f8674cc4c92e483b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/valueAutocomplete.js\":\"85a9ea5c06bb9ab9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/valueSchema.js\":\"7e0074c6c71d70b1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/HeaderItem.js\":\"469bf767603d8eea\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/QuickFind.js\":\"6e7c4990a56062be\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/index.js\":\"443f52831ef1c7de\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/recents.js\":\"8a283b7105dee59d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/resultItems.js\":\"cdb0c76a46eaa7d2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/selection.js\":\"e83dbb0937000bdb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/toggleStore.js\":\"1e73e3197b7954eb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/HeaderItem.js\":\"cfd2d9681b4b37b8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/RecentsPageBlockRenderer.js\":\"e933d0a00edb3c39\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/grouping.js\":\"9699fb86d1e2adee\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/index.js\":\"15908ba4b9fb6c14\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/target.js\":\"a2daab5bdb2b688a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/codeMirrorExtensions.js\":\"b5ee1be5f944bf57\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/contentPrefill.js\":\"90180a809d54750b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/dataExtension.js\":\"38d2baaead5bf354\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/index.js\":\"67205a439841dc98\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"c227db2f573fe459\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/invalidation.js\":\"46c2583c3bc243cd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/localSchema.js\":\"6ed88d65eaba1c6f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/blockrefs/index.js\":\"6b511842b74c3baa\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"d9e670ec9ec8127a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/index.js\":\"5a86f797700afa10\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/referenceNode.js\":\"4df358d22bd3043c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/remark-reference-occurrences.js\":\"a035ff8a8590a4fb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"9878441d9a69e8a6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/wikilinks/index.js\":\"a0b35a4fa21c6490\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"4c49c8c71095e7df\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"744cd2465693c8eb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/mergeRetargetProcessor.js\":\"8f5a48f28518e263\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/parseFence.js\":\"9ad48557d69e8448\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/referenceParser.js\":\"fc65500232596c61\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/referenceProjection.js\":\"221b9deb95e5a305\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/referencesProcessor.js\":\"2fda25fcb3a58b3a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/renameProcessor.js\":\"994f8365379cea35\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/spanReplacement.js\":\"3eac8c31dd6331d6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/rich-paste/htmlToOutline.js\":\"c0adcd3b8fe714e3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/rich-paste/index.js\":\"7f52faed5d117c2e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/rich-paste/normalizeClipboardDom.js\":\"367f172717657095\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/rich-paste/pasteDecision.js\":\"0279da97a1239a34\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/action.js\":\"3036a6da63dec0cb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/blockIds.js\":\"0c3b718d703e018b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/content.js\":\"8e64106252f32b0e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/effect.js\":\"9352ed54629d9b3e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/ids.js\":\"92200ac5defa1cf8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/import.js\":\"dfae80109d0b40f5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/index.js\":\"a2fe6e1941b5fdb8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/plan.js\":\"53a5b611a0509f99\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/plugin.js\":\"e384a24d3a65bd74\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/promotion.js\":\"54f2691ad9168686\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/properties.js\":\"b575fc70383876ba\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/references.js\":\"7a6364504566353c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/report.js\":\"0ad6be6b9f2ab4bc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/roamMemo.js\":\"b13d26d58ead5e49\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/runtime.js\":\"8b786f9226b96aac\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/schemaReconciliation.js\":\"610afc27bc0d6ad7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/srsMarkers.js\":\"a1bef74646520b42\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/todo.js\":\"faf366c1f30571b0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/typeCandidates.js\":\"e37e31ff45072d67\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/types.js\":\"e1a79cb04d33dd36\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/search-health/index.js\":\"d19b6c880c9092be\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/search-health/store.js\":\"0d2bbd3ce3f47190\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/HeaderItem.js\":\"89b63bb8b0010b21\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7bd056983e3b82bc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/index.js\":\"9e3c07a8160b3391\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/model.js\":\"18966327c196d1fb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/toggleStore.js\":\"31d09e67f8f1e7bb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/useKeyInspector.js\":\"3d7b3e92976b3495\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"54732f7af02de89e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/ShellDecorator.js\":\"4c0c8444c5c297c7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/actions.js\":\"63588c6c64c05de7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/exclusionsFacet.js\":\"39432e4e80c8f59c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/index.js\":\"777bc70d0a01f935\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/shell.js\":\"4261884f73562ef8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/surface.js\":\"835478277dca8718\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/walker.js\":\"66ebf68ae8599ee2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/RescheduleToast.js\":\"e21dc9f94bbd01cb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/dataExtension.js\":\"1701f8e5ca807030\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/index.js\":\"6158b942b717ef61\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/indicator.js\":\"6425c59126c4da06\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/moveSrsState.js\":\"2b3f2cffcb8ae748\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"24968afdf1ee334e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/scheduler.js\":\"d922ddb75e81b028\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/schema.js\":\"94bd29d78b51689c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"2e79caf07d988f42\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/srsClipboard.js\":\"d27b347a77184184\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"1b5c344101b30e0f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/DailyNoteReviewHint.js\":\"e3b8d0a5edbaefc4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/DeckPicker.js\":\"160711d1d83827d7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/ReviewControls.js\":\"11e6def356982438\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/ReviewDeckRenderer.js\":\"62a47cf8d3f3a67e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/ReviewSession.js\":\"94f0e0cb1265ccbc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/actions.js\":\"16702458b572452f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/archive.js\":\"b8160a6f03e464bf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/dataExtension.js\":\"0c87bec1667a75d4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/deck.js\":\"252bb52bf9c249bd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/dueQuery.js\":\"2c9266bebfca6451\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/gradeDecision.js\":\"879198731bf71e5c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/index.js\":\"b3f730183ec01769\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/keyHints.js\":\"d50d899c900f299c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/reviewCardLayout.js\":\"4596484fda64346c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/reviewProgress.js\":\"b807da5667929f55\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/schema.js\":\"4b30d0eb8bd129a9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/useDueCards.js\":\"8cf4692c862c5bfc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/startup-metrics/index.js\":\"79c117a1b5d8a965\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/startup-metrics/record.js\":\"9df992466461ed46\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/storage-persistence/index.js\":\"aaede82f4e7b2cab\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/storage-persistence/persistenceStatus.js\":\"20d2f5c6d0067a17\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/storage-persistence/requestAction.js\":\"c90139ea438d2def\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/supertags/TypeChipsDecorator.js\":\"63eb3da2963deae3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/supertags/codeMirrorExtensions.js\":\"9ecb5b73cf336c18\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/supertags/index.js\":\"bbdcdecd24d8f611\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/supertags/typeAutocomplete.js\":\"d1cf27c240556748\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"7c33181e652d1b8a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/actions.js\":\"270662409abbca2b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/anchor.js\":\"b87c78366eef14f1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/events.js\":\"2e90a162f7375ee1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/gestureActions.js\":\"91465cd437ec1264\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/index.js\":\"0173d75e544b13cd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"4ca34832de099ff3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/sync-metrics/collect.js\":\"a44b2e177bba6ef2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/sync-metrics/index.js\":\"366efcd19ebe56d3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/sync-metrics/record.js\":\"2c572d1bebf1143d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/RejectionDialog.js\":\"91f47d6bc129bd35\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/SystemStatusHeaderItem.js\":\"970603015e949a7b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/index.js\":\"19f7c901692aeba7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/model.js\":\"c76f27b052c43f77\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/queueCounts.js\":\"b5901d9a55b62e2a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/rejectedHelpers.js\":\"f1bb3522fafaeda7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/rematerializeAction.js\":\"681600740dbd3b0f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/useHysteresis.js\":\"dd42f4c876be6420\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/ColumnHeaders.js\":\"58b84da0d42f6a06\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/QueryUi.js\":\"5e9acc3228c537b6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/TableLayout.js\":\"6555185442cede1a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/actions.js\":\"09070fffcec19899\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/cellEdits.js\":\"5b678b304e35531c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/childrenViews.js\":\"06ef826c29d716ff\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/columns.js\":\"29e3e7be587dde89\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/controller.js\":\"f89b991fdfea5160\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/convert.js\":\"234110169e424bc4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/dataExtension.js\":\"fbc4ba489c1f95dc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/index.js\":\"acd45a263a28671a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/keys.js\":\"a6ba91764267786f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/model.js\":\"b2bb0decd339e020\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/QueryText.js\":\"86a50a54a00ab5f7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/backfill.js\":\"ea9ba664cbbc49a2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/completion.js\":\"f234384f9a73e222\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/format.js\":\"ae137a86e2c2db1b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/parse.js\":\"b30a8d808fbe1c89\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/queryValue.js\":\"d007025d2e2f1750\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/registrations.js\":\"df9120dc746e7e99\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/source.js\":\"2cb5b06fc11961d1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/registry.js\":\"baafa8946e555f48\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/rowGutter.js\":\"8e8a36ab0bf8a8d9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/rowVerbs.js\":\"6db178d5c204ad7b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/schema.js\":\"6147a85ca32509d2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/sort.js\":\"b1ea1a2aafcb97d8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/theme-toggle/effect.js\":\"6e4d1e0ffeb2c0ac\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/theme-toggle/index.js\":\"f10dd51f68d00e0e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/theme-toggle/theme.js\":\"5eb798cf629088f9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/todo/actions.js\":\"9d2c656f2d075f5d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/todo/dataExtension.js\":\"4570ff5c3b280fab\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/todo/index.js\":\"a809ab561d6fbe1a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/todo/schema.js\":\"038cffbafafeaa0c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/TouchSelectionLayer.js\":\"11fceeea32ccc6ef\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/actions.js\":\"f22e49d437048071\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/defaultItems.js\":\"eb0c7fb01e00c803\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/facet.js\":\"37528e68db5e7ad5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/holdRecognizer.js\":\"0b5afeddbd7e0e19\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/index.js\":\"e4fad832a1e15e51\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/update-indicator/UpdateIndicator.js\":\"f4e7c981f2a7a521\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/update-indicator/index.js\":\"db681295471e1213\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/update-indicator/loadTimes.js\":\"db64f819ad041188\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/VideoNotesRenderer.js\":\"2f201c992db9b277\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/VideoPlayerRenderer.js\":\"59c1575ec737a34f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/VideoTimeStamp.js\":\"aa8e39b9c75967a3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/actions.js\":\"ffc18671eca63426\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/index.js\":\"a0cc432b410af103\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/markdown.js\":\"0317fb5d34baba77\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/notes.js\":\"bcfc6962735cced3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/registry.js\":\"a34b70193dc7fdd7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/remark-timestamps.js\":\"6a160eedae8591ba\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/view.js\":\"446024704fa1657c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-link-hints/LinkHints.js\":\"7ec829585a345b8a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-link-hints/index.js\":\"e302b349bf11c8f8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-link-hints/model.js\":\"6cdf7c8a19d5dae1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-link-hints/settings.js\":\"87ed6d6958448dac\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-normal-mode/actions.js\":\"6da039feaae8dad4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-normal-mode/index.js\":\"0397f64160d2f599\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-normal-mode/interactions.js\":\"2462b188181ef0e3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/workspace-header/index.js\":\"93333b5d0d2677c8\",\"/knowledge-medium/pr-preview/pr-1921/src/registerServiceWorker.js\":\"3de7ee004ee33207\",\"/knowledge-medium/pr-preview/pr-1921/src/requestPersistentStorage.js\":\"594ff540d3de0603\",\"/knowledge-medium/pr-preview/pr-1921/src/services/authRequestDeadline.js\":\"245c0d063bfd17c4\",\"/knowledge-medium/pr-preview/pr-1921/src/services/authStorage.js\":\"2fc88a478a04af8c\",\"/knowledge-medium/pr-preview/pr-1921/src/services/powersync.js\":\"fb84545a2d1b59ae\",\"/knowledge-medium/pr-preview/pr-1921/src/services/supabase.js\":\"2540a5bd2996cca0\",\"/knowledge-medium/pr-preview/pr-1921/src/services/uploadErrorClassifier.js\":\"cf43f1330bc6483b\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/ActiveContexts.js\":\"497fe880815ddb32\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/HotkeyReconciler.js\":\"38abc426ce7fce02\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/WipeLocalDataDialog.js\":\"f43a37b321859453\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/actionDispatch.js\":\"7d13c46d3c400050\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/actionKeyHints.js\":\"4ace3a16ca1c45b1\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/actionRefItems.js\":\"39f15f5baa07636d\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/applyKeybindingOverrides.js\":\"7b219b0831970056\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/blockActions.js\":\"b732988e727bf06a\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/blockMergeGesture.js\":\"dc7ec242e88d1453\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/canonicalizeChord.js\":\"6d45623975ac0f3f\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/defaultContexts.js\":\"b3d6d729e0006c68\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/defaultShortcuts.js\":\"cf45ce2fbcdee019\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/effectiveActions.js\":\"c1ca1b1d112ad169\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/formatChord.js\":\"40f21c6fd3581ab0\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/gestureAction.js\":\"97e6b33f3080a869\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/gestureBinding.js\":\"a23857a40445541a\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/holdRegistry.js\":\"96cacea1baa438d8\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/keybindingConflicts.js\":\"5fd488d88096e6d7\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/keybindingOverrides.js\":\"a57b5c9e80cbad41\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/pointerAction.js\":\"05255330978dc647\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/resolve.js\":\"d65c2e4321f50013\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/runAction.js\":\"03512e08ec926899\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/sequenceMatcher.js\":\"773ca07093759248\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/types.js\":\"d60ad300a455daf9\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/useActionContext.js\":\"98bbcd991fce3ba2\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/useActionDiscovery.js\":\"a4242fb5ed9f6a4d\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/utils.js\":\"da89db930356531b\",\"/knowledge-medium/pr-preview/pr-1921/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1921/src/sw/bootStore.js\":\"9f48af59a5df9cca\",\"/knowledge-medium/pr-preview/pr-1921/src/sw/previewDatabases.js\":\"ddc1caa074bbfa3d\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/byteTransform.js\":\"8980fa540c2beba2\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/attachmentCleaner.js\":\"11faf9aa5221f432\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/attachmentParts.js\":\"40e94b14ebd6e85f\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/bundleParts.js\":\"4dd99371578ad8db\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/bundleRecord.js\":\"102bf36005ae12e6\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/manifest.js\":\"47a69befab528076\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/takeBundle.js\":\"ccaa1d892fba9777\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/verifyBundle.js\":\"e05449cf1f94a0bc\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/cleaningStage.js\":\"530dbf9fb794b156\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/conversionKey.js\":\"f166c7ef3af852d3\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/conversionServer.js\":\"0f5f25de4e45fe4b\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/flip.js\":\"eb869c9ff896ec09\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/flipAttempts.js\":\"2ca640640b91aeed\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/pages.js\":\"cb14a07cc59eff0e\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/preflight.js\":\"6aa4a7380da36b8b\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/reseal.js\":\"d211c0176058c360\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/runConversion.js\":\"36d6ac35936e6df8\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/runLock.js\":\"ebbc9fdddb57bdc4\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/sealing.js\":\"cdaf0fa144af0d78\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/sealingStage.js\":\"ab2d6e31967e63b6\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/stage.js\":\"4b7d09aea97a4477\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/verifyReseal.js\":\"ab88d33aa5bb2e91\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/aad.js\":\"5d71b367db5e2b47\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/aead.js\":\"8909130a7040df71\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/base32.js\":\"b0614ae0cb315fd0\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/base64url.js\":\"341edeccb269005e\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/binaryEnvelope.js\":\"5c3c3f0b35d8a7a3\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/byteAead.js\":\"dc47578827f716d0\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/canary.js\":\"f35170345ea02275\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/contentHash.js\":\"edda35f8142832f6\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/contentKey.js\":\"e54ab8f73d694635\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/derivedIdNamespace.js\":\"adb173ffa88a3189\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/envelope.js\":\"468dc65cdbea84d5\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/hex.js\":\"4eb8126d0b19c232\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/sha256Hex.js\":\"c4c164a056570a86\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/workspaceKey.js\":\"46eb5768412e5b3d\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/conversionState.js\":\"e9c460fee4639f99\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2ce164684cacc9a7\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/flows/pastedKey.js\":\"e25634c0b08f556e\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"abd6cef1d791074f\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/flows/upgradeWorkspacePin.js\":\"0abcaa0f058b8191\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/keyStore.js\":\"f7073801093641cc\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/mintWorkspaceKey.js\":\"a6f8c6ef9d96c007\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/modePin.js\":\"3852d50878efd261\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/openWorkspaceKeys.js\":\"80f21ecbfb62fa57\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/resolveWorkspaceEntry.js\":\"6471a8129515dc71\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/resolver.js\":\"18f2aec485c6d8d7\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/workspaceAccess.js\":\"b25c738d55bf5e4f\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/transform.js\":\"ab9e7196b6b03576\",\"/knowledge-medium/pr-preview/pr-1921/src/themeBootDefaults.js\":\"e393c6d64bfa093f\",\"/knowledge-medium/pr-preview/pr-1921/src/types.js\":\"542faa2ab2cada99\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/ClientLocalSettings.js\":\"5bbf105afc4ac9d9\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/abortableSleep.js\":\"ba038f142409e778\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/array.js\":\"5f9ce91c300b45eb\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/backlinkAutocomplete.js\":\"1e03f8ad0a8c4d5c\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/blockCrumbs.js\":\"d230f5fe692aab8f\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/blockrefAutocomplete.js\":\"1da008a96c44c558\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/cadencedIdleJob.js\":\"ba83181d40b930b3\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/callbackSet.js\":\"b9e0873ea2806871\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/clientId.js\":\"d0403484c577615b\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/codemirror.js\":\"99d71cf57a819d95\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/codemirrorCompletion.js\":\"e779a2a402f20390\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/copy.js\":\"2c0df3d061935e2c\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dailyPage.js\":\"d9f7aa89d586d7ac\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dbForensics.js\":\"0042c3952f0ec9d2\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dbForensicsHooks.js\":\"0df8a28b4e9183cf\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/deleteBlockThroughUi.js\":\"cc62c296a09f0053\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dialogs.js\":\"1ced1898ea1ebf71\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dom.js\":\"29828e2a3d2db002\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/downloadBlob.js\":\"bfa13150a9a74ff8\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/drawnWalk.js\":\"4d8b6be0a5d05f9f\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/exportSqliteDb.js\":\"945699e5419c5161\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/fileSystemAccess.js\":\"0d525e7b1d4583b3\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/flipSlide.js\":\"16daaa589850b541\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/fnv1a.js\":\"ae099a26dc43c1d3\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/formatBytes.js\":\"1fb4fed8e9379572\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/fuzzyRank.js\":\"92640ef5b24be52c\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/idbKeyedStore.js\":\"e213738236d0b736\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/idleCallbackPolyfill.js\":\"83e9500da4e148e6\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/keyboardAwareScroll.js\":\"ffef2fa02d6a353a\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/keyboardViewport.js\":\"5370aba05589abb8\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/lastWorkspace.js\":\"41437081a4285f62\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/layoutColumns.js\":\"6a3f362e4b6654a8\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/layoutSessionDom.js\":\"1cd6efe19adf4b61\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/layoutSessionId.js\":\"1ea756066b37756f\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/linkClickGestures.js\":\"2c5ebbf0a79de6da\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/linkTargetAutocomplete.js\":\"84429d441d02eb6f\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/localDbCorruption.js\":\"9ebefa586eb4ed5d\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/localDbRecovery.js\":\"62cc2a743c205ec5\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/markdownParser.js\":\"2fb97cfe63183d1c\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/memoize.js\":\"9f006d33d04be160\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/nameFieldCommit.js\":\"9c70ff7fb8b239b1\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/nameList.js\":\"0ebfe5352cd8bd00\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/navigation.js\":\"fad4f6a6d8207ff3\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/omnilinerNamespace.js\":\"b8810155fa939622\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/opfsPageScan.js\":\"f5c530dea126ca6e\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelClearance.js\":\"a5e4cfa17c5f0c56\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelHistory.js\":\"24cb1997a31dd736\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelLanes.js\":\"285077c6ecd3a5d5\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelLayoutProjection.js\":\"ea6cfb3c56e57694\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelScrollAnchor.js\":\"e2af000543f4723d\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelUrlFlags.js\":\"bd45176ac6e5f180\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/platform.js\":\"b8493267e66c0e92\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/pluralize.js\":\"aa7e7bf937cf9428\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/propertyCreation.js\":\"17b6acb9018036c5\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/propertyNavigation.js\":\"eb680e4fcc55797d\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/propertyValueContext.js\":\"577643726acae44d\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/react.js\":\"aa3a4b3388f9fff8\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/relativeDate.js\":\"2e5b87c82191fb3b\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/relativeTime.js\":\"e7cfb259de5d3a54\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/renderScope.js\":\"b39f352572d451ff\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/resolvedThenable.js\":\"b3df623f6fd531bd\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/routing.js\":\"c553af30049102bf\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/safeMode.js\":\"3b9bf6ce7c6b02be\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/scheduleIdle.js\":\"347c92223295c4ae\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/screenWakeLock.js\":\"a260f07fd10ee2f3\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/selection.js\":\"3e1e460c368d6e22\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/softKeyboardGrab.js\":\"ae5c7a87820dde8f\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/startupTimeline.js\":\"9af92680446f8e66\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/state.js\":\"2c3c193b1d72dbe2\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/string.js\":\"e2c8d639e55f4033\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/surfaceZoom.js\":\"5e2ac2c295c5b654\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/time.js\":\"cf6cec9f2b69cf17\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/toast.js\":\"06f7d75d69952186\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/toggleStore.js\":\"060d98ad1d22b387\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/untilStopped.js\":\"dc68d94669d0d4f2\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/userActivity.js\":\"f0f5c686eb286257\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/viewTransition.js\":\"1d3cf5f2808f4085\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/viewport.js\":\"b7afaa9b7f098581\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/webLock.js\":\"3598abbc252a76ba\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/workspaceRecovery.js\":\"dc151f1f8343a774\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/workspaceSnapshotStore.js\":\"1ac02ec2a319959c\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-compiler-runtime.js\":\"6f56e4b49805b652\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-client.js\":\"c42333cea568ddec\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-server-edge.js\":\"c0bf48f54a02f034\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-server.js\":\"f43f2b7e41b19c78\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-static-edge.js\":\"35dc8303ef8c6d09\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-static.js\":\"6924628d36743b30\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-test-utils.js\":\"c1a73662828853f5\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom.js\":\"7aa1f14650f9e1ef\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-jsx-runtime.js\":\"b9d93478de53e9c3\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react.js\":\"f4515e505239a205\",\"/knowledge-medium/pr-preview/pr-1921/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1921/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1921/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
