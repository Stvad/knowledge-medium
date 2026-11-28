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
		buildId: "1538be552a09-cf940e27",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1922/\":\"da97475a1365b7b5\",\"/knowledge-medium/pr-preview/pr-1922/index.html\":\"da97475a1365b7b5\",\"/knowledge-medium/pr-preview/pr-1922/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1922/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1922/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1922/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1922/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1922/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1922/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1922/assets/FacadeVFS-CjBLdSox.js\":\"af3e7722a1fb90a1\",\"/knowledge-medium/pr-preview/pr-1922/assets/OPFSCoopSyncVFS-CuwZ5njf.js\":\"e672d66b81a81963\",\"/knowledge-medium/pr-preview/pr-1922/assets/OPFSWriteAheadVFS-D_CllOCE.js\":\"92b348c872e24019\",\"/knowledge-medium/pr-preview/pr-1922/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1922/assets/wa-sqlite-DxAnm4Ay.js\":\"f4519eb68cc263b4\",\"/knowledge-medium/pr-preview/pr-1922/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1922/assets/wa-sqlite-async-B5U559qy.js\":\"6870f5999716cccf\",\"/knowledge-medium/pr-preview/pr-1922/assets/worker-C6Rq6TOE.js\":\"8e95374283323a22\",\"/knowledge-medium/pr-preview/pr-1922/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1922/chunks/app-C8XOxj7D.js\":\"ed90103d16f5ca10\",\"/knowledge-medium/pr-preview/pr-1922/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1922/index.js\":\"3d9e6ebba2d1a087\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1922/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1922/assets/AccessHandlePoolVFS-CI36JC69.js\":\"04523e7f095c44a6\",\"/knowledge-medium/pr-preview/pr-1922/assets/IDBBatchAtomicVFS-1OEq1Ylr.js\":\"7de118bfa865846d\",\"/knowledge-medium/pr-preview/pr-1922/assets/MemoryVFS-Cb2EnF4J.js\":\"225178edc81cea41\",\"/knowledge-medium/pr-preview/pr-1922/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1922/assets/mc-wa-sqlite-DnKozMJ7.js\":\"fa5a67cc3e60cacf\",\"/knowledge-medium/pr-preview/pr-1922/assets/mc-wa-sqlite-async-D8enZdfZ.js\":\"0e851f674723428f\",\"/knowledge-medium/pr-preview/pr-1922/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1922/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1922/chunks/AccessHandlePoolVFS-DpsR_HNk.js\":\"5cbd8e527d7502a3\",\"/knowledge-medium/pr-preview/pr-1922/chunks/FacadeVFS-a3jBKWMO.js\":\"9766324f52703e26\",\"/knowledge-medium/pr-preview/pr-1922/chunks/IDBBatchAtomicVFS-BKp3hIE2.js\":\"715b50e931ad2b8a\",\"/knowledge-medium/pr-preview/pr-1922/chunks/MemoryVFS-CTB68xE5.js\":\"f8d7daa9bd67bf54\",\"/knowledge-medium/pr-preview/pr-1922/chunks/OPFSCoopSyncVFS-DHRfS1__.js\":\"f69d89384d90de5f\",\"/knowledge-medium/pr-preview/pr-1922/chunks/OPFSWriteAheadVFS-Dn_497CW.js\":\"b7cc04a189cc5937\",\"/knowledge-medium/pr-preview/pr-1922/chunks/Preview-CNxeJPWx.js\":\"c70c20a2ba301e08\",\"/knowledge-medium/pr-preview/pr-1922/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1922/chunks/card-BJFtew1k.js\":\"de18089af779ee10\",\"/knowledge-medium/pr-preview/pr-1922/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1922/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1922/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1922/chunks/dist-C0r3kTWI.js\":\"130f717f579bda2e\",\"/knowledge-medium/pr-preview/pr-1922/chunks/freezeExtensionImports-q3YaCJcV.js\":\"7b2217a390c57d0a\",\"/knowledge-medium/pr-preview/pr-1922/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1922/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1922/chunks/mc-wa-sqlite-D4tKAScG.js\":\"e1dcc53dca9b2107\",\"/knowledge-medium/pr-preview/pr-1922/chunks/mc-wa-sqlite-async-C3Fancm2.js\":\"e34f73633ddc86bf\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-C9ew7JLV.js\":\"8ec6a6f2d35cb980\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-CRerOHmQ.js\":\"44dbef807ed9658e\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-CciIwQ9g.js\":\"a658789f53b214a8\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-DB2FNOwq.js\":\"131457605aa5e553\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-DEsHqVEm.js\":\"4f65efed4cc13d55\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-IhY-Mzee.js\":\"d182df891464749f\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-YKCA9GOz.js\":\"f5ce8f166a8491a2\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-dom-server-legacy.browser.production-D0LcLWsU.js\":\"d3b74fd5067044f5\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-dom-server.browser.production-BwnFOXft.js\":\"ffbd2eb2d1c8df1c\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-dom-server.edge.production-Dyyj2xTN.js\":\"ebaaa9c5cf4352ee\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-wHKJrBRH.js\":\"8b05c6dfd5a28fd7\",\"/knowledge-medium/pr-preview/pr-1922/chunks/server.browser-C9nWJHiq.js\":\"a0e0f20f79999baf\",\"/knowledge-medium/pr-preview/pr-1922/chunks/textarea-CrrnvXlV.js\":\"9f82506345794ebb\",\"/knowledge-medium/pr-preview/pr-1922/chunks/ui-DACeAepZ.js\":\"fbcd46068fbdd223\",\"/knowledge-medium/pr-preview/pr-1922/chunks/wa-sqlite-WsaP4Dt7.js\":\"2a507519abef2206\",\"/knowledge-medium/pr-preview/pr-1922/chunks/wa-sqlite-async-BiS5-rLv.js\":\"e5b323321427b6b9\",\"/knowledge-medium/pr-preview/pr-1922/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1922/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1922/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1922/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1922/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1922/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1922/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1922/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1922/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1922/src/App.js\":\"5f0f0d42ed4d8997\",\"/knowledge-medium/pr-preview/pr-1922/src/appUpdate.js\":\"f0ad4f01263c113b\",\"/knowledge-medium/pr-preview/pr-1922/src/appVersion.js\":\"109a4350f8a68bec\",\"/knowledge-medium/pr-preview/pr-1922/src/bootstrap/initialLayout.js\":\"205be974a5d20325\",\"/knowledge-medium/pr-preview/pr-1922/src/bootstrap/openWorkspaceData.js\":\"7a33255a523f0598\",\"/knowledge-medium/pr-preview/pr-1922/src/bootstrap/resolveWorkspace.js\":\"0be7ded12077d0cc\",\"/knowledge-medium/pr-preview/pr-1922/src/bootstrap/workspaceBootstrap.js\":\"b977030383991974\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockComponent.js\":\"b166723520c1a1bb\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockCrumbs.js\":\"e0be4584a48eb692\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockEditor.js\":\"05a0b729e19c3256\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockLoadingPlaceholder.js\":\"8778821bb78333fa\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockProperties.js\":\"b8b650f6185bb718\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockSearchPicker.js\":\"c709ba1de37b66a0\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ConfirmBulkDeleteDialog.js\":\"a0fd32081431eeb3\",\"/knowledge-medium/pr-preview/pr-1922/src/components/DividerHandle.js\":\"a3bf2e5a21f5b290\",\"/knowledge-medium/pr-preview/pr-1922/src/components/DraftEditor.js\":\"8bf076ea4b8d8a29\",\"/knowledge-medium/pr-preview/pr-1922/src/components/GutterPill.js\":\"2d2c3572dbab543d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/Header.js\":\"f2cc6e96b80491a6\",\"/knowledge-medium/pr-preview/pr-1922/src/components/LazyBlockComponent.js\":\"04e031bbf8e45b3b\",\"/knowledge-medium/pr-preview/pr-1922/src/components/Login.js\":\"bf3851921bb4dd28\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ZoomableSurface.js\":\"7489b836b35b380f\",\"/knowledge-medium/pr-preview/pr-1922/src/components/editModeKeepalive.js\":\"423047874cf1244b\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyDisplay/PropertyDisplayScope.js\":\"695a9c797ef4f9a9\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"6aca958786faff79\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/RefPropertyEditor.js\":\"ea3ac35336b6242c\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/RefTargetTypePicker.js\":\"f1d0d14c23b785dd\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/SelectPropertyEditor.js\":\"a97334fb1bcd687d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/TypesPropertyEditor.js\":\"935b35c93ec08859\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/defaults.js\":\"cf874be3c9077d20\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/kernelValuePresets.js\":\"89158285eb876953\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/selectablePresets.js\":\"5f61d0f4c7d6e57e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/typesPropertyUi.js\":\"3e6b71c01a5199ce\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/AddPropertyForm.js\":\"4b4f599cb9c57dee\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/PropertyPicker.js\":\"c4b0a16497e6b4af\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/PropertyRow.js\":\"4ccb7918344f2fb7\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/Rows.js\":\"b8e24e1bfdad948f\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/actions.js\":\"36df3f8aa1f90d17\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/declarationOnly.js\":\"80818b601b0780e1\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/layout.js\":\"dbc7414d9ec8001a\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/model.js\":\"6840cb4323918ec5\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/shapeUi.js\":\"386a77a0733f4ae0\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/shapes.js\":\"ad381c48dadcda5c\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/usePropertyEditingActivation.js\":\"257a85e3eaaadcc1\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/visibility.js\":\"db44437276a4c8d8\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanelSections.js\":\"d9bb70492505596b\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/BlockEmbed.js\":\"d8d810481f86463c\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/BlockLink.js\":\"54fe9b59c5df98e3\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/BlockRef.js\":\"60420217b6a6bf95\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/CompactReferenceLink.js\":\"c499465eb644128e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/ReferenceLink.js\":\"3df7d013b63f2167\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/cycleGuard.js\":\"698c0470dda0e3cc\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/cycleGuardContext.js\":\"53c12040c459b3cd\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/linkInteraction.js\":\"9ef04175dfdd23f7\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/referenceLayout.js\":\"1c05da49e3ddb655\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/useBlockRefAncestors.js\":\"d6d79cf14228926b\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BlockGutter.js\":\"01510c8323e9a1ac\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BlockInfoDialog.js\":\"fc2ed17a850cf14e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BlockReadText.js\":\"6e1490c006feadc8\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BlockTypeBlockRenderer.js\":\"b796edd08a2b5a02\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BulletHoverCard.js\":\"64ae9b56e8517d1b\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/CodeMirrorContentRenderer.js\":\"5d894d108db40617\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"de0f632f0d2cd89b\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/ColumnResizeHandles.js\":\"d760a760f94d606e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"b32b09336a949799\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/DefaultBlockRenderer.js\":\"49e2a34e747b4a48\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/LayoutRenderer.js\":\"a5b3dca72e66d618\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/MarkdownContentRenderer.js\":\"ae2215a3b7baf5c2\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/MissingDataRenderer.js\":\"6730c58b1c56f05c\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/PanelRenderer.js\":\"8de4a223e6cde47d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/PropertySchemaBlockRenderer.js\":\"ef083bcab0e49073\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/TopLevelRenderer.js\":\"766aed3d2095536d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/blockGutterMode.js\":\"37e2bfc806b8c966\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/blockTitleText.js\":\"0203aad4b85a2086\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/fieldCreationKeydown.js\":\"de7ea463bffc62fe\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/layoutRootContext.js\":\"0665280a1c7bb200\",\"/knowledge-medium/pr-preview/pr-1922/src/components/typeChip/TypeChip.js\":\"7ed3153f5ec820b9\",\"/knowledge-medium/pr-preview/pr-1922/src/components/typeChip/chipStyle.js\":\"01768562cf14cae5\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/anchored-floating.js\":\"656a06d7395aadd1\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/button.js\":\"3572bd194051f553\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/card.js\":\"3861483100379398\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/checkbox.js\":\"7490f4a7f9c97ce0\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/collapsible.js\":\"e04c0f2eeebe3ad1\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/command.js\":\"ee13db340c8b2a27\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/context-menu.js\":\"15604c5daef8caa5\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/dialog.js\":\"fd91eeb42900d467\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/dropdown-menu.js\":\"50b8d5e2c950e227\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/floating-listbox.js\":\"c41c7daff0ecbe3d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/index.js\":\"78e8a945c499d481\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/input.js\":\"3aebe93df3d65e29\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/kbd.js\":\"13ddf1a7c3024e69\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/label.js\":\"1acfcd388456de32\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/textarea.js\":\"2a7dae46a5c2d334\",\"/knowledge-medium/pr-preview/pr-1922/src/components/useEditModeYieldKeepalive.js\":\"c656299a3418201e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/BootFallback.js\":\"c4e9f49b255c0458\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/FocusedRowLazyMount.js\":\"5571da07ece168d9\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/LazyViewportMount.js\":\"9afb896931583e4a\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/LocalDbCorruptionFallback.js\":\"d9a5c4775631d297\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/error.js\":\"1a5e366b1b90aab1\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/lazyMountRegistry.js\":\"5c48f85ad5764b76\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/suspense.js\":\"b3a9fb10c07ff774\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/CreateWorkspaceDialog.js\":\"d7bb639acde44d92\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/PendingInvitations.js\":\"c4503f743d790dee\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/SyncProgress.js\":\"709b528b4fcfff51\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/UnlockProgress.js\":\"66834fdc8599436e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/WorkspaceKeyGate.js\":\"8c63854b9d4686ff\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/WorkspaceSettingsDialog.js\":\"334ce7bb646173b8\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/WorkspaceSwitcher.js\":\"fa4c17d8f22e7655\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/WorkspaceSyncGate.js\":\"f71aee20e0fb7e88\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/ConversionFlow.js\":\"3be5584f9b0691f5\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/ConversionFlowHost.js\":\"414051a939e6a1a9\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/EncryptionSection.js\":\"6062f73e0be6ed79\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/attachmentPrompts.js\":\"c27a07adf42b9b8c\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/bundleFolderPrompts.js\":\"f2b6ef33bb001a8d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/conversionFlowDeps.js\":\"5dad97c88b0451c3\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/conversionFlowStore.js\":\"c9aaa73caa4db0df\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/flowUi.js\":\"eb6f03b65329e189\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/useConversionRun.js\":\"5e8f44098397cbf2\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/keyUi.js\":\"477d24d7d79e10b2\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/useCloseOnKeyLoss.js\":\"43f4aca8d9afb7ed\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/useCloseOnServerE2ee.js\":\"1db9e577c818f397\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/workspaceUnlocked.js\":\"5aed71a716b220e2\",\"/knowledge-medium/pr-preview/pr-1922/src/context/backgroundSubtree.js\":\"c1d11ab645a24454\",\"/knowledge-medium/pr-preview/pr-1922/src/context/block.js\":\"2d49c19d891380b8\",\"/knowledge-medium/pr-preview/pr-1922/src/context/layoutWsContext.js\":\"b80e613a9d4f4514\",\"/knowledge-medium/pr-preview/pr-1922/src/context/propertyDisplay.js\":\"d1da7a0af7a46594\",\"/knowledge-medium/pr-preview/pr-1922/src/context/repo.js\":\"c87c525c0fce169c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/aliasClaim.js\":\"d20331041fbabe74\",\"/knowledge-medium/pr-preview/pr-1922/src/data/aliasSeatNamespace.js\":\"d555fa7267a127f0\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/blockData.js\":\"39bf8be2e53a13f9\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/blockType.js\":\"fda65b884c89c292\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/changeScope.js\":\"1acff309e7aebe7d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/codecs.js\":\"5db0cfad11a2255b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/derivedData.js\":\"ca1ca3a00809de25\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/errors.js\":\"2ee93ddfbbcacd0e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/events.js\":\"4d203392b889a6fc\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/handle.js\":\"2e3917053f1bcbfc\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/index.js\":\"e98663ad8b3ecb56\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/mutator.js\":\"ed69a015584b966c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/processor.js\":\"7ce02c523d5d4010\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/propertySchema.js\":\"18f2f6b48ecbb4d3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/query.js\":\"248c548f137f1aaa\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/sameTxProcessor.js\":\"b952debcfb2030a1\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/schema.js\":\"2e3917053f1bcbfc\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/tx.js\":\"2e3917053f1bcbfc\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/typedBlockQuery.js\":\"0909cf41ab8f37c3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/user.js\":\"becc4b1a891b304a\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/valuePresetCore.js\":\"5f93bc29650b6e66\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/valuePresets.js\":\"237bf21237946b85\",\"/knowledge-medium/pr-preview/pr-1922/src/data/attachmentCleanerIOVerb.js\":\"79faec075bcef43b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/block.js\":\"ae837ccae0b8260e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockCache.js\":\"0d8e2cf08ba25919\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockId.js\":\"ed22bbaecda072eb\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockLiveness.js\":\"bb5d9e57aa932469\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockMerge.js\":\"c39f7a3b361d661f\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockSchema.js\":\"508a0265542bae5a\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockTypeLookup.js\":\"6451b6d81b790a81\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockTypes.js\":\"d573fbfda38661d2\",\"/knowledge-medium/pr-preview/pr-1922/src/data/childrenView.js\":\"e1a0150c4c4c1eec\",\"/knowledge-medium/pr-preview/pr-1922/src/data/clientContext.js\":\"c057fd07613443a3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/dbFileSiblings.js\":\"457f7d09f846fddf\",\"/knowledge-medium/pr-preview/pr-1922/src/data/definitionSeeds.js\":\"825c0bb8b0b74e9c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/derivedIds.js\":\"c6d9c1067a8d168a\",\"/knowledge-medium/pr-preview/pr-1922/src/data/drawnSubtree.js\":\"6ebadfb16fae5a21\",\"/knowledge-medium/pr-preview/pr-1922/src/data/facetBridge.js\":\"457f01b6c754a0bb\",\"/knowledge-medium/pr-preview/pr-1922/src/data/facets.js\":\"5023d36aa01ed4cb\",\"/knowledge-medium/pr-preview/pr-1922/src/data/globalState.js\":\"63b0bae9680cc11a\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/aliasClaimRederiveProcessor.js\":\"fb0046b55ce8b246\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/ancestorBatch.js\":\"de2e4bb10d1bdb56\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/blockTypeTypeifyProcessor.js\":\"433f46612a983b6b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/clientSchema.js\":\"d959184a4196941d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/commitPipeline.js\":\"ad7293d176c6b09a\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/devAssertions.js\":\"990c59f7274bc483\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/firstSync.js\":\"a3747a78d27f2fa0\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/freshInitialLoad.js\":\"c0822d7e83751956\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/graphBackfillClaim.js\":\"351af1560ec5f2f5\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/handleStore.js\":\"8fda45fb1a86fc28\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/idleMarkerJobs.js\":\"8f77d5ab80a21870\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/initialDownload.js\":\"9429c90b62334684\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/initializeClientDatabase.js\":\"f6f17d256ee6070e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/jsonCanonical.js\":\"936069d74455fdae\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/kernelInvalidation.js\":\"a4d5d0c50eaf2783\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/kernelProcessors.js\":\"d8d0bf5be2da492e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/kernelQueries.js\":\"f632bd9761e1306e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/mergeTypeMembershipProcessor.js\":\"034ea0ea22855297\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/normalizeReferencesProcessor.js\":\"d5570c23f87260a2\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/poolInstrumentation.js\":\"165450031f763e34\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/processorRunner.js\":\"6e8e503e0903a5de\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyCellBackfill.js\":\"268f8c0886fa8805\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyChildMint.js\":\"98c4653ee9341526\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyChildrenProcessor.js\":\"b336da619a3f1be3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyDefinitionChangeProcessor.js\":\"2f03a4f300783990\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyDefinitionSynthesis.js\":\"30b53b7188697b61\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyKeyScan.js\":\"67a5a21538406f0b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertySchemaResolution.js\":\"18674bc365775dca\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyValueEdits.js\":\"19082e3b82c1f742\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/raiseProtocol.js\":\"31f98410fdb3aa39\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/readBatch.js\":\"ea819391d99313a9\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/refProjection.js\":\"df24cf77e10e6703\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/referenceTargetLookups.js\":\"0169e6f13bfc0562\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/referenceTargetProcessor.js\":\"229388e33c23845d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/replayMerge.js\":\"f3b319c109aadc33\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/sqlBinds.js\":\"f7b6bb3a81eb4327\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"05e67b288cdae1d1\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/arrivalProcessors.js\":\"344a437ab94b19dd\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/invalidate.js\":\"4085981cb5a5aefb\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/materialize.js\":\"20ce8712746253ec\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/observer.js\":\"29f74bb65c635f42\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/reconcile.js\":\"cd462aa01ffa67e9\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/timingMetrics.js\":\"4e1777d946928f19\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/treeQueries.js\":\"66abb543a90afa24\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/txEngine.js\":\"ef28bfa784560a1f\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/txSnapshots.js\":\"7307f4ae42817bc2\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/typedBlockQuery.js\":\"fcf06cb16fe96015\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/undoManager.js\":\"b354ff3c14694d14\",\"/knowledge-medium/pr-preview/pr-1922/src/data/invalidation.js\":\"52dc9103da2440d5\",\"/knowledge-medium/pr-preview/pr-1922/src/data/kernelDataExtension.js\":\"972c4881ffed944d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/kernelPage.js\":\"fba6c1361855bd4b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/kernelValuePresetCores.js\":\"2f1ee34696aa57e9\",\"/knowledge-medium/pr-preview/pr-1922/src/data/localDbCorruptionSignal.js\":\"d6195b47a7554599\",\"/knowledge-medium/pr-preview/pr-1922/src/data/localDbStorage.js\":\"3df69aa1799aa37b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/localDbVfs.js\":\"dd0e654e8bed3c45\",\"/knowledge-medium/pr-preview/pr-1922/src/data/localSchema.js\":\"5a721615dd1ca53c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/maintenance.js\":\"834a2d981fb0f4d7\",\"/knowledge-medium/pr-preview/pr-1922/src/data/mergeProperties.js\":\"e1ee7ba97a75eaa8\",\"/knowledge-medium/pr-preview/pr-1922/src/data/metricsConsoleHook.js\":\"77d50cf5a6c7c389\",\"/knowledge-medium/pr-preview/pr-1922/src/data/migrationsPage.js\":\"05399caa03058984\",\"/knowledge-medium/pr-preview/pr-1922/src/data/mutators.js\":\"bad9fe80b3fe5ba4\",\"/knowledge-medium/pr-preview/pr-1922/src/data/orderKey.js\":\"128524aa2874ec36\",\"/knowledge-medium/pr-preview/pr-1922/src/data/orderKeyPlacement.js\":\"56480fb8e95062c5\",\"/knowledge-medium/pr-preview/pr-1922/src/data/outlineSurface.js\":\"08c78892f2301687\",\"/knowledge-medium/pr-preview/pr-1922/src/data/pendingEditorContent.js\":\"be52d4908b8dda0c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/pendingUploadsSql.js\":\"5fdc6289960aca01\",\"/knowledge-medium/pr-preview/pr-1922/src/data/pluginStateExtensions.js\":\"63b36eea30231b36\",\"/knowledge-medium/pr-preview/pr-1922/src/data/powerSyncLogger.js\":\"3a05616ed79c8a3e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/projectorRuntime.js\":\"39efad43472a6a56\",\"/knowledge-medium/pr-preview/pr-1922/src/data/properties.js\":\"99ded72e7fe1f4bb\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertiesPage.js\":\"e91f39aa96f6c7be\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyChildren.js\":\"df753d856c3bb825\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyDefinitionFanout.js\":\"3afb31bc0a119ce5\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyDefinitionMetadata.js\":\"666580e927ce3d83\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyDefinitionRegistry.js\":\"c36aaefb12b79e8c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyDisplayMode.js\":\"0f9780c716bd6352\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyRowCreation.js\":\"f23cc92da42e41ac\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertySchemaCreation.js\":\"2bcb67abcff38d52\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertySeeds.js\":\"0edc32cabba4db0a\",\"/knowledge-medium/pr-preview/pr-1922/src/data/recentsPage.js\":\"a8822d54b62d3357\",\"/knowledge-medium/pr-preview/pr-1922/src/data/refTargetComparableProperty.js\":\"f49206efe447ed6c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/referenceBlock.js\":\"588c185202400502\",\"/knowledge-medium/pr-preview/pr-1922/src/data/rejectedUploads.js\":\"3593e509d688ec59\",\"/knowledge-medium/pr-preview/pr-1922/src/data/releasePowerSyncConnection.js\":\"aab7658f842ca0ad\",\"/knowledge-medium/pr-preview/pr-1922/src/data/repo.js\":\"4866876353a69e2c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/repoProvider.js\":\"311d30289dac19c1\",\"/knowledge-medium/pr-preview/pr-1922/src/data/rowProperty.js\":\"fca39b7d32bda5e1\",\"/knowledge-medium/pr-preview/pr-1922/src/data/searchFilter.js\":\"4501dde053d38007\",\"/knowledge-medium/pr-preview/pr-1922/src/data/seedIdentityLedger.js\":\"5964c73fa0cd0906\",\"/knowledge-medium/pr-preview/pr-1922/src/data/stateBlocks.js\":\"ca68767dcef0db5b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/structuralEditPolicy.js\":\"ef44853e45d20725\",\"/knowledge-medium/pr-preview/pr-1922/src/data/structuralInsert.js\":\"a4742000a69519d9\",\"/knowledge-medium/pr-preview/pr-1922/src/data/subtreeDelete.js\":\"007ee72758cdb83f\",\"/knowledge-medium/pr-preview/pr-1922/src/data/syncStreamLock.js\":\"eb960bce82fe0ffc\",\"/knowledge-medium/pr-preview/pr-1922/src/data/syncedTableSqlRecognizer.js\":\"3a2cc6f71b393c2c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/syncedTableWriteGuard.js\":\"62aa3e94425705f5\",\"/knowledge-medium/pr-preview/pr-1922/src/data/targets.js\":\"91e671025acef89a\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeColors.js\":\"d72717c9dd6c1f24\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeDefinitionMetadata.js\":\"0912d860d7d82518\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeDefinitionRegistry.js\":\"aec44eee291bc3db\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeExtraction.js\":\"ea8e564da0bcdc91\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeInitialValues.js\":\"dc6778c9403d5448\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typePropertyGroups.js\":\"9eeda489164d6b17\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeSeeds.js\":\"cad103e0b8b37c21\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeTagger.js\":\"adb8b82ae337dfd3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typedRecords.js\":\"b80770938731b645\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typesPage.js\":\"a12c1743b7a59931\",\"/knowledge-medium/pr-preview/pr-1922/src/data/userPrefs.js\":\"7b848fb8c99f5f17\",\"/knowledge-medium/pr-preview/pr-1922/src/data/userSchemasService.js\":\"62bd29f26837b0dc\",\"/knowledge-medium/pr-preview/pr-1922/src/data/userTypesService.js\":\"395f8bf906b2c8ac\",\"/knowledge-medium/pr-preview/pr-1922/src/data/valuePresetRegistry.js\":\"b91270009d77902b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/visibleChildren.js\":\"317e26ba612edbd3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaceConversion.js\":\"a76e7c8b71c90460\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaceFirstSync.js\":\"a3ef4c9a3727bb7b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaceIdNamespace.js\":\"e654505f67284dd7\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaceSchema.js\":\"85c7389ea9902c7d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaces.js\":\"b9b3af8a97e619bd\",\"/knowledge-medium/pr-preview/pr-1922/src/data/writeAheadLog.js\":\"39538e539f8074e8\",\"/knowledge-medium/pr-preview/pr-1922/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/BlockPasteShellDecorator.js\":\"ce8631cb8da3ae2c\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/atTrigger.js\":\"3db1bfe385d85c30\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/autocomplete.js\":\"9c2b5bb96be0bd08\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/codeMirrorExtensions.js\":\"cccc52e697511afb\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/contentFlush.js\":\"521c3a6a5db6e4f2\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/defaultInteractions.js\":\"9fae392de00aadfc\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/editSettleSignal.js\":\"d792be93cde76c9b\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/insertImage.js\":\"586532c72529910b\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/referenceCompletionRange.js\":\"964e5b2670dacce6\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/referenceTargetTypes.js\":\"2a7f5abb12c746fa\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/syntaxContext.js\":\"ef1ebc73d3b7456a\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/triggerMatch.js\":\"4250fecbeaf98716\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/AppRuntimeProvider.js\":\"aee2855901c40a65\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/BlockFocusShellDecorator.js\":\"1a96032f80e20d33\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/ExtensionRenderBoundary.js\":\"b36e3dc3be3d1260\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/PanelContentRecovery.js\":\"5b86fd8c13edc0ea\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/apiCatalog.js\":\"551975f403296394\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/appRuntimeController.js\":\"d7c195668460ca42\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/approveExtensionHere.js\":\"f891d43c9a431ef9\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/armedCutAppMount.js\":\"42efab2d385949b2\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/batchableKeyedStore.js\":\"7d7d8bbc456a2f0d\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/blockInteraction.js\":\"596ceb212a6b3b00\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/blockSelectionAction.js\":\"e2b7927875b5b6c8\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/buildApprovalRecord.js\":\"cea547a3dc0bfc77\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/compileExtensionModule.js\":\"cafb318473ac5910\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/compiledModuleCache.js\":\"8c232ac117aa7b35\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/continuousGestures.js\":\"005948af1c33e24d\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/core.js\":\"56384a81f72450f7\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/defaultRenderers.js\":\"5294a01cfea41bb1\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/definitionFanoutAppMount.js\":\"e061558d1c26e608\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/dialogAppMount.js\":\"c49b3a713965e388\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/dynamicExtensionSeeds.js\":\"3f81de13e5980b50\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/dynamicExtensions.js\":\"e9897f122af80288\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/exampleExtensions.js\":\"95fd75974963583e\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionApprovalStatus.js\":\"e70757d4048400af\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionImportPolicy.js\":\"3d67868f0d86ee79\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionLoadErrorToast.js\":\"4ef9b5f145e02bba\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionLoadErrors.js\":\"fe3dded7a9403aab\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionLookup.js\":\"14521f139beeb29f\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionToggles.js\":\"29dc25c1e3a05197\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionUtilitiesCss.js\":\"15cc21d1e877953c\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/kernelPageDeletionGuard.js\":\"04e1a9999e8200ec\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/liveRuntime.js\":\"d3c2a25740dbe349\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/normalizeExtensionSource.js\":\"0c22f1e201692077\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/openExtensionsSettings.js\":\"0278c759e44b3622\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/overridesCache.js\":\"79b2630d8cf79051\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/pluginIds.js\":\"2f96e92f1aeca332\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/processorRejectionToast.js\":\"81d6284a166139b6\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/runtimeActions.js\":\"dfa8dd21318e31ef\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/runtimeContext.js\":\"085e9bfebf17404f\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/staticAppExtensions.js\":\"53219975a60796f3\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/staticDataExtensions.js\":\"3a60d9d64ae87c6b\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/toastAppMount.js\":\"b2eefc00b35d992f\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/transpileExtension.js\":\"60764edbcd4d50e9\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/useOverrides.js\":\"e6003b95916bbecc\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/useShortcutSurfaceActivations.js\":\"32011b38442027ed\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/discoverToggleTree.js\":\"9b2fcc5348f9bce7\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/facet.js\":\"ed0cca8bf26d28aa\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/resolveAppRuntime.js\":\"fc55a3699e97c5d4\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/runtimeEvents.js\":\"dc361825c93428b0\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/togglable.js\":\"53af768169ed36b5\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/variantFacet.js\":\"bab4f3564fc27deb\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/verbFacet.js\":\"a41d4bc1eae7450b\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/block.js\":\"29b629e228496ac4\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/focusedChild.js\":\"c015e0906f0da342\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/propertySchemas.js\":\"f3d2b8171d360132\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/typeRegistry.js\":\"e20efd0e6415215e\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useAncestorCrumbs.js\":\"6950c973c451e74e\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useAutocompleteListbox.js\":\"ddccec69777a6357\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useDebouncedSearch.js\":\"1aeb16415037d093\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useDebouncedValue.js\":\"366db57e840218f1\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useFacetValue.js\":\"c39e5c63a9b41e26\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useIsFocalRender.js\":\"dce91a63f95d49c5\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useIsReadOnly.js\":\"5a8c2745c81bdac5\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useMaterializeBacklog.js\":\"4d879348e446cd50\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useMinuteClock.js\":\"46af6bed4dbbe5b9\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/usePanelLayoutProjection.js\":\"a69073160bfdf102\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/usePendingInvitations.js\":\"8c1c8d1b104b208a\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useRendererRegistry.js\":\"966141bd3891230d\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useRetainedFieldRows.js\":\"f3787dc597332993\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useWorkspaces.js\":\"31cac683491b2500\",\"/knowledge-medium/pr-preview/pr-1922/src/lib/utils.js\":\"8c1bbb47d8e6ccb2\",\"/knowledge-medium/pr-preview/pr-1922/src/main.js\":\"eafe1eecdc3f5750\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/MarkdownImage.js\":\"4668c3e6119b2ef7\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/blockSeparators.js\":\"1b8d6efc4f7e59b7\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/context.js\":\"1e62c80d3384b995\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/defaultMarkdownExtension.js\":\"8be99c3ec89d40e6\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/extensions.js\":\"34b03bb59be43c9f\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/renderMarkdownHtml.js\":\"9fb257cb86cb2101\",\"/knowledge-medium/pr-preview/pr-1922/src/minimal-editor.js\":\"1c3e4506dbdf40f2\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/armedCut.js\":\"5bcddfeb3ca94be0\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/captureMediaVerb.js\":\"8a52a2003eedea45\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/clipboard.js\":\"2c8915193bcda0fb\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/decision.js\":\"52256f0ecd08a373\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/operations.js\":\"4b92c223a286ace5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/account-header/AccountHeaderItem.js\":\"75ee93a13e53701f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/account-header/index.js\":\"b92894fe3d14d608\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"00eefd665d281aa9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/askAgent.js\":\"652d440b66659852\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/askedStore.js\":\"cc1d645002bb0377\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f6f4927dacab9ce6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/chipState.js\":\"332080b2226d1ca0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/dataExtension.js\":\"0d3b36195c870fa7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/index.js\":\"3c442a44bb414565\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"8e704afb6558c037\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/schema.js\":\"6bfb2c9f36df89b4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/AgentTokensDialog.js\":\"12df8a74c13be2f9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0da1686eaf16e4fb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/addMedia.js\":\"4b2ad5d2494c9e12\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/backlinks.js\":\"f794b473d8d3f0e5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/block.js\":\"25141ed18cab87b8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/context.js\":\"ac0e3294c6528117\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/displayIds.js\":\"98011869396d3396\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/index.js\":\"524f481451ee1016\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/outline.js\":\"f23b6904ab91865d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/properties.js\":\"30daabfbe03c630a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/refs.js\":\"1ce727bc7ad13bdd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"896eb2ef1f8bc14a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/search.js\":\"c178610d175fe714\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/shared.js\":\"7b47aff3cc00e213\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"6d5cd7faecf379a5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/text.js\":\"2f64b0bf17f0d0aa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentWrites.js\":\"4fc23b6e15fef405\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/authoringCatalog.js\":\"5def29ca8fea35fe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/blockRefTargets.js\":\"6087a4679bbd77ad\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/bridge.js\":\"8675703f588b3c13\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/bridgeLoop.js\":\"51498ad86f36c95d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/changeHistory.js\":\"e6e5adb4e5dee10d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/commands.js\":\"3f260832e8ab4901\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/commentsCommands.js\":\"eec6d5d0d3928e1f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/dataExtension.js\":\"fcad3fb5c3f807e1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/dataModelGuide.js\":\"e65c73da6a05322a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/dayPropertyInputs.js\":\"69deb21a6cef9477\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/describeRuntime.js\":\"a2163398dd83719b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/extensionLint.js\":\"c5835910c13815ef\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/grainAudit.js\":\"e601ed7a4e388f9d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/healthCommand.js\":\"5072f12dd9b1026b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/index.js\":\"15c44c4e7472cf6e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/presetIdentity.js\":\"2d96cc8fa7be7193\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"63f1029406b39eac\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/readMedia.js\":\"250c1ceee478659a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/schema.js\":\"d298b6e39df5895b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/serialization.js\":\"8cf8bb038260904e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/targets.js\":\"e49e11693a65da55\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/tokens.js\":\"131e1a4890310631\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/watchEvents.js\":\"718db2b9d03f4996\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/workspaceGuard.js\":\"728dfdb5ef9c5808\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/writeCommands.js\":\"d80c113a1be7e785\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/AliasCollisionToast.js\":\"a779daddcdc81e50\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/DuplicateNameBanner.js\":\"6aeb5e01f4cf56e0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/collisionMerge.js\":\"0256a71a8b331f1e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/dataExtension.js\":\"2f6e4f0df38eb56d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/index.js\":\"9e154aa42ff52bae\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/mergeCollisionAction.js\":\"5683ec1ca0cb810a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/pageStyling.js\":\"2d1a23b38e60c922\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/rejectionToast.js\":\"c8fc9f7de18ef1a6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/syncProcessor.js\":\"f9b3fb88c735fd06\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/actions.js\":\"508ab931b6bb01b0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/addComment.js\":\"ec91c154bc911496\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/anchor.js\":\"640855573980a4f1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/anchorState.js\":\"4385157dcab248ea\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/commentLinks.js\":\"98144feebc06688a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/confirmThreadDeletion.js\":\"754e494c2bc89860\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/container.js\":\"6ef9d1a3f68fdd28\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/dataExtension.js\":\"5a8bc1b83a39365b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/deleteComment.js\":\"66aede2b360ce1a5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/highlights.js\":\"45e0503b376581de\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/index.js\":\"e613ce99b9c94375\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/linkedCommentsPill.js\":\"9d6cd9400d3f5128\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/margin.js\":\"eab66d070dc30960\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/marginAnchorLinks.js\":\"dac6fcae290db93d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/marginSchema.js\":\"9eb671b5be84f99b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/newComment.js\":\"86ae6b7e2d842d3b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/ownThreadPicker.js\":\"5b8bfcd9a9595f23\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/placement.js\":\"e4042c76091915e0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/queries.js\":\"e0019622caf35336\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/quotePosition.js\":\"92cea30f540a8671\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/quotedIn.js\":\"d6a37dce07a21587\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/quotedRange.js\":\"9a9cc1e8e5cf0e9f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/rangeRefs.js\":\"b8dc59fc324267ed\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/readHighlights.js\":\"c32f69fc19a30807\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/readSelection.js\":\"881d398dd7877c66\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/readSelectionUi.js\":\"f2f4a4f120304dad\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/reanchor.js\":\"dce054d69e8334e0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/schema.js\":\"400d421fe2417c46\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/scope.js\":\"3d449b0b47cb259e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/scopeThreads.js\":\"23ccfef14396293d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/splitRetarget.js\":\"fe94b55cc693d26e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/suggestionCard.js\":\"59f40b9b7e6a3109\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/suggestions.js\":\"ec624b6b328a2c25\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/summaries.js\":\"375781cb583a8504\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/summaryBatch.js\":\"a836aba6887d0ba2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/surface.js\":\"73b9b408e83e966e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/threadNavigation.js\":\"88d66d320d72b328\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/threads.js\":\"188ef630f266bf62\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/ui.js\":\"9fa555921b8e1b0d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/uiStore.js\":\"9df524a50e640168\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/app-intents/appIntents.js\":\"5beec9a3a8aff78e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/app-intents/index.js\":\"4274806f8128364b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/app-update-prompt/index.js\":\"2b492dafdd9d45f3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/app-update-prompt/status.js\":\"5b6ca6eedd7e1e40\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"552711277efaf3aa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/MediaBlockRenderer.js\":\"50ff685b35af5ead\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/MediaDownLaneReplicator.js\":\"4d75535362fa83c7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/MediaUploadReconciler.js\":\"c79813bb969f4598\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/assetDownLane.js\":\"ee5ecfcd30aa0a53\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/assetResolver.js\":\"b46af446a1222659\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/assetUpload.js\":\"15881336d548351a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/attachmentCleanerIO.js\":\"14fc88a4d633a8f4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0557a14ea7e332ac\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/blobStore.js\":\"b3efe7497c284d0c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/browserMedia.js\":\"fb34d32b16fc5c70\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/byteStore.js\":\"23534f2e092a1a2d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/cleanerIO.js\":\"d27bcc55587d6116\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/cleanupAttachments.js\":\"e78b92b06981b649\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/dataExtension.js\":\"83ea3b9121766188\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/downLane.js\":\"c65050f62945b48e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/index.js\":\"ddaab34ad6319577\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/insertImageContribution.js\":\"8422fac73fb7915a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/laneArming.js\":\"992e355065c478ee\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/laneLock.js\":\"f94c7355b9b5a883\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaBlock.js\":\"d7901e38dffad73d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaCapture.js\":\"1b99bd5a8d6bb0fc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaLanes.js\":\"9d6e32d16a2dfbe0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaViewers.js\":\"e8c5823b19630f16\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaViewersFacet.js\":\"b1922e34a3e6ee40\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/pasteCapture.js\":\"b68ce891d774a513\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/resolver.js\":\"d3ad9fcfd65a8e40\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/retryUploadsAction.js\":\"3428bdfcdc9ad250\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/storagePaths.js\":\"5383482c834dc45d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadDrain.js\":\"5457497c93e0b86f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadLaneStatus.js\":\"2c9b6af9cbf66d02\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadReconcile.js\":\"88a3aea8884d4e83\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadRecovery.js\":\"55b265dc885ea252\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadStore.js\":\"ed9748cbad4ce1be\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/useAssetObjectUrl.js\":\"d17a32301e270573\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"d4e7d4baf9ae3b1f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/BacklinksViewSection.js\":\"17107dfaba3b7cf2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/facet.js\":\"6b546c81e38fd397\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/index.js\":\"a1526b36767b76f9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/prop.js\":\"231421a9d2ecfb63\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/BacklinkFilters.js\":\"a93b2fa89c023814\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"31eb9e23940b8d11\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/BlockEntry.js\":\"2b9931f1f2beabcc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/LinkedReferences.js\":\"eccfdb37de3f7152\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"032e06ce664b1c14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/dailyNoteDefaults.js\":\"81c6ae882ec53b9d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/dataExtension.js\":\"a7f992a7d14cdbee\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/edgeExclusions.js\":\"c2384fdda5b426d9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/filterProperty.js\":\"5cd0a63bb45b681c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/index.js\":\"6703631644bc14a0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"db1cc3412175465a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/applies.js\":\"05a28cae69c06ea2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/countQuery.js\":\"3db3b248bc184aa6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/expansionStore.js\":\"43cbee0cae832b34\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/index.js\":\"d34a860e5d6f5444\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"dee6378b4df3070b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/presentationInvalidation.js\":\"e2e5b2e5c5ceaa64\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/propertyEditorOverride.js\":\"e72ea23e25580993\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/propertyFilter.js\":\"c717140dc51326b5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/query.js\":\"8b9e0723bb5dcca1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/resolveFilter.js\":\"f05d76b65a22de0c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/sourceBatch.js\":\"52172ad2951c1292\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/sources.js\":\"7ee5ebd04752bf62\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/useBacklinks.js\":\"1452eeea986a395f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"387bfbadbedee7f4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/BirthdayCelebration.js\":\"31cc47e480a9747f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/BirthdayOverlay.js\":\"26df9a1d452f4a03\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/gate.js\":\"eb6ffa73ea3a3ec0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/index.js\":\"47ecdfbf5ea244ba\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/wolfTheme.js\":\"b9dcf9d6a6cf6863\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/BlockDragLayer.js\":\"ca2d3b86e18db665\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/dragController.js\":\"489d555c186f3422\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/dropTarget.js\":\"83c06593856f3423\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/index.js\":\"ec4a95458ee4e5e1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/projection.js\":\"c204ae8185d4cb05\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-info/BlockMetaCard.js\":\"6ef2ce82934dc8aa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-info/index.js\":\"261abbc9963bd905\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/AddTagDialog.js\":\"c93298c540a068a4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"76d8f45c45fab4af\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/TagNameIssueHint.js\":\"ef0295f0b4aca20a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/addTagAction.js\":\"2760a126cc9036ed\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/appendTag.js\":\"15691d9fcb870cc6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/config.js\":\"5058d786d902718a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/dataExtension.js\":\"a1979ca5ea0b0956\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/index.js\":\"9cd7d736f46311e0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/propertyEditorOverride.js\":\"96dbc516dea75d81\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/BreadcrumbList.js\":\"9d5526cd7ea556ef\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"34cc58580cd0e651\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/Breadcrumbs.js\":\"ccb38abe4e9db4ca\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"052e2ebdeb1655e5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"a82e475c334e93d7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/index.js\":\"29aae44498ebd103\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bd9f21b9371bb431\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/CharacterCountItem.js\":\"24eb19f3d2a3c547\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/ProfilePropertyEditor.js\":\"5cdb3842575cf584\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/actions.js\":\"8e954bed16f828bd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/blockType.js\":\"c3294181b86f8c90\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/charCount.js\":\"b13febdca98ff2ab\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/dataExtension.js\":\"c7e8e1c044b4bc40\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/index.js\":\"bbc3deea389e3bac\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/profiles.js\":\"e082e77c9117af60\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/properties.js\":\"cf793d717934de2d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/subtree.js\":\"3fe51034fa8c5464\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/textCounts.js\":\"ed8b032e0ce14ec8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/colemak-keybindings/index.js\":\"b029e6e356c6b7b8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/CommandPalette.js\":\"3cbb810d4173a3cc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/HeaderItem.js\":\"4e4e475fdf668d2c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/context.js\":\"53ecc26c76f3c8a8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/index.js\":\"11dd232bcd4773d4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/selection.js\":\"d81b220299096122\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/toggleStore.js\":\"90caf199f2a5bd11\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/useCommandPaletteActions.js\":\"26ff1f77ec06677e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/ContributorBadges.js\":\"a0ea1c1141ef15e4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/ProfilePicture.js\":\"0f6cf273702c6ef6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/author.js\":\"cb1e4ae9d936c955\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/codeMirrorExtensions.js\":\"04ffbf4d918753e7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/dataExtension.js\":\"8389bc38b1fd08d9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/index.js\":\"205a5bb4e9786610\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/mentionAutocomplete.js\":\"09241e8ee2ef90de\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/processor.js\":\"60533c744722986a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/profiles.js\":\"87d07db1a89a0b14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/queries.js\":\"a3ae30ea13421e83\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/schema.js\":\"a22dc89402a75395\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/useCommentAuthor.js\":\"664234bd450aab75\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"5339284a20922d6d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/followOrigin.js\":\"9c7f5ef353233344\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/index.js\":\"073ac1b592148c86\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2a7807a9e697e6ad\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"7beb5f1bd4102724\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/CalendarGrid.js\":\"00b32ebb690b12cf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DailyNotePicker.js\":\"befabf381e37d2ae\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"060aa80f48abb3a0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DateNavDecorator.js\":\"7107dcebb04e831e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DateScrubOverlay.js\":\"a3effb6de78f7550\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DayPropertyControl.js\":\"ed433d927c88acfb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DayValueReferenceControl.js\":\"c31a7e9337dfc508\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/HeaderItem.js\":\"285d8298a7a338a5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/ReschedulePicker.js\":\"e8a105dcfd771206\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/SpreadDatesDialog.js\":\"dff9d0e1c536224b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/actions.js\":\"53ada0d04c0f2e14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/blockDateAdapter.js\":\"c7b268f504924fc4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/calendar.js\":\"a1d7e7d5de467bdd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dailyNotes.js\":\"497b4432a3927e84\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dataExtension.js\":\"dd5fef77286d8434\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dateScrubActions.js\":\"2f8793f5842da928\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dateScrubGesture.js\":\"0914f299b57456a5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6c614165da4ac43e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dateScrubRecognizer.js\":\"1b3504c07253f1ec\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dayProperty.js\":\"095ac5244628ac9b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"1c27562b740d2a0e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/deletionGuard.js\":\"164940308f0b3185\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dueQuery.js\":\"d9ec71e3db76b33c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/index.js\":\"3fb2c23c5b15cb3e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/landing.js\":\"91186c7886cf14f9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/localSchema.js\":\"d0f8d17b67a3e0f5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/referenceDateAdapter.js\":\"6c916bf1d5c00e5d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/rescheduleAction.js\":\"6ca0e1026ce29df1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/schema.js\":\"a34ae058d0b4626b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/spreadBlockDates.js\":\"5be0c874ccef3cbf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/spreadDatesAction.js\":\"298c7b1feb636575\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/today.js\":\"f67b0da9a5f78376\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"f1c0bec8e2360e19\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"e36a71fcc6c6c064\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/audit.js\":\"5ee1e9952aec7edd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/auditAction.js\":\"f693364dd2ae5dea\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/auditRanges.js\":\"31d28118f6d38415\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/diagnosticsSource.js\":\"59711b0826d1a3bc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/divergenceScan.js\":\"681fae1e22172de5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/index.js\":\"dbed5b4bb901bad3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/propertyChildrenChecks.js\":\"23dc79b2dbfbbb41\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/referencesMirror.js\":\"67c8611c822b6887\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/rowJson.js\":\"46eb55a2ccb17cd6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/schedule.js\":\"519819687b8ea402\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/store.js\":\"53c47a632adaae38\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-maintenance/action.js\":\"456f635cdf0c450f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-maintenance/index.js\":\"e1c62f920b6454b8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-maintenance/plugin.js\":\"3b0397145ea7a831\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"f7d9d22061fec8df\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/actions.js\":\"9f52fa855032ae5d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/changeMarker.js\":\"dcc51f94d883cf98\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/diagnostics.js\":\"e6f8a826ef41c539\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/fileSystemAccess.js\":\"237433b84c5477cd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/filenames.js\":\"18e8ea35112b7230\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/index.js\":\"f266f65696ac5834\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/mirror.js\":\"9f8f5af783060d27\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/runLock.js\":\"4f48b5a8c46284f2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/runtimeHealth.js\":\"93a88a8246be569d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/schedule.js\":\"fb431c87021c25fe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/store.js\":\"ec657378e1721b1c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/default-themes/index.js\":\"30105ff3abd5dd9f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/default-themes/themes.js\":\"b106298b22f565fa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/diagnostics/facet.js\":\"37d4235fee96ec72\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/diagnostics/useDiagnostics.js\":\"8bd6a26f97fb53cc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extension-prompts/dismissals.js\":\"8862209671801ce0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extension-prompts/index.js\":\"61f57f90935cf90f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extension-prompts/status.js\":\"e90e4c7b4eda8184\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extension-prompts/store.js\":\"2bc53d1ce0a023f4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"07df766a1195b326\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/ExtensionsSettings.js\":\"b860b4c16dfca087\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/actions.js\":\"5f467ba6f4215517\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/config.js\":\"8cc67182564a8ea8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/dataExtension.js\":\"c7eccc06911c9202\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/effect.js\":\"33ddb09ce3c22d21\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/index.js\":\"086884c1e65d43ce\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/propertyEditorOverride.js\":\"2a58f0370773441f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/useToggleTree.js\":\"55db71ffec12f754\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/ExtractTypeDialog.js\":\"06a2526a2bcc04d7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"b691e417501e3fe7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/PropertyShapePicker.js\":\"1499b7f4b61753fe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/action.js\":\"a74ff47d57c6a75e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/index.js\":\"f4f79c9937cdd8f2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/FindReplaceDialog.js\":\"e355dfcfcb7f0826\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/HeaderItem.js\":\"bd880b1c6042bf10\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/dataExtension.js\":\"025c5e6d1d4e634c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/index.js\":\"dd1e3c46018f7248\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/search.js\":\"ca3a28464773ea37\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/toggleStore.js\":\"5b9eb2303cdc8813\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/LocationPropertyEditor.js\":\"a68b022bf5229936\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/MapView.js\":\"b0fa8d2343f7653a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/blockTypes.js\":\"efb662d28f78e789\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/codeMirrorExtensions.js\":\"93949aa6635debfd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/createOrFindPlace.js\":\"2659eac4de6f50ef\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/currentLocation.js\":\"a8a43614c6648e86\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/dataExtension.js\":\"1fc8640bed3d41ec\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/geoContentDecorator.js\":\"e9e77680120d14db\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/googlePlacesClient.js\":\"902e170304d54e11\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/index.js\":\"002138b46aba4313\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/locationsPage.js\":\"5dc0548b93da18c8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/mapViewport.js\":\"bb6435e3c87de178\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/pickCurrentLocation.js\":\"f961dd6ffa36fe3c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/placeAutocomplete.js\":\"434b58f8b468f715\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/placeNameCollision.js\":\"f433d7f780db1e9f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/properties.js\":\"601de6495df4444f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/propertyEditorOverrides.js\":\"a44d2943e78501ba\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/query.js\":\"b8dfafb514e7a5d5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/usePlaceSearch.js\":\"b68271c9fa5aeabf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"0ba66b8f2232cb15\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"22fe96410f4fb7de\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"f85d5a02040bf4ad\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/config.js\":\"505745f0f69bd49b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/dataExtension.js\":\"e96533149bf75236\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/facet.js\":\"6c045a0964622f56\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/grouping.js\":\"ce6ac95784b17aeb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/index.js\":\"caadcc1d5d7e193c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"82fb5c3c581bfcd7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/query.js\":\"8e53ac80f7f6f053\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/resolveConfig.js\":\"80b45f015f5a57db\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"50af5712274367ea\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"567964c79aeda2b6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/HtmlDocumentContent.js\":\"eddb8029fa5b726c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/HtmlFrame.js\":\"78745f595aa515a1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/actions.js\":\"956901fb8d2a8a3f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/blockType.js\":\"f67bb93c7f70bd13\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/confirmRunScripts.js\":\"1bc774de6ba63fcf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/dataExtension.js\":\"44c0e7ba437012ce\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/frameAnnotations.js\":\"07b896a1fadbb4b1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/frameDocument.js\":\"b069f60474a1f654\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/frameTheme.js\":\"5b5352ddae507f3c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/index.js\":\"57c2f7f743317366\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/scriptConsent.js\":\"96f08d5797fc0e54\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/sourceMap.js\":\"690b9fd693030828\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/useDocumentScripts.js\":\"3c23b089c36bf4fb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/index.js\":\"f175dacf6d57e0ad\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/record.js\":\"62052a1043efc001\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/recordStore.js\":\"dfc24a03d3ef8fbe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/responsiveness.js\":\"939ea62a2db5c6f8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/schedule.js\":\"942bc57cf6ad7882\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/sessionContext.js\":\"afce1b8858449195\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"3d70b3be572bb73a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"c715c0682b680c0c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/actions.js\":\"1b147d9d19cbe41d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/config.js\":\"92d779c2eaa4e8d5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/dataExtension.js\":\"171a36a2754561ce\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/effect.js\":\"2f231aa702c799f8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/index.js\":\"1c8c63d630b3513c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/keyCapture.js\":\"229274bb2033fc6d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/overrideStore.js\":\"db991fb171a49312\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"67b6b976a2fed939\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/HeaderItem.js\":\"28d84afc9ef16aaf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/LeftSidebar.js\":\"46c23c5b56cc4ab5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/actions.js\":\"fcea0016a7ae624a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/facet.js\":\"35211734b7623369\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/index.js\":\"f31f72f32056045d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/shortcuts.js\":\"cc28ff71462bbb81\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/toggleStore.js\":\"44a410b3500e40b0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/merge-blocks/MergePicker.js\":\"b0bc9c61ee9321f6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/merge-blocks/index.js\":\"c67dd32cf39ee9a6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/merge-blocks/mergeAction.js\":\"1459ca55166d41ce\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/merge-blocks/strategy.js\":\"5242417b632b80b8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/Button.js\":\"67829e40d475d0d2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"40c6f8888dc6f260\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/defaultItems.js\":\"b7a3df068e0013b8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/facet.js\":\"7d1b3e26e543ce8e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/index.js\":\"8b738bbdc6415ef6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"695d98437443a20a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/actions.js\":\"a36144994df008d8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"36f699e560369a4b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/facet.js\":\"895b9427f2f1b680\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/index.js\":\"8b02091024e09eba\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/MoveDestinationPicker.js\":\"409cae7dd41310ac\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/blockSubtreeMembership.js\":\"648e67928ad27965\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/contextMenuItem.js\":\"214f640c2b8a15dd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/index.js\":\"07d19e5b96d7ae08\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/moveAction.js\":\"5ceda53ae00400f4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/moveBlocks.js\":\"7aef4962573ca077\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/selectionAfterMove.js\":\"b121ace21041fa47\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/TutorialBanner.js\":\"fd568fe1fcc2dab0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/action.js\":\"f5c5574e28219c0e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/bannerDismissal.js\":\"29481b97d5a4110e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/documents/cheatSheet.js\":\"7f9f25b9d13a2bfa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/index.js\":\"cb91fa1873bf4095\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/keys.js\":\"473768c60329f0fc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/landing.js\":\"4c5382b043711a63\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/outline.js\":\"ee30b48590c08ce5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/seed.js\":\"dd43f754398b71c6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/PerfTrendDialog.js\":\"7b580b0b10196c79\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/analyze.js\":\"28ecf572a1428237\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/diagnosticsSource.js\":\"6ed0f7dee6486797\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/index.js\":\"7bf5e3ce23cf4ced\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/load.js\":\"3573b18f8c8fd4cc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/monitorRun.js\":\"bd9c22ef4704b7af\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/schedule.js\":\"bd72c32c2b528be8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/series.js\":\"a1545b80531280bf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/store.js\":\"920801dcc438e593\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/trendAction.js\":\"4e51c659558b4762\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/verdict.js\":\"14ba35f3843e8767\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/plain-outliner/clickToEditAction.js\":\"f1c7d51f9ac440c7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/plain-outliner/index.js\":\"007ebc6f7751221a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/plain-outliner/interactions.js\":\"d121a184d837011e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"5c2cac2b6813a02b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/MigrationGate.js\":\"56d4aa7609a7a363\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/MigrationGateDialog.js\":\"d945583c9a229ada\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/action.js\":\"6659e278ac9e4256\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/index.js\":\"2ddf449be9a2d66a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/localRunMessage.js\":\"28665ee11a0630c9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/plugin.js\":\"fd58f4f336cd135e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/progressReport.js\":\"ce231d764becea65\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/sweepProgress.js\":\"0eba0857af0ff7af\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/FieldRowRenderer.js\":\"f06b2c4ff510d945\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/ValueRowRenderer.js\":\"b1283a5aa844c307\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/actions.js\":\"96f3926c52458032\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/autocomplete.js\":\"fa57be4ec3cd0f8c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/fieldRow.js\":\"2b8eea15d8df5b55\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/index.js\":\"a165285dcf834789\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/referenceWarning.js\":\"26e2f501730a6226\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/valueAutocomplete.js\":\"eb3452fd77eadc8d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/valueSchema.js\":\"7d59282bb61f9781\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/HeaderItem.js\":\"482ca066c0501f91\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/QuickFind.js\":\"dc4dec74188ab677\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/index.js\":\"bd70de49e0297acf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/recents.js\":\"aa6cd3a3c2cec72a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/resultItems.js\":\"6c4b7d31fa052cdf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/selection.js\":\"fad9828f6ec0255e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/toggleStore.js\":\"b3173d0876d60c14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/HeaderItem.js\":\"4c75b857d53243e9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/RecentsPageBlockRenderer.js\":\"2c1548081504accf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/grouping.js\":\"c7572e42189aa3da\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/index.js\":\"f93f8798f896d070\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/target.js\":\"741d0b0e051f9481\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/codeMirrorExtensions.js\":\"cd9e22d64d0c8e63\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/contentPrefill.js\":\"347d8e7d65ab4892\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/dataExtension.js\":\"3094d514858ae1b3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/index.js\":\"fe087ee46a721e02\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"0e2eeed312a7035a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/invalidation.js\":\"f0e4f44b877d7976\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/localSchema.js\":\"0c372e661a54964f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/blockrefs/index.js\":\"22fbf4c9db9c2c2f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"05828df9fce8f8b2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/index.js\":\"9e30822d7fee0860\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/referenceNode.js\":\"e55a173ea201a441\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/remark-reference-occurrences.js\":\"8481caa0d21e7a14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c4b394b38e4679a3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/wikilinks/index.js\":\"c37d672340a43365\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"baba7d0786701efe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"3daafe9196fa797b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/mergeRetargetProcessor.js\":\"ba78b79dba071c26\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/parseFence.js\":\"a7b60be5d4dbf525\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/referenceParser.js\":\"5e791be9f1546949\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/referenceProjection.js\":\"580f511ebc775cec\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/referencesProcessor.js\":\"dc26080f71b75dc0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/renameProcessor.js\":\"bf0a9ccef461b828\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/spanReplacement.js\":\"70c313d9786f7bc0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/rich-paste/htmlToOutline.js\":\"7c4eb115121905ca\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/rich-paste/index.js\":\"665f7e01f4feaa75\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/rich-paste/normalizeClipboardDom.js\":\"c12d6e2f20f90bf2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/rich-paste/pasteDecision.js\":\"8573add3a4e668b6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/action.js\":\"752ca897668b8b96\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/blockIds.js\":\"a177fc542a06d4a4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/content.js\":\"f84ea738db69957f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/effect.js\":\"cfceb8bbfadc75df\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/ids.js\":\"b1ce82d4d74c0040\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/import.js\":\"273514186bb28541\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/index.js\":\"752b8b585b6e4fba\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/plan.js\":\"c925f303736f217f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/plugin.js\":\"b27d743f6d6d4e85\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/promotion.js\":\"4f9cf57cef7bd346\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/properties.js\":\"93b51a20c00725c3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/references.js\":\"369df87d082ebaa5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/report.js\":\"3580a773b6fef88e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/roamMemo.js\":\"8eaba7d66115c0e8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/runtime.js\":\"d8be99b644c85b29\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/schemaReconciliation.js\":\"fbfb7f4b64ff3ab6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/srsMarkers.js\":\"23582b2bb35982b2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/todo.js\":\"cde1b6b6f6bfde52\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/typeCandidates.js\":\"5582096e8a9676bf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/types.js\":\"3b26754737d34147\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/search-health/index.js\":\"cf3bed0d2cb31f4b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/search-health/store.js\":\"092cfaeca225794e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/HeaderItem.js\":\"400caa3dd0cac36d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"90f344e732c4f695\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/index.js\":\"4d6a3a110631d464\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/model.js\":\"327bba737cfc1b9a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/toggleStore.js\":\"ad1a899738c06577\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/useKeyInspector.js\":\"f700e92ece8016d7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"8216e46a26a78743\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/ShellDecorator.js\":\"cacab90bd6647a7e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/actions.js\":\"ac1e1345452ce693\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/exclusionsFacet.js\":\"20544ae4d4e53cfa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/index.js\":\"7fdbb63de91a20b6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/shell.js\":\"5bf8f9fe97c2deba\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/surface.js\":\"e100702f65e2f57f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/walker.js\":\"c090ac1006a4b942\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/RescheduleToast.js\":\"dead9e5e0fd050ce\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/dataExtension.js\":\"df051c31c2b6be5c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/index.js\":\"3015bab43455e81d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/indicator.js\":\"21c6924e6eab326c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/moveSrsState.js\":\"59ec64079d2d28d1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"563e127c91a1bc13\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/scheduler.js\":\"83c9d8f68131d1a9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/schema.js\":\"a408b20e650e809a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e5eacdfce62b02e0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/srsClipboard.js\":\"d910409fce766d35\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"b42d1d959e68f2db\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/DailyNoteReviewHint.js\":\"57165caaf917312f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/DeckPicker.js\":\"a4a44c81ad010256\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/ReviewControls.js\":\"764f7b8feb1ae020\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/ReviewDeckRenderer.js\":\"850d0f5d2295992c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/ReviewSession.js\":\"c36c1017cbb497a5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/actions.js\":\"0c2f5895e8e527b3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/archive.js\":\"52a818add83db71b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/dataExtension.js\":\"9e14c6d4b24c5c5d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/deck.js\":\"c2910703ba05b547\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/dueQuery.js\":\"3055d59e849eccd1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/gradeDecision.js\":\"32e3485a5f518e87\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/index.js\":\"55e881774fc69156\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/keyHints.js\":\"1edb42402429fb7e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/reviewCardLayout.js\":\"4a6636799d94e669\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/reviewProgress.js\":\"2e6fbfc1dbada6e9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/schema.js\":\"b4ce46e37aff4593\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/useDueCards.js\":\"b032646aa941e0d0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/startup-metrics/index.js\":\"7f8c700f8a5b8320\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/startup-metrics/record.js\":\"0b4dfae5f92632ba\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/storage-persistence/index.js\":\"de3c04af339f908a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/storage-persistence/persistenceStatus.js\":\"6006215d95429077\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/storage-persistence/requestAction.js\":\"c49864f9493d0726\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/supertags/TypeChipsDecorator.js\":\"fa82d270e398cf12\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/supertags/codeMirrorExtensions.js\":\"85cdbfa5d17157cb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/supertags/index.js\":\"c7f5476ad5b245ec\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/supertags/typeAutocomplete.js\":\"d3236236a2c58ad7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"f36cc4b512e2acb8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/actions.js\":\"16f15524aa9068fd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/anchor.js\":\"daf5d293e75364a5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/events.js\":\"9db71338ad8fefba\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/gestureActions.js\":\"8ad2db1420505096\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/index.js\":\"826d73ceccb28782\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"2b40399d99934907\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/sync-metrics/collect.js\":\"c7fa7269ba539a82\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/sync-metrics/index.js\":\"606adef25a975268\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/sync-metrics/record.js\":\"1ed05606c77e0e3b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/RejectionDialog.js\":\"06058594ab01cfa8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/SystemStatusHeaderItem.js\":\"4cd5fba0c9759125\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/index.js\":\"34f28a8f7d986a4f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/model.js\":\"af3ecbb6bfb9da98\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/queueCounts.js\":\"bd41b92f82c2aa53\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/rejectedHelpers.js\":\"b6952411e8f2e80f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/rematerializeAction.js\":\"0d3a2ce59dd26a83\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/useHysteresis.js\":\"3da320d88abf2e73\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/ColumnHeaders.js\":\"2475bc70ae8ea139\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/QueryUi.js\":\"8626e73d7bceee80\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/TableLayout.js\":\"4a85068adb992ea6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/actions.js\":\"75bf7a1e7330c12c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/cellEdits.js\":\"eb6bfd2a00163a5a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/childrenViews.js\":\"2ba5a437525da36c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/columns.js\":\"58c589631840f223\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/controller.js\":\"e1bf5459c7e7464e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/convert.js\":\"06fb10174c878709\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/dataExtension.js\":\"de796c7957c4773b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/index.js\":\"28bf9f8b30a8f3a1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/keys.js\":\"225b818bbf579ad0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/model.js\":\"d6a5bd98221822d5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/QueryText.js\":\"a0a2bfb21c2d50b2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/backfill.js\":\"e739079dd73dd0fa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/completion.js\":\"18d52a190b15c16d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/format.js\":\"e73db864f78c3bf6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/parse.js\":\"ff233684f4ae0c75\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/queryValue.js\":\"7b0445854b490989\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/registrations.js\":\"3d7c6fa00102708f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/source.js\":\"e4d3093cc06bc1d3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/registry.js\":\"5ac5e966c3b73c34\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/rowGutter.js\":\"3ab391714d40ee49\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/rowVerbs.js\":\"9cddcca859f9f42e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/schema.js\":\"a3226c5917e61742\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/sort.js\":\"3f69789448f9797f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/theme-toggle/effect.js\":\"180e101ad1979d65\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/theme-toggle/index.js\":\"67777742e0a8cd74\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/theme-toggle/theme.js\":\"78d8e96424ee8188\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/todo/actions.js\":\"c3261ea6b2cdd862\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/todo/dataExtension.js\":\"f5022ed62b46a921\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/todo/index.js\":\"907f4610029b6cdd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/todo/schema.js\":\"a7737c053c31c684\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/TouchSelectionLayer.js\":\"348888362e25f235\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/actions.js\":\"42556f5c3734bfd1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/defaultItems.js\":\"d515090fdbdf565c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/facet.js\":\"5e1fadccbad74b2e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/holdRecognizer.js\":\"921c401089c155db\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/index.js\":\"d5816274426791de\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/update-indicator/UpdateIndicator.js\":\"21767d7a6ccc147d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/update-indicator/index.js\":\"0b8703dc7fd6be04\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/update-indicator/loadTimes.js\":\"cf31644438c73a13\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/VideoNotesRenderer.js\":\"f9457b449d69faf5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/VideoPlayerRenderer.js\":\"444c9e088f5111f6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/VideoTimeStamp.js\":\"2eb5a388e9ca892d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/actions.js\":\"94592ce29c745744\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/index.js\":\"61206b5ff72512ab\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/markdown.js\":\"2cda3b0b9a760bc6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/notes.js\":\"568efd9e40e5d6ad\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/registry.js\":\"c7c1478ba8d3223a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/remark-timestamps.js\":\"78e34b717f873e03\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/view.js\":\"fe89db9a0f0da25e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-link-hints/LinkHints.js\":\"4d7541a73bbb48ef\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-link-hints/index.js\":\"15a43048b9b3c728\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-link-hints/model.js\":\"7f3c7ae7c3e7f961\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-link-hints/settings.js\":\"944ea1a240a6f379\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-normal-mode/actions.js\":\"50344640c8f8b4e5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-normal-mode/index.js\":\"d11711927d3c1368\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-normal-mode/interactions.js\":\"8cc144e66c18f40d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/workspace-header/index.js\":\"5d67871d9e6d9a99\",\"/knowledge-medium/pr-preview/pr-1922/src/registerServiceWorker.js\":\"2a2dc0ef3dbbce11\",\"/knowledge-medium/pr-preview/pr-1922/src/requestPersistentStorage.js\":\"d39b8dcd1d0e6732\",\"/knowledge-medium/pr-preview/pr-1922/src/services/authRequestDeadline.js\":\"76d6dc5f9b8a06eb\",\"/knowledge-medium/pr-preview/pr-1922/src/services/authStorage.js\":\"dc866c1144915ba1\",\"/knowledge-medium/pr-preview/pr-1922/src/services/powersync.js\":\"287cce6b47fab2d6\",\"/knowledge-medium/pr-preview/pr-1922/src/services/supabase.js\":\"eb723545a46c6485\",\"/knowledge-medium/pr-preview/pr-1922/src/services/uploadErrorClassifier.js\":\"fe73b5318dfb7844\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/ActiveContexts.js\":\"8f71fc56b552e2f1\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/HotkeyReconciler.js\":\"661ef60efb8c50c5\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/WipeLocalDataDialog.js\":\"b6141e94bd60cc9f\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/actionDispatch.js\":\"8ad7ec2c467a064b\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/actionKeyHints.js\":\"6c9bddedb44eed01\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/actionRefItems.js\":\"089af3484a7bb763\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/applyKeybindingOverrides.js\":\"9c854ecc06ea866b\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/blockActions.js\":\"d8a65b6ba5122b57\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/blockMergeGesture.js\":\"04639215225488c1\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/canonicalizeChord.js\":\"9d652db03177f587\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/defaultContexts.js\":\"ab505a548d38a050\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/defaultShortcuts.js\":\"885c6f747bba0760\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/effectiveActions.js\":\"857af1b405fcce7a\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/formatChord.js\":\"c923bb6083b18c26\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/gestureAction.js\":\"ebf2200525a07852\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/gestureBinding.js\":\"bf8f4cd43c7bf261\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/holdRegistry.js\":\"7a4726217c97e889\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/keybindingConflicts.js\":\"e5273637b3424ef2\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/keybindingOverrides.js\":\"9c600d7041e84144\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/pointerAction.js\":\"c70ebe6c9ede4897\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/resolve.js\":\"5c33588693eccc09\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/runAction.js\":\"c5f9acd2a83803c1\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/sequenceMatcher.js\":\"1312e8648e7997ce\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/types.js\":\"e1a42d398bcaed5b\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/useActionContext.js\":\"c9630c14cddd79df\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/useActionDiscovery.js\":\"5a1355970ffb8583\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/utils.js\":\"e92b59b962857fe1\",\"/knowledge-medium/pr-preview/pr-1922/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1922/src/sw/bootStore.js\":\"abc7b1044f609df7\",\"/knowledge-medium/pr-preview/pr-1922/src/sw/previewDatabases.js\":\"dbe919b71ae795f1\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/byteTransform.js\":\"4a4bf5e844b81eb4\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/attachmentCleaner.js\":\"32624f336e941cdf\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/attachmentParts.js\":\"0891f1d2c7de16dd\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/bundleParts.js\":\"03da35b6109cb990\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/bundleRecord.js\":\"a7b4eadf22937ab9\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/manifest.js\":\"f7320d80237f1926\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/takeBundle.js\":\"febf2f11d59c6aef\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/verifyBundle.js\":\"fc91a86c32eeabbe\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/cleaningStage.js\":\"d31890735774dc97\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/conversionKey.js\":\"fb0d5d9ddfdf727b\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/conversionServer.js\":\"da1d4177f9c51e94\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/flip.js\":\"93edf76aa592d52c\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/flipAttempts.js\":\"6bb07af4a04c1de2\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/pages.js\":\"3bbbc17e24fa708a\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/preflight.js\":\"a14f6948626032ec\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/reseal.js\":\"4005ddb48eb466f2\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/runConversion.js\":\"794df8ecbcfabad6\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/runLock.js\":\"54a4f8c75faaccfa\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/sealing.js\":\"97232d328f6f5cdc\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/sealingStage.js\":\"7bdea6c3418a5605\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/stage.js\":\"38e2c126ff64c9f1\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/verifyReseal.js\":\"12bd52080df3bc12\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/aad.js\":\"534a34094f3af678\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/aead.js\":\"4dbe63b86b535b4f\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/base32.js\":\"933881dd71bc5b36\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/base64url.js\":\"16e16ea3298ab793\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/binaryEnvelope.js\":\"4336d69001726374\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/byteAead.js\":\"ade22fc84d00e128\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/canary.js\":\"b6f26e904fa28df8\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/contentHash.js\":\"c73db83df93527fd\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/contentKey.js\":\"646b87debc3ebe19\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/derivedIdNamespace.js\":\"4df78330739e35a8\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/envelope.js\":\"3e5d1c94932cf10e\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/hex.js\":\"868378485f70f3eb\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/sha256Hex.js\":\"03faabd216934b1c\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/workspaceKey.js\":\"ad3886880f53c3e4\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/conversionState.js\":\"4c63c2efeaf8954d\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/flows/createEncryptedWorkspace.js\":\"933002b1a47058db\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/flows/pastedKey.js\":\"44f461855438efa8\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"b801f8a49c3e700b\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2849dc92221693c9\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/keyStore.js\":\"0067c9f51367edbb\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/mintWorkspaceKey.js\":\"c6ce236c3ebe6d0b\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/modePin.js\":\"8a6ec905d01d575f\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/openWorkspaceKeys.js\":\"ea4009e7adb63874\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/resolveWorkspaceEntry.js\":\"b76adc76d4fc8503\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/resolver.js\":\"9fd6fdd1327267a6\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/workspaceAccess.js\":\"ce00c13d10a73899\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/transform.js\":\"700a6062fcaab28f\",\"/knowledge-medium/pr-preview/pr-1922/src/themeBootDefaults.js\":\"0d873b83d87ecfee\",\"/knowledge-medium/pr-preview/pr-1922/src/types.js\":\"c79ee6d70c2908e1\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/ClientLocalSettings.js\":\"cf71e2cbaf66f358\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/abortableSleep.js\":\"e9846f830142ba33\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/array.js\":\"95efe6f223e6bfea\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/backlinkAutocomplete.js\":\"0f67e9fb911463b0\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/blockCrumbs.js\":\"16ccb60d5ec3aa22\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/blockrefAutocomplete.js\":\"68c3def5dc02d57b\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/cadencedIdleJob.js\":\"8426760644ddd879\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/callbackSet.js\":\"de96106577da5f2f\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/clientId.js\":\"b7f4845976a7faf4\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/codemirror.js\":\"6faa2127e17442d0\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/codemirrorCompletion.js\":\"41f99ffcf69fd45c\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/copy.js\":\"90296cd43cefd0f1\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dailyPage.js\":\"0d20b5179689cfa0\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dbForensics.js\":\"db65377fade669bb\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dbForensicsHooks.js\":\"761ae12ecd16d7d7\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/deleteBlockThroughUi.js\":\"3d99e9c0e7192a96\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dialogs.js\":\"51972cc18d5fd1a8\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dom.js\":\"531aca2d3362dec6\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/downloadBlob.js\":\"fab3cbfeaae6a06d\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/drawnWalk.js\":\"a68b244963658122\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/exportSqliteDb.js\":\"33a351b9c100f281\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/fileSystemAccess.js\":\"1c5c8a5ae9f313a8\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/flipSlide.js\":\"48d7c34ee66b5a05\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/fnv1a.js\":\"df260e363923278f\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/formatBytes.js\":\"ec26947fd3dc63f1\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/fuzzyRank.js\":\"facc99d932c70c53\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/idbKeyedStore.js\":\"969215cce4ee68f7\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/idleCallbackPolyfill.js\":\"ac572d2dd3b908de\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/keyboardAwareScroll.js\":\"ae49934cfd81a4c1\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/keyboardViewport.js\":\"63f3bea7c57de00c\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/lastWorkspace.js\":\"36c9d984032801d0\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/layoutColumns.js\":\"f5beaf7992eba566\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/layoutSessionDom.js\":\"816e0b10cab5f48b\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/layoutSessionId.js\":\"b7312155c0962d6b\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/linkClickGestures.js\":\"81673b64fabf5d96\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/linkTargetAutocomplete.js\":\"dc1a6635072c2943\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/localDbCorruption.js\":\"96e9025ffc77815c\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/localDbRecovery.js\":\"cc7fa4a1323844dc\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/markdownParser.js\":\"9ec087631959aa87\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/memoize.js\":\"dc9fc710a59182b3\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/nameFieldCommit.js\":\"441277e14cd3823e\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/nameList.js\":\"53139d3e8ed88697\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/navigation.js\":\"71c73ccb43199887\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/omnilinerNamespace.js\":\"09c48f8ec9f3e825\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/opfsPageScan.js\":\"7c8565e7c9d0b86a\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelClearance.js\":\"1d502f780fad6965\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelHistory.js\":\"9e4d949536b459bd\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelLanes.js\":\"71ae70d2a9a7bb6c\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelLayoutProjection.js\":\"d5633d3cbb4b4f6f\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelScrollAnchor.js\":\"f8a10243fbf2af0d\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelUrlFlags.js\":\"960ad68cbbba5500\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/platform.js\":\"54d5187d5be3ddb1\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/pluralize.js\":\"ec5a29b9cf4d08e1\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/propertyCreation.js\":\"d73de612c17535d8\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/propertyNavigation.js\":\"b3f9779cd03515ba\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/propertyValueContext.js\":\"63dc2a441f7bce02\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/react.js\":\"15338c1044419fae\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/relativeDate.js\":\"42be3a0f2d6cd6d5\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/relativeTime.js\":\"443535af0f11746c\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/renderScope.js\":\"a724cc8d118803d2\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/resolvedThenable.js\":\"13524a521a679715\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/routing.js\":\"d151c85dc18acf6a\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/safeMode.js\":\"ebb8aec972b7e2b8\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/scheduleIdle.js\":\"c428ec24744b31f1\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/screenWakeLock.js\":\"b85441cb3f8efb23\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/selection.js\":\"93dee0b7a678fe59\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/softKeyboardGrab.js\":\"5c1d5185df036f59\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/startupTimeline.js\":\"8ca4e6971cdf5dc3\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/state.js\":\"b27ba7aad2a53873\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/string.js\":\"981bd1a9cd699a6d\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/surfaceZoom.js\":\"d25016c5342aaf31\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/time.js\":\"3df2d6017b301744\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/toast.js\":\"8e7317d462177ed0\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/toggleStore.js\":\"6cbe5f24685da69a\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/untilStopped.js\":\"0796ad7d337430f4\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/userActivity.js\":\"99e92bc36e29169a\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/viewTransition.js\":\"56c786caf2242579\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/viewport.js\":\"da04e1e1c9b778ef\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/webLock.js\":\"ae4fb0c2f160009b\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/workspaceRecovery.js\":\"fae18958bc7d9c38\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/workspaceSnapshotStore.js\":\"a83cd3ea935b9e12\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-compiler-runtime.js\":\"404d2ebcbfc8c6f2\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-client.js\":\"12fcc5508014333c\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-server-edge.js\":\"ee4f6ac295def2d9\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-server.js\":\"a669799b4e93e2f0\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-static-edge.js\":\"49754325ccd09189\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-static.js\":\"6c8ce2a8f573c8fa\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-test-utils.js\":\"40085802f99967a8\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom.js\":\"ace35c9b6583c4ee\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-jsx-runtime.js\":\"1edbf80d301d99c8\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react.js\":\"f999ecf4a3e0e098\",\"/knowledge-medium/pr-preview/pr-1922/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1922/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1922/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
