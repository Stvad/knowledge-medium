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
		buildId: "b1804e620586-e47f3be1",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1924/\":\"d2233421767a0e10\",\"/knowledge-medium/pr-preview/pr-1924/index.html\":\"d2233421767a0e10\",\"/knowledge-medium/pr-preview/pr-1924/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1924/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1924/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1924/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1924/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1924/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1924/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1924/assets/FacadeVFS-CLU-lChw.js\":\"106e5bfef18c7604\",\"/knowledge-medium/pr-preview/pr-1924/assets/OPFSCoopSyncVFS-C9Bg9Ve6.js\":\"09441d6b652784ae\",\"/knowledge-medium/pr-preview/pr-1924/assets/OPFSWriteAheadVFS-CPvn8Gk8.js\":\"eb466f2aa0d7ad10\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-D41mtu2Q.js\":\"7e62781e0291d551\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-async-CW0YAjpl.js\":\"a352279bca47c139\",\"/knowledge-medium/pr-preview/pr-1924/assets/worker-CEOE64nW.js\":\"155fed017e256545\",\"/knowledge-medium/pr-preview/pr-1924/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1924/chunks/app-BoNXuy6s.js\":\"9aad190352a34ac2\",\"/knowledge-medium/pr-preview/pr-1924/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1924/index.js\":\"d26c70c0fe19fd4e\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1924/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1924/assets/AccessHandlePoolVFS-Bi1a0tMN.js\":\"13c9608a78a48084\",\"/knowledge-medium/pr-preview/pr-1924/assets/IDBBatchAtomicVFS-DcFVOYqP.js\":\"f5d141607bc3b1f5\",\"/knowledge-medium/pr-preview/pr-1924/assets/MemoryVFS-CG_emkB8.js\":\"6cf2043fdfee2f25\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-Dz0GV88t.js\":\"6f8ffe196c5a2e3d\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-async-CTTUm0s9.js\":\"7ef39714fe888498\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1924/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1924/chunks/AccessHandlePoolVFS-BD324Uhn.js\":\"f9e2ee3558812daa\",\"/knowledge-medium/pr-preview/pr-1924/chunks/FacadeVFS-DzNZvvK3.js\":\"e37660d73ed3dd8c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/IDBBatchAtomicVFS-sjOmBrY1.js\":\"a09ee158c773e43c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/MemoryVFS-Ds4GNRQd.js\":\"90e1295eadcedd13\",\"/knowledge-medium/pr-preview/pr-1924/chunks/OPFSCoopSyncVFS-Cn4L98wr.js\":\"545e0ad63ca14f74\",\"/knowledge-medium/pr-preview/pr-1924/chunks/OPFSWriteAheadVFS-DU2M65lq.js\":\"7790562880043748\",\"/knowledge-medium/pr-preview/pr-1924/chunks/Preview-Ciy0Qetb.js\":\"20d66baa5740be88\",\"/knowledge-medium/pr-preview/pr-1924/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/card-CEm9qWbr.js\":\"dc296ee1f203b8c5\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dist-CVLzZ3Ed.js\":\"b1d281a9f9660f8b\",\"/knowledge-medium/pr-preview/pr-1924/chunks/freezeExtensionImports-Bgmlk_Lk.js\":\"e0c177a67b7e0e4c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1924/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1924/chunks/mc-wa-sqlite-BfJegxcw.js\":\"2359c584017b1cf9\",\"/knowledge-medium/pr-preview/pr-1924/chunks/mc-wa-sqlite-async-DUl3mvxs.js\":\"1714dac622176348\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-62u0xwaX.js\":\"d2f71eeeacae905b\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-C9TexR-t.js\":\"d9e3a59f2a1a0d3d\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-CDVkDbvB.js\":\"9b194350133f00fa\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-CTSVypON.js\":\"b73ef93b64c7815c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-C_4fIxDp.js\":\"551af26511e8716c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-DQC8TZ85.js\":\"e315e57c0a071647\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-_pCIT2ip.js\":\"53a701eb59b91c25\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-bZenRKfW.js\":\"cbadbc060f315d96\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-dom-server-legacy.browser.production-HGXUANbH.js\":\"f78443ecf534d7e9\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-dom-server.browser.production-CnftvENs.js\":\"b77b916aa1feadf0\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-dom-server.edge.production-CC3BpMlD.js\":\"133c84a49780b91a\",\"/knowledge-medium/pr-preview/pr-1924/chunks/server.browser-xYn5b3bm.js\":\"b91515be7f094e6c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/textarea-pesVAwLO.js\":\"277fbdd4470bde5d\",\"/knowledge-medium/pr-preview/pr-1924/chunks/ui-DmtqxmSP.js\":\"b46a1e5dae2c68ce\",\"/knowledge-medium/pr-preview/pr-1924/chunks/wa-sqlite-SWkC1p24.js\":\"69a924a8a03c5aad\",\"/knowledge-medium/pr-preview/pr-1924/chunks/wa-sqlite-async-BR0G8gBn.js\":\"d6391cda2b8a1185\",\"/knowledge-medium/pr-preview/pr-1924/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1924/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1924/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1924/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1924/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1924/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1924/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1924/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1924/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1924/src/App.js\":\"9dd2e0308a4bd531\",\"/knowledge-medium/pr-preview/pr-1924/src/appUpdate.js\":\"bf97135348895a70\",\"/knowledge-medium/pr-preview/pr-1924/src/appVersion.js\":\"23f2bafa1c27d2d9\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/initialLayout.js\":\"70d533cf3249b10e\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/openWorkspaceData.js\":\"a5f0752a40734a08\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/resolveWorkspace.js\":\"c3964daa681c25b8\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/workspaceBootstrap.js\":\"56357f537a931e9a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockComponent.js\":\"6ae77967fb2524e0\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockCrumbs.js\":\"2f93fd8fffc5cfe8\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockEditor.js\":\"07a277c84ce0c19f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockLoadingPlaceholder.js\":\"7bc87421d67612fc\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockProperties.js\":\"881d2d0603c45b26\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockSearchPicker.js\":\"c07ddb4b5c0c0946\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ConfirmBulkDeleteDialog.js\":\"6c4567427c72eeee\",\"/knowledge-medium/pr-preview/pr-1924/src/components/DividerHandle.js\":\"5d990b19beb35f31\",\"/knowledge-medium/pr-preview/pr-1924/src/components/DraftEditor.js\":\"e119d8087e019668\",\"/knowledge-medium/pr-preview/pr-1924/src/components/GutterPill.js\":\"04552e4ca9a4a607\",\"/knowledge-medium/pr-preview/pr-1924/src/components/Header.js\":\"dd0f153c6b60bc04\",\"/knowledge-medium/pr-preview/pr-1924/src/components/LazyBlockComponent.js\":\"d3c99da22d7a799d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/Login.js\":\"a05f683ddac6afd4\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ZoomableSurface.js\":\"f53e1fb2eea7b60e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/editModeKeepalive.js\":\"0b879bb9af3a08b0\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyDisplay/PropertyDisplayScope.js\":\"baacd9182349b6c8\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"c9a32b67e2d102fe\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/RefPropertyEditor.js\":\"2b1a5d66c672bb7e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/RefTargetTypePicker.js\":\"423d0c5f7cb973c7\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/SelectPropertyEditor.js\":\"f1a4f8c8bf07506b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/TypesPropertyEditor.js\":\"3f1ac8e4c9a73a2a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/defaults.js\":\"b147f113fd6e56cc\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/kernelValuePresets.js\":\"6884d061084a736d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/selectablePresets.js\":\"fd7d43edaff4c58f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/typesPropertyUi.js\":\"ac5ce5b45832cd03\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/AddPropertyForm.js\":\"6910fda43f0683d5\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/PropertyPicker.js\":\"d7d89d9bfc54bebb\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/PropertyRow.js\":\"c20e600eee09a408\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/Rows.js\":\"6415b9569d3a348d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/actions.js\":\"5d65f2317bb1ffd8\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/declarationOnly.js\":\"98ac2350937611f1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/layout.js\":\"3293257a0cde1a1e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/model.js\":\"a9ed20826e020d0d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/shapeUi.js\":\"1f60ce3d015b7f14\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/shapes.js\":\"49ce86a2361adda4\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/usePropertyEditingActivation.js\":\"0d57ec39ea8b28e8\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/visibility.js\":\"7dbad00e00c5238b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanelSections.js\":\"27280916a33fc41c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/BlockEmbed.js\":\"bca1ee1d5b88a954\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/BlockLink.js\":\"9f322e0290331c86\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/BlockRef.js\":\"6e9b873d6b3ad909\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/CompactReferenceLink.js\":\"13bd70491af4686f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/ReferenceLink.js\":\"1d5cbfc57464283e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/cycleGuard.js\":\"bb213f3077c33ea2\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/cycleGuardContext.js\":\"ca17d4bcfd390bc5\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/linkInteraction.js\":\"acbd7b1c61b7dfb2\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/referenceLayout.js\":\"a6459e0488340757\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/useBlockRefAncestors.js\":\"6e3300b290097be1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockGutter.js\":\"21fb230f58327893\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockInfoDialog.js\":\"3459ce59e73ee6d6\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockReadText.js\":\"163c300cb4aa2f16\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockTypeBlockRenderer.js\":\"76ac8f65fed00592\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BulletHoverCard.js\":\"3ca59d1bc8e98c61\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/CodeMirrorContentRenderer.js\":\"3b260a715cea246f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"2d8642152da792ea\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/ColumnResizeHandles.js\":\"33c4b9ef1ea49574\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"d103771da8aee552\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/DefaultBlockRenderer.js\":\"c74e4bc0217ef0da\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/LayoutRenderer.js\":\"047e0f1708c2a476\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/MarkdownContentRenderer.js\":\"efd3bc9977348e8e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/MissingDataRenderer.js\":\"10ceb9fe99cbd13d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/PanelRenderer.js\":\"96be810db66b87eb\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/PropertySchemaBlockRenderer.js\":\"e5d3111e71da5885\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/TopLevelRenderer.js\":\"7ad1de65a56d59f7\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/blockGutterMode.js\":\"af7a9f0f365f17e1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/blockTitleText.js\":\"12909b767da4b1f9\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/fieldCreationKeydown.js\":\"96e48c1b5fe16809\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/layoutRootContext.js\":\"6694e0293053026b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/typeChip/TypeChip.js\":\"124667fcc59138bc\",\"/knowledge-medium/pr-preview/pr-1924/src/components/typeChip/chipStyle.js\":\"ca0f7637fa7ff6ff\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/anchored-floating.js\":\"5b9d5761141c0c05\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/button.js\":\"6b911cb8763a95be\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/card.js\":\"a7d1edf47afc5e45\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/checkbox.js\":\"77ac06d5a41ac2b9\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/collapsible.js\":\"cdcd1e8e69b7180b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/command.js\":\"6cb2b9c3968f6829\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/context-menu.js\":\"f146c1cd01386d8c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/dialog.js\":\"40f1002c04dbeef8\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/dropdown-menu.js\":\"1ad8242f26cd2b54\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/floating-listbox.js\":\"ef933eacdd110060\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/index.js\":\"15bf7dfcc58f586f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/input.js\":\"9240b15b11a099fb\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/kbd.js\":\"31e03479cef57774\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/label.js\":\"fe9a4fce19c8cfcf\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/textarea.js\":\"5ea5f5810f1dc6ca\",\"/knowledge-medium/pr-preview/pr-1924/src/components/useEditModeYieldKeepalive.js\":\"06226a2b7ba2fda6\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/BootFallback.js\":\"f0c01430ad4365cf\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/FocusedRowLazyMount.js\":\"e3ce5f53f912e505\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/LazyViewportMount.js\":\"9e97145f8d8080e4\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/LocalDbCorruptionFallback.js\":\"074079e1b31718a8\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/error.js\":\"a02548cf0d4e7c96\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/lazyMountRegistry.js\":\"4878bcdf0740a6b0\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/suspense.js\":\"587c2637652d7993\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/CreateWorkspaceDialog.js\":\"72332ccdc9250447\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/PendingInvitations.js\":\"64019dc922a8a02a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/SyncProgress.js\":\"ab4765c38e561664\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/UnlockProgress.js\":\"89196aad5f89a647\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceKeyGate.js\":\"c8fd13904eea22bf\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceSettingsDialog.js\":\"b2cf67d946bb6775\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceSwitcher.js\":\"187056bc483760e6\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceSyncGate.js\":\"5b54f62fc808fc80\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/ConversionFlow.js\":\"ee5ddeba69ae8dda\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/ConversionFlowHost.js\":\"5469e78927bcd39e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/EncryptionSection.js\":\"c442b74129453341\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/attachmentPrompts.js\":\"7ffe0f2cd83a1238\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/bundleFolderPrompts.js\":\"67986ab0b90a8ad1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/conversionFlowDeps.js\":\"7abfcf8ac45d16f4\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/conversionFlowStore.js\":\"faf5c5d8a33fbb2e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/flowUi.js\":\"5cfd9eb2e799cf81\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/useConversionRun.js\":\"b43a18eab50a89e9\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/keyUi.js\":\"3abfb0f0dcdcd603\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/useCloseOnKeyLoss.js\":\"4e11ab339ea69905\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/useCloseOnServerE2ee.js\":\"31638f7ea733314d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/workspaceUnlocked.js\":\"c8968c3557f9a7db\",\"/knowledge-medium/pr-preview/pr-1924/src/context/backgroundSubtree.js\":\"5a71889ef1df6f4b\",\"/knowledge-medium/pr-preview/pr-1924/src/context/block.js\":\"7d50986f92c62983\",\"/knowledge-medium/pr-preview/pr-1924/src/context/layoutWsContext.js\":\"1452706f81de7458\",\"/knowledge-medium/pr-preview/pr-1924/src/context/propertyDisplay.js\":\"968861b8983cd4a1\",\"/knowledge-medium/pr-preview/pr-1924/src/context/repo.js\":\"f9a05de837d616b0\",\"/knowledge-medium/pr-preview/pr-1924/src/data/aliasClaim.js\":\"15365b31531f2315\",\"/knowledge-medium/pr-preview/pr-1924/src/data/aliasSeatNamespace.js\":\"29c9f9bc899c7754\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/blockData.js\":\"422feb17b777132d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/blockType.js\":\"43c384868c3f95f8\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/changeScope.js\":\"9d2db733c917b0d1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/codecs.js\":\"6edb9f327fc3e146\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/derivedData.js\":\"5a7e1c5fd2cf2efe\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/errors.js\":\"4eeb65e5e00769fa\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/events.js\":\"1a3877b61150965a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/handle.js\":\"4a35d67713226aae\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/index.js\":\"ddcd4f25fa1eb352\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/mutator.js\":\"a9705c09b5e61e60\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/processor.js\":\"dbe0fe52d0921acf\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/propertySchema.js\":\"d5245e55a4f740b7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/query.js\":\"725a337b17af8d5b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/sameTxProcessor.js\":\"b38b11fee59a2c79\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/schema.js\":\"4a35d67713226aae\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/tx.js\":\"4a35d67713226aae\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/typedBlockQuery.js\":\"79b1b7cd2c8fecff\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/user.js\":\"47aff271eda21d10\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/valuePresetCore.js\":\"25e4998b4d469bf5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/valuePresets.js\":\"bcbaf2bc25bb3861\",\"/knowledge-medium/pr-preview/pr-1924/src/data/attachmentCleanerIOVerb.js\":\"5e3df6be7a17f9c6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/block.js\":\"1481e9070332c6e5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockCache.js\":\"0f235efb01b3fc71\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockId.js\":\"0bbc61f874633595\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockLiveness.js\":\"cd1eaa048a846e06\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockMerge.js\":\"d78031edac55ef89\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockSchema.js\":\"3e726c87e399addb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockTypeLookup.js\":\"38672e88277a6a40\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockTypes.js\":\"290e12b764e6e6e4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/childrenView.js\":\"7af0c92cab08d720\",\"/knowledge-medium/pr-preview/pr-1924/src/data/clientContext.js\":\"bcee64be80045dbd\",\"/knowledge-medium/pr-preview/pr-1924/src/data/dbFileSiblings.js\":\"bbecf441f78cf383\",\"/knowledge-medium/pr-preview/pr-1924/src/data/definitionSeeds.js\":\"ac97ca7fdea680f3\",\"/knowledge-medium/pr-preview/pr-1924/src/data/derivedIds.js\":\"91d4293402c5ff3c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/drawnSubtree.js\":\"830ac4bdbb66e042\",\"/knowledge-medium/pr-preview/pr-1924/src/data/facetBridge.js\":\"83b05032584da75b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/facets.js\":\"21e617a0ca6d5670\",\"/knowledge-medium/pr-preview/pr-1924/src/data/globalState.js\":\"2557e2cb60e36738\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/aliasClaimRederiveProcessor.js\":\"4bb14372e38b0ff0\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/ancestorBatch.js\":\"c55588e82973db2b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/blockTypeTypeifyProcessor.js\":\"2437bccabaf84c80\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/clientSchema.js\":\"f94482c46f33047a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/commitPipeline.js\":\"6a9d74fee221f769\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/devAssertions.js\":\"dbe7a9d733691946\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/firstSync.js\":\"c0276cdc0e8429df\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/freshInitialLoad.js\":\"d8ef805edc07ce9e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/graphBackfillClaim.js\":\"075d872fcfbe08da\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/handleStore.js\":\"4d5fda89fc7e7311\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/idleMarkerJobs.js\":\"143e535194cbd4bb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/initialDownload.js\":\"c8a924e34932dd8f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/initializeClientDatabase.js\":\"a6ffbcc8b1968564\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/jsonCanonical.js\":\"e68722d27b9f4a35\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/kernelInvalidation.js\":\"1419a68566ed6064\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/kernelProcessors.js\":\"77d1e5e44f06cbc2\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/kernelQueries.js\":\"1ea7873762b5cc71\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/mergeTypeMembershipProcessor.js\":\"6278f289a8b27430\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/normalizeReferencesProcessor.js\":\"effb2c62e2df976b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/poolInstrumentation.js\":\"711421b331cc3bdb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/processorRunner.js\":\"687fcfc45dc1c23f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyCellBackfill.js\":\"b34c38d4361da47e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyChildMint.js\":\"bd1c0c5b332c30a0\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyChildrenProcessor.js\":\"420ef92345257c3a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyDefinitionChangeProcessor.js\":\"692f47844489b47c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyDefinitionSynthesis.js\":\"485e955435d8de62\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyKeyScan.js\":\"dacf2679286078b7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertySchemaResolution.js\":\"a531db73e04bc49b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyValueEdits.js\":\"e2dbfd6c66810718\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/raiseProtocol.js\":\"9e8a7f05d5bdb193\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/readBatch.js\":\"0628c8c2568a3048\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/refProjection.js\":\"448ac099014ad82f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/referenceTargetLookups.js\":\"dd8c964f540f5c44\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/referenceTargetProcessor.js\":\"d06bce5574feb82c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/replayMerge.js\":\"f765b955a29638b8\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/sqlBinds.js\":\"e38ecc5b95528e16\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"4c2b817ad3d6a258\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/arrivalProcessors.js\":\"0aade27bd85e1d7a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/invalidate.js\":\"fcb73523361a3c18\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/materialize.js\":\"45c8380e4cc58fac\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/observer.js\":\"a462119df9bd9e52\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/reconcile.js\":\"0d6b91b80561e37c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/timingMetrics.js\":\"91a3f05636f7aac5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/treeQueries.js\":\"4e383466349c7955\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/txEngine.js\":\"997d9a26fa5d25da\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/txSnapshots.js\":\"71bac50bf481f88b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/typedBlockQuery.js\":\"a2e21ba380debe5d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/undoManager.js\":\"440ee627010eab17\",\"/knowledge-medium/pr-preview/pr-1924/src/data/invalidation.js\":\"deef624ecdca3db4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/kernelDataExtension.js\":\"7cb3922bbea1ff69\",\"/knowledge-medium/pr-preview/pr-1924/src/data/kernelPage.js\":\"87235e305da898a7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/kernelValuePresetCores.js\":\"8b699ef375a6602e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localDbCorruptionSignal.js\":\"ba793a75d1bb25c8\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localDbStorage.js\":\"9c6bba56ddaffb2f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localDbVfs.js\":\"0ccb05119161b7aa\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localSchema.js\":\"eaf57bc7eb071727\",\"/knowledge-medium/pr-preview/pr-1924/src/data/maintenance.js\":\"f2cc6145be6817a7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/mergeProperties.js\":\"1c0f12a534954b9f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/metricsConsoleHook.js\":\"5b36408aeb408acb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/migrationsPage.js\":\"6e2f05030f2eb9db\",\"/knowledge-medium/pr-preview/pr-1924/src/data/mutators.js\":\"6c1950933682da29\",\"/knowledge-medium/pr-preview/pr-1924/src/data/orderKey.js\":\"cbe0a04b319e38df\",\"/knowledge-medium/pr-preview/pr-1924/src/data/orderKeyPlacement.js\":\"5545c81ef418ab54\",\"/knowledge-medium/pr-preview/pr-1924/src/data/outlineSurface.js\":\"f31d8fba9c28803c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/pendingEditorContent.js\":\"b78f48cb973c05ed\",\"/knowledge-medium/pr-preview/pr-1924/src/data/pendingUploadsSql.js\":\"2b86f2d4562cce1b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/pluginStateExtensions.js\":\"d6aa9acadafa5817\",\"/knowledge-medium/pr-preview/pr-1924/src/data/powerSyncLogger.js\":\"393dd3f7c4cddeea\",\"/knowledge-medium/pr-preview/pr-1924/src/data/projectorRuntime.js\":\"d7741c7158c3e05f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/properties.js\":\"e06ba411e960253e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertiesPage.js\":\"5d59087e0ff1a403\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyChildren.js\":\"835cb7fca6d32837\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDefinitionFanout.js\":\"5421b2d8a545527e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDefinitionMetadata.js\":\"0df5d16c70c07875\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDefinitionRegistry.js\":\"b341a4dfd169807f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDisplayMode.js\":\"3b1071391c82d57b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyRowCreation.js\":\"39956f402f9af75a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertySchemaCreation.js\":\"233728f6c0ba3b01\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertySeeds.js\":\"25830e511c52e73a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/recentsPage.js\":\"f3fffaf91f0584e4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/refTargetComparableProperty.js\":\"0ac9848c08178582\",\"/knowledge-medium/pr-preview/pr-1924/src/data/referenceBlock.js\":\"94c013c71b7b7c50\",\"/knowledge-medium/pr-preview/pr-1924/src/data/rejectedUploads.js\":\"e1bf8fbb47bad3bf\",\"/knowledge-medium/pr-preview/pr-1924/src/data/releasePowerSyncConnection.js\":\"703c76d5ca0ffeb6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/repo.js\":\"1c9e98446be0564a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/repoProvider.js\":\"e7f64bfd805eefe4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/rowProperty.js\":\"437b0de83c9bfd8c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/searchFilter.js\":\"9ccc94e91328de00\",\"/knowledge-medium/pr-preview/pr-1924/src/data/seedIdentityLedger.js\":\"1abfe5859b5e8862\",\"/knowledge-medium/pr-preview/pr-1924/src/data/stateBlocks.js\":\"3af3429c86bdb94b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/structuralEditPolicy.js\":\"77894227f7797c39\",\"/knowledge-medium/pr-preview/pr-1924/src/data/structuralInsert.js\":\"24e5fb38e76cb1ba\",\"/knowledge-medium/pr-preview/pr-1924/src/data/subtreeDelete.js\":\"cf1f77cdf81ab5c2\",\"/knowledge-medium/pr-preview/pr-1924/src/data/syncStreamLock.js\":\"e2cf23efbc46b883\",\"/knowledge-medium/pr-preview/pr-1924/src/data/syncedTableSqlRecognizer.js\":\"915eec3acdea2962\",\"/knowledge-medium/pr-preview/pr-1924/src/data/syncedTableWriteGuard.js\":\"8d64d467d0bb616f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/targets.js\":\"b0d5df6f586e2a87\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeColors.js\":\"518c28dd43ce451a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeDefinitionMetadata.js\":\"2d952d3da0ec0177\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeDefinitionRegistry.js\":\"965353dfb3e29cef\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeExtraction.js\":\"8edddf0f838523ee\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeInitialValues.js\":\"728acc9d491fcffb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typePropertyGroups.js\":\"0bb3b98edc37969a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeSeeds.js\":\"66a0754a045a3308\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeTagger.js\":\"a6932ae05ffb3bd7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typedRecords.js\":\"762bcd819bc851d6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typesPage.js\":\"6a7427bddc2d943d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/userPrefs.js\":\"ef814e6f4f2a24a1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/userSchemasService.js\":\"16973c9c5f4f80e7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/userTypesService.js\":\"863dd9a01d6970d7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/valuePresetRegistry.js\":\"9a3c7f0993ef3b49\",\"/knowledge-medium/pr-preview/pr-1924/src/data/visibleChildren.js\":\"3e893ae81b73905f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceConversion.js\":\"4312328244060b56\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceFirstSync.js\":\"a33e7914bba81e38\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceIdNamespace.js\":\"591aa7772f5935ae\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceSchema.js\":\"ec03664670d0222d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaces.js\":\"7ad9888dee849fbe\",\"/knowledge-medium/pr-preview/pr-1924/src/data/writeAheadLog.js\":\"20b16985332d44b3\",\"/knowledge-medium/pr-preview/pr-1924/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/BlockPasteShellDecorator.js\":\"a9f44d55d3fec626\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/atTrigger.js\":\"b0d0d006e6d13005\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/autocomplete.js\":\"de49ab70b8180c96\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/codeMirrorExtensions.js\":\"f54590ac3c82307b\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/contentFlush.js\":\"fad10ab15191210c\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/defaultInteractions.js\":\"d5f050666c9fbbda\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/editSettleSignal.js\":\"91da5209ecfb7a96\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/insertImage.js\":\"70c231277edc676b\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/referenceCompletionRange.js\":\"b1633ba97680af95\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/referenceTargetTypes.js\":\"0fff1bd3e239db87\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/syntaxContext.js\":\"cdc1d2d382f07196\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/triggerMatch.js\":\"b98e51fea34944e7\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/AppRuntimeProvider.js\":\"9a42b3b505f70262\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/BlockFocusShellDecorator.js\":\"ff153cc5e0fb6fce\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/ExtensionRenderBoundary.js\":\"cc291f6eabc1fbce\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/PanelContentRecovery.js\":\"2dcb4a1ac052edf5\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/apiCatalog.js\":\"832db9081f5d209b\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/appRuntimeController.js\":\"0c49cf7d10425ef8\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/approveExtensionHere.js\":\"c984113cbc91d3bb\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/armedCutAppMount.js\":\"5385b93ad6c94fa6\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/batchableKeyedStore.js\":\"418ecf9f6bd2e658\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/blockInteraction.js\":\"a43ed9494334b3d2\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/blockSelectionAction.js\":\"ad9949ab3962bc6b\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/buildApprovalRecord.js\":\"4790ef96a61ca866\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/compileExtensionModule.js\":\"5c3d5bb5aa392e32\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/compiledModuleCache.js\":\"08565ad1df74b0e2\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/continuousGestures.js\":\"3a116b6a66f70d79\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/core.js\":\"cf50a5fe985760d8\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/defaultRenderers.js\":\"591e5323b68297f3\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/definitionFanoutAppMount.js\":\"fa3c9f033d523ebb\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/dialogAppMount.js\":\"4346b0c64d99ada4\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/dynamicExtensionSeeds.js\":\"0f4bb795cdb0cd47\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/dynamicExtensions.js\":\"229666f08439729a\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/exampleExtensions.js\":\"f9a08e4558db246b\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionApprovalStatus.js\":\"9faa78d55228121e\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionImportPolicy.js\":\"39b197b1f69c2c64\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionLoadErrorToast.js\":\"49a83199496e9e60\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionLoadErrors.js\":\"eb4fd16b96dc37d1\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionLookup.js\":\"59f399c590cbb096\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionToggles.js\":\"12c6510c34685e77\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionUtilitiesCss.js\":\"1412701596d1f7b5\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/kernelPageDeletionGuard.js\":\"effecd87f01fddb5\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/liveRuntime.js\":\"40a3f2e74cf5a58b\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/normalizeExtensionSource.js\":\"6654b8456a33103e\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/openExtensionsSettings.js\":\"8168087733408d45\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/overridesCache.js\":\"88be9ba08bac434e\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/pluginIds.js\":\"711ebbc771ce7e72\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/processorRejectionToast.js\":\"87b80a9851353255\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/runtimeActions.js\":\"eefbac59d7fbe15a\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/runtimeContext.js\":\"119adbccae6a6ef9\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/staticAppExtensions.js\":\"a357551ef1add851\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/staticDataExtensions.js\":\"3127f8452ecf5c68\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/toastAppMount.js\":\"2ac74d303e9b90af\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/transpileExtension.js\":\"ed07d056adb8dba7\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/useOverrides.js\":\"7b817b39cf56e6ce\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/useShortcutSurfaceActivations.js\":\"fba5e8723d6da3e2\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/discoverToggleTree.js\":\"727289b511e740e0\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/facet.js\":\"f827b4e699180a0c\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/resolveAppRuntime.js\":\"e9aed4441dac0c6c\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/runtimeEvents.js\":\"a0d905e0450dd52f\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/togglable.js\":\"55be41952cf55e3a\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/variantFacet.js\":\"70484f39e9b19dec\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/verbFacet.js\":\"6c79a201056cd3f7\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/block.js\":\"726d4117138db045\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/focusedChild.js\":\"98c3d269a51f8730\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/propertySchemas.js\":\"7a5d9545f6366e05\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/typeRegistry.js\":\"11595226b2d277d2\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useAncestorCrumbs.js\":\"d84818530c9264c7\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useAutocompleteListbox.js\":\"b98eab7de5def712\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useDebouncedSearch.js\":\"866f4f273947cf32\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useDebouncedValue.js\":\"833345c801ca40da\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useFacetValue.js\":\"94e556957eb02515\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useIsFocalRender.js\":\"77ce32355a9aea2c\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useIsReadOnly.js\":\"cbbec777dfca7fdb\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useMaterializeBacklog.js\":\"bab209dfdf85d185\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useMinuteClock.js\":\"25e6811caf958f9a\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/usePanelLayoutProjection.js\":\"9552465833059101\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/usePendingInvitations.js\":\"85c9f5cb9342f24b\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useRendererRegistry.js\":\"3fc2e5990355bcc1\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useRetainedFieldRows.js\":\"5d8c54cb37354e08\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useWorkspaces.js\":\"6a315cd8eb3b07a5\",\"/knowledge-medium/pr-preview/pr-1924/src/lib/utils.js\":\"f5a666c44db87b9a\",\"/knowledge-medium/pr-preview/pr-1924/src/main.js\":\"c6e12cd7f47affae\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/MarkdownImage.js\":\"3d5da87d1f009594\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/blockSeparators.js\":\"5fe2f062754643cf\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/context.js\":\"e59e9b7258076b70\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/defaultMarkdownExtension.js\":\"f257b1300a90c7ed\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/extensions.js\":\"e762275e70bb93a9\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/renderMarkdownHtml.js\":\"34fbdb2c60ef0f98\",\"/knowledge-medium/pr-preview/pr-1924/src/minimal-editor.js\":\"c1d04aac9a4a2ebe\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/armedCut.js\":\"104593e27335ff55\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/captureMediaVerb.js\":\"2e9bf40b89e83e09\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/clipboard.js\":\"249a473dbee0dfb3\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/decision.js\":\"a26b5c4bcd461082\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/operations.js\":\"8a2c9e5d132b6178\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/account-header/AccountHeaderItem.js\":\"4d9efc6f4834c3b9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/account-header/index.js\":\"a1e1dd9f92db5f72\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"bbfafff545abd4fb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/askAgent.js\":\"c7f68505b4843d30\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/askedStore.js\":\"599036c2ec35bb6f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"0b35b250c6934f0b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/chipState.js\":\"6bde807d0b620656\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/dataExtension.js\":\"4d4d8f15eb3c1bd1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/index.js\":\"4984bba5630f214b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"59c37e5574d26533\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/retryAgent.js\":\"b09da4358384cd48\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/schema.js\":\"7313a94b348826cc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/AgentTokensDialog.js\":\"3188b9b5f2355a78\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/BridgePairingDialog.js\":\"a2c9d7d72ec55f1e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/addMedia.js\":\"cbf58c7d6a00e129\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/backlinks.js\":\"a7c7a5320410f6d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/block.js\":\"095d338119790b40\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/context.js\":\"81c14cada68a37db\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/displayIds.js\":\"41b632aff43249f0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/index.js\":\"3feb172a7c11af35\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/outline.js\":\"ae8589c371c50fc2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/properties.js\":\"57ae08a9e14a24d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/refs.js\":\"047e19c08fb83d15\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"35565ab253e51a27\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/search.js\":\"e9a4fa12d8a6a62b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/shared.js\":\"b809010b7eadd0fd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"94065647cd083b92\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/text.js\":\"6d23c46279f03c80\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentWrites.js\":\"cf5d75e70515df94\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/authoringCatalog.js\":\"c877ac6a40ef67a1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/blockRefTargets.js\":\"0e1260add450b772\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/bridge.js\":\"fcdb8675340418e3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/bridgeLoop.js\":\"9e17ef3250bbb1d7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/changeHistory.js\":\"be8f514c0045d648\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/commands.js\":\"ded33353ead701e3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/commentsCommands.js\":\"c7f611d98368d4af\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/dataExtension.js\":\"53c4d755784c0c44\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/dataModelGuide.js\":\"f7f862aa6e65c0d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/dayPropertyInputs.js\":\"56265d700baf1c4c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/describeRuntime.js\":\"347cf01c458d0a9b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/extensionLint.js\":\"fc4b923c58848990\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/grainAudit.js\":\"466f0479c19dfa6f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/healthCommand.js\":\"0329c1235b52b99c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/index.js\":\"caa5e96693912561\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/presetIdentity.js\":\"41b172aaa5d4663d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"ec2fb74f7f65ee6b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/readMedia.js\":\"a1c1b84923d68656\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/schema.js\":\"2aaf4f82e5df2e14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/serialization.js\":\"9d1c8d9f04383742\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/targets.js\":\"1b5ab939a6ccf218\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/tokens.js\":\"02afd6417e6c0afb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/watchEvents.js\":\"b3236b90010e6fb9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/workspaceGuard.js\":\"3d265d4e7b1f266f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/writeCommands.js\":\"74d37fe37266db1a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/AliasCollisionToast.js\":\"ade1ff1d382e3a42\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/DuplicateNameBanner.js\":\"26b5db88e8968a42\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/collisionMerge.js\":\"31e80c27281feadd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/dataExtension.js\":\"28accdd6fcbf1ba4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/index.js\":\"91bb376da732b2d6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/mergeCollisionAction.js\":\"4e48d23157be2742\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/pageStyling.js\":\"aad22f4af5247f13\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/rejectionToast.js\":\"77b196151445da14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/syncProcessor.js\":\"42d7a5a121e1c19e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/actions.js\":\"fbb4ddbabb474389\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/addComment.js\":\"cd6e2d05a1239c20\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/anchor.js\":\"94c3e8102cf0bef6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/anchorState.js\":\"8e924fbcbbc560e8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/commentLinks.js\":\"18987497154b480e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/confirmThreadDeletion.js\":\"24a7119ce82a5984\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/container.js\":\"b352e5f98e434354\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/dataExtension.js\":\"ef96db1c6cc3f157\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/deleteComment.js\":\"7f4b8b5be3fbc478\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/highlights.js\":\"5392580e973c99f5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/index.js\":\"7e86c3ee08335a2c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/linkedCommentsPill.js\":\"ee8a92a31f17bfda\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/margin.js\":\"69177d8c0f39a2b6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/marginAnchorLinks.js\":\"9ce4a700e68a0b71\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/marginSchema.js\":\"6d7b773d87dfed6a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/newComment.js\":\"241d64493e70db41\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/ownThreadPicker.js\":\"616d64277932486c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/placement.js\":\"e93d4f37592798e2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/queries.js\":\"32ac311b9964f7d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/quotePosition.js\":\"503aea6a7e3f6deb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/quotedIn.js\":\"6d2fd7b4df7d1307\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/quotedRange.js\":\"19fb51554c8f1ecc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/rangeRefs.js\":\"2b80eac73d5123e3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/readHighlights.js\":\"4da387919056031f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/readSelection.js\":\"1fc9eac0f333c513\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/readSelectionUi.js\":\"57b40f89fb810230\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/reanchor.js\":\"431d3a9fd6adafba\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/schema.js\":\"60d84ee30804543e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/scope.js\":\"5603a242d289d378\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/scopeThreads.js\":\"de8d4d8a3a5a4956\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/splitRetarget.js\":\"0b7f6151211bbb31\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/suggestionCard.js\":\"e5e59ec3ce0b5a76\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/suggestions.js\":\"9cfad19d737994fe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/summaries.js\":\"bcb52e109569810c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/summaryBatch.js\":\"f4faa183a94599ef\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/surface.js\":\"24cc9b6c7432872d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/threadNavigation.js\":\"082f1da3e1e19b36\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/threads.js\":\"c8f7ff9bc5305a51\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/ui.js\":\"de1f4667d38f912f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/uiStore.js\":\"50d0965dd88d3b0c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-intents/appIntents.js\":\"12e0bf88b20abe7b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-intents/index.js\":\"6131760826b876f1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-update-prompt/index.js\":\"8a7fe830df9a36cd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-update-prompt/status.js\":\"6b834eab552ab90f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e7a9f452b97617e5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/MediaBlockRenderer.js\":\"0024e086df987832\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/MediaDownLaneReplicator.js\":\"853c25fa4c0c4c9e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/MediaUploadReconciler.js\":\"de69538c01c46265\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/assetDownLane.js\":\"e18cd0114da6290c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/assetResolver.js\":\"84f3165cc30c5d6a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/assetUpload.js\":\"b06dad478ca0580f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/attachmentCleanerIO.js\":\"dcdb813be0cb47d8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/supabaseAuditIO.js\":\"f77d9f91c90fd91e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/blobStore.js\":\"9f9cda00ce190f5b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/browserMedia.js\":\"bc62f3c4d245cfa6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/byteStore.js\":\"37f5f92cddcfb44e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/cleanerIO.js\":\"3b13c52886c0730a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/cleanupAttachments.js\":\"a84ad81d3d083f28\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/dataExtension.js\":\"ff2159a038ba3f61\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/downLane.js\":\"1bc196f379065acb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/index.js\":\"4a0ff82d61177a56\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/insertImageContribution.js\":\"b84f31e7af0961f8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/laneArming.js\":\"893c4e30173711a9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/laneLock.js\":\"d5fb9d237cba2da2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaBlock.js\":\"d6acb28901e33105\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaCapture.js\":\"2b0ad6789c097da3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaLanes.js\":\"b2110d2304654569\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaViewers.js\":\"d6439b2a88cff150\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaViewersFacet.js\":\"8b4ac0fd54884cf3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/pasteCapture.js\":\"ade0d46655378b63\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/resolver.js\":\"3b1f6c7c413af7a9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/retryUploadsAction.js\":\"ab3f85d37d283a03\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/storagePaths.js\":\"2df445f102e15b8f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadDrain.js\":\"2a10a572f2fd6259\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadLaneStatus.js\":\"e82e7b692e0d7472\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadReconcile.js\":\"39ca5a8092a68da4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadRecovery.js\":\"38bda07ad2251e60\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadStore.js\":\"a04de520d51085c3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/useAssetObjectUrl.js\":\"ade8a8f897083334\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"dbc7dc619d9808c6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/BacklinksViewSection.js\":\"3ed4097e197ba883\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/facet.js\":\"14fba19fcc58591e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/index.js\":\"0e99ec75425db1eb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/prop.js\":\"2be30f1168231076\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/BacklinkFilters.js\":\"c5def3544e9dd59b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"a287cf466185206e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/BlockEntry.js\":\"677352e486de9b3f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/LinkedReferences.js\":\"c7ad29ca13b298d4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"573b900851153b25\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/dailyNoteDefaults.js\":\"03603a2d878fb88a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/dataExtension.js\":\"5c5d6a1d5079c58b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/edgeExclusions.js\":\"63ff2545b7fae5d5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/filterProperty.js\":\"f84f4235bdcf1354\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/index.js\":\"1528b27036ab5ecf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"ac56501be9b8ed79\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/applies.js\":\"980fc718d9646ae4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/countQuery.js\":\"d1bbe2611ecd56cd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/expansionStore.js\":\"9ab0a12472f1ec4c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/index.js\":\"997af6fd5e9a5015\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"3ebe11f45333356a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/presentationInvalidation.js\":\"af91dae29677be08\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/propertyEditorOverride.js\":\"9a3c22e123d5681d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/propertyFilter.js\":\"fd2c9d3689862142\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/query.js\":\"e73823c5ab4466d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/resolveFilter.js\":\"1d9fda0f24bd62b0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/sourceBatch.js\":\"ea7ca347ab49fc85\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/sources.js\":\"13967655b59dc535\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/useBacklinks.js\":\"83015e5f2e35b6ef\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"3f87b0c42c35e213\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/BirthdayCelebration.js\":\"9c1d71a7a1954dcc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/BirthdayOverlay.js\":\"ba1f2454a75f9374\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/gate.js\":\"f920c962a77c2042\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/index.js\":\"b87214b212caf22e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/wolfTheme.js\":\"5bc186d7886aeb62\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/BlockDragLayer.js\":\"5857e5b65fb9491a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/dragController.js\":\"7f0252f466f6c31f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/dropTarget.js\":\"ceb1f4f41398b3e4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/index.js\":\"8c5b7618c583c7a3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/projection.js\":\"a73badd546f6029e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-info/BlockMetaCard.js\":\"47e972637fd2baaa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-info/index.js\":\"231c79bd29f63d4f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/AddTagDialog.js\":\"39d1400216fb4145\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"63746dd2d57365db\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/TagNameIssueHint.js\":\"2a1086a578114c8f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/addTagAction.js\":\"2885dc101cfec582\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/appendTag.js\":\"14aea16642e0396e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/config.js\":\"4150137221804257\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/dataExtension.js\":\"0cf21ee29e8e1b9b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/index.js\":\"4079938ef2ee560d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/propertyEditorOverride.js\":\"a0644036af7d453b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/BreadcrumbList.js\":\"4e510ec9113b38e9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"be289a92e1d70095\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/Breadcrumbs.js\":\"f0cfdc717671040a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"2f9cf470a096cfbe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"434b869855ba8ecc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/index.js\":\"b8ac0057f478a067\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"5a6fe7889763a1e5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/CharacterCountItem.js\":\"447d8b48fc18c835\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/ProfilePropertyEditor.js\":\"825e1e879cfb8b43\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/actions.js\":\"f3a444afff053d14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/blockType.js\":\"e4c7770c3212059a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/charCount.js\":\"82c303805c318e7d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/dataExtension.js\":\"b77f6c71d2332b75\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/index.js\":\"9100d8bb1536febb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/profiles.js\":\"68f89deb74914d14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/properties.js\":\"74f6ed5ec9d5c53f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/subtree.js\":\"63879a2d16d32412\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/textCounts.js\":\"b03f4c52b6755199\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/colemak-keybindings/index.js\":\"9cec75f3794f3022\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/CommandPalette.js\":\"6c856d03dff1a926\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/HeaderItem.js\":\"1dc87380f1b43758\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/context.js\":\"4087c1591c4651c9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/index.js\":\"eaa4f161147721c2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/selection.js\":\"3f2e7f2de5a2afd4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/toggleStore.js\":\"283567a1743000da\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/useCommandPaletteActions.js\":\"62c94ca80010fa7f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/ContributorBadges.js\":\"d61e4fa26dc632be\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/ProfilePicture.js\":\"1f2db7a5ec56489e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/author.js\":\"70645a9fde100def\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/codeMirrorExtensions.js\":\"49a232a72015fc2a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/dataExtension.js\":\"d505b5b02d703b58\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/index.js\":\"396c75869510c65f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/mentionAutocomplete.js\":\"b62d75feacbf3a05\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/processor.js\":\"4717338a543de42a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/profiles.js\":\"cd56f0fad39b0a68\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/queries.js\":\"f7aa8e5cdea1fb63\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/schema.js\":\"061dfe1861ada7de\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/useCommentAuthor.js\":\"7cdecb5ab8a5c9c7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"27c25d5ae4c42a03\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/followOrigin.js\":\"b6aa74ea03af992b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/index.js\":\"95ddd48a8020bd1d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"2196b71d48f0fcfa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"5d15597207c12764\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/CalendarGrid.js\":\"a10742a934dc93b1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DailyNotePicker.js\":\"32e6faccce6e435d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"3cc3c4a9b8fa948d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DateNavDecorator.js\":\"ec152413acd6457c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DateScrubOverlay.js\":\"4f605d5dc976834b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DayPropertyControl.js\":\"25e3332b884696e0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DayValueReferenceControl.js\":\"5fd33acc299ee5cf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/HeaderItem.js\":\"e30d791a4871ae9e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/ReschedulePicker.js\":\"a1604f306ba7d2d2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/SpreadDatesDialog.js\":\"314f82eef450a70a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/actions.js\":\"d3e9f22e07085001\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/blockDateAdapter.js\":\"6a5131d1e450aa43\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/calendar.js\":\"e3bd1fc19097eaea\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dailyNotes.js\":\"b2ee4b1fa2cc1b37\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dataExtension.js\":\"07b6c503ebcf8afb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubActions.js\":\"54507a3136ebc709\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubGesture.js\":\"8e67021b2284e1e6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubGestureActions.js\":\"f1ba0f7a7b580d45\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubRecognizer.js\":\"82821c1f57bf9842\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dayProperty.js\":\"ddcb7b806afd04dd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"49ae998885b6dac9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/deletionGuard.js\":\"1d2e64fd01864554\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dueQuery.js\":\"306752686dda6802\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/index.js\":\"9a7e62d2c6c714c6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/landing.js\":\"9e281cf806af3218\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/localSchema.js\":\"6426f2a89e4c6b55\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/referenceDateAdapter.js\":\"b506524abf8c5cd8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/rescheduleAction.js\":\"b6d9844c5079ddb0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/schema.js\":\"23804eb310ed5e7a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/spreadBlockDates.js\":\"b8b6aaa26cf8a989\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/spreadDatesAction.js\":\"89e2c855b94dcc8d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/today.js\":\"4cc2ac7397efebc8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"3bb36231e668d98c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"4677325c05607270\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/audit.js\":\"8da1abe64da6abc3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/auditAction.js\":\"d0c69ddb59001a7f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/auditRanges.js\":\"e45ea0324a6a0c59\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/diagnosticsSource.js\":\"fffddffed8e14eab\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/divergenceScan.js\":\"7e2400ffe2d07e8b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/index.js\":\"50449ce219478654\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/propertyChildrenChecks.js\":\"e378788803bd43f6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/referencesMirror.js\":\"73203dd9d620f302\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/rowJson.js\":\"5af0d4ec6832b33d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/schedule.js\":\"c9fc7eb222221468\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/store.js\":\"3b3201bfee4ef597\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-maintenance/action.js\":\"e26a79216ac30f0a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-maintenance/index.js\":\"8e184d14606f7717\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-maintenance/plugin.js\":\"74c01c6aae4db0cb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"bb27d5218f059d9c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/actions.js\":\"8a03d3612eae3ba8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/changeMarker.js\":\"e8357b85de7d2f72\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/diagnostics.js\":\"3f877c22aad15404\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/fileSystemAccess.js\":\"fdc0f63319cd2262\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/filenames.js\":\"e5a76c1b7f2d4993\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/index.js\":\"7641ed2c4680353b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/mirror.js\":\"4c358bc0350f5985\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/runLock.js\":\"b04a78a74cc2a267\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/runtimeHealth.js\":\"f9a06c7f4cb87ee4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/schedule.js\":\"77caea67ef70ef7a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/store.js\":\"f5542c063f34d86b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/default-themes/index.js\":\"354b11742dbfbd30\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/default-themes/themes.js\":\"40d5bc1c973da407\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/diagnostics/facet.js\":\"f4331a5e8ea92e80\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/diagnostics/useDiagnostics.js\":\"ccc89b9a6623f3db\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/dismissals.js\":\"d4de05ddef619981\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/index.js\":\"f812fe325c955c55\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/status.js\":\"f1ddefd40af0b4ae\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/store.js\":\"322232f745e07e01\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"2d52786814d9a999\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/ExtensionsSettings.js\":\"16df2a1abd105487\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/actions.js\":\"0f02dcd00a4eb695\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/config.js\":\"81b9a227ffdb9bf3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/dataExtension.js\":\"72991285039fa836\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/effect.js\":\"62f03cb27dc9145f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/index.js\":\"1f0602cc5eee5662\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/propertyEditorOverride.js\":\"04bd6cb1b55fdd82\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/useToggleTree.js\":\"c167f8b17be43925\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/ExtractTypeDialog.js\":\"2022a898655a0101\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"138180645c7935da\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/PropertyShapePicker.js\":\"386c2b1127b1b690\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/action.js\":\"59665b729e240f68\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/index.js\":\"e2f7ebf720e13673\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/FindReplaceDialog.js\":\"043ee0ce35701104\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/HeaderItem.js\":\"530cc2fcbf77b7f3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/dataExtension.js\":\"4e1aa1bf237e0b90\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/index.js\":\"76a74a6ab43dcbe5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/search.js\":\"d53f662f4fbe62d8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/toggleStore.js\":\"74050045fd67b65d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/LocationPropertyEditor.js\":\"f352b935cf33d713\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/MapView.js\":\"7587bafbdafb3190\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/blockTypes.js\":\"4cfd0095b392f086\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/codeMirrorExtensions.js\":\"04b4dd0c1084c717\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/createOrFindPlace.js\":\"03ee6b77a5f115be\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/currentLocation.js\":\"332d8df4dc06a0f1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/dataExtension.js\":\"d4e2b5e5ba55e970\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/geoContentDecorator.js\":\"6e4f398cfe848779\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/googlePlacesClient.js\":\"9a3ac6bd54500506\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/index.js\":\"c95312a5982ca07d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/locationsPage.js\":\"3ddbe1766a8c968a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/mapViewport.js\":\"9f087b1e12658205\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/pickCurrentLocation.js\":\"56d63b226125288d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/placeAutocomplete.js\":\"e5faad291e32d8f2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/placeNameCollision.js\":\"8ad24a1e6f9d6d13\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/properties.js\":\"e464e049ef06483d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/propertyEditorOverrides.js\":\"88b015c772cbd91d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/query.js\":\"e05b865fcbb5e48a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/usePlaceSearch.js\":\"f3e9ea02103bc86d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"831bf2bcb2e6bf69\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"93f8dd04ab067f90\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"afc8776149a8bc28\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/config.js\":\"b3e42bf6b6582d5f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/dataExtension.js\":\"9a09be627ea117b8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/facet.js\":\"efeebaa7321d54c2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/grouping.js\":\"793bd11f936eefcd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/index.js\":\"95424406ca17020a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"77d97cf33be806e2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/query.js\":\"a1b2fbeaf7b85c5a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/resolveConfig.js\":\"e7e97fa27c6259d6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"d693502b6aeda58b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"1e22ee203c4cf0a5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/HtmlDocumentContent.js\":\"00591d4622d7ace8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/HtmlFrame.js\":\"05afc776758d338b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/actions.js\":\"453fb4d793b7b28c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/blockType.js\":\"b8c3c7a4a55c16f6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/confirmRunScripts.js\":\"e1d91982416729b1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/dataExtension.js\":\"fc7d067b8706a8fc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/frameAnnotations.js\":\"ac60d13cbd88c025\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/frameDocument.js\":\"e097981ff9935d87\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/frameTheme.js\":\"2de8b9e4a355eaaa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/index.js\":\"c3f8fc9398430262\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/scriptConsent.js\":\"d4748ca43ee270d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/sourceMap.js\":\"f2147d959f5e86a5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/useDocumentScripts.js\":\"780628344d395b27\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/index.js\":\"d42ca38bf5a4d0a1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/record.js\":\"0dc23c816332b196\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/recordStore.js\":\"03d43689eab70d28\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/responsiveness.js\":\"f94acecf071e540d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/schedule.js\":\"d4a57b1c41b4f2eb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/sessionContext.js\":\"1a183c37ad3788b6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"2de3d1ae3f12f79e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"1715a67597bcae34\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/actions.js\":\"24f5538159d9627a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/config.js\":\"074b207b2887e0de\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/dataExtension.js\":\"369d76681ed842a4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/effect.js\":\"88140391a52c5ffb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/index.js\":\"2383040be47cd78a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/keyCapture.js\":\"774fe8a8de806b35\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/overrideStore.js\":\"b6eeb2a31673a971\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"fdd4be435d8a5e46\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/HeaderItem.js\":\"0b12f36cc9f8b002\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/LeftSidebar.js\":\"733b2956a1f5f078\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/actions.js\":\"0fdee392c3348048\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/facet.js\":\"38f233ab2c30b17b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/index.js\":\"253eece4e7b4710d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/shortcuts.js\":\"6dba7abe5443ce08\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/toggleStore.js\":\"5837a41cb8b4fe05\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/MergePicker.js\":\"478e64eab01f53b0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/index.js\":\"78ba5550cf1602c0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/mergeAction.js\":\"43a0bc0fefbd8585\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/strategy.js\":\"aa89313ab8a2aec6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/Button.js\":\"3e03b84ed48df94b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"e66808c4b20be38f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/defaultItems.js\":\"cfa25fb8368496d4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/facet.js\":\"5c06f2aa1ec3babf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/index.js\":\"2a1676accec0396c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"5a5002d270860acf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/actions.js\":\"6b4c6fe57ebe9496\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"85f98c62070cf66f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/facet.js\":\"9ff086901618ab84\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/index.js\":\"c5f93aea55b95334\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/MoveDestinationPicker.js\":\"128adad5b9ba8c1c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/blockSubtreeMembership.js\":\"b6ecbdf1d38d6252\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/contextMenuItem.js\":\"e659c1b36cab32c0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/index.js\":\"c78986c4327826fc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/moveAction.js\":\"f2d75b39db5e8b1f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/moveBlocks.js\":\"7f043fe19370e80b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/selectionAfterMove.js\":\"adccb4a847a78b3b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/TutorialBanner.js\":\"6793c845f28d43e5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/action.js\":\"37a5c0f61a6a16bc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/bannerDismissal.js\":\"2c7b9c88a1c6ead8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/documents/cheatSheet.js\":\"e762f8da938dd1fc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/index.js\":\"9f5b3d9b8bc60c7a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/keys.js\":\"b2834dc279316d7a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/landing.js\":\"c5c01dfc32bb1f86\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/outline.js\":\"ff042daf5329244a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/seed.js\":\"51d1cc6465596ab4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/PerfTrendDialog.js\":\"dc0db0710685a57c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/analyze.js\":\"27bd9a2a43a80d08\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/diagnosticsSource.js\":\"5ce641eab6295681\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/index.js\":\"4691edfcc0374f75\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/load.js\":\"99ce9c8f51fddaa6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/monitorRun.js\":\"4772474ef802a30e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/schedule.js\":\"58e4afd4334deef6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/series.js\":\"936d5cb7b02b8525\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/store.js\":\"aa4d14c95cb22f09\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/trendAction.js\":\"ba41deeefe70d844\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/verdict.js\":\"57e895e371cd5aab\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/plain-outliner/clickToEditAction.js\":\"0ae314efdcedcc0b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/plain-outliner/index.js\":\"1b6824d37ab5fb39\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/plain-outliner/interactions.js\":\"216bb7c010e84cd7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"87b9de018e977a21\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/MigrationGate.js\":\"c71bfe9806599286\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/MigrationGateDialog.js\":\"09fae6f910ff30cc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/action.js\":\"ae0425e05121a3b8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/index.js\":\"b2a6d7139739d595\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/localRunMessage.js\":\"c9c3912eede5488e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/plugin.js\":\"3db388b32b7c527a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/progressReport.js\":\"1cb147b6c2370db2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/sweepProgress.js\":\"b142ab93ec494d2d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/FieldRowRenderer.js\":\"36def99a28a2500d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/ValueRowRenderer.js\":\"78984dae0e995da6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/actions.js\":\"f9e37aee31910d72\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/autocomplete.js\":\"7626c2eee8d157d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/fieldRow.js\":\"ead3e68fd42d9e48\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/index.js\":\"1cd6279aaabedbcf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/referenceWarning.js\":\"a25e04b9bbf4fe89\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/valueAutocomplete.js\":\"dfc7b330cbf84066\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/valueSchema.js\":\"bec80b411e6f8479\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/HeaderItem.js\":\"e8bcf7fb09cceabf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/QuickFind.js\":\"47d6f044ba1ce9dd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/index.js\":\"b8349510d126f7c8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/recents.js\":\"5368afe5e0ce5481\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/resultItems.js\":\"9930364e22f30b38\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/selection.js\":\"4a0cba0b15755e9e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/toggleStore.js\":\"09c34b74412cb68d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/HeaderItem.js\":\"299d6380949555e2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/RecentsPageBlockRenderer.js\":\"cc69ec8e6e3a85d2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/grouping.js\":\"f19c158194f0cd34\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/index.js\":\"164362605e2215d0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/target.js\":\"80867e8d57a56f79\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/codeMirrorExtensions.js\":\"5fa4423f82fdc503\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/contentPrefill.js\":\"f883de507f3bd5fb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/dataExtension.js\":\"4311e11909fe339d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/index.js\":\"1bb73a864f0f2a9b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"94f0041bd62d8f20\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/invalidation.js\":\"ae162337f213a603\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/localSchema.js\":\"5997ffedb55d330b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/blockrefs/index.js\":\"51eb2cfbc06c57a0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"86747750d51e1cff\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/index.js\":\"f48ef8b3358c9a19\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/referenceNode.js\":\"2be93471677c1e87\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/remark-reference-occurrences.js\":\"0f7a59c00383a182\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"2f8d5f97e27a67f4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/index.js\":\"b1f20623a010c684\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"bcdb9b694bf2ec71\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"a5fa4c767efec2c7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/mergeRetargetProcessor.js\":\"8f6ab2d8cb67b3f8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/parseFence.js\":\"55ace2727af5b250\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/referenceParser.js\":\"535f8a9cfd49d05c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/referenceProjection.js\":\"f1f4b093ea4149a4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/referencesProcessor.js\":\"2194e75a129875a1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/renameProcessor.js\":\"8b3a543941a46929\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/spanReplacement.js\":\"0899634edc6c820d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/htmlToOutline.js\":\"57a7eb1595cc6c50\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/index.js\":\"48b0d410a5eaeaaf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/normalizeClipboardDom.js\":\"051282134d863ef7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/pasteDecision.js\":\"43cfcd63ffda7362\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/action.js\":\"3e58154d8939eda3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/blockIds.js\":\"b0b1b7793aab630a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/content.js\":\"ffa03e0a0422b900\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/effect.js\":\"1ac25b239854a595\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/ids.js\":\"5a317f188afe05ae\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/import.js\":\"6a60d71e37d66411\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/index.js\":\"d319c9dfb0af7715\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/plan.js\":\"d151d8761703b563\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/plugin.js\":\"8711d25d271c4f2d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/promotion.js\":\"a1a6148a7d804c59\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/properties.js\":\"51b45ac78acb756f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/references.js\":\"25c78b30462185ea\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/report.js\":\"eead145694be06a6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/roamMemo.js\":\"e34a90b5c51f2b24\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/runtime.js\":\"453dc13e7f266913\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/schemaReconciliation.js\":\"b9c899f4bc2737e7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/srsMarkers.js\":\"6ae53bacafcd3010\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/todo.js\":\"c514cee3a8477187\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/typeCandidates.js\":\"d551759bb24ab7b4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/types.js\":\"d6e8d19edfc31dd6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/search-health/index.js\":\"58cd0332a17225f2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/search-health/store.js\":\"4674e5346158356a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/HeaderItem.js\":\"3d72a50a0d43fde0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"7d60b7d369c200bd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/index.js\":\"f2f64b51fee83d46\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/model.js\":\"118606e4f4078668\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/toggleStore.js\":\"5ddf65f6ce94f0de\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/useKeyInspector.js\":\"19f85b3d031f2fc5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"3dd672f2e9782a63\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/ShellDecorator.js\":\"fa47f9327911e0fa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/actions.js\":\"ef532e0898d1de06\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/exclusionsFacet.js\":\"dee40b6526d0e32d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/index.js\":\"a145fedfcef2b782\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/shell.js\":\"e922f59205e0e6e6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/surface.js\":\"bd8d0f97d99e9e37\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/walker.js\":\"deb3bc184cb77032\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/RescheduleToast.js\":\"1b5ac36a85db9f7e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/dataExtension.js\":\"3463418006faf68e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/index.js\":\"03f9e68b992e737d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/indicator.js\":\"97bc57c3e0256fcc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/moveSrsState.js\":\"579443270374bcc0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"e9bd0eb75e7dbd7a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/scheduler.js\":\"f6a8f88926840650\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/schema.js\":\"5f373b405130b05a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"e0d29453aee63cfd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/srsClipboard.js\":\"f983d8d149140d6a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"f065e18704ad1429\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0a90d6f88a835ef9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/DeckPicker.js\":\"8d7bf01a5d7f7fcb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/ReviewControls.js\":\"0b937ab43eb1b08a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/ReviewDeckRenderer.js\":\"7cb7ff7e2cdfe67a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/ReviewSession.js\":\"9d643d4373f23c45\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/actions.js\":\"3390cbb4f2ab0313\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/archive.js\":\"0d0c9130a5a4513e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/dataExtension.js\":\"92d03ec2c9e6b33c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/deck.js\":\"79e21cdac1a17575\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/dueQuery.js\":\"4bd6be824efea0d6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/gradeDecision.js\":\"5bd20de6656147e4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/index.js\":\"a5755d01bf419d00\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/keyHints.js\":\"61b87d22092a7a3e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/reviewCardLayout.js\":\"a8486753e287016d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/reviewProgress.js\":\"d30bb5aaebad1650\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/schema.js\":\"a60e7df5284bf07d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/useDueCards.js\":\"f1890026292cc48a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/startup-metrics/index.js\":\"96b977be6f88f20a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/startup-metrics/record.js\":\"074c7607a3aa3e30\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/storage-persistence/index.js\":\"96f08ace530f13fe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/storage-persistence/persistenceStatus.js\":\"c184cb32474e7262\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/storage-persistence/requestAction.js\":\"0cf1add661578c41\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/TypeChipsDecorator.js\":\"ce64e5237d7002b3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/codeMirrorExtensions.js\":\"4fc93dc38c47c628\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/index.js\":\"29ab2dfc1599dd40\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/typeAutocomplete.js\":\"b3cf104a92b0eb3e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"10e9cbb36c75a898\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/actions.js\":\"f54c8815c885d408\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/anchor.js\":\"ec9d02203a5febec\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/events.js\":\"332da0b9f8ef3cbd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/gestureActions.js\":\"1ddc1d8e350a04f9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/index.js\":\"48790b5c33446a5f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"8e422b6a17e096c7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/sync-metrics/collect.js\":\"9ca20a325cbea888\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/sync-metrics/index.js\":\"c27dfa0162f9a4e9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/sync-metrics/record.js\":\"8ce70c665524d882\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/RejectionDialog.js\":\"9e8a70612fe3a2b0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/SystemStatusHeaderItem.js\":\"dc620d24e81719ba\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/index.js\":\"05b5eaf8030aa209\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/model.js\":\"b14f68a3c7b02604\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/queueCounts.js\":\"a099c3b845db423e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/rejectedHelpers.js\":\"2b9735b3e27e62d5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/rematerializeAction.js\":\"7f34621579324bcb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/useHysteresis.js\":\"574307bf66a33ff6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/ColumnHeaders.js\":\"645f7745d4b8d01a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/QueryUi.js\":\"7c6ab534da3ccf5c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/TableLayout.js\":\"75f81df192b969a2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/actions.js\":\"e3d3f0b05041901e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/cellEdits.js\":\"cf5b2f9f4ff87177\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/childrenViews.js\":\"a66171b9b88b58ca\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/columns.js\":\"b0ec8b7f14c5632f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/controller.js\":\"a4806abe296cc4a3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/convert.js\":\"06d1e6429f839bca\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/dataExtension.js\":\"a6c9aa80593dff87\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/index.js\":\"dd46869bbb49f2ca\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/keys.js\":\"277431797a72456a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/model.js\":\"8d0b472667c7f057\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/QueryText.js\":\"85df719222221fc7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/backfill.js\":\"73521d17989a6623\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/completion.js\":\"cf2d599f2817e841\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/format.js\":\"71bd623d5d6e2d6a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/parse.js\":\"a823f70dca4b910b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/queryValue.js\":\"03a99cb46192a123\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/registrations.js\":\"5ac4b1da178fb957\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/source.js\":\"f9f059b0d12638e3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/registry.js\":\"5ebfc7000c3f71b4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/rowGutter.js\":\"dc5ecab90a4d9b4f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/rowVerbs.js\":\"c30379bc1546c871\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/schema.js\":\"e2f7575ae185d3fb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/sort.js\":\"b4a7323fda4c9067\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/theme-toggle/effect.js\":\"1addaa12c55c9eb5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/theme-toggle/index.js\":\"9e05cedac2a37b71\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/theme-toggle/theme.js\":\"042d666f735a3197\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/actions.js\":\"2bf2eca14f37dfd7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/dataExtension.js\":\"4257fb92496ca415\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/index.js\":\"7df7d27c9d164850\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/schema.js\":\"ce659e8dac637a57\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/TouchSelectionLayer.js\":\"1cabdf8a8a38dc8d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/actions.js\":\"adac07f3e27ae3d4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/defaultItems.js\":\"3ef410a5b610876a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/facet.js\":\"e8718404c446ae35\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/holdRecognizer.js\":\"fb7f39488bcb5181\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/index.js\":\"d4f2026582ef0b68\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/update-indicator/UpdateIndicator.js\":\"9504b281bd47c91d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/update-indicator/index.js\":\"fffea16287c01e74\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/update-indicator/loadTimes.js\":\"931d33b7cd0f1804\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/VideoNotesRenderer.js\":\"a0ebd9000bea5587\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/VideoPlayerRenderer.js\":\"aa4f87e724a4fe32\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/VideoTimeStamp.js\":\"0b239e618fa372bf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/actions.js\":\"3734a8dea47046e2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/index.js\":\"8dbfaad9e217d711\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/markdown.js\":\"d2506b7a41f21186\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/notes.js\":\"d1a1be1b132849b2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/registry.js\":\"ccc804d8327c0fa7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/remark-timestamps.js\":\"caaceff77dd26cc0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/view.js\":\"bf06faf756770341\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/LinkHints.js\":\"3e0f796433c6a2fe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/index.js\":\"4eec176375365ac4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/model.js\":\"85b70aecef810aa1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/settings.js\":\"b5a53cc7177b2266\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-normal-mode/actions.js\":\"ad5c29796aaea29e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-normal-mode/index.js\":\"ceb9402a9e5d5629\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-normal-mode/interactions.js\":\"b34550ee57da3bfe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/workspace-header/index.js\":\"c28f9671615e261e\",\"/knowledge-medium/pr-preview/pr-1924/src/registerServiceWorker.js\":\"f0df1076bccd661f\",\"/knowledge-medium/pr-preview/pr-1924/src/requestPersistentStorage.js\":\"f63492a7af073aa3\",\"/knowledge-medium/pr-preview/pr-1924/src/services/authRequestDeadline.js\":\"98351ce4e68d1ebf\",\"/knowledge-medium/pr-preview/pr-1924/src/services/authStorage.js\":\"28c17929bfba39f0\",\"/knowledge-medium/pr-preview/pr-1924/src/services/powersync.js\":\"69456bb22806b2b7\",\"/knowledge-medium/pr-preview/pr-1924/src/services/supabase.js\":\"d4dee2bb6df57d89\",\"/knowledge-medium/pr-preview/pr-1924/src/services/uploadErrorClassifier.js\":\"c0d8e967614d84a0\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/ActiveContexts.js\":\"e62a7d399e738692\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/HotkeyReconciler.js\":\"550da609b61351c5\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/WipeLocalDataDialog.js\":\"bc231327519c77be\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/actionDispatch.js\":\"53f5fdfc63117507\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/actionKeyHints.js\":\"9635cc88449bf72d\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/actionRefItems.js\":\"6df76730955eb24e\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/applyKeybindingOverrides.js\":\"912f0b002de167b0\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/blockActions.js\":\"11d11ea41778a17c\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/blockMergeGesture.js\":\"fc8947ff24bf1e5e\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/canonicalizeChord.js\":\"005613e4093a1cbd\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/defaultContexts.js\":\"9e0e812367c67f51\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/defaultShortcuts.js\":\"743144074d4698fb\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/effectiveActions.js\":\"a439f6b524aff7b8\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/formatChord.js\":\"0896d7d7f62864c2\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/gestureAction.js\":\"60063c55159d5042\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/gestureBinding.js\":\"ca3a9d737dbe68b3\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/holdRegistry.js\":\"f4b4079f0cb9100b\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/keybindingConflicts.js\":\"7ede5c8b6295cb88\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/keybindingOverrides.js\":\"0ecf21431f6b1a8a\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/pointerAction.js\":\"4ddf2e84e0d8ed93\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/resolve.js\":\"d5f2b5cc3a271d7a\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/runAction.js\":\"d5f760129a48cdf5\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/sequenceMatcher.js\":\"3db515b139bbfd3d\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/types.js\":\"45bfb275e9ac9709\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/useActionContext.js\":\"934e4a929bb16ea5\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/useActionDiscovery.js\":\"aeafca57f384575e\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/utils.js\":\"9cdce5b1fcee2fc9\",\"/knowledge-medium/pr-preview/pr-1924/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1924/src/sw/bootStore.js\":\"e5d44df4c4fce17d\",\"/knowledge-medium/pr-preview/pr-1924/src/sw/previewDatabases.js\":\"765882c72cfab585\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/byteTransform.js\":\"6c48da764c48aba2\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/attachmentCleaner.js\":\"32d091684a70f64d\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/attachmentParts.js\":\"d27f77125dcb4e9f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/bundleParts.js\":\"86ec5715ea7d1df4\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/bundleRecord.js\":\"083fec9bee1952a3\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/manifest.js\":\"faf2b7cdd9dda9eb\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/takeBundle.js\":\"6f658f97e210fcc0\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/verifyBundle.js\":\"0030689d5de396e3\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/cleaningStage.js\":\"b4c7998734a8e746\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/conversionKey.js\":\"cfbee255f3370f3b\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/conversionServer.js\":\"705ffe39e7c5797c\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/flip.js\":\"df45b464e33564fd\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/flipAttempts.js\":\"4d58102e30eb23dc\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/pages.js\":\"fe12909330c1478a\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/preflight.js\":\"f088ea388ef094e7\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/reseal.js\":\"1fd0591ad610abac\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/runConversion.js\":\"9aea56fc511d4cde\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/runLock.js\":\"e95326eb54612049\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/sealing.js\":\"dbebeece29b6e841\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/sealingStage.js\":\"98e21aadab9f641e\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/stage.js\":\"adbdca9f8350750f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/verifyReseal.js\":\"0a3200665b52869c\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/aad.js\":\"59380ce6c8f1329b\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/aead.js\":\"3486a2db55e43296\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/base32.js\":\"f71b3eda95b66a99\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/base64url.js\":\"08f88cb29fa4113e\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/binaryEnvelope.js\":\"b8f6e5f5c3b35eb7\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/byteAead.js\":\"a959433513ace26f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/canary.js\":\"5f05194fb3701746\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/contentHash.js\":\"7d9ce77231c04018\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/contentKey.js\":\"c7fa45ed81d9142d\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/derivedIdNamespace.js\":\"0a567254de1f424a\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/envelope.js\":\"815fc18ee5743706\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/hex.js\":\"baad32c31a3c54de\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/sha256Hex.js\":\"9089674b40811070\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/workspaceKey.js\":\"198a3b1c77f6cc77\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/conversionState.js\":\"b4b9079f85314aad\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/createEncryptedWorkspace.js\":\"cc31a9bed0ecc18a\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/pastedKey.js\":\"72ecd704d25e550b\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a51ff0fef506aeff\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/upgradeWorkspacePin.js\":\"b03b7167a614fb8d\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/keyStore.js\":\"b3a8caaa5743f9dd\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/mintWorkspaceKey.js\":\"08e863eb868747ee\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/modePin.js\":\"7e2ae20263554b4d\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/openWorkspaceKeys.js\":\"ab01e9ccabcf82a4\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/resolveWorkspaceEntry.js\":\"661ba6af0218c1e9\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/resolver.js\":\"f71ce421659ea77f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/workspaceAccess.js\":\"bdd49a274631be06\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/transform.js\":\"4c504daa7f2f8374\",\"/knowledge-medium/pr-preview/pr-1924/src/themeBootDefaults.js\":\"265cab300054b057\",\"/knowledge-medium/pr-preview/pr-1924/src/types.js\":\"dc1030c126930396\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/ClientLocalSettings.js\":\"2c35607a074dbdef\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/abortableSleep.js\":\"ad721e58d355fff7\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/array.js\":\"99ba516abe15cbd9\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/backlinkAutocomplete.js\":\"b4800eb333fd9bae\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/blockCrumbs.js\":\"7d3d922540559dfb\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/blockrefAutocomplete.js\":\"042c4931ea745e3f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/cadencedIdleJob.js\":\"bffdcee38a67d8e3\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/callbackSet.js\":\"5452698cc7706080\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/clientId.js\":\"ad63c743a12ea93f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/codemirror.js\":\"2e09166abcc8e2df\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/codemirrorCompletion.js\":\"62745985cf43c826\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/copy.js\":\"a227149235f3da62\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dailyPage.js\":\"2330793904c36fdc\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dbForensics.js\":\"15ce1803d1031440\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dbForensicsHooks.js\":\"54e96956a932ffce\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/deleteBlockThroughUi.js\":\"d868b9304ede6e76\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dialogs.js\":\"348024a3ebd36b4d\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dom.js\":\"4c12f1a4a63250f3\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/downloadBlob.js\":\"fa2e6b82f94bc35e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/drawnWalk.js\":\"068d2448397e9915\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/exportSqliteDb.js\":\"fd2baa9efc5ffd1e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/fileSystemAccess.js\":\"f3670319eb762bfd\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/flipSlide.js\":\"b39141380cd70a41\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/fnv1a.js\":\"206923ab27288a76\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/formatBytes.js\":\"669a9772c435b768\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/fuzzyRank.js\":\"fdf9a4a9c08c6f63\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/idbKeyedStore.js\":\"331073341c4ab073\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/idleCallbackPolyfill.js\":\"607c7e2a5cd85951\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/keyboardAwareScroll.js\":\"9a09bc19bce9f081\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/keyboardViewport.js\":\"e688098501c5c195\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/lastWorkspace.js\":\"769bec6629ed7a9a\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/layoutColumns.js\":\"6a61d42e92dd8c1d\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/layoutSessionDom.js\":\"c89db157ddcab6ab\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/layoutSessionId.js\":\"e79405438e8f6209\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/linkClickGestures.js\":\"66fa77b058fa8231\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/linkTargetAutocomplete.js\":\"9c694cd3731da522\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/localDbCorruption.js\":\"6f81e4df06d87828\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/localDbRecovery.js\":\"46e3764485aeecde\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/markdownParser.js\":\"b6a14a5b538e5736\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/memoize.js\":\"41161a3ad643fd2e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/nameFieldCommit.js\":\"c938373af6ddd6a8\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/nameList.js\":\"43614b2d96ce766b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/navigation.js\":\"59deeea81579a549\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/omnilinerNamespace.js\":\"d868915704add9d6\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/opfsPageScan.js\":\"904e2f71ed9820da\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelClearance.js\":\"b360d547ee94be3a\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelHistory.js\":\"c2557178da443740\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelLanes.js\":\"f7decd201ca3f357\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelLayoutProjection.js\":\"2d84bc5ca8fd29a4\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelScrollAnchor.js\":\"dff4ca5057bda41d\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelUrlFlags.js\":\"f3e13313d7cb0aa1\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/platform.js\":\"d02d1594e96979eb\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/pluralize.js\":\"942458be5f47bbdd\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/propertyCreation.js\":\"d3a63eb2d5fe092e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/propertyNavigation.js\":\"3e2e09f89265d03b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/propertyValueContext.js\":\"44fcfd0e244c5ce2\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/react.js\":\"96402ee3dfd9d8a2\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/relativeDate.js\":\"cd15d33e2a5586ba\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/relativeTime.js\":\"00ae77ba58806a34\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/renderScope.js\":\"e1c41592d1066157\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/resolvedThenable.js\":\"0eb5aeab4cbd4665\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/routing.js\":\"3d1a966120cdacba\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/safeMode.js\":\"8121931cfe5cddfe\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/scheduleIdle.js\":\"b55552c082289ea4\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/screenWakeLock.js\":\"db4a3b4947255f75\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/selection.js\":\"1947fea0ae013bc8\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/softKeyboardGrab.js\":\"c914aef1577308d2\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/startupTimeline.js\":\"74fd8aa639c59d30\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/state.js\":\"11e3bef805e79c16\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/string.js\":\"c85c9509377e33a9\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/surfaceZoom.js\":\"193423d068a88b81\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/time.js\":\"fdc29c4e05b511ca\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/toast.js\":\"8b5fcb5dcb8f848c\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/toggleStore.js\":\"80bd1372031ee11b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/untilStopped.js\":\"632357e7fcd84977\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/userActivity.js\":\"2dd82a4e74821fc6\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/viewTransition.js\":\"cd73f923d988a070\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/viewport.js\":\"defdad800cd58499\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/webLock.js\":\"4647dc200820b51c\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/workspaceRecovery.js\":\"61cdbef3fccc23f4\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/workspaceSnapshotStore.js\":\"8b614a265ef5c599\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-compiler-runtime.js\":\"1fcb5f83adc91019\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-client.js\":\"6420ab82d3cfdd25\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-server-edge.js\":\"f5e0d1ab3629d92f\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-server.js\":\"6e0626400a57411a\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-static-edge.js\":\"39e0f893d6ddd098\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-static.js\":\"09b0231136dae2ac\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-test-utils.js\":\"8df64bef80604d06\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom.js\":\"fabbc14ddbbbc5f8\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-jsx-runtime.js\":\"73a42f25fb8096d7\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react.js\":\"56f6a0c79be88ef7\",\"/knowledge-medium/pr-preview/pr-1924/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1924/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1924/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
