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
		buildId: "02a9cadbf29e-debcb58f",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1921/\":\"b57fab87a8b5cffc\",\"/knowledge-medium/pr-preview/pr-1921/index.html\":\"b57fab87a8b5cffc\",\"/knowledge-medium/pr-preview/pr-1921/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1921/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1921/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1921/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1921/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1921/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1921/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1921/assets/FacadeVFS-BSSFManE.js\":\"5fc209f8909bbd04\",\"/knowledge-medium/pr-preview/pr-1921/assets/OPFSCoopSyncVFS-BWYhYPoN.js\":\"a67dc3aa987e26ac\",\"/knowledge-medium/pr-preview/pr-1921/assets/OPFSWriteAheadVFS-DB5pqBw9.js\":\"5fe1ba94d607c545\",\"/knowledge-medium/pr-preview/pr-1921/assets/wa-sqlite-B8aphSl5.js\":\"703651b05f6bea52\",\"/knowledge-medium/pr-preview/pr-1921/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1921/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1921/assets/wa-sqlite-async-D64yV3qD.js\":\"01cbeba0fccf8bbd\",\"/knowledge-medium/pr-preview/pr-1921/assets/worker-Ck7hjOUP.js\":\"73869b210ad51017\",\"/knowledge-medium/pr-preview/pr-1921/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1921/chunks/app-Cl4eX0-E.js\":\"7995bfe41a014c3c\",\"/knowledge-medium/pr-preview/pr-1921/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1921/index.js\":\"411dea5aab63291e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1921/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1921/assets/AccessHandlePoolVFS-AsI7DUzD.js\":\"7626f7d1a56f24db\",\"/knowledge-medium/pr-preview/pr-1921/assets/IDBBatchAtomicVFS-Cc0Oqw0F.js\":\"55c7f3a865b8a4c0\",\"/knowledge-medium/pr-preview/pr-1921/assets/MemoryVFS-Dp9vGCDl.js\":\"29f6dc13ec2d97bb\",\"/knowledge-medium/pr-preview/pr-1921/assets/mc-wa-sqlite-Bx6eVRBz.js\":\"54cb7f77acbd34ae\",\"/knowledge-medium/pr-preview/pr-1921/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1921/assets/mc-wa-sqlite-async-ClkCeJ0m.js\":\"d72f02038007f076\",\"/knowledge-medium/pr-preview/pr-1921/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1921/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1921/chunks/AccessHandlePoolVFS-CXWuYtep.js\":\"5f486017cd0dca88\",\"/knowledge-medium/pr-preview/pr-1921/chunks/FacadeVFS-DgYgcrka.js\":\"04eddf102b1ba0ec\",\"/knowledge-medium/pr-preview/pr-1921/chunks/IDBBatchAtomicVFS-MzU5gROj.js\":\"04b4ecb70ebb86ea\",\"/knowledge-medium/pr-preview/pr-1921/chunks/MemoryVFS-Buzdn6Bc.js\":\"6f0afd3f637383b5\",\"/knowledge-medium/pr-preview/pr-1921/chunks/OPFSCoopSyncVFS-DA7lKTR5.js\":\"4a7386c4da827f83\",\"/knowledge-medium/pr-preview/pr-1921/chunks/OPFSWriteAheadVFS-Blb4Qzku.js\":\"7a798a462a5557d2\",\"/knowledge-medium/pr-preview/pr-1921/chunks/Preview-sor0Qgp5.js\":\"11007b01f27f777d\",\"/knowledge-medium/pr-preview/pr-1921/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1921/chunks/card-CizTi4EH.js\":\"a9b57d82cf7ffcb4\",\"/knowledge-medium/pr-preview/pr-1921/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1921/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1921/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1921/chunks/dist-CF9OArDa.js\":\"ac5460c16140c2ca\",\"/knowledge-medium/pr-preview/pr-1921/chunks/freezeExtensionImports-BtuIYGpv.js\":\"79aa566a078f7084\",\"/knowledge-medium/pr-preview/pr-1921/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1921/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1921/chunks/mc-wa-sqlite-CxdNIsVX.js\":\"f36580c5247eea11\",\"/knowledge-medium/pr-preview/pr-1921/chunks/mc-wa-sqlite-async-C4_YJ2Kx.js\":\"f2b50794c0f7cc2b\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-B-YvKVUW.js\":\"df2a5962973dc6f9\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-B7EpAt5r.js\":\"861e3b347f073004\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-C6sp-hf0.js\":\"0ce3febfaf770d54\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-DAgMA16Z.js\":\"c44df68d160cddbf\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-DfsT5sRy.js\":\"ee6045a16537c1d1\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-DnqNxp5m.js\":\"2db8f8e314d2a47a\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-DuItwQu1.js\":\"9aa0aaa709b8eba9\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-WqldDs1p.js\":\"7b42523d7e23258f\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-dom-server-legacy.browser.production-DMXTT_NJ.js\":\"e14a5f707ccca4ba\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-dom-server.browser.production-DU0msRpS.js\":\"37b32fa0578aa8ab\",\"/knowledge-medium/pr-preview/pr-1921/chunks/react-dom-server.edge.production-DvMBE64U.js\":\"5424893fd91085aa\",\"/knowledge-medium/pr-preview/pr-1921/chunks/server.browser-B-BAdU56.js\":\"9542cc0694b79e20\",\"/knowledge-medium/pr-preview/pr-1921/chunks/textarea-DfycudM_.js\":\"6a67ef50319a9bed\",\"/knowledge-medium/pr-preview/pr-1921/chunks/ui-b8U3oun7.js\":\"c420a9f981429ea9\",\"/knowledge-medium/pr-preview/pr-1921/chunks/wa-sqlite-BkY7Qq5_.js\":\"48372a220e1c05b9\",\"/knowledge-medium/pr-preview/pr-1921/chunks/wa-sqlite-async-CAgCCju9.js\":\"a230a835efe7b4b5\",\"/knowledge-medium/pr-preview/pr-1921/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1921/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1921/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1921/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1921/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1921/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1921/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1921/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1921/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1921/src/App.js\":\"309faff479cf57c5\",\"/knowledge-medium/pr-preview/pr-1921/src/appUpdate.js\":\"278d172c6d2761ea\",\"/knowledge-medium/pr-preview/pr-1921/src/appVersion.js\":\"4f9d36b4311de54d\",\"/knowledge-medium/pr-preview/pr-1921/src/bootstrap/initialLayout.js\":\"cd92c571859a02b2\",\"/knowledge-medium/pr-preview/pr-1921/src/bootstrap/openWorkspaceData.js\":\"259186e7e8727379\",\"/knowledge-medium/pr-preview/pr-1921/src/bootstrap/resolveWorkspace.js\":\"62cb85232805e69a\",\"/knowledge-medium/pr-preview/pr-1921/src/bootstrap/workspaceBootstrap.js\":\"41493b55059a45d4\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockComponent.js\":\"b0cf46c87285d783\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockCrumbs.js\":\"7e05f7b2b7c897ae\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockEditor.js\":\"e1bf8826b542726b\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockLoadingPlaceholder.js\":\"1ae96289e520d407\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockProperties.js\":\"7eb40add36d1b1ca\",\"/knowledge-medium/pr-preview/pr-1921/src/components/BlockSearchPicker.js\":\"a3dbedb539992062\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ConfirmBulkDeleteDialog.js\":\"0b812efac8247f9a\",\"/knowledge-medium/pr-preview/pr-1921/src/components/DividerHandle.js\":\"228865dd757d5a1e\",\"/knowledge-medium/pr-preview/pr-1921/src/components/DraftEditor.js\":\"b37603834accaa1a\",\"/knowledge-medium/pr-preview/pr-1921/src/components/GutterPill.js\":\"26d2405ea58ad88d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/Header.js\":\"300424d8aab60ac0\",\"/knowledge-medium/pr-preview/pr-1921/src/components/LazyBlockComponent.js\":\"c8e368d1054ba90d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/Login.js\":\"6c5ebb32062e1606\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ZoomableSurface.js\":\"fd55fbfc0184c4c0\",\"/knowledge-medium/pr-preview/pr-1921/src/components/editModeKeepalive.js\":\"d9ec774c84720ed2\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyDisplay/PropertyDisplayScope.js\":\"c523fde38bc0ebba\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"0b78a0a9e6f4778f\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/RefPropertyEditor.js\":\"ba4b1a6c69ac11d4\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/RefTargetTypePicker.js\":\"b00b5c16d32bab42\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/SelectPropertyEditor.js\":\"fad814a66c18b796\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/TypesPropertyEditor.js\":\"9ed95fb59123319d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/defaults.js\":\"c661c4f69cb86f5a\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/kernelValuePresets.js\":\"9a9d783073002836\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/selectablePresets.js\":\"bc2f1c0c0e954a0d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyEditors/typesPropertyUi.js\":\"8e6bc976717a36b5\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/AddPropertyForm.js\":\"5dd3988a7e06cdfe\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/PropertyPicker.js\":\"4393028523f86159\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/PropertyRow.js\":\"f7287a067ec0a767\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/Rows.js\":\"c7ed05f1aa783b67\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/actions.js\":\"e6b7bf89889fa4fd\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/declarationOnly.js\":\"a460641b87bcb842\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/layout.js\":\"7deb6c6a7ae33b66\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/model.js\":\"177f5dcb48a6c51c\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/shapeUi.js\":\"9a37546c9a9fde15\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/shapes.js\":\"147f89ae42007643\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/usePropertyEditingActivation.js\":\"926fe3b0046b8827\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanel/visibility.js\":\"691d0c7a9b93d79b\",\"/knowledge-medium/pr-preview/pr-1921/src/components/propertyPanelSections.js\":\"f7abdc2a374afa51\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/BlockEmbed.js\":\"c7d6e70f144453fe\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/BlockLink.js\":\"72cbb1be7e1f7792\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/BlockRef.js\":\"248d035070b06623\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/CompactReferenceLink.js\":\"6068b0ab916deef1\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/ReferenceLink.js\":\"47e85ceeac899f6b\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/cycleGuard.js\":\"60410aa58fa2cad5\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/cycleGuardContext.js\":\"b1715553140efe79\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/linkInteraction.js\":\"d4867226db654cf2\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/referenceLayout.js\":\"5e809753d20377cc\",\"/knowledge-medium/pr-preview/pr-1921/src/components/references/useBlockRefAncestors.js\":\"03aa38e3eace1dda\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BlockGutter.js\":\"7bb6cd8047b115d8\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BlockInfoDialog.js\":\"76f60ebf6667dc99\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BlockReadText.js\":\"59a46f7506ce041e\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BlockTypeBlockRenderer.js\":\"b54af21b4a86c02b\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/BulletHoverCard.js\":\"37c6e863fa80a356\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/CodeMirrorContentRenderer.js\":\"d87185655fdd117d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"0cc5ba9efde07298\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/ColumnResizeHandles.js\":\"bbad1179bf8466a9\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"bc11714a9aad4755\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/DefaultBlockRenderer.js\":\"d3805774b3887468\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/LayoutRenderer.js\":\"a2d2c154e041c5e5\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/MarkdownContentRenderer.js\":\"3c390d1beec1991c\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/MissingDataRenderer.js\":\"8e80c43609446623\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/PanelRenderer.js\":\"4487cb5d91b2c107\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/PropertySchemaBlockRenderer.js\":\"82def026df34ce26\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/TopLevelRenderer.js\":\"de063e11fb86fc23\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/blockGutterMode.js\":\"167fc36d79134ea5\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/blockTitleText.js\":\"afa1ddd0953b052a\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/fieldCreationKeydown.js\":\"ffba01d93d14c228\",\"/knowledge-medium/pr-preview/pr-1921/src/components/renderer/layoutRootContext.js\":\"66092867c07eb740\",\"/knowledge-medium/pr-preview/pr-1921/src/components/typeChip/TypeChip.js\":\"800851d46b6067bd\",\"/knowledge-medium/pr-preview/pr-1921/src/components/typeChip/chipStyle.js\":\"0850e61d27a56343\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/anchored-floating.js\":\"55e94cdc19cbe021\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/button.js\":\"8addc7fe84f794ed\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/card.js\":\"ffd8b785b9bda95b\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/checkbox.js\":\"d49f8977eb3c1c46\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/collapsible.js\":\"6f52cf9e80374642\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/command.js\":\"7dfa613c2a986280\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/context-menu.js\":\"302f9e9b98b97beb\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/dialog.js\":\"2823d47d8930e3c1\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/dropdown-menu.js\":\"b66f78f8b584a3bd\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/floating-listbox.js\":\"b8af365da9230178\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/index.js\":\"879e4da03ab0542a\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/input.js\":\"147262372019439e\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/kbd.js\":\"b80c4e94cab3f761\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/label.js\":\"fdf62d12a6ea0cd6\",\"/knowledge-medium/pr-preview/pr-1921/src/components/ui/textarea.js\":\"904ffa73bc9b750e\",\"/knowledge-medium/pr-preview/pr-1921/src/components/useEditModeYieldKeepalive.js\":\"a9d8b28f4d8269e0\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/BootFallback.js\":\"99846d177a518ca1\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/FocusedRowLazyMount.js\":\"f308e07731e5a3c5\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/LazyViewportMount.js\":\"9945a1e50d3ed66d\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/LocalDbCorruptionFallback.js\":\"e951767fe0e79b70\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/error.js\":\"c44180448cfe36b6\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/lazyMountRegistry.js\":\"8394e1264416c39f\",\"/knowledge-medium/pr-preview/pr-1921/src/components/util/suspense.js\":\"8ed261fbc058cfd1\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/CreateWorkspaceDialog.js\":\"80e491854a59a0ca\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/PendingInvitations.js\":\"4de00b850cf8f383\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/SyncProgress.js\":\"f407a1deb494eb62\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/UnlockProgress.js\":\"02e1de7703a3f3f0\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/WorkspaceKeyGate.js\":\"4245f5fbf3d5be06\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/WorkspaceSettingsDialog.js\":\"1d8d2933d984a700\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/WorkspaceSwitcher.js\":\"d0d0989ff6d65546\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/WorkspaceSyncGate.js\":\"d748c5ce07a7d18c\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/ConversionFlow.js\":\"36fe8bf486b5c42c\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/ConversionFlowHost.js\":\"a69b5ee6540817fa\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/EncryptionSection.js\":\"d15138667ef95977\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/attachmentPrompts.js\":\"c6c663ea18b3dc5b\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/bundleFolderPrompts.js\":\"0b7d56d679e904a4\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/conversionFlowDeps.js\":\"b98623cc425eeb62\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/conversionFlowStore.js\":\"689cb918d32e0d95\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/flowUi.js\":\"7110cba00b98dd12\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/conversion/useConversionRun.js\":\"f06db0c5102a0dfe\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/keyUi.js\":\"b1a7632f044a6fa9\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/useCloseOnKeyLoss.js\":\"b7151f1f8f9d1afe\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/useCloseOnServerE2ee.js\":\"c41cc998016b9805\",\"/knowledge-medium/pr-preview/pr-1921/src/components/workspace/workspaceUnlocked.js\":\"1fc24b5789773f19\",\"/knowledge-medium/pr-preview/pr-1921/src/context/backgroundSubtree.js\":\"81bcfffb7a5183f6\",\"/knowledge-medium/pr-preview/pr-1921/src/context/block.js\":\"e970b17b9d92eb03\",\"/knowledge-medium/pr-preview/pr-1921/src/context/layoutWsContext.js\":\"3ae1a8bea1e0a5ab\",\"/knowledge-medium/pr-preview/pr-1921/src/context/propertyDisplay.js\":\"af10491683db8754\",\"/knowledge-medium/pr-preview/pr-1921/src/context/repo.js\":\"af9bae8ca453033a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/aliasClaim.js\":\"b19b6e5b1d0a2d55\",\"/knowledge-medium/pr-preview/pr-1921/src/data/aliasSeatNamespace.js\":\"4d19307cb0a882a9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/blockData.js\":\"d63374e2a30628c5\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/blockType.js\":\"6b04e5ab1d877038\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/changeScope.js\":\"45cb6a2cdfcfdd6a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/codecs.js\":\"cb5825d53e3bb149\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/derivedData.js\":\"caf5beb296b3403f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/errors.js\":\"1506fed8fe4f6a79\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/events.js\":\"42505a68ac79f76e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/handle.js\":\"835ac6c50b9f4387\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/index.js\":\"3072937938c23e16\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/mutator.js\":\"b889f6aac01d50a3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/processor.js\":\"568f1ae975d22eff\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/propertySchema.js\":\"b1eb6e51267d9121\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/query.js\":\"3180ad2d147a5f9e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/sameTxProcessor.js\":\"1067eb48e1b7e4ca\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/schema.js\":\"835ac6c50b9f4387\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/tx.js\":\"835ac6c50b9f4387\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/typedBlockQuery.js\":\"53f9e2cc890884bc\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/user.js\":\"bcfd77b5c66ccc74\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/valuePresetCore.js\":\"4f78d0338b6cd14b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/api/valuePresets.js\":\"bdd5686302529ac5\",\"/knowledge-medium/pr-preview/pr-1921/src/data/attachmentCleanerIOVerb.js\":\"bce84754d94494e6\",\"/knowledge-medium/pr-preview/pr-1921/src/data/block.js\":\"a1192f43632c4d69\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockCache.js\":\"efef9ceb321adb0b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockId.js\":\"ef52eccc561e2853\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockLiveness.js\":\"ea0db5187578915c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockMerge.js\":\"bf73649caad0d757\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockSchema.js\":\"8ffbc3e37e3c62ee\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockTypeLookup.js\":\"9269c619d65cf966\",\"/knowledge-medium/pr-preview/pr-1921/src/data/blockTypes.js\":\"6d9f2fcd5735db3c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/childrenView.js\":\"cca301e741d1b995\",\"/knowledge-medium/pr-preview/pr-1921/src/data/clientContext.js\":\"23e154bb1c65db0c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/dbFileSiblings.js\":\"9f98f367f2334a75\",\"/knowledge-medium/pr-preview/pr-1921/src/data/definitionSeeds.js\":\"de20223cb85c3bd9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/derivedIds.js\":\"6d878dea75325029\",\"/knowledge-medium/pr-preview/pr-1921/src/data/drawnSubtree.js\":\"f9a8664315d3b7e4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/facetBridge.js\":\"afa306febac315b8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/facets.js\":\"c5fdb7fd845b8292\",\"/knowledge-medium/pr-preview/pr-1921/src/data/globalState.js\":\"ad6cb28b1cba0b8b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/aliasClaimRederiveProcessor.js\":\"9c37786c29aaf056\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/ancestorBatch.js\":\"d23ac243ed66d61e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/blockTypeTypeifyProcessor.js\":\"f3e4642025806f7a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/clientSchema.js\":\"0e102925a992afe3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/commitPipeline.js\":\"1c222a439d996a50\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/devAssertions.js\":\"afef8bcba6bb3963\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/firstSync.js\":\"78334f194bb75324\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/freshInitialLoad.js\":\"0349890b3e11e4d5\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/graphBackfillClaim.js\":\"6c690a3bc07a2a2a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/handleStore.js\":\"e490ab1da3aebc30\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/idleMarkerJobs.js\":\"3465335ef473fc47\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/initialDownload.js\":\"40cde9465d4d8f23\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/initializeClientDatabase.js\":\"6b99ba1ed91f47d9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/jsonCanonical.js\":\"8dc4eee9f56d6399\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/kernelInvalidation.js\":\"6d20af76fc1a500f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/kernelProcessors.js\":\"33e1010589d227be\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/kernelQueries.js\":\"593511119751be16\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/mergeTypeMembershipProcessor.js\":\"1c1e35d51a223992\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/normalizeReferencesProcessor.js\":\"6cc2d0c5e0f1d0e6\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/poolInstrumentation.js\":\"d23b2b43ae2f658e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/processorRunner.js\":\"b84bcdca59514aa0\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyCellBackfill.js\":\"f1065d07eda3e524\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyChildMint.js\":\"a389f3fdd975ff1d\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyChildrenProcessor.js\":\"483c17e5cca4b5f9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyDefinitionChangeProcessor.js\":\"25e5e63e421a7d38\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyDefinitionSynthesis.js\":\"4da3e4eabfaf1f46\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyKeyScan.js\":\"46e61a1e5a4f742f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertySchemaResolution.js\":\"62d17ec095382f49\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/propertyValueEdits.js\":\"4c74bc98ccf7835a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/raiseProtocol.js\":\"7c5d4b0d882aeb5a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/readBatch.js\":\"3f6fd51838a864a5\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/refProjection.js\":\"4e1ea3cfc909abae\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/referenceTargetLookups.js\":\"975a37622207b977\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/referenceTargetProcessor.js\":\"258a437b4781db35\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/replayMerge.js\":\"4067e3f71af4088d\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/sqlBinds.js\":\"07b9e7a0adda5974\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"1f140295d461e0f7\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/arrivalProcessors.js\":\"a8870785200bfcbd\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/invalidate.js\":\"549b8b0a4c52abb4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/materialize.js\":\"628e8539b58f0c0c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/observer.js\":\"77c80f9ca78d7b9e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/syncObserver/reconcile.js\":\"7b8050141f99f41c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/timingMetrics.js\":\"635366574c4a0d59\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/treeQueries.js\":\"6c52f390611448d2\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/txEngine.js\":\"4b20d6696be660e8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/txSnapshots.js\":\"32c1741c88cb80f9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/typedBlockQuery.js\":\"7b5cd82c29bfd814\",\"/knowledge-medium/pr-preview/pr-1921/src/data/internals/undoManager.js\":\"b4cbd2296c1101b1\",\"/knowledge-medium/pr-preview/pr-1921/src/data/invalidation.js\":\"affb6382d73f4cb4\",\"/knowledge-medium/pr-preview/pr-1921/src/data/kernelDataExtension.js\":\"6796abd27500ce40\",\"/knowledge-medium/pr-preview/pr-1921/src/data/kernelPage.js\":\"b011155b4c82cc56\",\"/knowledge-medium/pr-preview/pr-1921/src/data/kernelValuePresetCores.js\":\"947195edfe5616c3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/localDbCorruptionSignal.js\":\"cd49e80882b6c64d\",\"/knowledge-medium/pr-preview/pr-1921/src/data/localDbStorage.js\":\"2611cd56341c3a4a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/localDbVfs.js\":\"c99e70264a9c554f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/localSchema.js\":\"fa9cdd3e90026c5e\",\"/knowledge-medium/pr-preview/pr-1921/src/data/maintenance.js\":\"02aa38f98003c588\",\"/knowledge-medium/pr-preview/pr-1921/src/data/mergeProperties.js\":\"b02cc29e55e851a6\",\"/knowledge-medium/pr-preview/pr-1921/src/data/metricsConsoleHook.js\":\"19036e957cf33872\",\"/knowledge-medium/pr-preview/pr-1921/src/data/migrationsPage.js\":\"de8e788b48c8d2f0\",\"/knowledge-medium/pr-preview/pr-1921/src/data/mutators.js\":\"acb677f0d9b494e9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/orderKey.js\":\"e4153c9060f68b64\",\"/knowledge-medium/pr-preview/pr-1921/src/data/orderKeyPlacement.js\":\"fb46e4371260285b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/outlineSurface.js\":\"1396c5529208b3e9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/pendingEditorContent.js\":\"ac318b45349fd348\",\"/knowledge-medium/pr-preview/pr-1921/src/data/pendingUploadsSql.js\":\"0549e68a1fb6aa73\",\"/knowledge-medium/pr-preview/pr-1921/src/data/pluginStateExtensions.js\":\"f3fb5a0d4cbefbd0\",\"/knowledge-medium/pr-preview/pr-1921/src/data/powerSyncLogger.js\":\"af8f2a1f371005b0\",\"/knowledge-medium/pr-preview/pr-1921/src/data/projectorRuntime.js\":\"a92d8a9498cbdf10\",\"/knowledge-medium/pr-preview/pr-1921/src/data/properties.js\":\"9b7a84919f005f26\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertiesPage.js\":\"a328b5273f129477\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyChildren.js\":\"4941b2c423e5fca3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyDefinitionFanout.js\":\"03cf773ffa1d15ca\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyDefinitionMetadata.js\":\"cf198f74add4c118\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyDefinitionRegistry.js\":\"ee7c264b0b970f39\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyDisplayMode.js\":\"e229a2b0e73ba88b\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertyRowCreation.js\":\"84f39a9bb8ab3ac8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertySchemaCreation.js\":\"dc3a3d9f8240344a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/propertySeeds.js\":\"9129861fd991283d\",\"/knowledge-medium/pr-preview/pr-1921/src/data/recentsPage.js\":\"e0053311ccf45cb3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/refTargetComparableProperty.js\":\"aeb0e440dcdf6278\",\"/knowledge-medium/pr-preview/pr-1921/src/data/referenceBlock.js\":\"fd6e33176ac533df\",\"/knowledge-medium/pr-preview/pr-1921/src/data/rejectedUploads.js\":\"7fbc74cbc487c849\",\"/knowledge-medium/pr-preview/pr-1921/src/data/releasePowerSyncConnection.js\":\"5448f1295a431587\",\"/knowledge-medium/pr-preview/pr-1921/src/data/repo.js\":\"28b634278e8cb6df\",\"/knowledge-medium/pr-preview/pr-1921/src/data/repoProvider.js\":\"865f344b7d2c5473\",\"/knowledge-medium/pr-preview/pr-1921/src/data/rowProperty.js\":\"3ec9c3fa8a436df2\",\"/knowledge-medium/pr-preview/pr-1921/src/data/searchFilter.js\":\"44b1f08e02e7890f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/seedIdentityLedger.js\":\"c8f334b362538688\",\"/knowledge-medium/pr-preview/pr-1921/src/data/stateBlocks.js\":\"e4b61bbc1ae1fdbc\",\"/knowledge-medium/pr-preview/pr-1921/src/data/structuralEditPolicy.js\":\"8a201f56ecd2ee27\",\"/knowledge-medium/pr-preview/pr-1921/src/data/structuralInsert.js\":\"a1f8aa76c70f0e99\",\"/knowledge-medium/pr-preview/pr-1921/src/data/subtreeDelete.js\":\"20dba3330d4195fa\",\"/knowledge-medium/pr-preview/pr-1921/src/data/syncStreamLock.js\":\"ce2f26a02e56cb09\",\"/knowledge-medium/pr-preview/pr-1921/src/data/syncedTableSqlRecognizer.js\":\"4314c37b580666fe\",\"/knowledge-medium/pr-preview/pr-1921/src/data/syncedTableWriteGuard.js\":\"e6c1853a2a6596c0\",\"/knowledge-medium/pr-preview/pr-1921/src/data/targets.js\":\"9a3ea861a41c4598\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeColors.js\":\"5acefff7a9f22dec\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeDefinitionMetadata.js\":\"0c7d9f8284dce7c3\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeDefinitionRegistry.js\":\"0600c09476c398ef\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeExtraction.js\":\"ed71dcc64bf8c2a6\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeInitialValues.js\":\"5db287dddd408446\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typePropertyGroups.js\":\"b66d2e95ea422bb5\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeSeeds.js\":\"dba3f5e49c83125a\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typeTagger.js\":\"d496cc9d7b21f280\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typedRecords.js\":\"423681f7e11bc454\",\"/knowledge-medium/pr-preview/pr-1921/src/data/typesPage.js\":\"91c2d9ebc7890645\",\"/knowledge-medium/pr-preview/pr-1921/src/data/userPrefs.js\":\"637cb8c643c53f33\",\"/knowledge-medium/pr-preview/pr-1921/src/data/userSchemasService.js\":\"5b73b84055a065d9\",\"/knowledge-medium/pr-preview/pr-1921/src/data/userTypesService.js\":\"70608992490c4361\",\"/knowledge-medium/pr-preview/pr-1921/src/data/valuePresetRegistry.js\":\"6dbbf81f4b07548c\",\"/knowledge-medium/pr-preview/pr-1921/src/data/visibleChildren.js\":\"3b86b168dd448ead\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaceConversion.js\":\"0f53bd63a6e2bfcc\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaceFirstSync.js\":\"7658d2161229bde8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaceIdNamespace.js\":\"a19a049ca8a936c2\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaceSchema.js\":\"5ec0a3963e3e0435\",\"/knowledge-medium/pr-preview/pr-1921/src/data/workspaces.js\":\"91d3d64b817c2b5f\",\"/knowledge-medium/pr-preview/pr-1921/src/data/writeAheadLog.js\":\"72c47eed33e8fed8\",\"/knowledge-medium/pr-preview/pr-1921/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/BlockPasteShellDecorator.js\":\"f7c8d53feb79ceb9\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/atTrigger.js\":\"43526ddf52568080\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/autocomplete.js\":\"9f2cbe7a04173db8\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/codeMirrorExtensions.js\":\"27bc4b9451fc5335\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/contentFlush.js\":\"a6e3f18c712ce3ca\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/defaultInteractions.js\":\"6c7aa842e09f3081\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/editSettleSignal.js\":\"1fec01d6e4b55a01\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/insertImage.js\":\"72fc6b18daab8c89\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/referenceCompletionRange.js\":\"98ff76fc04e03d0f\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/referenceTargetTypes.js\":\"cea0b72cd5bfc65c\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/syntaxContext.js\":\"15078587132d647c\",\"/knowledge-medium/pr-preview/pr-1921/src/editor/triggerMatch.js\":\"29b1fb41aa55aeed\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/AppRuntimeProvider.js\":\"b5b490f84bfe1e79\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/BlockFocusShellDecorator.js\":\"92240b635965ce35\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/ExtensionRenderBoundary.js\":\"63df13caf4f69777\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/PanelContentRecovery.js\":\"d387bc145993340d\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/apiCatalog.js\":\"acc5ee73dae95132\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/appRuntimeController.js\":\"c5c534b598209216\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/approveExtensionHere.js\":\"c9ff4eb8dc91a9b2\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/armedCutAppMount.js\":\"a4ca04b56f42f587\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/batchableKeyedStore.js\":\"c09040f41858095e\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/blockInteraction.js\":\"bb4b45acc9df0547\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/blockSelectionAction.js\":\"5e7882ba28cfe974\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/compileExtensionModule.js\":\"2b91595f27e1547b\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/compiledModuleCache.js\":\"c957202daa244c12\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/continuousGestures.js\":\"8576d7fe98c930c9\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/core.js\":\"9a206db92cf36b0f\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/defaultRenderers.js\":\"dff25d411eeb0a05\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/definitionFanoutAppMount.js\":\"e1104ed0a828b86c\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/dialogAppMount.js\":\"e3d0c7f322117d61\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/dynamicExtensionSeeds.js\":\"46e8666f1ec2ca60\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/dynamicExtensions.js\":\"7d50722854cc7c05\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/exampleExtensions.js\":\"b73a776ff4c205c5\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionApprovalStatus.js\":\"09d75b9e4e87b21d\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionImportPolicy.js\":\"502d8f2868eb0ecd\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionLoadErrorToast.js\":\"185b58d8af77d3de\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionLoadErrors.js\":\"b28e0cc8b1f4da64\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionLookup.js\":\"da6ffcd9322d3b8c\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionToggles.js\":\"10a9a0fe44ac709c\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/extensionUtilitiesCss.js\":\"df3c77932c02f65d\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/kernelPageDeletionGuard.js\":\"7997419c3a157895\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/liveRuntime.js\":\"94bb6f03c61b5cc8\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/normalizeExtensionSource.js\":\"908b1250703dd062\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/openExtensionsSettings.js\":\"b1e6288e31333e34\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/overridesCache.js\":\"9f445557d5e217af\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/pluginIds.js\":\"de9ec19a6c02eb08\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/processorRejectionToast.js\":\"4230e16d447e910b\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/runtimeActions.js\":\"b29485ebcf4ad9d4\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/runtimeContext.js\":\"5b6ecf33623eef1f\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/staticAppExtensions.js\":\"7f7b66d127a39f9c\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/staticDataExtensions.js\":\"edb3ceeb9444606b\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/toastAppMount.js\":\"f07076cf85e5fe16\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/transpileExtension.js\":\"e313530db43454e5\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/useOverrides.js\":\"47fa70b2e885e163\",\"/knowledge-medium/pr-preview/pr-1921/src/extensions/useShortcutSurfaceActivations.js\":\"50589af816baeb83\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/discoverToggleTree.js\":\"b1adf06994513e85\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/facet.js\":\"79d88af808509018\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/resolveAppRuntime.js\":\"dc57debfc5d55ac6\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/runtimeEvents.js\":\"9ae56b5455816a50\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/togglable.js\":\"e191f46835b0edbc\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/variantFacet.js\":\"841b7999a3e3f9b9\",\"/knowledge-medium/pr-preview/pr-1921/src/facets/verbFacet.js\":\"ad7fc31f675d56bb\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/block.js\":\"aa78ebf6f9b63c79\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/focusedChild.js\":\"a4180e00dd5c75c4\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/propertySchemas.js\":\"03de3996844d386a\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/typeRegistry.js\":\"718dc3226a57a332\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useAncestorCrumbs.js\":\"3f1519278bba357c\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useAutocompleteListbox.js\":\"effcb25bc3ef1aee\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useDebouncedSearch.js\":\"0dd5af3aedf0ac88\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useDebouncedValue.js\":\"5839d90ac7baa0ac\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useFacetValue.js\":\"c52e3f86343e900d\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useIsFocalRender.js\":\"19dbb451c960181d\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useIsReadOnly.js\":\"ca542bba504fb1e9\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useMaterializeBacklog.js\":\"64332cc6a01a5ddf\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useMinuteClock.js\":\"d3cd65b0511696a8\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/usePanelLayoutProjection.js\":\"357345c3f7223b6d\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/usePendingInvitations.js\":\"08bee87bc8da8bf7\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useRendererRegistry.js\":\"144b335b9ba26364\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useRetainedFieldRows.js\":\"a1b00ca58fbd4016\",\"/knowledge-medium/pr-preview/pr-1921/src/hooks/useWorkspaces.js\":\"d12a98a15ff3b7a6\",\"/knowledge-medium/pr-preview/pr-1921/src/lib/utils.js\":\"33ee7b6a07e5d045\",\"/knowledge-medium/pr-preview/pr-1921/src/main.js\":\"ebe284ea84211e4f\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/MarkdownImage.js\":\"0809e20813bf368b\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/blockSeparators.js\":\"a5b6872b6762cb57\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/context.js\":\"d348740451891f6b\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/defaultMarkdownExtension.js\":\"c9ffe438c1145f7b\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/extensions.js\":\"30cfb70615c2b567\",\"/knowledge-medium/pr-preview/pr-1921/src/markdown/renderMarkdownHtml.js\":\"7dfc1352fc0888a1\",\"/knowledge-medium/pr-preview/pr-1921/src/minimal-editor.js\":\"40821b87fc000c87\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/armedCut.js\":\"797c89eba7a3fdcf\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/captureMediaVerb.js\":\"db84a47f3e24924f\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/clipboard.js\":\"f48b848b34a25a7a\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/decision.js\":\"13b3d1a9199d95fd\",\"/knowledge-medium/pr-preview/pr-1921/src/paste/operations.js\":\"295d22f88cbce997\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/account-header/AccountHeaderItem.js\":\"fd962ed4b355910d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/account-header/index.js\":\"ce147aa58617ec8f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"b583c21240fcf185\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/askAgent.js\":\"d6a1eb6e9dcd2474\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/askedStore.js\":\"f56658e9b24defe8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"400dd1af46d4c188\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/chipState.js\":\"e11b40d01b997984\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/dataExtension.js\":\"9684b759bc4b0d23\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/index.js\":\"0322f238baa5e614\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"69fec1a17ed71750\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-dispatch-companion/schema.js\":\"e0fc24104ccd2453\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/AgentTokensDialog.js\":\"d5ff08c19e387263\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/BridgePairingDialog.js\":\"5422047e18f56a82\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/addMedia.js\":\"dff7a5cfccdd0759\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/backlinks.js\":\"e6b3b3618b3b4f4d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/block.js\":\"8fc0a66a3d583b7f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/context.js\":\"711cb25f06f7ad4d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/displayIds.js\":\"934a9be3a85199d3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/index.js\":\"37811d5ab4272200\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/outline.js\":\"feff0bca5102931f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/properties.js\":\"7bc64d2592d8b842\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/refs.js\":\"4c861e969e4adf3e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"9c87f64c8152cfb1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/search.js\":\"4a21900ecd6460f2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/shared.js\":\"c14a0c1b08db7276\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"f9392dce85daf960\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentViews/text.js\":\"b068af11ed61a324\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/agentWrites.js\":\"2be81a7288ac84cb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/authoringCatalog.js\":\"bfba5ba226facf34\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/blockRefTargets.js\":\"94b6384a7801a349\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/bridge.js\":\"cd3d0eabc7391c8f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/bridgeLoop.js\":\"a8345ea184e35578\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/changeHistory.js\":\"90b62bbc09f0f4e9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/commands.js\":\"ded636e8c37ba203\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/commentsCommands.js\":\"40fcfc8bb004a696\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/dataExtension.js\":\"35f811ca4b8d0ea0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/dataModelGuide.js\":\"46a4766c9065ca4b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/dayPropertyInputs.js\":\"9c5e033f87be329d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/describeRuntime.js\":\"a1dd895d2513d86f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/extensionLint.js\":\"a3e52e3a1c8d5f8f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/grainAudit.js\":\"d1d34714caf51d44\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/healthCommand.js\":\"6475c3a8494c19ec\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/index.js\":\"9b2f5cc9f961915d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/presetIdentity.js\":\"4e6cb2a907f76599\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"181a9b2ad9ea95b9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/readMedia.js\":\"c2f85ae94f7913ba\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/schema.js\":\"5e94633f73da9cb3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/serialization.js\":\"8f583133be78f7bc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/targets.js\":\"dac3e5c1135f289b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/tokens.js\":\"7df1c28a9de213df\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/watchEvents.js\":\"e2d08c904676717c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/workspaceGuard.js\":\"ca77452e1798d353\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/agent-runtime/writeCommands.js\":\"c954162ce859fc70\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/AliasCollisionToast.js\":\"35414779cbce757c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/DuplicateNameBanner.js\":\"00a35857a6f26e7b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/collisionMerge.js\":\"ccfaf9f6cf6f15df\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/dataExtension.js\":\"ebc391622c1e9099\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/index.js\":\"0a37c8d845b05286\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/mergeCollisionAction.js\":\"ab5dba24f0dfd90a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/pageStyling.js\":\"0653beb73b862af9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/rejectionToast.js\":\"7e064a89148736ed\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/alias/syncProcessor.js\":\"079b0fdfb5dd97f6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/actions.js\":\"e8f08725d9f81b51\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/addComment.js\":\"4fc56ea7315d5c43\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/anchor.js\":\"04883ea0a4a6e807\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/anchorState.js\":\"d88499edac02f351\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/commentLinks.js\":\"8ecf48a545cb20b2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/confirmThreadDeletion.js\":\"529aa4fa1dd3c942\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/container.js\":\"ec4fbc8f4b50398e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/dataExtension.js\":\"6b69e3b57d67ada5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/deleteComment.js\":\"c656729184f934e9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/highlights.js\":\"7826b17c73761df8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/index.js\":\"5e314a34f8bf7c89\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/linkedCommentsPill.js\":\"9e2ad35813da83e5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/margin.js\":\"faae95d7af4fd2c0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/marginAnchorLinks.js\":\"6c4d76d84cb71f2d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/marginSchema.js\":\"4d2b9d78f1881773\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/newComment.js\":\"b04395d336aa4acc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/ownThreadPicker.js\":\"8b390439955105c7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/placement.js\":\"ccf6542711be7ed1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/queries.js\":\"24eb898bdc6bfc0a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/quotePosition.js\":\"4e2200150f7696e4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/quotedIn.js\":\"df76d27926620515\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/quotedRange.js\":\"34151bc655176e53\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/rangeRefs.js\":\"c7d3a12ab9240dd3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/readHighlights.js\":\"d6c99650866f292f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/readSelection.js\":\"b28280e6c0201671\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/readSelectionUi.js\":\"0cc21de58355b2e1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/reanchor.js\":\"e876b8ecc897069d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/schema.js\":\"2c3cd155ad5abb01\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/scope.js\":\"1037d8f114ce42af\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/scopeThreads.js\":\"c6f1c02bc419ed3e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/splitRetarget.js\":\"844d9c9dcbbe6b42\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/suggestionCard.js\":\"0c0c5932c95d125a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/suggestions.js\":\"055dcb24246cfedf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/summaries.js\":\"48688c4a1921cd1f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/summaryBatch.js\":\"caf3540f4082bb25\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/surface.js\":\"0e0033228491d737\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/threadNavigation.js\":\"08d1abf6f0935f38\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/threads.js\":\"27bbdc581fa10bd7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/ui.js\":\"0d430f8bf6d6d14b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/annotations/uiStore.js\":\"a000f6ed08bcb7b9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/app-intents/appIntents.js\":\"4b7b9156f98cd00d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/app-intents/index.js\":\"7382c2ff2119e319\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/app-update-prompt/index.js\":\"65200c548e01b064\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/app-update-prompt/status.js\":\"50f9d403b0e533fa\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"50a166dcac68a35f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/MediaBlockRenderer.js\":\"05a551d433edf72c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/MediaDownLaneReplicator.js\":\"052c6d8dccfa0c15\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/MediaUploadReconciler.js\":\"6365b3a2179ea3a4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/assetDownLane.js\":\"efe9880ab3471db4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/assetResolver.js\":\"513f6ff136958606\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/assetUpload.js\":\"6ee7b7df370c06f9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/attachmentCleanerIO.js\":\"b6c1e6dec41662b3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/supabaseAuditIO.js\":\"c4c958227765325b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/blobStore.js\":\"114d3e065526bedc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/browserMedia.js\":\"3de7552e75c566b1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/byteStore.js\":\"6b24c80714247cc9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/cleanerIO.js\":\"a44d92a45c1f31b5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/cleanupAttachments.js\":\"2214536a83fb291e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/dataExtension.js\":\"4e39c37c63bdb47b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/downLane.js\":\"30d14005951a082a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/index.js\":\"78eedb86f805a46f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/insertImageContribution.js\":\"6a2ebe39e4833d70\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/laneArming.js\":\"e9d7aeabdb94374f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/laneLock.js\":\"ad0360e81db58a26\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaBlock.js\":\"f5c53303cc6039ad\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaCapture.js\":\"85882efe2b551670\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaLanes.js\":\"5776e85942a2e247\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaViewers.js\":\"a329756f22f77a94\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/mediaViewersFacet.js\":\"f4695190fb50de17\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/pasteCapture.js\":\"fb89f1755139ae71\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/resolver.js\":\"0289dae17484f158\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/retryUploadsAction.js\":\"5bbfac334e145dbf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/storagePaths.js\":\"ad83fffcecd8f20c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadDrain.js\":\"31913985eb1c5c3a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadLaneStatus.js\":\"e10d614fa6290ff7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadReconcile.js\":\"b110ae66cc63a528\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadRecovery.js\":\"ed96f67dc91f196c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/uploadStore.js\":\"1b72c2e4c61b6ef0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/attachments/useAssetObjectUrl.js\":\"3d84e307988caef1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"97464d6fc8c92300\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/BacklinksViewSection.js\":\"15a03cffaaad0075\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/facet.js\":\"b94dbf3a88292305\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/index.js\":\"6280b83422818f5d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks-view/prop.js\":\"23ba6ed11f552eee\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/BacklinkFilters.js\":\"a59ae8a8377c7294\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"8e877e275d9b27b7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/BlockEntry.js\":\"886e62c46a11930d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/LinkedReferences.js\":\"b8d7461da2274a46\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"a8c4ec8d01983e7e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/dailyNoteDefaults.js\":\"6128f71e072744f0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/dataExtension.js\":\"15818608a78912c2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/edgeExclusions.js\":\"85e3c57a80b55feb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/filterProperty.js\":\"b5a0e0e425507ace\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/index.js\":\"f3927a84c9975890\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"1e9791f69e8c1620\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/applies.js\":\"cc9d25a968c8851c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/countQuery.js\":\"7aeeb7785233dbd9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/expansionStore.js\":\"214fa736e88c4a2b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/index.js\":\"da8999f0f55b40a8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"843b5a55e10fb119\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/presentationInvalidation.js\":\"081d1f6afa29be12\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/propertyEditorOverride.js\":\"b79ec2fb85dc9252\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/propertyFilter.js\":\"bdc1c700c1509faf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/query.js\":\"8fa219d867446f76\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/resolveFilter.js\":\"78214a28a6470c0e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/sourceBatch.js\":\"bc33c870fdd204cc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/sources.js\":\"34a0805b2ed886a9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/useBacklinks.js\":\"e76733620e883607\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"2f159c2e119e6ff4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/BirthdayCelebration.js\":\"2ca3ddaa0b3bdb8d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/BirthdayOverlay.js\":\"746d773abedb8944\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/gate.js\":\"388b0aa664341d08\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/index.js\":\"86303b58225be4e4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/birthday/wolfTheme.js\":\"43fa70ba721cf9fd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/BlockDragLayer.js\":\"3813856cd3e29316\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/dragController.js\":\"76c45ad2097faa4e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/dropTarget.js\":\"d66a9b3f0ef266a7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/index.js\":\"7858e8bd769701fb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-drag/projection.js\":\"9bd73391ae731637\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-info/BlockMetaCard.js\":\"06b0b17f728c792d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-info/index.js\":\"19004ea04fdb00cd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/AddTagDialog.js\":\"5922548b710ea549\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"0e03c36414952c69\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/TagNameIssueHint.js\":\"0d87fcfda7b5bc0f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/addTagAction.js\":\"047050aa0b8076ad\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/appendTag.js\":\"92faf425c960b9e4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/config.js\":\"e26d07363bb35ffe\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/dataExtension.js\":\"87ab5acb80cab6c6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/index.js\":\"883ad4d430aad795\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/block-tagging/propertyEditorOverride.js\":\"13c867e60e1b8fdb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/BreadcrumbList.js\":\"0d20a3ee7d05c518\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"9c217b9c635c4143\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/Breadcrumbs.js\":\"65e2f14123a33b83\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"e2c63315ab4d790e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"0052ea4a479111ab\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/index.js\":\"ccb4227c77e9cc6b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"7d809c89586eb1eb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/CharacterCountItem.js\":\"032cd6b77d0c2eb9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3f8e4434d9d26500\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/actions.js\":\"942a2fe77b0bd3a7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/blockType.js\":\"d010fa5a63a47052\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/charCount.js\":\"463e8fa7ac8216b1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/dataExtension.js\":\"d64ede94d8726ca4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/index.js\":\"a3dab311d48ddf52\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/profiles.js\":\"1bd18db617760bab\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/properties.js\":\"43a6a2319f22b263\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/subtree.js\":\"fa0987739ad66c7d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/character-counter/textCounts.js\":\"401b94a9720023ef\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/colemak-keybindings/index.js\":\"2945c6a547b9f442\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/CommandPalette.js\":\"cd006f0304155162\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/HeaderItem.js\":\"ebd9b5c008e14bae\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/context.js\":\"9dfd57e65359a276\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/index.js\":\"be4d4894f46992c2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/selection.js\":\"b83c35768a55aa43\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/toggleStore.js\":\"077988efc3466d3d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/command-palette/useCommandPaletteActions.js\":\"c51feb104bc7e710\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/ContributorBadges.js\":\"b6fa175756a35b24\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/ProfilePicture.js\":\"f4de7fb3d12a89bd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/author.js\":\"6e579e7c346267b6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/codeMirrorExtensions.js\":\"3c117fc7626f56c1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/dataExtension.js\":\"5ed7ea0c6771932d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/index.js\":\"74893d1d252b4165\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/mentionAutocomplete.js\":\"6f2a2a2696c3a51a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/processor.js\":\"55437a53aeadbda9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/profiles.js\":\"97d71f8008c2756b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/queries.js\":\"13f1aed1e8b4ee12\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/schema.js\":\"39d1aa73f3d886ab\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/contributors/useCommentAuthor.js\":\"529259735e812a1b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"27816ae163e72410\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/followOrigin.js\":\"83ee3a90d24f2a7a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/index.js\":\"20c69cffe18f5588\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"e1cf1d0a8a8c8ced\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"b0377c6d9839fbb4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/CalendarGrid.js\":\"b2587a92c970764d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DailyNotePicker.js\":\"7610acc425fb1536\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"6703aab6e71e1850\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DateNavDecorator.js\":\"c50d2b15dde4ded1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DateScrubOverlay.js\":\"4605de30b7282088\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DayPropertyControl.js\":\"c2d87db4fc7b5895\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/DayValueReferenceControl.js\":\"83dae3c4b3334e77\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/HeaderItem.js\":\"00f2bdc7b10c5725\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/ReschedulePicker.js\":\"3a95a4f9f910aac2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/SpreadDatesDialog.js\":\"ba5dfee27c2fe284\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/actions.js\":\"0f7ba2a698848352\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/blockDateAdapter.js\":\"4d5c977766c00c53\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/calendar.js\":\"8d2130b4a2d73ab7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dailyNotes.js\":\"cafeb337feaed41e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dataExtension.js\":\"6ef41509a7dde572\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dateScrubActions.js\":\"07e665b78662081e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dateScrubGesture.js\":\"15ce6b27cadee05c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dateScrubGestureActions.js\":\"a274c9b56a478418\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dateScrubRecognizer.js\":\"0e13de5fbaa56dc2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dayProperty.js\":\"92f7be5c7ba1ffa6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"080c87c6f5734a8f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/deletionGuard.js\":\"3964c18f9b423bbf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/dueQuery.js\":\"c02901e3a1af76a4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/index.js\":\"6dd899b9f4eac2c6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/landing.js\":\"2bb3105c47facd26\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/localSchema.js\":\"c6a2212fc86b6260\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/referenceDateAdapter.js\":\"c2af43fa88cc3a52\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/rescheduleAction.js\":\"e15cfcb717db1bc6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/schema.js\":\"75c0880e26849ece\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/spreadBlockDates.js\":\"b54d1eac1d1880a7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/spreadDatesAction.js\":\"b3d950191ca8e646\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/today.js\":\"8ba69c57fb3de592\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3ea27cc6ec792c4e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"f0542ec7ba19ed6b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/audit.js\":\"c3fbbb09f18235cc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/auditAction.js\":\"2fee3eb4393df35b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/auditRanges.js\":\"3b00b45686fc91e3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/diagnosticsSource.js\":\"144d311e4be075fc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/divergenceScan.js\":\"8d3932bdbf3f6665\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/index.js\":\"e06de952d29bc55f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/propertyChildrenChecks.js\":\"d2e6a6a586cb5472\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/referencesMirror.js\":\"79b3a62d88b130b6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/rowJson.js\":\"170c8c1dc781e719\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/schedule.js\":\"d49b2d1ec58c8520\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/data-integrity/store.js\":\"476ea7fb69fe9e7f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-maintenance/action.js\":\"b503b4b9f1d8e878\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-maintenance/index.js\":\"7eed9907bc9aec63\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-maintenance/plugin.js\":\"2c996f8e1859484d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f6b18fbd805c058e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/actions.js\":\"326a21ca173792cd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/changeMarker.js\":\"ffa0a9c29f7d09d7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/diagnostics.js\":\"942f26bc7cb434f9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/fileSystemAccess.js\":\"7875c36739aceffa\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/filenames.js\":\"5e5c8f039c29b024\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/index.js\":\"33dc4614e87bc3f2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/mirror.js\":\"f5a5764cf1b93ec1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/runLock.js\":\"71b0a366876c36b0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/runtimeHealth.js\":\"da344efd3c14a958\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/schedule.js\":\"25e65907f29a5eb2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/db-mirror/store.js\":\"e66a2d8cf66006bc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/default-themes/index.js\":\"95ff24fc7f949e13\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/default-themes/themes.js\":\"8e597f2c1b13956f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/diagnostics/facet.js\":\"a7060496d7b3bcb6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/diagnostics/useDiagnostics.js\":\"44151ec8a6c05a3b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extension-prompts/dismissals.js\":\"531b2b10acf2bfa2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extension-prompts/index.js\":\"d8e480ce016825cd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extension-prompts/status.js\":\"402572ce130ec3fc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extension-prompts/store.js\":\"18c38aeeee469632\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"af2da0a020421470\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/ExtensionsSettings.js\":\"1c45f733724b1dc6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/actions.js\":\"d187af7b8a3b869b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/config.js\":\"27a5b1ada68badc1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/dataExtension.js\":\"9bc39088446d68b7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/effect.js\":\"5390e24a6ca36b48\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/index.js\":\"2a9a997d42b68612\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/propertyEditorOverride.js\":\"214f6c37acc81de1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extensions-settings/useToggleTree.js\":\"a41f9c3c1126e20b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/ExtractTypeDialog.js\":\"f012d78174ac457a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"0008484b3ae48dff\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/PropertyShapePicker.js\":\"c493b99b4340e54c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/action.js\":\"e1b5a8d5a13afb7a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/extract-type/index.js\":\"9bc45f0288a09b01\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/FindReplaceDialog.js\":\"3c1a554260ba6372\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/HeaderItem.js\":\"c5706f04595bc2d3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/dataExtension.js\":\"d9c7ddeaa3df9ede\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/index.js\":\"482941f4c296eec6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/search.js\":\"c6c44bac6ba71c59\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/toggleStore.js\":\"58d08afcb59db69a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/LocationPropertyEditor.js\":\"ea183461bbb1980f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/MapView.js\":\"80c9d3880f18be98\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/blockTypes.js\":\"e69a5ca33dc65856\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/codeMirrorExtensions.js\":\"4d1c6ba8550d9813\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/createOrFindPlace.js\":\"1ffe5118a23bf565\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/currentLocation.js\":\"3bcb0345ba9aff7d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/dataExtension.js\":\"297f9a1ad8378aa8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/geoContentDecorator.js\":\"ada3b199e7aaa446\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/googlePlacesClient.js\":\"a7789274f369bd14\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/index.js\":\"e8ff07e409c7806b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/locationsPage.js\":\"682fb80f90dda5e1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/mapViewport.js\":\"2b18e59fa5a10871\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/pickCurrentLocation.js\":\"a0d9a1843d74d549\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/placeAutocomplete.js\":\"760f9afaa3485dc2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/placeNameCollision.js\":\"d960de8cb2ec5d9d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/properties.js\":\"13a5d6c83edd2618\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/propertyEditorOverrides.js\":\"86966356b147ab75\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/query.js\":\"6177b69087bbf853\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/geo/usePlaceSearch.js\":\"71e73fa239ede6c7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"c0eb18aeb66e2885\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"c296c5192a453295\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"f99108067245398f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/config.js\":\"7868e7e41c5b0ef0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/dataExtension.js\":\"8225abe6695018f6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/facet.js\":\"7f94f810ce7ba16e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/grouping.js\":\"a86e7262f6ac13fa\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/index.js\":\"1c427af8e4838fbc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"632b810bd78d10d6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/query.js\":\"06ab395f18614135\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/resolveConfig.js\":\"03c979e89bf4296a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"909753c573f660a1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8103e80703c7f35e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/HtmlDocumentContent.js\":\"8891ed5001ebf631\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/HtmlFrame.js\":\"51a80257c0aae593\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/actions.js\":\"c22ceb81f1fcf572\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/blockType.js\":\"bba98960e8db51b0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/confirmRunScripts.js\":\"8cf51ad1604817d5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/dataExtension.js\":\"81bff4db811b158e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/frameAnnotations.js\":\"56cb2e0fe57871fc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/frameDocument.js\":\"cd04b48745aa849b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/frameTheme.js\":\"3e73bf921f672360\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/index.js\":\"7ea488ecb2cfea95\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/scriptConsent.js\":\"7ef3061a93d278cd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/sourceMap.js\":\"03a6077ec2a96a8d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/html-document/useDocumentScripts.js\":\"d0136f6f5d3e4d50\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/index.js\":\"c246ddb87b9274a6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/record.js\":\"a71ccc1a4480b4a4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/recordStore.js\":\"bfd4b661ec69565e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/responsiveness.js\":\"3e9c8bab764b2b75\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/schedule.js\":\"a1b340c43eb9b66d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/interaction-metrics/sessionContext.js\":\"4b06d18ce71bb9aa\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"8ceda19bee50d523\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"836d605ebb351d63\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/actions.js\":\"991111006d4ae26f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/config.js\":\"97b2c994554af0f0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/dataExtension.js\":\"27e81fcfe3c7c433\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/effect.js\":\"5ab47fd0c73b406c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/index.js\":\"e0bea100d25df5f3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/keyCapture.js\":\"7a8cc2b41e4b08e8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/overrideStore.js\":\"6d29cf883ddc4f2f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"ab252b6e3accfa32\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/HeaderItem.js\":\"af823d92f653d31f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/LeftSidebar.js\":\"3d6f0edc112f5ba8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/actions.js\":\"d10f28f1357a5faa\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/facet.js\":\"ff7eaf5936d5d71d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/index.js\":\"8635f710d245c009\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/shortcuts.js\":\"5e3b367fbb3acfed\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/left-sidebar/toggleStore.js\":\"66f5414396eede67\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/merge-blocks/MergePicker.js\":\"9d89e2b6af025a55\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/merge-blocks/index.js\":\"85087db7df97b80b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/merge-blocks/mergeAction.js\":\"effebb207132e9b0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/merge-blocks/strategy.js\":\"7c362adae33a99bb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/Button.js\":\"be349b3c207d6f25\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"134b57130115e4af\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4df9fd4ce548d956\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/facet.js\":\"6fe5106c2eda0a69\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-bottom-nav/index.js\":\"86a072f00f5c79a1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"ebfb1ad4f18ecade\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4c270294b4856c42\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"55d429b9a3904a78\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9bbf14fe784550e2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/mobile-keyboard-toolbar/index.js\":\"46c7a9ab93d68801\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/MoveDestinationPicker.js\":\"5db562ec7f2af0bd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/blockSubtreeMembership.js\":\"6fc327a2ce44195d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/contextMenuItem.js\":\"e4549b86d7c40d67\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/index.js\":\"ebf687e7ecf02ba2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/moveAction.js\":\"a80113a30ce09b72\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/moveBlocks.js\":\"1c74c20b0b243eda\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/move-blocks/selectionAfterMove.js\":\"193c9f9e39e1c632\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/TutorialBanner.js\":\"88d2435c9199e3b8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/action.js\":\"8146a15e8ff1b8d1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/bannerDismissal.js\":\"a54419561741ff7d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/documents/cheatSheet.js\":\"347ebf575834126c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/index.js\":\"12106dbed0a540ec\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/keys.js\":\"83b30714f2a6b672\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/landing.js\":\"c5c1ca5b8af340d6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/outline.js\":\"b3b60270b0b3480b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/onboarding/seed.js\":\"e1e9d80d2a7827a2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/PerfTrendDialog.js\":\"da3ea3d7b3a3d84e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/analyze.js\":\"e8bd8b13fabf2f53\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/diagnosticsSource.js\":\"e36cb47771a76982\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/index.js\":\"b9839f2e78a1f0a7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/load.js\":\"1eb7965c4a06040a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/monitorRun.js\":\"d31d84f594604cdc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/schedule.js\":\"6fe0507bd63a6162\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/series.js\":\"8a4ea1f22727cea8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/store.js\":\"7ebd07e67eb589b9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/trendAction.js\":\"7205101295a1fb17\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/perf-monitor/verdict.js\":\"66e7600d9a8f76ef\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/plain-outliner/clickToEditAction.js\":\"42872cf841f4243e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/plain-outliner/index.js\":\"487105000cfdf5c0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/plain-outliner/interactions.js\":\"3c6cf7b089181616\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"3a637764cf36abc8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/MigrationGate.js\":\"7fee065b33ac5c72\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/MigrationGateDialog.js\":\"53d1255e2e5735d3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/action.js\":\"a67536314f629018\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/index.js\":\"a90587e8f0f76da3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/localRunMessage.js\":\"9f1528139dd0657f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/plugin.js\":\"5310b09a1fa154d5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/progressReport.js\":\"5950aa19814c0170\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/properties-migration/sweepProgress.js\":\"83ea272ed2f5a16f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/FieldRowRenderer.js\":\"74957139b2adcb5c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/ValueRowRenderer.js\":\"e39084f5efac21bc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/actions.js\":\"5168712b1b6681fb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/autocomplete.js\":\"0802c7fb49776e0f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/fieldRow.js\":\"d988f05beaadda2f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/index.js\":\"65d4a5f92dc4d7b6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/referenceWarning.js\":\"8832ade5f663fe0a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/valueAutocomplete.js\":\"3bbd44456d549367\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/property-rows/valueSchema.js\":\"b8b11e9746e95a02\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/HeaderItem.js\":\"01718c7260f306c3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/QuickFind.js\":\"58ac12fe91f45874\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/index.js\":\"7cb1decfa9dc7b48\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/recents.js\":\"79795d669e0d0564\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/resultItems.js\":\"0ba98306969f7cda\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/selection.js\":\"b4a3df1190ab5ebc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/quick-find/toggleStore.js\":\"41716d5529130c8d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/HeaderItem.js\":\"e482e5e4f534f388\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/RecentsPageBlockRenderer.js\":\"56afb1ff401a5ad6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/grouping.js\":\"40389453d66d7696\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/index.js\":\"b353cfcd596a8eb3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/recents/target.js\":\"499988d60a154218\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/codeMirrorExtensions.js\":\"2089383ec43c6cd7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/contentPrefill.js\":\"ec863b47ce48a41b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/dataExtension.js\":\"4cdf245ecaaeffe3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/index.js\":\"88571540f7feb4b5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"194178ae56b9f7c6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/invalidation.js\":\"63c006af41e83687\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/localSchema.js\":\"020421f4a3f08428\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/blockrefs/index.js\":\"f7a29cf138048519\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"26986b650baf38cd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/index.js\":\"5d5ec72439595778\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/referenceNode.js\":\"223e41ed397bb6f3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/remark-reference-occurrences.js\":\"aa3210e67b9e84f5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"d117c31faa6ee681\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/wikilinks/index.js\":\"4c493a6367edacc6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"b6b2d472e23c55ad\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"96143a1852dd7e4a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/mergeRetargetProcessor.js\":\"774da6bd27aed12d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/parseFence.js\":\"20607989c6fc33af\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/referenceParser.js\":\"5c8496c98e4bb4f7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/referenceProjection.js\":\"863e903da7bde38c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/referencesProcessor.js\":\"dbd83a7598a277ba\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/renameProcessor.js\":\"41058b64c1b339ad\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/references/spanReplacement.js\":\"5d3b7d493907a596\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/rich-paste/htmlToOutline.js\":\"b7bbdd7ce641eed2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/rich-paste/index.js\":\"4d0336824a4b6b9c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/rich-paste/normalizeClipboardDom.js\":\"7431c9a4f418e170\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/rich-paste/pasteDecision.js\":\"c8d30413b0461adc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/action.js\":\"39792f8fd9b8edbe\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/blockIds.js\":\"73265ce5979393a5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/content.js\":\"cac386cc3b7c5ba7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/effect.js\":\"ab74a9aab32175c7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/ids.js\":\"75ee87ab0ea6169d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/import.js\":\"d5bdbc8befe190e4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/index.js\":\"51260ff996c1f226\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/plan.js\":\"85f52ec01ea5a28e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/plugin.js\":\"084c384803472bb2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/promotion.js\":\"bdd280dc382062e2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/properties.js\":\"db367c77415bb7b1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/references.js\":\"79d78208af9c5deb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/report.js\":\"b4697e4edd1b89e6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/roamMemo.js\":\"01c3645bedb6ff00\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/runtime.js\":\"d5204f8d77d72331\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/schemaReconciliation.js\":\"cd605e8932621bcf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/srsMarkers.js\":\"34fc961c473c562e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/todo.js\":\"58bac376bc9085e3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/typeCandidates.js\":\"e3a1e045a6ae46f7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/roam-import/types.js\":\"76e0df6d84085627\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/search-health/index.js\":\"f233f1f36fe6399b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/search-health/store.js\":\"ef73e8e34ed9614b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/HeaderItem.js\":\"ab29ea91af52a30c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"c7e563159cb222df\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/index.js\":\"dcf0c76bf2b6bd6d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/model.js\":\"5d622e0be12207ca\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/toggleStore.js\":\"45e52beb38683047\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/shortcut-help/useKeyInspector.js\":\"8b350a04bd3eba22\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"59c596854aa64857\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/ShellDecorator.js\":\"97df6698bb43d140\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/actions.js\":\"70aa113bb9dd4a94\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/exclusionsFacet.js\":\"e878375646a712a3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/index.js\":\"6119dd5ca8a7d763\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/shell.js\":\"3f3f2e2f86d4f4b2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/surface.js\":\"d2a768adbbb1d4bb\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/spatial-navigation/walker.js\":\"f7962be30ed69ad1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/RescheduleToast.js\":\"67e427177cb0c0ca\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/dataExtension.js\":\"eb927b3ec2f24c13\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/index.js\":\"d3a04ad49918bc20\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/indicator.js\":\"3e3e6498181e0146\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/moveSrsState.js\":\"d7a3cf6f91bd1f42\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e13e49afb3f91049\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/scheduler.js\":\"f431774c3a42bdb5\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/schema.js\":\"031b05f52fe50e0a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"0e80dc711047fbf2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/srsClipboard.js\":\"f3fa584e4d31dbcf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"93859b28206144f4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/DailyNoteReviewHint.js\":\"7ee0cf7d3376143d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/DeckPicker.js\":\"78cbaaa36ffcf46a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/ReviewControls.js\":\"6ddcde052c6f09b8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/ReviewDeckRenderer.js\":\"856492e9044e5766\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/ReviewSession.js\":\"779b8e0094699f28\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/actions.js\":\"f908ea67e86cd26c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/archive.js\":\"38380f1d41f0e5f7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/dataExtension.js\":\"e922a7ca162fbcae\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/deck.js\":\"362d9298ddd4dfa1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/dueQuery.js\":\"f34c483a2c8308ad\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/gradeDecision.js\":\"9a160018e85657e4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/index.js\":\"b4ff219cf4d74d7e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/keyHints.js\":\"cac3a89118dd0170\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/reviewCardLayout.js\":\"1139e122e1b59339\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/reviewProgress.js\":\"ecd4129f2008044f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/schema.js\":\"72a11767e0811c7c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/srs-review/useDueCards.js\":\"fc0dab7cca841d5f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/startup-metrics/index.js\":\"ea1fb55cbebaacfd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/startup-metrics/record.js\":\"6db3bb9fe5fde0dc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/storage-persistence/index.js\":\"9da8c4759fd9ad43\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/storage-persistence/persistenceStatus.js\":\"379dd31f294c7e3a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/storage-persistence/requestAction.js\":\"53bacfdbf364b722\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/supertags/TypeChipsDecorator.js\":\"c7621d8028edf00d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/supertags/codeMirrorExtensions.js\":\"e740a5f1de68ae1a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/supertags/index.js\":\"3149734390efe1f0\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/supertags/typeAutocomplete.js\":\"9c5026968943c188\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"e43ae6cffe4b50e4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/actions.js\":\"e10ea7342a1f5fd7\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/anchor.js\":\"b85a0076b50197ba\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/events.js\":\"7f341ffd31660753\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/gestureActions.js\":\"8bb3ab2ce66d2c3f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/index.js\":\"35d08555b9b622d3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"e890c77b431c6b95\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/sync-metrics/collect.js\":\"015120c0a7985afa\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/sync-metrics/index.js\":\"46ea60a951e1da98\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/sync-metrics/record.js\":\"51f1eba3392452a6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/RejectionDialog.js\":\"bbfb9be7298f5a9b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/SystemStatusHeaderItem.js\":\"9fdde68117f4b6e8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/index.js\":\"c939e5cb9e187c8f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/model.js\":\"3fe41e7d6cdc2951\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/queueCounts.js\":\"3efe2d3f0c504eea\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/rejectedHelpers.js\":\"d2ed33f052d3fc89\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/rematerializeAction.js\":\"4accf317de157a4d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/system-status/useHysteresis.js\":\"6aa7fd94bdcb4a4d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/ColumnHeaders.js\":\"f86b90d7773521e4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/QueryUi.js\":\"2c0af6191e68112f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/TableLayout.js\":\"94387ea1a0159cd4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/actions.js\":\"4d6dabacc253c5e9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/cellEdits.js\":\"f38cdf20c79ef0ce\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/childrenViews.js\":\"a101fc7bff27aac2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/columns.js\":\"00ade36ce396bc6f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/controller.js\":\"c83ec98ed38f096b\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/convert.js\":\"75c9943ea2c4b7f6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/dataExtension.js\":\"240cc054b9071308\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/index.js\":\"7e1e456770bbcead\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/keys.js\":\"c58b5f634ac92f5e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/model.js\":\"13afb1d879678f4c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/QueryText.js\":\"e20b9450441f2e67\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/backfill.js\":\"4ff059285893f4c9\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/completion.js\":\"e08e63baf73e7456\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/format.js\":\"0de680189aaf0860\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/parse.js\":\"1793f807cdf70b5f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/queryValue.js\":\"232448a48dbe2825\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/registrations.js\":\"e133afa0edb622c2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/query/source.js\":\"7e5cb5ab768fde96\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/registry.js\":\"b24f52772197b53e\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/rowGutter.js\":\"21ee8599ba4d0f76\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/rowVerbs.js\":\"5d8445e42524f356\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/schema.js\":\"a14229f22aea7ded\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/tables/sort.js\":\"4322a11ee41d0d57\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/theme-toggle/effect.js\":\"74eccf18ccb1f4fe\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/theme-toggle/index.js\":\"0a2f0abc2316c5df\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/theme-toggle/theme.js\":\"9d89a9e945bb1899\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/todo/actions.js\":\"e3a525a4f2e75c9a\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/todo/dataExtension.js\":\"a4444b9e5749ad2c\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/todo/index.js\":\"4c8d3fb4c32166e8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/todo/schema.js\":\"440bf4d6c7a4a8d1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/TouchSelectionLayer.js\":\"98b11f13f83937a6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/actions.js\":\"158115f1451ecd20\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/defaultItems.js\":\"9ce7940f70ef18f8\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/facet.js\":\"f9e097a7b3ca8b82\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/holdRecognizer.js\":\"8fcb73ab407dd0a6\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/touch-selection/index.js\":\"5459fddd0be1860d\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/update-indicator/UpdateIndicator.js\":\"77509609f5c26723\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/update-indicator/index.js\":\"f20e5f7522080342\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/update-indicator/loadTimes.js\":\"c23b9946bfb24aff\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/VideoNotesRenderer.js\":\"c29a32b217cbb2ce\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/VideoPlayerRenderer.js\":\"f9721fd94a2ea509\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/VideoTimeStamp.js\":\"c7367450786f08bd\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/actions.js\":\"843fac827c4dbec1\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/index.js\":\"a72c1a4c80e8b6e2\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/markdown.js\":\"1a13812ed4d5ebcc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/notes.js\":\"01475d29076378e3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/registry.js\":\"7d39ee09690d5aac\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/remark-timestamps.js\":\"b652a875d0195b97\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/video-player/view.js\":\"03cb157c0f851ccf\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-link-hints/LinkHints.js\":\"77c2341384abc1bc\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-link-hints/index.js\":\"ae254729f84ec307\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-link-hints/model.js\":\"29ccc384de76a0a4\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-link-hints/settings.js\":\"b756b2f569fc8913\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-normal-mode/actions.js\":\"5fb3586ba727e50f\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-normal-mode/index.js\":\"241d605d8a217f79\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/vim-normal-mode/interactions.js\":\"d9fd9bdbd6aceef3\",\"/knowledge-medium/pr-preview/pr-1921/src/plugins/workspace-header/index.js\":\"c5b4c102664cb14b\",\"/knowledge-medium/pr-preview/pr-1921/src/registerServiceWorker.js\":\"60d7a849e103de76\",\"/knowledge-medium/pr-preview/pr-1921/src/requestPersistentStorage.js\":\"1d8e960960392767\",\"/knowledge-medium/pr-preview/pr-1921/src/services/authRequestDeadline.js\":\"60bfc2588be95442\",\"/knowledge-medium/pr-preview/pr-1921/src/services/authStorage.js\":\"5423c42b4400f4a1\",\"/knowledge-medium/pr-preview/pr-1921/src/services/powersync.js\":\"68603d929a4130fd\",\"/knowledge-medium/pr-preview/pr-1921/src/services/supabase.js\":\"596a7b34c2080431\",\"/knowledge-medium/pr-preview/pr-1921/src/services/uploadErrorClassifier.js\":\"75a4cfd26eaa84d7\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/ActiveContexts.js\":\"27f0b1db296de627\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/HotkeyReconciler.js\":\"eda27b970bb41dc3\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/WipeLocalDataDialog.js\":\"fe9056b5ed71e8cc\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/actionDispatch.js\":\"99a3e3b10abf9428\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/actionKeyHints.js\":\"5f3b1de5997d5646\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/actionRefItems.js\":\"fc88d0f3f4018d94\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/applyKeybindingOverrides.js\":\"429c4e52b3053a1f\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/blockActions.js\":\"7390edf3681e2134\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/blockMergeGesture.js\":\"2d5e597bcf14394b\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/canonicalizeChord.js\":\"a7354c6c1c5bad3c\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/defaultContexts.js\":\"0e4c19d41d708151\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/defaultShortcuts.js\":\"db552117a16f911a\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/effectiveActions.js\":\"355bc1927a29911f\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/formatChord.js\":\"29e071f5bd8fbe92\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/gestureAction.js\":\"c31da9f017ac6b2d\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/gestureBinding.js\":\"61cc1e55be6e6c9a\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/holdRegistry.js\":\"6d2b77884d787e58\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/keybindingConflicts.js\":\"632f50f7101f905f\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/keybindingOverrides.js\":\"1fcf68445915005d\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/pointerAction.js\":\"d6ea71bf5c523bd8\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/resolve.js\":\"27cf965eeb00cbe1\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/runAction.js\":\"3f116eb9c7d2be85\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/sequenceMatcher.js\":\"96666ede9591aff9\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/types.js\":\"7d386b10ef0d5884\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/useActionContext.js\":\"56d5724d06a7a9ad\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/useActionDiscovery.js\":\"7b637b0ce0c7b698\",\"/knowledge-medium/pr-preview/pr-1921/src/shortcuts/utils.js\":\"99d837b592f4d42a\",\"/knowledge-medium/pr-preview/pr-1921/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1921/src/sw/bootStore.js\":\"0af8408ff4c117bc\",\"/knowledge-medium/pr-preview/pr-1921/src/sw/previewDatabases.js\":\"19d50b1d6136b63a\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/byteTransform.js\":\"a3b3ae9d3d6da947\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/attachmentCleaner.js\":\"12b2e10b5ba1c260\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/attachmentParts.js\":\"ee4918c3a1bbe31b\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/bundleParts.js\":\"1687c1bb06438749\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/bundleRecord.js\":\"c6f679b3f6885322\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/manifest.js\":\"56412120ca0a5ac6\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/takeBundle.js\":\"257c01d998c1bb1e\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/bundle/verifyBundle.js\":\"67749baf1c6081f8\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/cleaningStage.js\":\"fa747938bdcf9c1b\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/conversionKey.js\":\"f753bce09272c71c\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/conversionServer.js\":\"6040cb4ff00234f3\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/flip.js\":\"a1f1394c7fa4e771\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/flipAttempts.js\":\"d129cbaaeadbadaa\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/pages.js\":\"6eee2f3bdc2105a2\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/preflight.js\":\"36b02da1aaf399ef\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/reseal.js\":\"9f6f38cc2d89b328\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/runConversion.js\":\"878b91e8a0ede9ce\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/runLock.js\":\"eb9d01b192f54df2\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/sealing.js\":\"fab67a4d887a9918\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/sealingStage.js\":\"cd423582100d67ff\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/stage.js\":\"97ca8b1fa01cf75f\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/conversion/verifyReseal.js\":\"aac78785b0f72070\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/aad.js\":\"4da27923f4540c26\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/aead.js\":\"bbc4bea1ddd7239f\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/base32.js\":\"294bb8d1bf59f631\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/base64url.js\":\"c2de5be6cf55aa80\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/binaryEnvelope.js\":\"82a89b5151ed2ae1\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/byteAead.js\":\"9c47dee4be1287c1\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/canary.js\":\"95ff3fe3d08d365a\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/contentHash.js\":\"e0318cfedf042475\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/contentKey.js\":\"fe4b0bbcc3249007\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/derivedIdNamespace.js\":\"8a0399f0f2123e77\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/envelope.js\":\"347bde5a7c252523\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/hex.js\":\"6ef8359e80ea4e27\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/sha256Hex.js\":\"d5bc0f91398c4206\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/crypto/workspaceKey.js\":\"8f5ff1eeba8a4dd5\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/conversionState.js\":\"131df710cd966245\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/flows/createEncryptedWorkspace.js\":\"6cdd193c5b55871f\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/flows/pastedKey.js\":\"fc8c16a1082d663d\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"066281d51c75adb6\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/flows/upgradeWorkspacePin.js\":\"8600834d9d0e419a\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/keyStore.js\":\"75602e3df1a635c9\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/mintWorkspaceKey.js\":\"3bfa7d7b4d4656f6\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/modePin.js\":\"1a2788a286ea2681\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/openWorkspaceKeys.js\":\"fce59c7b146c5973\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/resolveWorkspaceEntry.js\":\"3f28533e48b7ba63\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/resolver.js\":\"d2dca7701f73a7fd\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/keys/workspaceAccess.js\":\"a650bdb06063ed2c\",\"/knowledge-medium/pr-preview/pr-1921/src/sync/transform.js\":\"bc09c84c62a82ddb\",\"/knowledge-medium/pr-preview/pr-1921/src/themeBootDefaults.js\":\"c491b0eea2a354f4\",\"/knowledge-medium/pr-preview/pr-1921/src/types.js\":\"06c7cba3b9ac0d01\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/ClientLocalSettings.js\":\"f9f8fd3b47e55b22\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/abortableSleep.js\":\"d01f90669c872ec5\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/array.js\":\"b1e266a3457a2964\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/backlinkAutocomplete.js\":\"82abd11abcbab564\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/blockCrumbs.js\":\"32e725b8197b5466\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/blockrefAutocomplete.js\":\"d68a5c8972ad81da\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/cadencedIdleJob.js\":\"62bbbbe63d55fdb4\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/callbackSet.js\":\"5e6f01f4d416dc51\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/clientId.js\":\"3afece715b03b457\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/codemirror.js\":\"b390087cd9953b8b\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/codemirrorCompletion.js\":\"47e61e938800a152\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/copy.js\":\"4a0a52a53861648d\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dailyPage.js\":\"1e84c0969ef7f7df\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dbForensics.js\":\"9f2e10fb598878d8\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dbForensicsHooks.js\":\"dc25d67904fb4993\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/deleteBlockThroughUi.js\":\"d1c6e4dc92234df2\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dialogs.js\":\"668f03707a1da842\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/dom.js\":\"4cedb19138e7c31b\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/downloadBlob.js\":\"e8ab8f829623ec38\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/drawnWalk.js\":\"7fbbfd49facb9ba1\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/exportSqliteDb.js\":\"b9a68b22eaa61a02\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/fileSystemAccess.js\":\"d3811ca0c685028e\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/flipSlide.js\":\"3cb34e52fc788ae0\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/fnv1a.js\":\"6e1a630a1594e03a\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/formatBytes.js\":\"2bcacdf88f752ec5\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/fuzzyRank.js\":\"39711a7fffc33b01\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/idbKeyedStore.js\":\"17269ca4c2beadaf\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/idleCallbackPolyfill.js\":\"58514370d57d9cfc\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/keyboardAwareScroll.js\":\"d3e4eab6f5f22829\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/keyboardViewport.js\":\"d071fa1879e8d4b6\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/lastWorkspace.js\":\"7d8c27471bf33c52\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/layoutColumns.js\":\"a1512fec1c641754\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/layoutSessionDom.js\":\"a49c94733fe13621\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/layoutSessionId.js\":\"252d3cb1d5cd3b5f\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/linkClickGestures.js\":\"a671e108a154c6a7\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/linkTargetAutocomplete.js\":\"a2d6c5dfa366221f\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/localDbCorruption.js\":\"f78a274dd99fc66a\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/localDbRecovery.js\":\"c235b032cedb3cc2\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/markdownParser.js\":\"6e1e61042a4c1738\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/memoize.js\":\"d699d656b8405c42\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/nameFieldCommit.js\":\"a1ead23c1f803e42\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/nameList.js\":\"f80f9dad17664aa4\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/navigation.js\":\"497341d4192e9cad\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/omnilinerNamespace.js\":\"10075d162c25fddc\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/opfsPageScan.js\":\"ce35c50c5cecbfc1\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelClearance.js\":\"a6709706fac506b2\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelHistory.js\":\"7e714d456cc74408\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelLanes.js\":\"1b76937ac926a307\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelLayoutProjection.js\":\"75f1bbb290334e34\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelScrollAnchor.js\":\"4732a1a1d5dfd8ca\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/panelUrlFlags.js\":\"ab9963575e292559\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/platform.js\":\"5c790328dbd38643\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/pluralize.js\":\"06a744a07118b873\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/propertyCreation.js\":\"732dc8edebca2549\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/propertyNavigation.js\":\"4dc300f04acc8cf7\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/propertyValueContext.js\":\"40e37b6ad5d32cd7\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/react.js\":\"ce37267f246977d1\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/relativeDate.js\":\"339f9312317c96c1\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/relativeTime.js\":\"f66775786680210f\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/renderScope.js\":\"8108e38f9da9e46a\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/resolvedThenable.js\":\"755b08a51de6c92a\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/routing.js\":\"6a7f8eb0a2c319b1\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/safeMode.js\":\"6ed5845c412adb1a\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/scheduleIdle.js\":\"7cc20cd35dd800bd\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/screenWakeLock.js\":\"6eec834680de4f30\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/selection.js\":\"ec95a8456bfd42eb\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/softKeyboardGrab.js\":\"dc45e5ab8d2f7dae\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/startupTimeline.js\":\"edcd7e0eddbec8da\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/state.js\":\"fe5e0ed94906dae6\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/string.js\":\"1a1884db0f89b03e\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/surfaceZoom.js\":\"e1d3fa2aaad79959\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/time.js\":\"a8f8d54f6f782303\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/toast.js\":\"f1394a0a958a640a\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/toggleStore.js\":\"5948bb0f965db6ba\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/untilStopped.js\":\"02e2c16c1d9b3c22\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/userActivity.js\":\"ffd949bc328de1ba\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/viewTransition.js\":\"e72fa4d299dbcb0a\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/viewport.js\":\"379872d081b861a9\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/webLock.js\":\"14ab4dba93f61543\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/workspaceRecovery.js\":\"de84ac9dcf557385\",\"/knowledge-medium/pr-preview/pr-1921/src/utils/workspaceSnapshotStore.js\":\"ed008d2026737ce2\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-compiler-runtime.js\":\"5e4ce1361bc8f024\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-client.js\":\"9b9db13a63e9642b\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-server-edge.js\":\"96a9d0833794c571\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-server.js\":\"adbf975e1ad45905\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-static-edge.js\":\"906d174de461a8e0\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-static.js\":\"28827e0116725efe\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom-test-utils.js\":\"930b2934a92c4576\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-dom.js\":\"1f09908d38a43c4a\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react-jsx-runtime.js\":\"634cf485c49a6986\",\"/knowledge-medium/pr-preview/pr-1921/src/vendor/react.js\":\"acbffa50edf8a4de\",\"/knowledge-medium/pr-preview/pr-1921/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1921/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1921/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
