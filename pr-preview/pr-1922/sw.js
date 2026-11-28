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
		buildId: "51a45e3ca2d8-c940f24c",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1922/\":\"f115fcd6292628bf\",\"/knowledge-medium/pr-preview/pr-1922/index.html\":\"f115fcd6292628bf\",\"/knowledge-medium/pr-preview/pr-1922/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1922/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1922/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1922/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1922/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1922/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1922/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1922/assets/FacadeVFS-CjBLdSox.js\":\"af3e7722a1fb90a1\",\"/knowledge-medium/pr-preview/pr-1922/assets/OPFSCoopSyncVFS-CuwZ5njf.js\":\"e672d66b81a81963\",\"/knowledge-medium/pr-preview/pr-1922/assets/OPFSWriteAheadVFS-D_CllOCE.js\":\"92b348c872e24019\",\"/knowledge-medium/pr-preview/pr-1922/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1922/assets/wa-sqlite-DxAnm4Ay.js\":\"f4519eb68cc263b4\",\"/knowledge-medium/pr-preview/pr-1922/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1922/assets/wa-sqlite-async-B5U559qy.js\":\"6870f5999716cccf\",\"/knowledge-medium/pr-preview/pr-1922/assets/worker-C6Rq6TOE.js\":\"8e95374283323a22\",\"/knowledge-medium/pr-preview/pr-1922/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1922/chunks/app-DU4h-_RX.js\":\"02bc4c550fbb753f\",\"/knowledge-medium/pr-preview/pr-1922/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1922/index.js\":\"eea1176b1a5771b1\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1922/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1922/assets/AccessHandlePoolVFS-CI36JC69.js\":\"04523e7f095c44a6\",\"/knowledge-medium/pr-preview/pr-1922/assets/IDBBatchAtomicVFS-1OEq1Ylr.js\":\"7de118bfa865846d\",\"/knowledge-medium/pr-preview/pr-1922/assets/MemoryVFS-Cb2EnF4J.js\":\"225178edc81cea41\",\"/knowledge-medium/pr-preview/pr-1922/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1922/assets/mc-wa-sqlite-DnKozMJ7.js\":\"fa5a67cc3e60cacf\",\"/knowledge-medium/pr-preview/pr-1922/assets/mc-wa-sqlite-async-D8enZdfZ.js\":\"0e851f674723428f\",\"/knowledge-medium/pr-preview/pr-1922/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1922/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1922/chunks/AccessHandlePoolVFS-DTEaX6VG.js\":\"537a50eb02ec2f9f\",\"/knowledge-medium/pr-preview/pr-1922/chunks/FacadeVFS-DSGCAb_x.js\":\"9d24cae6ab4fb934\",\"/knowledge-medium/pr-preview/pr-1922/chunks/IDBBatchAtomicVFS-BjafaXOW.js\":\"b6cb7918869b4ee6\",\"/knowledge-medium/pr-preview/pr-1922/chunks/MemoryVFS-Bhu3Eazo.js\":\"789129151bde3cae\",\"/knowledge-medium/pr-preview/pr-1922/chunks/OPFSCoopSyncVFS-CtIxtVQS.js\":\"9455b88f19bf7028\",\"/knowledge-medium/pr-preview/pr-1922/chunks/OPFSWriteAheadVFS-CtNjgP5f.js\":\"a66c81ab4711ecfd\",\"/knowledge-medium/pr-preview/pr-1922/chunks/Preview-MMXpon6I.js\":\"e13ba3092140bbc6\",\"/knowledge-medium/pr-preview/pr-1922/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1922/chunks/card-DWh6h7iu.js\":\"c28fb99654f7206f\",\"/knowledge-medium/pr-preview/pr-1922/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1922/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1922/chunks/dist-BR51qmcm.js\":\"f1b28c78079c7a24\",\"/knowledge-medium/pr-preview/pr-1922/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1922/chunks/freezeExtensionImports-jnxbH8wj.js\":\"9da3817129e1cbee\",\"/knowledge-medium/pr-preview/pr-1922/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1922/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1922/chunks/mc-wa-sqlite-D4tKAScG.js\":\"e1dcc53dca9b2107\",\"/knowledge-medium/pr-preview/pr-1922/chunks/mc-wa-sqlite-async-C3Fancm2.js\":\"e34f73633ddc86bf\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-CXuLVShr.js\":\"7a74a9381b9ae2d9\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-D-I-c17K.js\":\"048bc3f86734fbbc\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-D1XL9mZf.js\":\"20c77c7d16989557\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-D7Kyku7Y.js\":\"412b004ce1477ea3\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-DE4qBlHE.js\":\"14b2a8ae2272c660\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-DczjMWRK.js\":\"2afb5b485132bec4\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-DsdhFseX.js\":\"5565132697035d99\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-Dv47nk_o.js\":\"2d9eaef8c28a0831\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-dom-server-legacy.browser.production-Cj__2nZ6.js\":\"2cc51980c0f8eee8\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-dom-server.browser.production-DXeAroRB.js\":\"afd99f26c60d2d67\",\"/knowledge-medium/pr-preview/pr-1922/chunks/react-dom-server.edge.production-Djp1L0Sz.js\":\"ee81494948be1f81\",\"/knowledge-medium/pr-preview/pr-1922/chunks/server.browser-BpUusqbs.js\":\"6b19ba03b6b1f744\",\"/knowledge-medium/pr-preview/pr-1922/chunks/textarea-C4yUfMjw.js\":\"21c92671ff827640\",\"/knowledge-medium/pr-preview/pr-1922/chunks/ui-C0kZz9Iz.js\":\"bafa9496056cb476\",\"/knowledge-medium/pr-preview/pr-1922/chunks/wa-sqlite-WsaP4Dt7.js\":\"2a507519abef2206\",\"/knowledge-medium/pr-preview/pr-1922/chunks/wa-sqlite-async-BiS5-rLv.js\":\"e5b323321427b6b9\",\"/knowledge-medium/pr-preview/pr-1922/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1922/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1922/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1922/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1922/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1922/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1922/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1922/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1922/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1922/src/App.js\":\"ce238f0f6bf3c10b\",\"/knowledge-medium/pr-preview/pr-1922/src/appUpdate.js\":\"99749f05d354d3c2\",\"/knowledge-medium/pr-preview/pr-1922/src/appVersion.js\":\"65c470a9b40ee806\",\"/knowledge-medium/pr-preview/pr-1922/src/bootstrap/initialLayout.js\":\"5eb1c7c60e73e1ed\",\"/knowledge-medium/pr-preview/pr-1922/src/bootstrap/openWorkspaceData.js\":\"66411c02d16d6178\",\"/knowledge-medium/pr-preview/pr-1922/src/bootstrap/resolveWorkspace.js\":\"2211453e2d31d307\",\"/knowledge-medium/pr-preview/pr-1922/src/bootstrap/workspaceBootstrap.js\":\"490982ecd6fb8fd4\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockComponent.js\":\"2d53bb367fea2522\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockCrumbs.js\":\"39423e0086262f4d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockEditor.js\":\"19867a68a8370c28\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockLoadingPlaceholder.js\":\"2a45a37d5a89aaeb\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockProperties.js\":\"2bdd76575e629eac\",\"/knowledge-medium/pr-preview/pr-1922/src/components/BlockSearchPicker.js\":\"24ad546274081734\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ConfirmBulkDeleteDialog.js\":\"cff3d624af586eba\",\"/knowledge-medium/pr-preview/pr-1922/src/components/DividerHandle.js\":\"5d0486cbca02e2ff\",\"/knowledge-medium/pr-preview/pr-1922/src/components/DraftEditor.js\":\"1b97e32e0a2b178e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/GutterPill.js\":\"cb156b0414b8cc3f\",\"/knowledge-medium/pr-preview/pr-1922/src/components/Header.js\":\"2cd63615874ab82f\",\"/knowledge-medium/pr-preview/pr-1922/src/components/LazyBlockComponent.js\":\"b673b0b900fdf194\",\"/knowledge-medium/pr-preview/pr-1922/src/components/Login.js\":\"d190c69e8d19e4b0\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ZoomableSurface.js\":\"0ae42783ef740413\",\"/knowledge-medium/pr-preview/pr-1922/src/components/editModeKeepalive.js\":\"04408f628a00d0da\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyDisplay/PropertyDisplayScope.js\":\"b747236fe6c192d6\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"bd84c4fcc40906fb\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/RefPropertyEditor.js\":\"0dae2520faf28c5e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/RefTargetTypePicker.js\":\"9a98ec1ec9526b4b\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/SelectPropertyEditor.js\":\"b2f9844ba1353ce4\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/TypesPropertyEditor.js\":\"06db118bb2cfbbcc\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/defaults.js\":\"e03e5f0cb528f41a\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/kernelValuePresets.js\":\"c3cb91c71ab8bc35\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/selectablePresets.js\":\"09f3f4cfe0c25134\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyEditors/typesPropertyUi.js\":\"cb51b688211661ca\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/AddPropertyForm.js\":\"f6fec5e2785f92ff\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/PropertyPicker.js\":\"be5c475986ef28ae\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/PropertyRow.js\":\"da719e6e52b60048\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/Rows.js\":\"326553bcd538e041\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/actions.js\":\"c2a30545af505d01\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/declarationOnly.js\":\"8c472f768ea62233\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/layout.js\":\"adb22a05623bfeae\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/model.js\":\"6883636b1d4d1fd3\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/shapeUi.js\":\"acef8ee92252c9a8\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/shapes.js\":\"d84e501b08693257\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/usePropertyEditingActivation.js\":\"6f7fe8c081faee42\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanel/visibility.js\":\"ddaeaf1c88a01f64\",\"/knowledge-medium/pr-preview/pr-1922/src/components/propertyPanelSections.js\":\"51327937a6e6193c\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/BlockEmbed.js\":\"5af76eb2b437d923\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/BlockLink.js\":\"4ba9993247c62033\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/BlockRef.js\":\"e5f0d8b7d4126986\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/CompactReferenceLink.js\":\"96537d578cc5d203\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/ReferenceLink.js\":\"467965c51c0bb407\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/cycleGuard.js\":\"67900e0d0b71adec\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/cycleGuardContext.js\":\"33a96f569f018c6a\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/linkInteraction.js\":\"684e3788550b7570\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/referenceLayout.js\":\"110a4e6d4e1ff5e4\",\"/knowledge-medium/pr-preview/pr-1922/src/components/references/useBlockRefAncestors.js\":\"906ae379e76f67e5\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BlockGutter.js\":\"38e310815e51059d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BlockInfoDialog.js\":\"ceae0084783d538e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BlockReadText.js\":\"7b242f386055da5e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BlockTypeBlockRenderer.js\":\"0083db1ad8253a3a\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/BulletHoverCard.js\":\"b0a27b3b38ff8ac7\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/CodeMirrorContentRenderer.js\":\"f99681691a9fba94\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"9518f77fae72940d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/ColumnResizeHandles.js\":\"f87f98692ff2d0c2\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"250bdf8c6cd0e23b\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/DefaultBlockRenderer.js\":\"289844321dc9dc5a\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/LayoutRenderer.js\":\"e4d4531a641d5344\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/MarkdownContentRenderer.js\":\"ab85c6be4bd3ece4\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/MissingDataRenderer.js\":\"c7560c7e942c6111\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/PanelRenderer.js\":\"ff4775395f756952\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/PropertySchemaBlockRenderer.js\":\"289b05ca588cd7f7\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/TopLevelRenderer.js\":\"dea1a6518b95d818\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/blockGutterMode.js\":\"819fbcee7f67d247\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/blockTitleText.js\":\"681ad9a1f7aa7cae\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/fieldCreationKeydown.js\":\"0a109b08eb0df9f5\",\"/knowledge-medium/pr-preview/pr-1922/src/components/renderer/layoutRootContext.js\":\"a9c42a7099771fd5\",\"/knowledge-medium/pr-preview/pr-1922/src/components/typeChip/TypeChip.js\":\"298b3b902c7510d1\",\"/knowledge-medium/pr-preview/pr-1922/src/components/typeChip/chipStyle.js\":\"6f510c3ff421a0fe\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/anchored-floating.js\":\"56c3af8fb4a0aef7\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/button.js\":\"eb68ddf1fcb65d93\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/card.js\":\"d36d1cf1469cddc7\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/checkbox.js\":\"a2ab36adb58a4f7e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/collapsible.js\":\"34bb7e8441249801\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/command.js\":\"e1f32c3db693472c\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/context-menu.js\":\"64404b96fc1032f2\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/dialog.js\":\"0eaaeb5fee7873f6\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/dropdown-menu.js\":\"23f96504ce86cd74\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/floating-listbox.js\":\"e07923e83c43e8f1\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/index.js\":\"df402a9fcf2b0f94\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/input.js\":\"65c1994dc62072cd\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/kbd.js\":\"fef52f0788123d17\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/label.js\":\"d3f732b05585439d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/ui/textarea.js\":\"a3ab3a18b9ce58c2\",\"/knowledge-medium/pr-preview/pr-1922/src/components/useEditModeYieldKeepalive.js\":\"200fdcb9eba22a59\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/BootFallback.js\":\"87ce0c6d09dc013d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/FocusedRowLazyMount.js\":\"4cacc509d7beff2d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/LazyViewportMount.js\":\"0ade59b6bb98fbea\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/LocalDbCorruptionFallback.js\":\"2f37941ab3ac1585\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/error.js\":\"f8ea982fcef13f1a\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/lazyMountRegistry.js\":\"46746954ff8ca275\",\"/knowledge-medium/pr-preview/pr-1922/src/components/util/suspense.js\":\"8d470900b18d7dee\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/CreateWorkspaceDialog.js\":\"1cbaf563532f0402\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/PendingInvitations.js\":\"5481686ec4975e37\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/SyncProgress.js\":\"03da276f6bddad15\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/UnlockProgress.js\":\"49b6c8d090748c1d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/WorkspaceKeyGate.js\":\"41368f98e949cb83\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/WorkspaceSettingsDialog.js\":\"21eb6cf4d731bd5a\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/WorkspaceSwitcher.js\":\"2495015e6bd2d8f2\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/WorkspaceSyncGate.js\":\"95628407f7caae81\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/ConversionFlow.js\":\"2e3fa3321a1e410e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/ConversionFlowHost.js\":\"402ed6c5d74f7463\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/EncryptionSection.js\":\"91b0ccce2b49a77b\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/attachmentPrompts.js\":\"6d4b9b1b019bfba7\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/bundleFolderPrompts.js\":\"d28f9b76a5eae0c4\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/conversionFlowDeps.js\":\"c384d3ec93b05b65\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/conversionFlowStore.js\":\"7d4dab473ff30037\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/flowUi.js\":\"60b03b2a908d116c\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/conversion/useConversionRun.js\":\"3ac0e45d76ee510d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/keyUi.js\":\"8da2b788af287a0d\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/useCloseOnKeyLoss.js\":\"b19b9c029d764baa\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/useCloseOnServerE2ee.js\":\"d20c95e5d94c396e\",\"/knowledge-medium/pr-preview/pr-1922/src/components/workspace/workspaceUnlocked.js\":\"e772671c7d8b7785\",\"/knowledge-medium/pr-preview/pr-1922/src/context/backgroundSubtree.js\":\"c7fae61e113e8f05\",\"/knowledge-medium/pr-preview/pr-1922/src/context/block.js\":\"da161483de0bc2cb\",\"/knowledge-medium/pr-preview/pr-1922/src/context/layoutWsContext.js\":\"a32d9ee7ea33f9d3\",\"/knowledge-medium/pr-preview/pr-1922/src/context/propertyDisplay.js\":\"dde4ebf10b8c3218\",\"/knowledge-medium/pr-preview/pr-1922/src/context/repo.js\":\"4b937ad99ac0b4ca\",\"/knowledge-medium/pr-preview/pr-1922/src/data/aliasClaim.js\":\"f1c4afe2d4ce91b3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/aliasSeatNamespace.js\":\"e6264b648566c450\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/blockData.js\":\"a305e123c9da5aa2\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/blockType.js\":\"6fc20bb4b68588b6\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/changeScope.js\":\"2c5898968992218b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/codecs.js\":\"c3ecf513a633d167\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/derivedData.js\":\"d598d3f572f5d217\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/errors.js\":\"451a6db9b7e267e8\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/events.js\":\"088c0a99f3380dce\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/handle.js\":\"2f60ab9c0d622c15\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/index.js\":\"22836aa1b69c2b4f\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/mutator.js\":\"e79f8f29f5ad671e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/processor.js\":\"605f650a36821d70\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/propertySchema.js\":\"a7d22cb5f75a76c3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/query.js\":\"3ddfc8d6dece23cc\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/sameTxProcessor.js\":\"be67793090a9787c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/schema.js\":\"2f60ab9c0d622c15\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/tx.js\":\"2f60ab9c0d622c15\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/typedBlockQuery.js\":\"feeaa9fc880b012e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/user.js\":\"6e356576861d0f58\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/valuePresetCore.js\":\"f40be8fbdbc26957\",\"/knowledge-medium/pr-preview/pr-1922/src/data/api/valuePresets.js\":\"cc6a71905c95f779\",\"/knowledge-medium/pr-preview/pr-1922/src/data/attachmentCleanerIOVerb.js\":\"92a42bae64decd8e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/block.js\":\"f2873a1fe5dcfab1\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockCache.js\":\"64281310feb60c93\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockId.js\":\"d8ab51aac45ea5f1\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockLiveness.js\":\"c207be41a7573dc2\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockMerge.js\":\"7a175645ee069171\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockSchema.js\":\"542d77b253fc7c3b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockTypeLookup.js\":\"cb2b2ad9a9b35a16\",\"/knowledge-medium/pr-preview/pr-1922/src/data/blockTypes.js\":\"485d09118f69a556\",\"/knowledge-medium/pr-preview/pr-1922/src/data/childrenView.js\":\"de2e4a9b1fd233ac\",\"/knowledge-medium/pr-preview/pr-1922/src/data/clientContext.js\":\"f0ce4960f4b3b05d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/dbFileSiblings.js\":\"2fc38b31b2d008d4\",\"/knowledge-medium/pr-preview/pr-1922/src/data/definitionSeeds.js\":\"03b56662d7583593\",\"/knowledge-medium/pr-preview/pr-1922/src/data/derivedIds.js\":\"59d9c10f5012b0a0\",\"/knowledge-medium/pr-preview/pr-1922/src/data/drawnSubtree.js\":\"fc43513557951f34\",\"/knowledge-medium/pr-preview/pr-1922/src/data/facetBridge.js\":\"7e73f38b38937e59\",\"/knowledge-medium/pr-preview/pr-1922/src/data/facets.js\":\"ed5adff954c19c86\",\"/knowledge-medium/pr-preview/pr-1922/src/data/globalState.js\":\"7fc1994ec1cdb384\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/aliasClaimRederiveProcessor.js\":\"8ccc463f5a7c0e44\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/ancestorBatch.js\":\"19e87dd18e8e36ae\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/blockTypeTypeifyProcessor.js\":\"83db245637baab13\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/clientSchema.js\":\"18d7aca400534765\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/commitPipeline.js\":\"156108bbcf91aece\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/devAssertions.js\":\"60c1f21f2b1f3a65\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/firstSync.js\":\"266b7bac8e3ba617\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/freshInitialLoad.js\":\"be8de3ffa65241f9\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/graphBackfillClaim.js\":\"0f15577fc890141c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/handleStore.js\":\"c1516bf5f396f388\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/idleMarkerJobs.js\":\"bae4ad1de31cb695\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/initialDownload.js\":\"5f22200aa1c831ab\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/initializeClientDatabase.js\":\"4f57454c72673433\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/jsonCanonical.js\":\"1dc9f1ea92a03fb0\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/kernelInvalidation.js\":\"95034e1d62974bdc\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/kernelProcessors.js\":\"cbb376c4965cd3fb\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/kernelQueries.js\":\"b297d58d34febbae\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/mergeTypeMembershipProcessor.js\":\"48211fa8807ed2a7\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/normalizeReferencesProcessor.js\":\"d739422a4f794049\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/poolInstrumentation.js\":\"f6efbecf5eb66dae\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/processorRunner.js\":\"381e12d456422773\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyCellBackfill.js\":\"4a7d7e221adbbe5f\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyChildMint.js\":\"d4581c64acac90a2\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyChildrenProcessor.js\":\"94294e1e7a6beb38\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyDefinitionChangeProcessor.js\":\"9544cb4b951a3433\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyDefinitionSynthesis.js\":\"967cbd2921c4e6e1\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyKeyScan.js\":\"93daf0396c1a6e71\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertySchemaResolution.js\":\"1b90910c6ee7d274\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/propertyValueEdits.js\":\"2b58de10344ce551\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/raiseProtocol.js\":\"d4a128f592beb080\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/readBatch.js\":\"1caf5ab0e7e3a40b\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/refProjection.js\":\"9b2d0cc774c389ef\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/referenceTargetLookups.js\":\"55523cd205c44cb3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/referenceTargetProcessor.js\":\"cb6704a70bf414f4\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/replayMerge.js\":\"94213ed2df272dc6\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/sqlBinds.js\":\"b94d984117541c23\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"0dc23c6b4db8afcf\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/arrivalProcessors.js\":\"7ebede31495d1821\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/invalidate.js\":\"5d13dbb25d36fc19\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/materialize.js\":\"55427cb7fd694650\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/observer.js\":\"4feeef672a0556a9\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/syncObserver/reconcile.js\":\"f23a7b208bb8ac24\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/timingMetrics.js\":\"bb02bffb020dd0a8\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/treeQueries.js\":\"48b9b18c2f8d6527\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/txEngine.js\":\"fcf16a19aa052b0a\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/txSnapshots.js\":\"d70383721c75e0f0\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/typedBlockQuery.js\":\"0660e5a8410e3c2d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/internals/undoManager.js\":\"a7678124c68e2a60\",\"/knowledge-medium/pr-preview/pr-1922/src/data/invalidation.js\":\"f5ed5f003fe02691\",\"/knowledge-medium/pr-preview/pr-1922/src/data/kernelDataExtension.js\":\"0063aeeaa4983714\",\"/knowledge-medium/pr-preview/pr-1922/src/data/kernelPage.js\":\"ab9c1458f9fad5c7\",\"/knowledge-medium/pr-preview/pr-1922/src/data/kernelValuePresetCores.js\":\"789b453532f85069\",\"/knowledge-medium/pr-preview/pr-1922/src/data/localDbCorruptionSignal.js\":\"8fad21e165fa1de1\",\"/knowledge-medium/pr-preview/pr-1922/src/data/localDbStorage.js\":\"6e66f07414f47928\",\"/knowledge-medium/pr-preview/pr-1922/src/data/localDbVfs.js\":\"7cbbedfb38da49cd\",\"/knowledge-medium/pr-preview/pr-1922/src/data/localSchema.js\":\"245ed3cc7d44bc16\",\"/knowledge-medium/pr-preview/pr-1922/src/data/maintenance.js\":\"913c8b7f64a43abe\",\"/knowledge-medium/pr-preview/pr-1922/src/data/mergeProperties.js\":\"d9e1d9ed52a8b8d5\",\"/knowledge-medium/pr-preview/pr-1922/src/data/metricsConsoleHook.js\":\"0fe52a0db223ec9f\",\"/knowledge-medium/pr-preview/pr-1922/src/data/migrationsPage.js\":\"536296062b4d9ef8\",\"/knowledge-medium/pr-preview/pr-1922/src/data/mutators.js\":\"66e0128db0dd0f85\",\"/knowledge-medium/pr-preview/pr-1922/src/data/orderKey.js\":\"68f2253a62f29db4\",\"/knowledge-medium/pr-preview/pr-1922/src/data/orderKeyPlacement.js\":\"c27d10541f1d4a6c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/outlineSurface.js\":\"c6fa5e191930ae47\",\"/knowledge-medium/pr-preview/pr-1922/src/data/pendingEditorContent.js\":\"a9ed8c55827dbcee\",\"/knowledge-medium/pr-preview/pr-1922/src/data/pendingUploadsSql.js\":\"14019ed6f1628b31\",\"/knowledge-medium/pr-preview/pr-1922/src/data/pluginStateExtensions.js\":\"96166bfdb6cf9a4c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/powerSyncLogger.js\":\"65ba3fe640b19c04\",\"/knowledge-medium/pr-preview/pr-1922/src/data/projectorRuntime.js\":\"e478d2cff3e21ae2\",\"/knowledge-medium/pr-preview/pr-1922/src/data/properties.js\":\"1726cf42d502a372\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertiesPage.js\":\"12a71d1d743faf3d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyChildren.js\":\"1e2517c0dd1a4cfd\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyDefinitionFanout.js\":\"50e43189c435c782\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyDefinitionMetadata.js\":\"7056cd5dd849846d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyDefinitionRegistry.js\":\"f63195e16203ef00\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyDisplayMode.js\":\"2bc6b6bc5ddcbad3\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertyRowCreation.js\":\"ffd3e1546a6f7aa8\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertySchemaCreation.js\":\"741036856b4529be\",\"/knowledge-medium/pr-preview/pr-1922/src/data/propertySeeds.js\":\"2d5c6b931e1ef75e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/recentsPage.js\":\"6dfb0e179bdcee34\",\"/knowledge-medium/pr-preview/pr-1922/src/data/refTargetComparableProperty.js\":\"347e545ee9bd9e8c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/referenceBlock.js\":\"12b1e9a2f598f2bf\",\"/knowledge-medium/pr-preview/pr-1922/src/data/rejectedUploads.js\":\"99e6cb088b49a00f\",\"/knowledge-medium/pr-preview/pr-1922/src/data/releasePowerSyncConnection.js\":\"1bb896469f748334\",\"/knowledge-medium/pr-preview/pr-1922/src/data/repo.js\":\"7ad425d4b22724a5\",\"/knowledge-medium/pr-preview/pr-1922/src/data/repoProvider.js\":\"22f0be65f742bcb9\",\"/knowledge-medium/pr-preview/pr-1922/src/data/rowProperty.js\":\"c6cd4a591027c2d5\",\"/knowledge-medium/pr-preview/pr-1922/src/data/searchFilter.js\":\"3837e56165af81b8\",\"/knowledge-medium/pr-preview/pr-1922/src/data/seedIdentityLedger.js\":\"3e0c224bfc3070f6\",\"/knowledge-medium/pr-preview/pr-1922/src/data/stateBlocks.js\":\"8b2f7e89d2814dfb\",\"/knowledge-medium/pr-preview/pr-1922/src/data/structuralEditPolicy.js\":\"20d2cd23df169357\",\"/knowledge-medium/pr-preview/pr-1922/src/data/structuralInsert.js\":\"85f8eacbe92ffe69\",\"/knowledge-medium/pr-preview/pr-1922/src/data/subtreeDelete.js\":\"4855af2612d1290e\",\"/knowledge-medium/pr-preview/pr-1922/src/data/syncStreamLock.js\":\"1b75da718866563f\",\"/knowledge-medium/pr-preview/pr-1922/src/data/syncedTableSqlRecognizer.js\":\"1d1948af40d66537\",\"/knowledge-medium/pr-preview/pr-1922/src/data/syncedTableWriteGuard.js\":\"429f008387fc6e3c\",\"/knowledge-medium/pr-preview/pr-1922/src/data/targets.js\":\"751529e8f13232ea\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeColors.js\":\"94287474e24a1c83\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeDefinitionMetadata.js\":\"1a81855e1f0cabe8\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeDefinitionRegistry.js\":\"8449915c4981294d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeExtraction.js\":\"9ff360d3cebfb8ea\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeInitialValues.js\":\"bdc511971e042033\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typePropertyGroups.js\":\"0ba0ab731f23a68f\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeSeeds.js\":\"6834c9088c3ea5b0\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typeTagger.js\":\"cbc008e5744b665a\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typedRecords.js\":\"ce6ee55cb2460416\",\"/knowledge-medium/pr-preview/pr-1922/src/data/typesPage.js\":\"b0868ac3e6e5bc57\",\"/knowledge-medium/pr-preview/pr-1922/src/data/userPrefs.js\":\"9534ce2c8f540664\",\"/knowledge-medium/pr-preview/pr-1922/src/data/userSchemasService.js\":\"57085215fdc1ffe8\",\"/knowledge-medium/pr-preview/pr-1922/src/data/userTypesService.js\":\"e276502020d43734\",\"/knowledge-medium/pr-preview/pr-1922/src/data/valuePresetRegistry.js\":\"d6b3ccdb3ff6168d\",\"/knowledge-medium/pr-preview/pr-1922/src/data/visibleChildren.js\":\"9b66aa2fe91a68fb\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaceConversion.js\":\"2eac53616da38cca\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaceFirstSync.js\":\"e188f20beb09ddec\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaceIdNamespace.js\":\"492b013c2d9ebaee\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaceSchema.js\":\"b329469bc8ed1fb0\",\"/knowledge-medium/pr-preview/pr-1922/src/data/workspaces.js\":\"601a90bf68ee96ec\",\"/knowledge-medium/pr-preview/pr-1922/src/data/writeAheadLog.js\":\"0e10c1a48db5defc\",\"/knowledge-medium/pr-preview/pr-1922/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/BlockPasteShellDecorator.js\":\"758ffdc50fb88457\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/atTrigger.js\":\"f1f2f6ae4adea0da\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/autocomplete.js\":\"aa574248c11f0f65\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/codeMirrorExtensions.js\":\"2ccf23578f36ab4b\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/contentFlush.js\":\"a857793e97c73014\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/defaultInteractions.js\":\"25beb22cf4a7e815\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/editSettleSignal.js\":\"7d1812998576b087\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/insertImage.js\":\"43c85274ae4e4097\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/referenceCompletionRange.js\":\"61c3b2ec17920755\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/referenceTargetTypes.js\":\"e516c5a5183d77d4\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/syntaxContext.js\":\"d8d2c2f37036f5e1\",\"/knowledge-medium/pr-preview/pr-1922/src/editor/triggerMatch.js\":\"0aae19b7dec103d1\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/AppRuntimeProvider.js\":\"20462bac5b0b0b3a\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/BlockFocusShellDecorator.js\":\"f0d9c3dbebca4caa\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/ExtensionRenderBoundary.js\":\"2ea1844096313d56\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/PanelContentRecovery.js\":\"94c1605d66e9874d\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/apiCatalog.js\":\"b2f09e957ad2f096\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/appRuntimeController.js\":\"99b7146aa0f3a7f2\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/approveExtensionHere.js\":\"cd04f81f0c29b0f8\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/armedCutAppMount.js\":\"d6b6330cf6f1789e\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/batchableKeyedStore.js\":\"a82fa7bb08286a44\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/blockInteraction.js\":\"d632437ececa4ca3\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/blockSelectionAction.js\":\"e13772aeb339d887\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/buildApprovalRecord.js\":\"cae269874fab50c6\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/compileExtensionModule.js\":\"0f0c3abf6752ff29\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/compiledModuleCache.js\":\"6f059f4c80546e95\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/continuousGestures.js\":\"8e44ed95d64f8233\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/core.js\":\"4df5d3cdf3dd419d\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/defaultRenderers.js\":\"1a6ab620e2166871\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/definitionFanoutAppMount.js\":\"059f6163d4513a8b\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/dialogAppMount.js\":\"f9ffb7cf18735204\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/dynamicExtensionSeeds.js\":\"06d82882e35d0bc4\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/dynamicExtensions.js\":\"2bfaec776ba41454\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/exampleExtensions.js\":\"518c6174defec8d6\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionApprovalStatus.js\":\"b0e7fddfeaeb19b1\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionImportPolicy.js\":\"86d98fbc367a3686\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionLoadErrorToast.js\":\"6156ed6a43b71791\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionLoadErrors.js\":\"004ed4850bd01149\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionLookup.js\":\"a3a828d50a1bccc2\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionToggles.js\":\"9fccc10b5f61fbae\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/extensionUtilitiesCss.js\":\"0e8dfc0554d63bf3\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/kernelPageDeletionGuard.js\":\"1d1c767a7392d713\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/liveRuntime.js\":\"76a0f0a2bceb928e\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/normalizeExtensionSource.js\":\"6c72ff5787e6897e\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/openExtensionsSettings.js\":\"431e18e7c95e581f\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/overridesCache.js\":\"54dea8eb6032a0f2\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/pluginIds.js\":\"6a4dc5f62786e610\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/processorRejectionToast.js\":\"bbe8e7abd6321329\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/runtimeActions.js\":\"b423941d3048fd76\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/runtimeContext.js\":\"4cbb5a21c54c95ee\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/staticAppExtensions.js\":\"1f5fe6f60768266a\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/staticDataExtensions.js\":\"327e1e574d4e8021\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/toastAppMount.js\":\"939fadfd01d2d7e1\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/transpileExtension.js\":\"08118051cdd8d27d\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/useOverrides.js\":\"b82c530b77efe385\",\"/knowledge-medium/pr-preview/pr-1922/src/extensions/useShortcutSurfaceActivations.js\":\"39bf3b0d12e6fff3\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/discoverToggleTree.js\":\"7a3ad5926ac3c8d9\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/facet.js\":\"b21f2ea159c2375f\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/resolveAppRuntime.js\":\"4f4b7c481fac136e\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/runtimeEvents.js\":\"985b7e89239a0f23\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/togglable.js\":\"7b560d4144e262fb\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/variantFacet.js\":\"d10edcfc557e64d8\",\"/knowledge-medium/pr-preview/pr-1922/src/facets/verbFacet.js\":\"1e29ffffcee4fdc9\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/block.js\":\"9a5c1251bdea2ed1\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/focusedChild.js\":\"c17db2f6d9671a1c\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/propertySchemas.js\":\"8f434020c50d569d\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/typeRegistry.js\":\"43d55c45b3edad30\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useAncestorCrumbs.js\":\"1f629656c683de41\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useAutocompleteListbox.js\":\"1d41a68564fbfb6d\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useDebouncedSearch.js\":\"a8242229e76035bb\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useDebouncedValue.js\":\"377fa2c304e8fe14\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useFacetValue.js\":\"7c68076f27b23d9e\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useIsFocalRender.js\":\"a375a09e46f50cd4\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useIsReadOnly.js\":\"d8b84f9950e90dd5\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useMaterializeBacklog.js\":\"22258fe452f13233\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useMinuteClock.js\":\"d1fd2da2de6bb0ed\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/usePanelLayoutProjection.js\":\"0f8dda37c4717d1f\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/usePendingInvitations.js\":\"ffb9e784fc7e42fd\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useRendererRegistry.js\":\"edebd65532496aa2\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useRetainedFieldRows.js\":\"89aae4464334743c\",\"/knowledge-medium/pr-preview/pr-1922/src/hooks/useWorkspaces.js\":\"b0b4f53684c05271\",\"/knowledge-medium/pr-preview/pr-1922/src/lib/utils.js\":\"7ab7317ab592d867\",\"/knowledge-medium/pr-preview/pr-1922/src/main.js\":\"6f69e8ad31e39b1b\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/MarkdownImage.js\":\"118aa9ff8022521b\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/blockSeparators.js\":\"5f3f201746fdeca4\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/context.js\":\"984aa4bb9cf8dd06\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/defaultMarkdownExtension.js\":\"1f5989dcedc90116\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/extensions.js\":\"2eb4ae4a1b50598a\",\"/knowledge-medium/pr-preview/pr-1922/src/markdown/renderMarkdownHtml.js\":\"05c5e8eb5b2ec509\",\"/knowledge-medium/pr-preview/pr-1922/src/minimal-editor.js\":\"d385f2b2c35fb78f\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/armedCut.js\":\"ab74aa54a1cf4723\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/captureMediaVerb.js\":\"93e91a8c7d973528\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/clipboard.js\":\"34fd1992684bf186\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/decision.js\":\"2a9d6bf05b1d92b0\",\"/knowledge-medium/pr-preview/pr-1922/src/paste/operations.js\":\"45aa0f15f340a281\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/account-header/AccountHeaderItem.js\":\"21dd9b0e2452d315\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/account-header/index.js\":\"e4ae8f01d08beaaf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"996d2f0e5cdad3e2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/askAgent.js\":\"145692b69551563a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/askedStore.js\":\"4b9b38381dbc6ca6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"a9b7c611de4c8045\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/chipState.js\":\"4b8253f748dfba6e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4eea874aedfcbd6c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/index.js\":\"cbc2bb44ead29431\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"379726d4c498d0a9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-dispatch-companion/schema.js\":\"dabcba97d45fe66f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/AgentTokensDialog.js\":\"2be9ae68739892b8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/BridgePairingDialog.js\":\"6add456c06c61c06\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/addMedia.js\":\"0ac1372db27e5c4e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/backlinks.js\":\"41e84fd475955ef5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/block.js\":\"bb743eda65dcb717\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/context.js\":\"e58931cb6cdd1143\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/displayIds.js\":\"e7b075b114e64b0d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/index.js\":\"37dca1964116c08c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/outline.js\":\"52809822e29fcb63\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/properties.js\":\"c900f20bc8c25417\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/refs.js\":\"66a86e694be103ca\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"ab60f035d232f5fa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/search.js\":\"4e6b07bd28fbb565\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/shared.js\":\"98979d9d5c604dcd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"820af2d8d619158c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentViews/text.js\":\"42d985854483ade3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/agentWrites.js\":\"8519bb28706056bf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/authoringCatalog.js\":\"1d57d512f696ad37\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/blockRefTargets.js\":\"ee8c892534e6059a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/bridge.js\":\"487c4021ae6189d5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/bridgeLoop.js\":\"afa7dc06871d5570\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/changeHistory.js\":\"65124560374b53ef\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/commands.js\":\"bb7fc284bde8f0d9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/commentsCommands.js\":\"c3774d1ae67dfecf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/dataExtension.js\":\"af98fdce36e63e5e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/dataModelGuide.js\":\"4ad3a723e8a821c2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/dayPropertyInputs.js\":\"47bb72cbbf656d3b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/describeRuntime.js\":\"a661213c9a4625cc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/extensionLint.js\":\"42f4330f62375106\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/grainAudit.js\":\"3a85f730d9094516\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/healthCommand.js\":\"6f6394356b7da666\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/index.js\":\"3a86d1033508cab8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/presetIdentity.js\":\"7b55a8ea1662c8fc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"a06bb8c40e5c4b8f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/readMedia.js\":\"3bea27fdb676e4d2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/schema.js\":\"b03e52f9b24a4bec\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/serialization.js\":\"27d7ef9bb6ae8823\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/targets.js\":\"39f40bc6ee145853\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/tokens.js\":\"440f1bfab837a7bd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/watchEvents.js\":\"3dd3a433f7a48fc8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/workspaceGuard.js\":\"4f51e8646e2b02be\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/agent-runtime/writeCommands.js\":\"89388174c58caf8a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/AliasCollisionToast.js\":\"a745dc1a994ad8c5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/DuplicateNameBanner.js\":\"827dd18200c601af\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/collisionMerge.js\":\"61d137f3327fb146\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/dataExtension.js\":\"8c3151f6dcdcf4b1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/index.js\":\"11b7abbc25a51c0b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/mergeCollisionAction.js\":\"b148a944271b4546\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/pageStyling.js\":\"df4df5c90746efc1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/rejectionToast.js\":\"c40ef8f6fcaa6f7c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/alias/syncProcessor.js\":\"7479510bc60f9dda\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/actions.js\":\"aa02c7cb218695ec\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/addComment.js\":\"1495a2dde3923cf3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/anchor.js\":\"81122b6112d120b9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/anchorState.js\":\"b679f312c6a9eaa3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/commentLinks.js\":\"f684ad035ab1404a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/confirmThreadDeletion.js\":\"afd42274de343852\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/container.js\":\"bae76158238cd626\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/dataExtension.js\":\"c4f2a36addcc7f1d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/deleteComment.js\":\"041cb12928530cce\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/highlights.js\":\"499ad31e5f01224b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/index.js\":\"55d3c1ae30a26474\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/linkedCommentsPill.js\":\"5d263c0ff1a0dd92\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/margin.js\":\"82dd8e7ce03e2027\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/marginAnchorLinks.js\":\"ad12e54fca4ff7cc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/marginSchema.js\":\"429ab512bdfffca7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/newComment.js\":\"7ab1c68977df7bab\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/ownThreadPicker.js\":\"83751d52f54a295f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/placement.js\":\"199e72d625496d9b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/queries.js\":\"a812c9ffb8ed2a1f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/quotePosition.js\":\"2e413904c44ed41a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/quotedIn.js\":\"2c29ee69aab8d0dd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/quotedRange.js\":\"53572ed461a489b2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/rangeRefs.js\":\"94e28f6b02358d7f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/readHighlights.js\":\"18107da117a7bbf3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/readSelection.js\":\"25f29f2d73f4fd25\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/readSelectionUi.js\":\"d4e63256b947ef6f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/reanchor.js\":\"5ae73d42bfe6da99\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/schema.js\":\"971eb533c59a1d09\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/scope.js\":\"80311e36a54719bf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/scopeThreads.js\":\"e0267baeb66c4cc8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/splitRetarget.js\":\"610766110018a3b9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/suggestionCard.js\":\"76c0df59c9d57e74\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/suggestions.js\":\"6acd8134d84219ac\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/summaries.js\":\"8ea56b767962000a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/summaryBatch.js\":\"3f506b7b2c35b39b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/surface.js\":\"319539edd7dfb9b4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/threadNavigation.js\":\"d22f4e3a71db1466\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/threads.js\":\"ed5d830efdf11a93\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/ui.js\":\"12a4b2e0b3eadd3a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/annotations/uiStore.js\":\"ce69940d13879740\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/app-intents/appIntents.js\":\"1bda53e5defd43d9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/app-intents/index.js\":\"dee893186de9bf54\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/app-update-prompt/index.js\":\"235c0ffcb39c9aa9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/app-update-prompt/status.js\":\"88c132d15d11cc1a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"f927e48bf336a1e5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/MediaBlockRenderer.js\":\"c78119e059837f4c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/MediaDownLaneReplicator.js\":\"5a7950e55bf786ca\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/MediaUploadReconciler.js\":\"022358fd7916482d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/assetDownLane.js\":\"85c8e9da5d66c722\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/assetResolver.js\":\"c2321b7c2ecebe90\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/assetUpload.js\":\"7096c1701d972e84\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/attachmentCleanerIO.js\":\"8f63c708e5141cea\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/supabaseAuditIO.js\":\"4a9bb17f154f59f8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/blobStore.js\":\"f7a02f291a262b3b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/browserMedia.js\":\"739ef5b5179ad805\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/byteStore.js\":\"ffddd17ec88a79f0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/cleanerIO.js\":\"680c746d18e74773\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/cleanupAttachments.js\":\"4d4a54c827a1e701\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/dataExtension.js\":\"d59420176890b9e4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/downLane.js\":\"ccba28c672d5f5dd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/index.js\":\"7d5a363f4b32d33d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/insertImageContribution.js\":\"8f89a8823951819c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/laneArming.js\":\"d9ddf14005f6ac0f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/laneLock.js\":\"03b6192834099c95\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaBlock.js\":\"356bdaed4763afb4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaCapture.js\":\"5034577dc108aa2a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaLanes.js\":\"4f851110fb7a9317\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaViewers.js\":\"e28a5f8f31d9fc16\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/mediaViewersFacet.js\":\"bf07ef1ec38249cc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/pasteCapture.js\":\"729671766c73d4d6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/resolver.js\":\"6bb128315129f5ee\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/retryUploadsAction.js\":\"c96fb2ffdc547f4d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/storagePaths.js\":\"52e2c2cf7037dd04\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadDrain.js\":\"d98985dad5dcaa3a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadLaneStatus.js\":\"2854da3d0ca85b55\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadReconcile.js\":\"aeedefbca991c3d7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadRecovery.js\":\"b8295dbe989f88a3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/uploadStore.js\":\"06f06d454ce10c5f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/attachments/useAssetObjectUrl.js\":\"8f1ae503fe596a38\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"8a69110c0b32bde6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/BacklinksViewSection.js\":\"a5810084405812de\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/facet.js\":\"809d942a7f127238\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/index.js\":\"89ee28455beaea96\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks-view/prop.js\":\"da5c85f5738f8e86\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/BacklinkFilters.js\":\"cab501c6ba7df54a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"dca3fb995386b428\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/BlockEntry.js\":\"bc12859ebdac6493\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/LinkedReferences.js\":\"4e61b0f805f08db2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"66e57499b06a2553\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/dailyNoteDefaults.js\":\"42687e8a9aef466c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/dataExtension.js\":\"c27159a813ce6aa2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/edgeExclusions.js\":\"871d0d4ff939e31e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/filterProperty.js\":\"08a1694bc3264351\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/index.js\":\"5046781fe9452ffa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"816467cf4596a978\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/applies.js\":\"95233d6551a56b16\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/countQuery.js\":\"794645ad64f8d754\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/expansionStore.js\":\"7b7c898fab26a55a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/index.js\":\"11907d3a8f564820\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"5e114bc60a7e3768\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/presentationInvalidation.js\":\"441eef308219778e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/propertyEditorOverride.js\":\"c6f1758240f0871d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/propertyFilter.js\":\"e5f498b9b98c0ca2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/query.js\":\"4f451e4b1ce2325d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/resolveFilter.js\":\"bb37c339bcb32554\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/sourceBatch.js\":\"082783346ed6e1ea\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/sources.js\":\"8c541018a3a1afb6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/useBacklinks.js\":\"23a3eb2d5513917e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"b4873ff61e5755f9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/BirthdayCelebration.js\":\"33a243501d84eefa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/BirthdayOverlay.js\":\"adae2561b0a39647\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/gate.js\":\"4e4d4fb457b5ba01\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/index.js\":\"6b5f588fb5ecff98\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/birthday/wolfTheme.js\":\"693cb6e985c00dbc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/BlockDragLayer.js\":\"52030a876e6357a5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/dragController.js\":\"6d01bda5f6157f37\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/dropTarget.js\":\"66d983013d8e15bd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/index.js\":\"fb342646435122a6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-drag/projection.js\":\"0470c9c3d1069326\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-info/BlockMetaCard.js\":\"91e6ae1fecf15cb6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-info/index.js\":\"065e87c583d95822\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/AddTagDialog.js\":\"d0d79efc593ec6b4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"4037dc8614cb2d07\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/TagNameIssueHint.js\":\"19ce8691360387a1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/addTagAction.js\":\"4a149b3d79163b1f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/appendTag.js\":\"4a886929cec78118\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/config.js\":\"9d94a37c5485b436\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/dataExtension.js\":\"cfe7576a07ec7c29\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/index.js\":\"876746aa2943534e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/block-tagging/propertyEditorOverride.js\":\"9f9dac174ab7cef9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/BreadcrumbList.js\":\"83a1c8ddd3a409be\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"5ef33e9da2057835\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/Breadcrumbs.js\":\"8a56d068d46a9223\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"034204e6a1f6e6fb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"1c91485dd94af93b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/index.js\":\"39ba83e10440509b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"bb1433402ecd4c82\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/CharacterCountItem.js\":\"a2afcb9fe7c36809\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/ProfilePropertyEditor.js\":\"3b1e5c156084bc0d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/actions.js\":\"b7f0d754ab97885d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/blockType.js\":\"a40d96616629bcdc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/charCount.js\":\"6e9ea903778584a0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/dataExtension.js\":\"2fe4c70fdb9c3899\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/index.js\":\"94cbad476ebee320\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/profiles.js\":\"4212f780bf907c4f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/properties.js\":\"9ad326d9b5196c94\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/subtree.js\":\"83be6e8f7ea2bcbf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/character-counter/textCounts.js\":\"a73d6a5cb285b547\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/colemak-keybindings/index.js\":\"223f143dda3301c8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/CommandPalette.js\":\"1c6dd9130fcef8d1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/HeaderItem.js\":\"4aeffad10ea5208d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/context.js\":\"067cf5dba1cec035\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/index.js\":\"bc0625a424ad7a37\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/selection.js\":\"376392a288ad1082\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/toggleStore.js\":\"8e07cd920a10675f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/command-palette/useCommandPaletteActions.js\":\"be4dbd9e25fa9ec4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/ContributorBadges.js\":\"bba5b87603d92bcb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/ProfilePicture.js\":\"0d92ecf575871368\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/author.js\":\"d4185ed522fe9413\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/codeMirrorExtensions.js\":\"70bdf645481580e3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/dataExtension.js\":\"0c944014fdab355e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/index.js\":\"5dd066b783ce7404\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/mentionAutocomplete.js\":\"73dfb58d3d7e9e2e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/processor.js\":\"36a3f30992301f37\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/profiles.js\":\"06108062616669c7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/queries.js\":\"cb089163aff93449\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/schema.js\":\"7aeefae136531d54\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/contributors/useCommentAuthor.js\":\"f79069e4a7aebdb9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"00f6430575586ca7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/followOrigin.js\":\"da3f183873af4126\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/index.js\":\"cc9428b38644384e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"b5d4e22b64f1b8f5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"d71dabd3ebdc237f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/CalendarGrid.js\":\"f3d0069d7f1b9acc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DailyNotePicker.js\":\"7b801dd4df5e4a8e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"8bc9191d2d22eeb1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DateNavDecorator.js\":\"66b98584eb571018\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DateScrubOverlay.js\":\"d63e46af5885ed09\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DayPropertyControl.js\":\"151a9ad21ae5f2f7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/DayValueReferenceControl.js\":\"ffc6c38c5c6f205f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/HeaderItem.js\":\"b94c4b6d24a4c9bc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/ReschedulePicker.js\":\"6aa22139fc0091ef\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/SpreadDatesDialog.js\":\"63dce91786c7c068\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/actions.js\":\"b4756e8529c508a3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/blockDateAdapter.js\":\"65a0c0b588df20ad\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/calendar.js\":\"33d13f4cd66f9e3b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dailyNotes.js\":\"f168ca0ab09f81a0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dataExtension.js\":\"48e1551ebe163282\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dateScrubActions.js\":\"883e43e1a2b1bd18\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dateScrubGesture.js\":\"4ef3b5b10425bb7c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dateScrubGestureActions.js\":\"c096523bd4495d12\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dateScrubRecognizer.js\":\"ce56993e8f6bbaae\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dayProperty.js\":\"9ababca5110d7df0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"7a5d1d9c72b18c2c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/deletionGuard.js\":\"15a6da45ba5cbe26\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/dueQuery.js\":\"556e4a3f3e001982\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/index.js\":\"6494464f21e4eda5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/landing.js\":\"e72df165f9798f2c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/localSchema.js\":\"a5435f26e3d600a8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/referenceDateAdapter.js\":\"301ee780f7b6b652\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/rescheduleAction.js\":\"65ba7899ea30a83f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/schema.js\":\"a76804ae864656e2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/spreadBlockDates.js\":\"f65e09dc30debf9e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/spreadDatesAction.js\":\"8ae8b877ff1b9bca\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/today.js\":\"4ecb76ff49399361\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"5e41da1aa7ea3d11\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"8fc11187dbce9d9d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/audit.js\":\"72a2ce14b8255468\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/auditAction.js\":\"61f43dcb5f754ba2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/auditRanges.js\":\"e8e5c4036471ecc3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/diagnosticsSource.js\":\"ed3d8f3db18f3278\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/divergenceScan.js\":\"b8d36237c3afe2c2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/index.js\":\"58c205d7d1a67ac2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/propertyChildrenChecks.js\":\"4e91ebf96664868d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/referencesMirror.js\":\"c0ab72a81d78a55e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/rowJson.js\":\"75a8601722156050\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/schedule.js\":\"ece480890846d8de\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/data-integrity/store.js\":\"20e12aba9a4f8009\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-maintenance/action.js\":\"3626a421216aa7b0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-maintenance/index.js\":\"1800dce163f69ef0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-maintenance/plugin.js\":\"b484c3b7092d561d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"4bbcebe21e4d4015\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/actions.js\":\"7b9789af1dd4c19c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/changeMarker.js\":\"71723616fb389708\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/diagnostics.js\":\"b6f6f7284825c340\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/fileSystemAccess.js\":\"59babb97f82ef4cd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/filenames.js\":\"87ad8abcc1210cf5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/index.js\":\"384c80d55099b5f7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/mirror.js\":\"03c2d8a267baf640\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/runLock.js\":\"e5a2a962ad30478a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/runtimeHealth.js\":\"66fe7cea1eae11c7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/schedule.js\":\"5f50fb85c43957e0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/db-mirror/store.js\":\"1dbf98a58a21a7f7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/default-themes/index.js\":\"b6e290fe1d668aa9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/default-themes/themes.js\":\"9b8b0b63b7e786eb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/diagnostics/facet.js\":\"6d3827c250828c7c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/diagnostics/useDiagnostics.js\":\"6bc96c9ad094e67b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extension-prompts/dismissals.js\":\"8658dfa7ce0d0d7f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extension-prompts/index.js\":\"77415ccffb538e2f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extension-prompts/status.js\":\"d0178f825dc32d6d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extension-prompts/store.js\":\"552539c5c1596548\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"b439e5a728c07473\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/ExtensionsSettings.js\":\"450f14003df29782\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/actions.js\":\"71e1a4d1714df189\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/config.js\":\"db0626db658af4e9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/dataExtension.js\":\"d5f0da32e2e2deb6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/effect.js\":\"2d64a6a6e103d689\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/index.js\":\"b50c68bdb2dd94e7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/propertyEditorOverride.js\":\"11bf2cb8d47238e5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extensions-settings/useToggleTree.js\":\"f7b9696c5d370a79\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/ExtractTypeDialog.js\":\"8546fb8050c62850\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"fb56220832abbaf0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/PropertyShapePicker.js\":\"1d1f524eed2060e7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/action.js\":\"f1d26651a6a1033b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/extract-type/index.js\":\"0b7414a623b7bbb8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/FindReplaceDialog.js\":\"07e8d6487d353ff2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/HeaderItem.js\":\"44e68c8e726ca654\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/dataExtension.js\":\"7a3b79e566748b04\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/index.js\":\"004ded56d4cd7d0a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/search.js\":\"be0cf264d28169b8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/toggleStore.js\":\"b7f1c90400d1e4c1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/LocationPropertyEditor.js\":\"453ac4af8e7d158d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/MapView.js\":\"431981dafc663703\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/blockTypes.js\":\"35a3a45a31c18251\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/codeMirrorExtensions.js\":\"5976651d8938cb7b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/createOrFindPlace.js\":\"fc6e4e9a65c3e11e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/currentLocation.js\":\"7f2857ff550e5b6f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/dataExtension.js\":\"1fc952f4a1def1cb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/geoContentDecorator.js\":\"a168c7e566798437\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/googlePlacesClient.js\":\"7013ffd6d889ceb2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/index.js\":\"e7f3c08e6c69c504\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/locationsPage.js\":\"ac5825fc75536713\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/mapViewport.js\":\"568a6dca2935b99c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/pickCurrentLocation.js\":\"e5e777fbd3bc6387\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/placeAutocomplete.js\":\"3e0892bb5c461a51\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/placeNameCollision.js\":\"6c711dc6642ff608\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/properties.js\":\"4983a8b45d956f4a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/propertyEditorOverrides.js\":\"fcd7f37d6ba6a903\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/query.js\":\"59c69342e97683a6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/geo/usePlaceSearch.js\":\"869495e3c55f9f81\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"51711801ce22be2c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"cfbe65b52f8d6cce\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"1725d26b9eaffde4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/config.js\":\"a6b3435242dd1543\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/dataExtension.js\":\"ab4e82f6c0fb2d6a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/facet.js\":\"2f753a10770c7c47\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/grouping.js\":\"c54689adc7e974b1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/index.js\":\"4c8362c844ffc2d8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"e891084365358d4e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/query.js\":\"ed9af5123fb47b35\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/resolveConfig.js\":\"ec7096c17c53a13c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"59b9aff988242bd9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"8007013a93fefe0c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/HtmlDocumentContent.js\":\"9a33fac081e9f969\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/HtmlFrame.js\":\"2d07ca0caa203665\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/actions.js\":\"4980f232128295fd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/blockType.js\":\"8640e250ad18efe5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/confirmRunScripts.js\":\"36c67cbfe757befe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/dataExtension.js\":\"1148b976adecd896\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/frameAnnotations.js\":\"6f281c248b2e4535\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/frameDocument.js\":\"46e748320007baea\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/frameTheme.js\":\"adeb1df900e70180\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/index.js\":\"6385dfdf495ae639\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/scriptConsent.js\":\"4fcdd4b31a78e244\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/sourceMap.js\":\"f906deaa02ed87dd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/html-document/useDocumentScripts.js\":\"04a97f17539a050e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/index.js\":\"c39911c85cce799a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/record.js\":\"f15cc92c4c8d69a3\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/recordStore.js\":\"ac8cb10434297eea\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/responsiveness.js\":\"067605d7f14e8d30\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/schedule.js\":\"0a0472589b7bd14a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/interaction-metrics/sessionContext.js\":\"98b1ed41e4680e70\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"b6aa45a3a7449479\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"65773adf793089dd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/actions.js\":\"efa07e16c0d47b7b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/config.js\":\"d5bfeec9111bb111\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/dataExtension.js\":\"557b847c4e06696d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/effect.js\":\"51cdda48b5faaa97\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/index.js\":\"5efa5ef221a3115c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/keyCapture.js\":\"c66c947ce796b03a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/overrideStore.js\":\"4fe03d1edf9685db\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"8144a56a42280093\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/HeaderItem.js\":\"bb32de10a39ffc14\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/LeftSidebar.js\":\"c938d57c3b5f5074\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/actions.js\":\"c9c2ba3a0f2c35e1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/facet.js\":\"cd9b11f3eac5115d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/index.js\":\"3a74bedf0b54ccbe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/shortcuts.js\":\"6f7de79c6a79d05f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/left-sidebar/toggleStore.js\":\"33a3cf8d93176df1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/merge-blocks/MergePicker.js\":\"05bf697b4801dbb4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/merge-blocks/index.js\":\"e29c9df0fc1058fe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/merge-blocks/mergeAction.js\":\"710eddd8d95e25e6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/merge-blocks/strategy.js\":\"96e556fe02d6200d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/Button.js\":\"fe9432469f22fbdb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"f1dbb0621b3fdae0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/defaultItems.js\":\"018583588af5831a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/facet.js\":\"3a9354f421ae0fea\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-bottom-nav/index.js\":\"9b6bfeda1db630c0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"efd9d0d9f75c88dd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/actions.js\":\"4cc9572211eaaf64\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"d4522e6ded395e7b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/facet.js\":\"7238286abafa2c6b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/mobile-keyboard-toolbar/index.js\":\"8474402befcc7882\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/MoveDestinationPicker.js\":\"29cea47f398c99b5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/blockSubtreeMembership.js\":\"717649900e4bd15d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/contextMenuItem.js\":\"2de50846040fef8d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/index.js\":\"1efbfe360fbdf08e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/moveAction.js\":\"bc1b6ba1aeb1d384\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/moveBlocks.js\":\"6d94f36eba391b69\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/move-blocks/selectionAfterMove.js\":\"479a67bb21e48455\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/TutorialBanner.js\":\"fbb3a6788c372c85\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/action.js\":\"06b5186c7c4ca594\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/bannerDismissal.js\":\"542c399e569a341b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/documents/cheatSheet.js\":\"b4db5e94766e058d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/index.js\":\"5889c9b7dfdc89d7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/keys.js\":\"56d93cf11d7f3c7b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/landing.js\":\"dcd5fe2496cc9944\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/outline.js\":\"b22d369269df687c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/onboarding/seed.js\":\"2c4268671a4a16eb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/PerfTrendDialog.js\":\"11d13e6e1fc554a7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/analyze.js\":\"f8d59e474a638c20\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/diagnosticsSource.js\":\"bfb777a39f5ea319\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/index.js\":\"02469a193ceefde4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/load.js\":\"322ea19e339e34d0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/monitorRun.js\":\"856833c11bfc210f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/schedule.js\":\"dc11af51d47b0c26\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/series.js\":\"260a962a3487af2a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/store.js\":\"0c0631eaf89b6049\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/trendAction.js\":\"a1b9a30c75a95c3e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/perf-monitor/verdict.js\":\"00c56aa4bc6aca7d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/plain-outliner/clickToEditAction.js\":\"6265dc4a9bace32d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/plain-outliner/index.js\":\"00b75cb45af8c12e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/plain-outliner/interactions.js\":\"76b7e83e2b845b2c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"50c7e4eddb3f6a10\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/MigrationGate.js\":\"d852d63708dd4448\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/MigrationGateDialog.js\":\"69ac98eb3a77abdb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/action.js\":\"1ab447614680a162\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/index.js\":\"b75027b30d8eaaec\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/localRunMessage.js\":\"8fef36d39ad4b690\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/plugin.js\":\"5bde891ebbaf6342\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/progressReport.js\":\"d3143ade84da1ff2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/properties-migration/sweepProgress.js\":\"26458aac902f9d44\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/FieldRowRenderer.js\":\"f24c463d70c337c4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/ValueRowRenderer.js\":\"b4bff4df61cdf06d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/actions.js\":\"1a620a1a85726f63\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/autocomplete.js\":\"3e1dcb5d40fc8f9c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/fieldRow.js\":\"d1d4b1cfebf12efc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/index.js\":\"5a55958f5ec66925\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/referenceWarning.js\":\"2c1b101b7a6c8937\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/valueAutocomplete.js\":\"bbfd1914ca075b7e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/property-rows/valueSchema.js\":\"bb6956925d2fedda\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/HeaderItem.js\":\"801af9b02f9d9069\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/QuickFind.js\":\"c31bba0346095898\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/index.js\":\"e734cc543fbbe9c8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/recents.js\":\"bc3d9394c1c95641\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/resultItems.js\":\"df3c3b1e35958264\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/selection.js\":\"d04554c4151196ca\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/quick-find/toggleStore.js\":\"53eb8cee852c8293\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/HeaderItem.js\":\"7af322a0ed9dda11\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/RecentsPageBlockRenderer.js\":\"d888019104167848\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/grouping.js\":\"b88e2840311a6368\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/index.js\":\"67286372b93508b9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/recents/target.js\":\"1c839615a5ff0658\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/codeMirrorExtensions.js\":\"fe3bfd86b0127576\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/contentPrefill.js\":\"efd93145ca3da3f4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/dataExtension.js\":\"9235a8202b7977f8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/index.js\":\"dd1ab88cd8a215d2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"602f9356de686f48\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/invalidation.js\":\"51f5c8134f90ac72\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/localSchema.js\":\"c6ab5cbc01a55186\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/blockrefs/index.js\":\"100371f8da1abe4b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"e22a2f60dbca1b2a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/index.js\":\"7c0a7894930e8fd4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/referenceNode.js\":\"aeb05a6a6ef35e24\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/remark-reference-occurrences.js\":\"ba0fd73a4d43d9de\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"71f18b71647f8ed7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/wikilinks/index.js\":\"f7c8995780c8ea17\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"21697f2ea4d86fa8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"0a98c33424ff79af\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/mergeRetargetProcessor.js\":\"57cb5ca39562173a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/parseFence.js\":\"0d31fa7372cbd531\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/referenceParser.js\":\"6a6ee17751e53976\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/referenceProjection.js\":\"d11a9fe01a2113b4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/referencesProcessor.js\":\"57201a653810b75a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/renameProcessor.js\":\"53171db35546bc6c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/references/spanReplacement.js\":\"d23e80358bdeab0f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/rich-paste/htmlToOutline.js\":\"c2f5dd2617c6c1f1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/rich-paste/index.js\":\"da9ba829a85f3fbe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/rich-paste/normalizeClipboardDom.js\":\"676f90d6629b749e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/rich-paste/pasteDecision.js\":\"fb7ae27b85784c3c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/action.js\":\"ee8a4193a2d7c103\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/blockIds.js\":\"60f3228b6f5c891c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/content.js\":\"b043d9bebab4c427\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/effect.js\":\"554824f924868460\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/ids.js\":\"df7c1cdd8f3f3ee6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/import.js\":\"fa2182be3f7fcdbe\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/index.js\":\"de7fda43e0a83201\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/plan.js\":\"bad8a74fbd02727e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/plugin.js\":\"1f23ec52dd8c7dcd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/promotion.js\":\"dbcbfdab644c92e5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/properties.js\":\"22f802c87eb1e9b9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/references.js\":\"ecf0e8a1405bddf7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/report.js\":\"abbc708a95baf00b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/roamMemo.js\":\"72e2e2a5e0ec0870\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/runtime.js\":\"3478ee3a06d3da39\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/schemaReconciliation.js\":\"127ed2f05e7e2e20\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/srsMarkers.js\":\"5b3b388d006f141e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/todo.js\":\"f662c19e84a67fca\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/typeCandidates.js\":\"7eab5055263ba46b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/roam-import/types.js\":\"451d9485c5fb24ea\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/search-health/index.js\":\"3705e67979eb4760\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/search-health/store.js\":\"7ec77e7611d7f1d0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/HeaderItem.js\":\"9ee597a6d29d0b85\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"9617a1ac48b31fb4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/index.js\":\"7aca77383db5fe0a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/model.js\":\"6c10b54b48f21fb0\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/toggleStore.js\":\"d46ec577c91b9ce2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/shortcut-help/useKeyInspector.js\":\"26a14fb72bbb10bd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"63c83a5e9f879b52\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/ShellDecorator.js\":\"d1fb7417263557d5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/actions.js\":\"a6767a64cfd314e4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/exclusionsFacet.js\":\"d17f59ba3aca27cf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/index.js\":\"8a0592011ee37343\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/shell.js\":\"eb2de03f39149c0a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/surface.js\":\"bc5c40b767e74999\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/spatial-navigation/walker.js\":\"7d45037816fcacd1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/RescheduleToast.js\":\"ce7c5456262c635a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/dataExtension.js\":\"1b00caab9e0cf0b7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/index.js\":\"e78e223ba7a14792\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/indicator.js\":\"d695937b92c6ce11\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/moveSrsState.js\":\"dcf1e481d630c825\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"f0a459e4f40cef57\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/scheduler.js\":\"076a0b1117cd55c7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/schema.js\":\"8c406bc7f99ba2a9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"cdb642e16d82b534\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/srsClipboard.js\":\"a8718d177540e61a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"5d6e7559f806f027\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/DailyNoteReviewHint.js\":\"9bcadf08eba1fcb7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/DeckPicker.js\":\"897318bf6d19bc08\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/ReviewControls.js\":\"bb2034a1f62d8699\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f2248a6493f2dd8d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/ReviewSession.js\":\"24857b7048a39168\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/actions.js\":\"dd6d03b7bcd573d9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/archive.js\":\"c596257174b14ba6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/dataExtension.js\":\"eb6e2d8ce7edf3fd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/deck.js\":\"54b80101b0cb7932\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/dueQuery.js\":\"1e14a757221f5e49\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/gradeDecision.js\":\"e60e7bea49b26d2c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/index.js\":\"d3c0261a254bbedd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/keyHints.js\":\"b4eafa38fc590a54\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/reviewCardLayout.js\":\"32e24f81dc3598d9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/reviewProgress.js\":\"b28aff2d071c4686\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/schema.js\":\"d9aed346e1c954bd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/srs-review/useDueCards.js\":\"46adbf19a154d22b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/startup-metrics/index.js\":\"57c042f0bab862cb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/startup-metrics/record.js\":\"a4d8742b301ab10f\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/storage-persistence/index.js\":\"832d8d52a073897e\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/storage-persistence/persistenceStatus.js\":\"a5c7b87be3767abb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/storage-persistence/requestAction.js\":\"eba34fec976936d1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/supertags/TypeChipsDecorator.js\":\"36ed0c3b37ab315c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/supertags/codeMirrorExtensions.js\":\"607f95b4b03b60b7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/supertags/index.js\":\"d3f513c46baf04d1\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/supertags/typeAutocomplete.js\":\"1b51ca91a80acceb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"43affdf0c86445ca\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/actions.js\":\"546df21eeb5d28d2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/anchor.js\":\"ee94983da18cf660\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/events.js\":\"f981bbdbb8788c25\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/gestureActions.js\":\"493bae6165bfe8ec\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/index.js\":\"66125b3f4dd01e15\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"067195c27f93d87d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/sync-metrics/collect.js\":\"482a8ebdfed5740d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/sync-metrics/index.js\":\"a8c2afcad9d283b6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/sync-metrics/record.js\":\"549376236ffd6abb\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/RejectionDialog.js\":\"c110a91101ef8dce\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/SystemStatusHeaderItem.js\":\"5c4cbe89c28359bf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/index.js\":\"cb92fcfa84d0fb72\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/model.js\":\"b625fd0da938eadc\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/queueCounts.js\":\"c1ec60790b518d73\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/rejectedHelpers.js\":\"d30273ed4b219984\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/rematerializeAction.js\":\"d488ef637ecd2fd9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/system-status/useHysteresis.js\":\"0297a954bbbfeb55\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/ColumnHeaders.js\":\"e156d10dadcc3b15\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/QueryUi.js\":\"ffb4368d013a24f6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/TableLayout.js\":\"3a0aab59dacb15c8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/actions.js\":\"4a9147fdfd7096a4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/cellEdits.js\":\"5e2758ea2dfd4520\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/childrenViews.js\":\"6df8c303fe354096\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/columns.js\":\"e7b79fda19e35749\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/controller.js\":\"b799b6db5878c9ca\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/convert.js\":\"571951121827e5df\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/dataExtension.js\":\"20f39e2dd4775967\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/index.js\":\"bb9b440fde9f8746\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/keys.js\":\"4f41a247b4ebbea8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/model.js\":\"5465bf1f6e6be389\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/QueryText.js\":\"2b12c7fc9b88105b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/backfill.js\":\"602be3bedfa27d5c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/completion.js\":\"2e8db9b04f57eec2\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/format.js\":\"9b100d2ff9551dcd\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/parse.js\":\"80441466b2de4723\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/queryValue.js\":\"e420bff79e315daf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/registrations.js\":\"da193fa4ba8f0788\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/query/source.js\":\"e5026260f10cb4e5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/registry.js\":\"d19b4f38de469b63\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/rowGutter.js\":\"5841dd48e77ed613\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/rowVerbs.js\":\"5331cd40d8c47967\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/schema.js\":\"5c1e741e2cc13f4a\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/tables/sort.js\":\"ff40399ff587fdf6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/theme-toggle/effect.js\":\"b907c7e3ff415879\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/theme-toggle/index.js\":\"b28049638d3f16a8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/theme-toggle/theme.js\":\"cbe3f33b87a18069\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/todo/actions.js\":\"3a521fae920341ad\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/todo/dataExtension.js\":\"7993449b18cd6076\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/todo/index.js\":\"db8064313c228a51\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/todo/schema.js\":\"8894a45a602562ab\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/TouchSelectionLayer.js\":\"16d0eeec91deafb5\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/actions.js\":\"bc8322c1a8b57376\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/defaultItems.js\":\"e607bf1296ee0274\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/facet.js\":\"e5e3f4bb41ea9a08\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/holdRecognizer.js\":\"0c2f92dcfa13b699\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/touch-selection/index.js\":\"cd6bb1418e797bfa\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/update-indicator/UpdateIndicator.js\":\"27447ec2175beab9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/update-indicator/index.js\":\"476cb64f3dabc965\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/update-indicator/loadTimes.js\":\"c6e817f6e3de56f6\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/VideoNotesRenderer.js\":\"0a446cda49cb60f7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/VideoPlayerRenderer.js\":\"2e0b2042f100faf4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/VideoTimeStamp.js\":\"3ba38edda2491f65\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/actions.js\":\"698d89c40599c7d4\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/index.js\":\"b9567a739774f19d\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/markdown.js\":\"4c42cdd1fc85be40\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/notes.js\":\"7e35e2dc92e129de\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/registry.js\":\"ba71203d8368f7cf\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/remark-timestamps.js\":\"bb28033a115ce46c\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/video-player/view.js\":\"14963af3cbae4fd9\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-link-hints/LinkHints.js\":\"0212c8f5bb934f76\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-link-hints/index.js\":\"ff6fc4fd7cf193d7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-link-hints/model.js\":\"bfa11b31c085c73b\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-link-hints/settings.js\":\"6e840f25b014d1ba\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-normal-mode/actions.js\":\"fd38fa85592f2ea7\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-normal-mode/index.js\":\"3d88bd69a32f4585\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/vim-normal-mode/interactions.js\":\"33e58ead6cbb8aa8\",\"/knowledge-medium/pr-preview/pr-1922/src/plugins/workspace-header/index.js\":\"0f55a95a990b9cb3\",\"/knowledge-medium/pr-preview/pr-1922/src/registerServiceWorker.js\":\"db9bef0304ecba83\",\"/knowledge-medium/pr-preview/pr-1922/src/requestPersistentStorage.js\":\"8e471f07ca1e0bfd\",\"/knowledge-medium/pr-preview/pr-1922/src/services/authRequestDeadline.js\":\"863a89cbf5101620\",\"/knowledge-medium/pr-preview/pr-1922/src/services/authStorage.js\":\"17bd657b3000a63a\",\"/knowledge-medium/pr-preview/pr-1922/src/services/powersync.js\":\"a04dd2e2435fe5e3\",\"/knowledge-medium/pr-preview/pr-1922/src/services/supabase.js\":\"7e331ae4ed2f0ec1\",\"/knowledge-medium/pr-preview/pr-1922/src/services/uploadErrorClassifier.js\":\"70097d0c171ee4cb\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/ActiveContexts.js\":\"6897a4f8e8883ff4\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/HotkeyReconciler.js\":\"08901e45734e1c41\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/WipeLocalDataDialog.js\":\"5f034b7f7b39c0e8\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/actionDispatch.js\":\"49cd4c272730cb0b\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/actionKeyHints.js\":\"a506ac378387e316\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/actionRefItems.js\":\"f04f539ccf37b5cd\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/applyKeybindingOverrides.js\":\"1e6a6b9648ec6e59\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/blockActions.js\":\"1ba6a28ea222e252\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/blockMergeGesture.js\":\"30b77ff20005baeb\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/canonicalizeChord.js\":\"78aade9cd9f4ed08\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/defaultContexts.js\":\"c4b8a4b564519694\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/defaultShortcuts.js\":\"315516d26b7a82bc\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/effectiveActions.js\":\"87ddd331bbb5c73e\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/formatChord.js\":\"c9beb59539e55e8d\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/gestureAction.js\":\"3cceb37b67ab2b6c\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/gestureBinding.js\":\"d0222b2d2257b666\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/holdRegistry.js\":\"43e82a276397fbe8\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/keybindingConflicts.js\":\"46fd6e8d55c38a49\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/keybindingOverrides.js\":\"7c5dd95d25a06222\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/pointerAction.js\":\"84f5723dea497742\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/resolve.js\":\"480a29ee1846451b\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/runAction.js\":\"db75d6fa8d47efcc\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/sequenceMatcher.js\":\"ad299c75dfadd26f\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/types.js\":\"5bc2019d8d2451ab\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/useActionContext.js\":\"f4c5ca2794925e37\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/useActionDiscovery.js\":\"c41eac685605f2b4\",\"/knowledge-medium/pr-preview/pr-1922/src/shortcuts/utils.js\":\"f2bae0ea0c41d4e3\",\"/knowledge-medium/pr-preview/pr-1922/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1922/src/sw/bootStore.js\":\"731bb4ba54814408\",\"/knowledge-medium/pr-preview/pr-1922/src/sw/previewDatabases.js\":\"02b1ea5db35fbcdc\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/byteTransform.js\":\"3d609d1a82c18ff9\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/attachmentCleaner.js\":\"5838cde4c1ebb778\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/attachmentParts.js\":\"f478ae6758a3c67d\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/bundleParts.js\":\"1fcd9c784a7030cf\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/bundleRecord.js\":\"18bbccefa82bb771\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/manifest.js\":\"ca78268c3c99c138\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/takeBundle.js\":\"91d8ed3fc6a54f78\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/bundle/verifyBundle.js\":\"e534d7417b855929\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/cleaningStage.js\":\"80e41ffd8f4857d8\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/conversionKey.js\":\"552e65f1c52b1cdc\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/conversionServer.js\":\"ca098eaec995692c\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/flip.js\":\"894905f0200999df\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/flipAttempts.js\":\"1d68bbb964b5c2dc\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/pages.js\":\"c33e3509047e29bf\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/preflight.js\":\"7ad1684127a2e9c6\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/reseal.js\":\"70591542c3cb64a4\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/runConversion.js\":\"516b1c5e9ddc40ba\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/runLock.js\":\"141516b3fad227ff\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/sealing.js\":\"8cee2cc8eb92af72\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/sealingStage.js\":\"8b3cb23d3aee6750\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/stage.js\":\"cec9b0a3ceee00f8\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/conversion/verifyReseal.js\":\"b078110130e57ad3\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/aad.js\":\"608e218c1e4e2317\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/aead.js\":\"ee35ef39fa7cc9ff\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/base32.js\":\"ed5310a43c56bec1\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/base64url.js\":\"7f19bf25493038c5\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/binaryEnvelope.js\":\"1d469e3c9a7c574f\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/byteAead.js\":\"04761217c2ba281a\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/canary.js\":\"2348f2edd9ed8d13\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/contentHash.js\":\"1cce5a4410dbc14f\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/contentKey.js\":\"9b92869bc670bd25\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/derivedIdNamespace.js\":\"d0d7789ed8dec3f6\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/envelope.js\":\"91d9b9cfee2e72de\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/hex.js\":\"9d741587550ef456\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/sha256Hex.js\":\"6f30839fa5f33911\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/crypto/workspaceKey.js\":\"bc69b21474c1377b\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/conversionState.js\":\"84cb09695b1f70f3\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/flows/createEncryptedWorkspace.js\":\"783b0b936b36a767\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/flows/pastedKey.js\":\"b67eca045eba830f\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"da2c39e10077df84\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/flows/upgradeWorkspacePin.js\":\"44874dd39c21c255\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/keyStore.js\":\"c8274a1474650e4e\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/mintWorkspaceKey.js\":\"1210ca85deffe5d5\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/modePin.js\":\"d8c051c9a8fd29d5\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/openWorkspaceKeys.js\":\"8c6d4087eab66366\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/resolveWorkspaceEntry.js\":\"235443fedb476b68\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/resolver.js\":\"4b37a462e0adbf17\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/keys/workspaceAccess.js\":\"ba0a3eaaf5d47812\",\"/knowledge-medium/pr-preview/pr-1922/src/sync/transform.js\":\"8a6610de89cb4330\",\"/knowledge-medium/pr-preview/pr-1922/src/themeBootDefaults.js\":\"1787c2cc9b2c90ca\",\"/knowledge-medium/pr-preview/pr-1922/src/types.js\":\"f72a16b7e9f1de1d\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/ClientLocalSettings.js\":\"cc898aa757f741a2\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/abortableSleep.js\":\"dc3c5c77d6e485cb\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/array.js\":\"a55b443248888219\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/backlinkAutocomplete.js\":\"8c42fb404e9c92fd\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/blockCrumbs.js\":\"256157e37c425ee8\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/blockrefAutocomplete.js\":\"d8091f25293c7d6f\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/cadencedIdleJob.js\":\"cb888efb79c7c11b\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/callbackSet.js\":\"1bfd395e180b9590\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/clientId.js\":\"d28f932971e2cab8\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/codemirror.js\":\"7df2811e28bf5e82\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/codemirrorCompletion.js\":\"f44dc2dba02a7342\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/copy.js\":\"39e8e020633d2482\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dailyPage.js\":\"8d024fe9a2dc78a5\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dbForensics.js\":\"c53b3f043b6bae07\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dbForensicsHooks.js\":\"43be602cf96600f9\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/deleteBlockThroughUi.js\":\"cf06a488e5f8fff0\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dialogs.js\":\"ed5e5ca46cf98f59\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/dom.js\":\"0a45c7d2e4f0a10a\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/downloadBlob.js\":\"6fe16a6cae754375\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/drawnWalk.js\":\"5d4ae3b684dbb38d\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/exportSqliteDb.js\":\"915a0c77bfdb3e7c\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/fileSystemAccess.js\":\"527ecf59d3cbb5c5\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/flipSlide.js\":\"acb3d4ab96e51d84\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/fnv1a.js\":\"48bc9dabc53f1db2\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/formatBytes.js\":\"1f53fb946eba39a6\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/fuzzyRank.js\":\"9b0295756758b053\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/idbKeyedStore.js\":\"b6924e03147cd265\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/idleCallbackPolyfill.js\":\"9b46c58040df09c1\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/keyboardAwareScroll.js\":\"2f84d7ecbf07c699\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/keyboardViewport.js\":\"bd222dbe13dab258\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/lastWorkspace.js\":\"fbab0fa41039f1d0\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/layoutColumns.js\":\"46278cd684474281\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/layoutSessionDom.js\":\"e16a69ab0d4ce2dc\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/layoutSessionId.js\":\"af18a16ada281e10\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/linkClickGestures.js\":\"83273f0e0a5a6ee5\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/linkTargetAutocomplete.js\":\"048707cd61bfdafa\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/localDbCorruption.js\":\"f615219a991edeb2\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/localDbRecovery.js\":\"8582b777e9f763cd\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/markdownParser.js\":\"8bd06644949ea616\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/memoize.js\":\"e456958b7497d5e2\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/nameFieldCommit.js\":\"4b4ea47200cba958\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/nameList.js\":\"80b9d2097a68efe4\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/navigation.js\":\"0e7977d938adc86b\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/omnilinerNamespace.js\":\"1dd743ebaa48c281\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/opfsPageScan.js\":\"5b90b2e60df80a2f\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelClearance.js\":\"8adc121b71cc3996\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelHistory.js\":\"17b2ea9c33d9581c\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelLanes.js\":\"3c215d751d355d75\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelLayoutProjection.js\":\"96bcd5cc9ff965ad\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelScrollAnchor.js\":\"7ccdbe4fa7790285\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/panelUrlFlags.js\":\"4aeb078fa232379d\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/platform.js\":\"33afac2968a35487\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/pluralize.js\":\"f486baadf4a7988b\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/propertyCreation.js\":\"70d07225f7fb1714\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/propertyNavigation.js\":\"9218bd7b2a30957f\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/propertyValueContext.js\":\"00b070b010dcb5bd\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/react.js\":\"0930d28cc88e09c4\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/relativeDate.js\":\"e54861be461bad98\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/relativeTime.js\":\"e6ecd200fffd2397\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/renderScope.js\":\"9ad08825097a8a86\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/resolvedThenable.js\":\"36d288362e69ec69\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/routing.js\":\"8cc8642cca7d4c82\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/safeMode.js\":\"2b435f3ad609f8fa\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/scheduleIdle.js\":\"0ca1e79fd97b5be5\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/screenWakeLock.js\":\"35316dc2aaca821b\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/selection.js\":\"5192acd67b99574a\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/softKeyboardGrab.js\":\"1431241fa196f46a\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/startupTimeline.js\":\"0d6e2fd7fbaf54ed\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/state.js\":\"34625e2e6852a145\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/string.js\":\"66c0175ce9ade8d8\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/surfaceZoom.js\":\"578e1f3d21acebca\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/time.js\":\"8881f7f927731be5\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/toast.js\":\"fd00a779d01b3d8f\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/toggleStore.js\":\"11e89504f07729e8\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/untilStopped.js\":\"57e109cb302232e6\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/userActivity.js\":\"ecd1539be9b5bba0\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/viewTransition.js\":\"adcb5e217690edf1\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/viewport.js\":\"00b514bb6f4ab225\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/webLock.js\":\"1536b3a86ee13b3f\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/workspaceRecovery.js\":\"be20b7f7c66f9f84\",\"/knowledge-medium/pr-preview/pr-1922/src/utils/workspaceSnapshotStore.js\":\"a209067b3d1a1591\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-compiler-runtime.js\":\"1baa8ac71a39e06f\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-client.js\":\"59f391a8410e7683\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-server-edge.js\":\"b9cfc38fa91f5101\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-server.js\":\"3bed4dcf5f7da113\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-static-edge.js\":\"d50b18c7b3a4e152\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-static.js\":\"9adceaa882f16fd1\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom-test-utils.js\":\"b47635c16229195a\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-dom.js\":\"d13292ec042e604d\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react-jsx-runtime.js\":\"b50c810c8a803da7\",\"/knowledge-medium/pr-preview/pr-1922/src/vendor/react.js\":\"7ad3fd0ea8df1d76\",\"/knowledge-medium/pr-preview/pr-1922/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1922/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1922/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
