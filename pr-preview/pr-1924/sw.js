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
		buildId: "687f29ba093d-2b330136",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1924/\":\"058805df63bc7e6d\",\"/knowledge-medium/pr-preview/pr-1924/index.html\":\"058805df63bc7e6d\",\"/knowledge-medium/pr-preview/pr-1924/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1924/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1924/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1924/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1924/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1924/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1924/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1924/assets/FacadeVFS-CLU-lChw.js\":\"106e5bfef18c7604\",\"/knowledge-medium/pr-preview/pr-1924/assets/OPFSCoopSyncVFS-C9Bg9Ve6.js\":\"09441d6b652784ae\",\"/knowledge-medium/pr-preview/pr-1924/assets/OPFSWriteAheadVFS-CPvn8Gk8.js\":\"eb466f2aa0d7ad10\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-D41mtu2Q.js\":\"7e62781e0291d551\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-async-CW0YAjpl.js\":\"a352279bca47c139\",\"/knowledge-medium/pr-preview/pr-1924/assets/worker-CEOE64nW.js\":\"155fed017e256545\",\"/knowledge-medium/pr-preview/pr-1924/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1924/chunks/app-BuZ8Aj1z.js\":\"e23ea40f8f0d2523\",\"/knowledge-medium/pr-preview/pr-1924/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1924/index.js\":\"c198d4f1a07e721c\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1924/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1924/assets/AccessHandlePoolVFS-Bi1a0tMN.js\":\"13c9608a78a48084\",\"/knowledge-medium/pr-preview/pr-1924/assets/IDBBatchAtomicVFS-DcFVOYqP.js\":\"f5d141607bc3b1f5\",\"/knowledge-medium/pr-preview/pr-1924/assets/MemoryVFS-CG_emkB8.js\":\"6cf2043fdfee2f25\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-Dz0GV88t.js\":\"6f8ffe196c5a2e3d\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-async-CTTUm0s9.js\":\"7ef39714fe888498\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1924/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1924/chunks/AccessHandlePoolVFS-CBACQOhE.js\":\"78cedc3275f56515\",\"/knowledge-medium/pr-preview/pr-1924/chunks/FacadeVFS-CkpXE7tM.js\":\"32bee15c02109f52\",\"/knowledge-medium/pr-preview/pr-1924/chunks/IDBBatchAtomicVFS-alpEF5n9.js\":\"9dd71e496da8bd0c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/MemoryVFS-BAuv0MCS.js\":\"da11104df8aec8b1\",\"/knowledge-medium/pr-preview/pr-1924/chunks/OPFSCoopSyncVFS-DK94zuo8.js\":\"9b63aa4bb01626b3\",\"/knowledge-medium/pr-preview/pr-1924/chunks/OPFSWriteAheadVFS-Drv_0PS_.js\":\"c04413af9aefcb19\",\"/knowledge-medium/pr-preview/pr-1924/chunks/Preview-D9Z9gi9K.js\":\"ec43e72e21e5a362\",\"/knowledge-medium/pr-preview/pr-1924/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/card-CnK7-s1d.js\":\"731f7de9b74bd037\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dist-DIKrwmNw.js\":\"46250af9571402f5\",\"/knowledge-medium/pr-preview/pr-1924/chunks/freezeExtensionImports-CyZBvfHw.js\":\"422488985bc8eeef\",\"/knowledge-medium/pr-preview/pr-1924/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1924/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1924/chunks/mc-wa-sqlite-BfJegxcw.js\":\"2359c584017b1cf9\",\"/knowledge-medium/pr-preview/pr-1924/chunks/mc-wa-sqlite-async-DUl3mvxs.js\":\"1714dac622176348\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react--16viLwt.js\":\"c225f9d6ed8c7b6a\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-BkA4PQlI.js\":\"ab6ffdb9c7ecf961\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-BlQPQFtX.js\":\"d2ba06d3203ddac2\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-BvuG33Xa.js\":\"39c720cf526b533b\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-CGKeVVXr.js\":\"5398bc8c8580d40a\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-D09sOFUq.js\":\"64cdb1fe2f50200f\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-DAyv0yDI.js\":\"d1d3e48d8893074a\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-RBRxnJi4.js\":\"f26de5c883046d0b\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-dom-server-legacy.browser.production-BX1Z2YGx.js\":\"e3718ab28949486f\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-dom-server.browser.production-CxbPY169.js\":\"2d74f106103dae1b\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-dom-server.edge.production-D5xlhtfc.js\":\"e8b5ca26b482409c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/server.browser-BRi0W3YN.js\":\"792c6c034bfdc17d\",\"/knowledge-medium/pr-preview/pr-1924/chunks/textarea-BL8Nf7gu.js\":\"69fc70ec89455f73\",\"/knowledge-medium/pr-preview/pr-1924/chunks/ui-C0MlAvfJ.js\":\"2f0001e91f958a08\",\"/knowledge-medium/pr-preview/pr-1924/chunks/wa-sqlite-SWkC1p24.js\":\"69a924a8a03c5aad\",\"/knowledge-medium/pr-preview/pr-1924/chunks/wa-sqlite-async-BR0G8gBn.js\":\"d6391cda2b8a1185\",\"/knowledge-medium/pr-preview/pr-1924/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1924/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1924/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1924/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1924/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1924/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1924/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1924/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1924/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1924/src/App.js\":\"df8b73c0f433ee2a\",\"/knowledge-medium/pr-preview/pr-1924/src/appUpdate.js\":\"16bafc757975b3d3\",\"/knowledge-medium/pr-preview/pr-1924/src/appVersion.js\":\"8acb9ea596d699a5\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/initialLayout.js\":\"059378b54481f0be\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/openWorkspaceData.js\":\"5392989f91901947\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/resolveWorkspace.js\":\"e4c8296e2c7ce3a6\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/workspaceBootstrap.js\":\"649478b8703cd0d6\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockComponent.js\":\"2ec13c6b22bb6b30\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockCrumbs.js\":\"1f9cb879f3988e06\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockEditor.js\":\"471b7c643d573062\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockLoadingPlaceholder.js\":\"6c08fb62e74f68ee\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockProperties.js\":\"56f57a81cc1dbcf1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockSearchPicker.js\":\"7b981233a3160248\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ConfirmBulkDeleteDialog.js\":\"d54712019d1db277\",\"/knowledge-medium/pr-preview/pr-1924/src/components/DividerHandle.js\":\"3415135aaf551246\",\"/knowledge-medium/pr-preview/pr-1924/src/components/DraftEditor.js\":\"af906e4e13e9f319\",\"/knowledge-medium/pr-preview/pr-1924/src/components/GutterPill.js\":\"d0b396806382699b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/Header.js\":\"19e8e65795dbd5d5\",\"/knowledge-medium/pr-preview/pr-1924/src/components/LazyBlockComponent.js\":\"f51c2379d3c26662\",\"/knowledge-medium/pr-preview/pr-1924/src/components/Login.js\":\"c6bb01f9c31e8d52\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ZoomableSurface.js\":\"f06b206743b80ab1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/editModeKeepalive.js\":\"0b4083fea407e2cc\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyDisplay/PropertyDisplayScope.js\":\"9bcdb9828787e4af\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"7bc2265e1fb99583\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/RefPropertyEditor.js\":\"d1d594c1b6a7a916\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/RefTargetTypePicker.js\":\"dcba111681d40a11\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/SelectPropertyEditor.js\":\"b0fcf353c1686dd7\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/TypesPropertyEditor.js\":\"67483cd62ae35027\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/defaults.js\":\"ab974b8bc952a75b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/kernelValuePresets.js\":\"cae2a349de9ccd4f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/selectablePresets.js\":\"f0849794da8e53ed\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/typesPropertyUi.js\":\"effdb147fb2d315c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/AddPropertyForm.js\":\"608be2a0e4e9eb3c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/PropertyPicker.js\":\"dd77b74a423cb94a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/PropertyRow.js\":\"bc7f9cef33eaffc3\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/Rows.js\":\"1cee8a03ed06dcbb\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/actions.js\":\"d2042114a2bdb566\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/declarationOnly.js\":\"84eef4d62874fe8a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/layout.js\":\"cde7235016edabb2\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/model.js\":\"7b7cb70b78800cb5\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/shapeUi.js\":\"b3ee13039ccae898\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/shapes.js\":\"fd631297ae53cd84\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/usePropertyEditingActivation.js\":\"ece7b6c86c4328df\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/visibility.js\":\"c69287d20766afc2\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanelSections.js\":\"e918253ec512a097\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/BlockEmbed.js\":\"7258c9953dbb330e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/BlockLink.js\":\"fafe2eced5823212\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/BlockRef.js\":\"51f6147314fd5397\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/CompactReferenceLink.js\":\"c1fcd10daf0ab26b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/ReferenceLink.js\":\"d116792d39b12b08\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/cycleGuard.js\":\"bd50e08a0b80fc89\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/cycleGuardContext.js\":\"30c9bece29a0aa55\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/linkInteraction.js\":\"c7dc5c8bfe00a6dc\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/referenceLayout.js\":\"56054addd7050f0e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/useBlockRefAncestors.js\":\"a81735196554fd32\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockGutter.js\":\"dbbd4615bbf02ac5\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockInfoDialog.js\":\"f06da25105b7e157\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockReadText.js\":\"910b36e54e55f465\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockTypeBlockRenderer.js\":\"98831b304a708fc1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BulletHoverCard.js\":\"27d8ade9e29dcb2e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/CodeMirrorContentRenderer.js\":\"c94fe84b62eb31c4\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"af970d18f6d50a0b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/ColumnResizeHandles.js\":\"52462ce2f90ad893\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"435d1b15eb8f400f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/DefaultBlockRenderer.js\":\"580b4aefa7c1c2ab\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/LayoutRenderer.js\":\"16c500f196e15c40\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/MarkdownContentRenderer.js\":\"2f9d4569dc0ad211\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/MissingDataRenderer.js\":\"0ff51ffde7e832ad\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/PanelRenderer.js\":\"3229f3c408bb46c6\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/PropertySchemaBlockRenderer.js\":\"c327a8ae16bfb78e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/TopLevelRenderer.js\":\"c95172b463a26f3f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/blockGutterMode.js\":\"d15c3033e949774e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/blockTitleText.js\":\"c8abeb1fcdd8c22f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/fieldCreationKeydown.js\":\"b9ed56fd2f449abe\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/layoutRootContext.js\":\"b9422f69591663c1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/typeChip/TypeChip.js\":\"104ceece345e3e1d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/typeChip/chipStyle.js\":\"f35c4739a95f763f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/anchored-floating.js\":\"57dfdc269cf2a0eb\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/button.js\":\"9a3999e96cf46766\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/card.js\":\"7560879cd2dafff3\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/checkbox.js\":\"de3526c43cba9eb0\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/collapsible.js\":\"955b4ff234fe2f88\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/command.js\":\"05c13b698cc206e5\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/context-menu.js\":\"9b3754885b0be49c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/dialog.js\":\"a42672eadcca8625\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/dropdown-menu.js\":\"7aad0edd8f20386a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/floating-listbox.js\":\"17ebaf1ee3d7d778\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/index.js\":\"af49404262679705\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/input.js\":\"330696c96195036e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/kbd.js\":\"683711e6580e1880\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/label.js\":\"03cf1bb5db83fecc\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/textarea.js\":\"4308b49684cac917\",\"/knowledge-medium/pr-preview/pr-1924/src/components/useEditModeYieldKeepalive.js\":\"1a73e7576100a703\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/BootFallback.js\":\"ec7ed8a788e159a4\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/FocusedRowLazyMount.js\":\"5647d4431fc9a0a4\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/LazyViewportMount.js\":\"3615b3b5d1fceeb6\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/LocalDbCorruptionFallback.js\":\"64f60569a3ca043e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/error.js\":\"da76a1414d258406\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/lazyMountRegistry.js\":\"e1c58fe5d194ed2d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/suspense.js\":\"e37294ad3f4254bc\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/CreateWorkspaceDialog.js\":\"61364d567f69af45\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/PendingInvitations.js\":\"74446a43b14a0205\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/SyncProgress.js\":\"944baef791897c36\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/UnlockProgress.js\":\"4f14a3cf2d049f32\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceKeyGate.js\":\"5e106d7ba1ed38ed\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceSettingsDialog.js\":\"0b4bba895630d911\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceSwitcher.js\":\"36e47fc7b0f01806\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceSyncGate.js\":\"3dba6f639e894402\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/ConversionFlow.js\":\"71be4b49e7e6d02e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/ConversionFlowHost.js\":\"2537e2486cf5a03e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/EncryptionSection.js\":\"10158e47e876690c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/attachmentPrompts.js\":\"c73fca0fc33a4648\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/bundleFolderPrompts.js\":\"de85d46eac6208ff\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/conversionFlowDeps.js\":\"f121300f1a63087a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/conversionFlowStore.js\":\"e0b8f0286bf7e2d9\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/flowUi.js\":\"460417469530a877\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/useConversionRun.js\":\"881a17b67f8467a3\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/keyUi.js\":\"9ee4b8093ff052d1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/useCloseOnKeyLoss.js\":\"76e815773b17069e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/useCloseOnServerE2ee.js\":\"687a85e78f237446\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/workspaceUnlocked.js\":\"121e5c31ed47e8d6\",\"/knowledge-medium/pr-preview/pr-1924/src/context/backgroundSubtree.js\":\"65439d60ae0c3694\",\"/knowledge-medium/pr-preview/pr-1924/src/context/block.js\":\"4c110434ba5221e5\",\"/knowledge-medium/pr-preview/pr-1924/src/context/layoutWsContext.js\":\"380157bd46f9890b\",\"/knowledge-medium/pr-preview/pr-1924/src/context/propertyDisplay.js\":\"80526f381e0dee46\",\"/knowledge-medium/pr-preview/pr-1924/src/context/repo.js\":\"b4942e593c7a4750\",\"/knowledge-medium/pr-preview/pr-1924/src/data/aliasClaim.js\":\"ac3b62d81b8e3c3f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/aliasSeatNamespace.js\":\"51f276a53a08fa59\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/blockData.js\":\"9e600a7070068426\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/blockType.js\":\"f499394658f087f6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/changeScope.js\":\"4075545a77717e52\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/codecs.js\":\"542825cc7523949c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/derivedData.js\":\"69c9106d2cf6481d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/errors.js\":\"763df4fc0ba5212d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/events.js\":\"1f8fcce4bd82fbf9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/handle.js\":\"74c954d29ef6de17\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/index.js\":\"21fbaa3cb3d6d2fb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/mutator.js\":\"2abde3a76c4b7a5e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/processor.js\":\"ad385a147e419ab4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/propertySchema.js\":\"6181ec6249851db0\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/query.js\":\"e57a7b48a08bd431\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/sameTxProcessor.js\":\"e3c5c89583789221\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/schema.js\":\"74c954d29ef6de17\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/tx.js\":\"74c954d29ef6de17\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/typedBlockQuery.js\":\"7695642677102c73\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/user.js\":\"8bdee18fb737e9cc\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/valuePresetCore.js\":\"8d644801cb45c77d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/valuePresets.js\":\"40c07ecb15835e77\",\"/knowledge-medium/pr-preview/pr-1924/src/data/attachmentCleanerIOVerb.js\":\"a9ae39aa87a5855e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/block.js\":\"dbc6f0a00e5e57b2\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockCache.js\":\"23daae8cb542d094\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockId.js\":\"704df98888237fff\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockLiveness.js\":\"9bfb091a39d32908\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockMerge.js\":\"9a476642c06238d6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockSchema.js\":\"5feb8d419811584c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockTypeLookup.js\":\"bc957f399528ab48\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockTypes.js\":\"51541a67499e5f17\",\"/knowledge-medium/pr-preview/pr-1924/src/data/childrenView.js\":\"2109c7ec1c34f576\",\"/knowledge-medium/pr-preview/pr-1924/src/data/clientContext.js\":\"aa90e438920bfe3c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/dbFileSiblings.js\":\"8f68aad3fdbc4726\",\"/knowledge-medium/pr-preview/pr-1924/src/data/definitionSeeds.js\":\"5e9dd5ccb4e17603\",\"/knowledge-medium/pr-preview/pr-1924/src/data/derivedIds.js\":\"3aeb63a9effd2b03\",\"/knowledge-medium/pr-preview/pr-1924/src/data/drawnSubtree.js\":\"25c3d7158e830894\",\"/knowledge-medium/pr-preview/pr-1924/src/data/facetBridge.js\":\"0e11acbf183c2cdf\",\"/knowledge-medium/pr-preview/pr-1924/src/data/facets.js\":\"59982fcca23daef7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/globalState.js\":\"db3ca30022c86ff9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/aliasClaimRederiveProcessor.js\":\"751300441a1eadbb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/ancestorBatch.js\":\"bb8145d2acca3fee\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/blockTypeTypeifyProcessor.js\":\"dbecddd411efcfbd\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/clientSchema.js\":\"0c2912cfcd5954dd\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/commitPipeline.js\":\"389953f25af3c9ad\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/devAssertions.js\":\"3c73ce3030a7a6e6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/firstSync.js\":\"8b7fc4a364413e66\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/freshInitialLoad.js\":\"43b7a97066126822\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/graphBackfillClaim.js\":\"8a78914729683cf5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/handleStore.js\":\"93e694e12c8afc78\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/idleMarkerJobs.js\":\"a1c951aa53535976\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/initialDownload.js\":\"1266aafc9c68523a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/initializeClientDatabase.js\":\"29ab550fdf11cbb9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/jsonCanonical.js\":\"6ed9143776fae91d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/kernelInvalidation.js\":\"d584e740486e8c2c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/kernelProcessors.js\":\"4acca18074d293bb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/kernelQueries.js\":\"ef1367a0a71b8cb7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/mergeTypeMembershipProcessor.js\":\"3fadd811aaccaf9e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/normalizeReferencesProcessor.js\":\"45651180c5293079\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/poolInstrumentation.js\":\"b8334930d00a3a51\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/processorRunner.js\":\"7e977d160db04bcb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyCellBackfill.js\":\"4c31fccd2413f4c6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyChildMint.js\":\"7590b6bf66089c2a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyChildrenProcessor.js\":\"430c897b785b1aba\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyDefinitionChangeProcessor.js\":\"e4bccb69bd579ae1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyDefinitionSynthesis.js\":\"18eda26a8a17dc20\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyKeyScan.js\":\"6531477cafbaa843\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertySchemaResolution.js\":\"7b09864085dd0d48\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyValueEdits.js\":\"ceb910654e8831ba\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/raiseProtocol.js\":\"8c001db46fca9902\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/readBatch.js\":\"0e8eccede002be7a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/refProjection.js\":\"12ed490b100e0995\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/referenceTargetLookups.js\":\"ace3ad383eea91d6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/referenceTargetProcessor.js\":\"85495b84343ffbba\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/replayMerge.js\":\"feddb3432b4e4f94\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/sqlBinds.js\":\"1c5b11891fa89d0c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"cdb4fa4bb2310679\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/arrivalProcessors.js\":\"b8390d5e5846edb9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/invalidate.js\":\"7e771d891b0235e5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/materialize.js\":\"3489c6c2614e7c47\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/observer.js\":\"92810607bc55bc14\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/reconcile.js\":\"8adfa5f798b38741\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/timingMetrics.js\":\"2f7c52163d40ea17\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/treeQueries.js\":\"b70b5db54f550c48\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/txEngine.js\":\"0ac934a922d6f693\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/txSnapshots.js\":\"e1db04b451d9b094\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/typedBlockQuery.js\":\"363b1552871cb038\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/undoManager.js\":\"2e180012a42d7a75\",\"/knowledge-medium/pr-preview/pr-1924/src/data/invalidation.js\":\"6f095aebce654c3b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/kernelDataExtension.js\":\"9505bc6b1ab8fe9d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/kernelPage.js\":\"ad9fca7f7493d796\",\"/knowledge-medium/pr-preview/pr-1924/src/data/kernelValuePresetCores.js\":\"325e997d619cd849\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localDbCorruptionSignal.js\":\"14afbbb4a06e5bef\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localDbStorage.js\":\"7f94cab4df070c04\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localDbVfs.js\":\"b5925860728873e0\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localSchema.js\":\"707d9de424aa5446\",\"/knowledge-medium/pr-preview/pr-1924/src/data/maintenance.js\":\"1937fa9ce01dfacc\",\"/knowledge-medium/pr-preview/pr-1924/src/data/mergeProperties.js\":\"88a93ff75889c978\",\"/knowledge-medium/pr-preview/pr-1924/src/data/metricsConsoleHook.js\":\"5bc55e481d3bc30b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/migrationsPage.js\":\"dc25629bf07b66a4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/mutators.js\":\"71906afe301502f4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/orderKey.js\":\"d98c77a17ce9a831\",\"/knowledge-medium/pr-preview/pr-1924/src/data/orderKeyPlacement.js\":\"65fc82183bccde5b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/outlineSurface.js\":\"08950316ca5288e1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/pendingEditorContent.js\":\"d6f0429a08ed2ef4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/pendingUploadsSql.js\":\"8440ca0f0a95ad67\",\"/knowledge-medium/pr-preview/pr-1924/src/data/pluginStateExtensions.js\":\"b651fe297b0ffc69\",\"/knowledge-medium/pr-preview/pr-1924/src/data/powerSyncLogger.js\":\"0e3b790a21b7aff0\",\"/knowledge-medium/pr-preview/pr-1924/src/data/projectorRuntime.js\":\"733b69698486a6e6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/properties.js\":\"e638092feb16aacc\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertiesPage.js\":\"c147b919c1eb8996\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyChildren.js\":\"fcfc38d578637994\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDefinitionFanout.js\":\"fe812c9a3d499fd6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDefinitionMetadata.js\":\"6cbb9c8d28234351\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDefinitionRegistry.js\":\"039983e30d1f1c88\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDisplayMode.js\":\"5660af298c55ec5a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyRowCreation.js\":\"9dce3c983bca3d63\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertySchemaCreation.js\":\"c06657e0270a6dc8\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertySeeds.js\":\"40d1fa65540c3954\",\"/knowledge-medium/pr-preview/pr-1924/src/data/recentsPage.js\":\"5e4442441730d9d8\",\"/knowledge-medium/pr-preview/pr-1924/src/data/refTargetComparableProperty.js\":\"81319a16907a7c95\",\"/knowledge-medium/pr-preview/pr-1924/src/data/referenceBlock.js\":\"d2a9e57d8cfb6ff1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/rejectedUploads.js\":\"1bf301ebaa76853f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/releasePowerSyncConnection.js\":\"5a1b35af0647fd67\",\"/knowledge-medium/pr-preview/pr-1924/src/data/repo.js\":\"5a9985e2658966c6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/repoProvider.js\":\"e73e1cc3bc88d8ec\",\"/knowledge-medium/pr-preview/pr-1924/src/data/rowProperty.js\":\"a37c955e3fb41416\",\"/knowledge-medium/pr-preview/pr-1924/src/data/searchFilter.js\":\"6d12b6f7ff7064c5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/seedIdentityLedger.js\":\"8ed6511fabc37444\",\"/knowledge-medium/pr-preview/pr-1924/src/data/stateBlocks.js\":\"d223718e36b77ffb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/structuralEditPolicy.js\":\"1572dad210fa62fa\",\"/knowledge-medium/pr-preview/pr-1924/src/data/structuralInsert.js\":\"eda5f25137c64e66\",\"/knowledge-medium/pr-preview/pr-1924/src/data/subtreeDelete.js\":\"bc74b79eec54264f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/syncStreamLock.js\":\"50b7a7c9f0a7756f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/syncedTableSqlRecognizer.js\":\"7df05ec07479d277\",\"/knowledge-medium/pr-preview/pr-1924/src/data/syncedTableWriteGuard.js\":\"87f346c43a10b90d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/targets.js\":\"64892ab4853e1124\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeColors.js\":\"ca800f8a1c1a20ab\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeDefinitionMetadata.js\":\"8081190e57e35f12\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeDefinitionRegistry.js\":\"d76ea5558497c93a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeExtraction.js\":\"24b3a94057342184\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeInitialValues.js\":\"65264b583d9e50aa\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typePropertyGroups.js\":\"7f79ccdd93dba13f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeSeeds.js\":\"75b0e1db0e7f73db\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeTagger.js\":\"91d27a59e3eebd35\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typedRecords.js\":\"169f276dd2d37deb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typesPage.js\":\"f36c2547c2bd009a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/userPrefs.js\":\"c1355ccdeb3c4da4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/userSchemasService.js\":\"c7a92d5ee14da713\",\"/knowledge-medium/pr-preview/pr-1924/src/data/userTypesService.js\":\"5865a5252de40a61\",\"/knowledge-medium/pr-preview/pr-1924/src/data/valuePresetRegistry.js\":\"3aca950a13500dd9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/visibleChildren.js\":\"bed45b48627b8f5b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceConversion.js\":\"2e1d992aeced86a5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceFirstSync.js\":\"5c18f58ae1eee2f3\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceIdNamespace.js\":\"5b23958588ff9d45\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceSchema.js\":\"1f8a2d0e3d1b813a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaces.js\":\"386cb3aa2bf0e22f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/writeAheadLog.js\":\"62c6516458206a4c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/BlockPasteShellDecorator.js\":\"4ccad5089047130a\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/atTrigger.js\":\"7b77113e743f685a\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/autocomplete.js\":\"b595683cba8b62fb\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/codeMirrorExtensions.js\":\"95e828f15c2646b1\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/contentFlush.js\":\"64eacb5a4c558c8a\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/defaultInteractions.js\":\"72b49884bd0018ae\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/editSettleSignal.js\":\"1e4bb123e082e5c0\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/insertImage.js\":\"406d97cbc095774e\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/referenceCompletionRange.js\":\"428a6edb8c25701f\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/referenceTargetTypes.js\":\"ebd40ad54dd2892a\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/syntaxContext.js\":\"8028572a1cf9cd0c\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/triggerMatch.js\":\"3a4ecdce74f0bd2e\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/AppRuntimeProvider.js\":\"6f45a0ddf70821bd\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/BlockFocusShellDecorator.js\":\"f0c6778b6bc3d4a8\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/ExtensionRenderBoundary.js\":\"a4100fba448312f5\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/PanelContentRecovery.js\":\"bea34f52755a0394\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/apiCatalog.js\":\"23a1dd0d7bb5d158\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/appRuntimeController.js\":\"cfa83b4c4a123ef4\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/approveExtensionHere.js\":\"90afe340df9c0953\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/armedCutAppMount.js\":\"29778517b00f53b7\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/batchableKeyedStore.js\":\"b993935a7fe63afb\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/blockInteraction.js\":\"b631ac53a54a47eb\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/blockSelectionAction.js\":\"aaf3b636e0b3bda2\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/buildApprovalRecord.js\":\"eb1515fbdccca4e1\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/compileExtensionModule.js\":\"5daae94237b508ef\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/compiledModuleCache.js\":\"c9cc8b3b6faae2aa\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/continuousGestures.js\":\"5fd8f8b21b19b998\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/core.js\":\"d63e60df50e369ed\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/defaultRenderers.js\":\"09d6a5e7ab9fc020\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/definitionFanoutAppMount.js\":\"39be7cc938a29287\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/dialogAppMount.js\":\"d357004cc84d2fdb\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/dynamicExtensionSeeds.js\":\"4f718fa326fe9b80\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/dynamicExtensions.js\":\"75b8aa57a68327c3\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/exampleExtensions.js\":\"89a916747c718a1f\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionApprovalStatus.js\":\"9515c731aba2de79\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionImportPolicy.js\":\"9d5258c16a210eb0\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionLoadErrorToast.js\":\"423300f6faf8f038\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionLoadErrors.js\":\"74e974168e3f2939\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionLookup.js\":\"bb38c46a20d59dea\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionToggles.js\":\"d940b6ca1c869959\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionUtilitiesCss.js\":\"18da638bb066ce53\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/kernelPageDeletionGuard.js\":\"bf3403effa40db6f\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/liveRuntime.js\":\"1b50ad6897c4590f\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/normalizeExtensionSource.js\":\"0160b4459979158c\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/openExtensionsSettings.js\":\"da582dc8b6758efa\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/overridesCache.js\":\"498ff025e0d1713e\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/pluginIds.js\":\"8f738797b5bb7047\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/processorRejectionToast.js\":\"32536aaf20eababe\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/runtimeActions.js\":\"f26212435c027771\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/runtimeContext.js\":\"15f85afc13b835cc\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/staticAppExtensions.js\":\"7d62d343d9cc08d3\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/staticDataExtensions.js\":\"ceb32ee4fb5847fa\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/toastAppMount.js\":\"0d6c8ee8cd3c9c69\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/transpileExtension.js\":\"d545f4bae23ff3df\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/useOverrides.js\":\"0815e0c712bb19cf\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/useShortcutSurfaceActivations.js\":\"b49285e011b38f0a\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/discoverToggleTree.js\":\"b784ce0844e128c1\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/facet.js\":\"5287d9717042b98f\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/resolveAppRuntime.js\":\"9bab88e521138656\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/runtimeEvents.js\":\"5edd758d56fc3745\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/togglable.js\":\"4ee435ed19f94a89\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/variantFacet.js\":\"852d6a03d3334455\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/verbFacet.js\":\"45a3085f6fde4643\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/block.js\":\"3c694fb2ca0db849\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/focusedChild.js\":\"9bce7e955459bb90\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/propertySchemas.js\":\"d8db128da75b9f63\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/typeRegistry.js\":\"b21a6596e1a033e4\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useAncestorCrumbs.js\":\"342cef47061f2abe\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useAutocompleteListbox.js\":\"272ea9ef0760e535\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useDebouncedSearch.js\":\"8859067bebdc7646\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useDebouncedValue.js\":\"fa68a1f3f07f8b7d\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useFacetValue.js\":\"090a8333e3b203a0\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useIsFocalRender.js\":\"3ee960d242b3c88b\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useIsReadOnly.js\":\"1a679f96880442dc\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useMaterializeBacklog.js\":\"27f14f89f6dc9ac7\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useMinuteClock.js\":\"d6b383086435479e\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/usePanelLayoutProjection.js\":\"e4cf8e0997f31475\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/usePendingInvitations.js\":\"8d30faa560c2e475\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useRendererRegistry.js\":\"c8925c2c6a1a6983\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useRetainedFieldRows.js\":\"28e4005ce8b6fcbc\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useWorkspaces.js\":\"d369a9170f725edd\",\"/knowledge-medium/pr-preview/pr-1924/src/lib/utils.js\":\"a6a8cd41b1bad89f\",\"/knowledge-medium/pr-preview/pr-1924/src/main.js\":\"8239230451b1bbb3\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/MarkdownImage.js\":\"73736af3887cbbd8\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/blockSeparators.js\":\"5585a97096755ee3\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/context.js\":\"35d42f9c4ca91ab8\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/defaultMarkdownExtension.js\":\"8b442044a348f25d\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/extensions.js\":\"5d516cb14d3dd6e0\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/renderMarkdownHtml.js\":\"541fbc9442df1d69\",\"/knowledge-medium/pr-preview/pr-1924/src/minimal-editor.js\":\"0fd8046d488be7a4\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/armedCut.js\":\"9dba6b21ecd039bc\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/captureMediaVerb.js\":\"83b59ef2150ced54\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/clipboard.js\":\"2602dfefc3588729\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/decision.js\":\"47dab84cfedbbbe8\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/operations.js\":\"cdf82147fcb67fab\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/account-header/AccountHeaderItem.js\":\"786eaecf490d50f6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/account-header/index.js\":\"77acd886a495bd1e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"ca175f74793f6c84\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/askAgent.js\":\"be87e9c689f17411\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/askedStore.js\":\"0c92c43e0b0d96bf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"3041c2cefaeec930\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/chipState.js\":\"5cce09ab41fe149e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/dataExtension.js\":\"7bd99b8823be8a98\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/index.js\":\"65ae18b685612ad2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"98df6f480836e7db\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/retryAgent.js\":\"be6641927fc7b65d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/schema.js\":\"fad6bcf17afd87bb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/AgentTokensDialog.js\":\"8ee115b684a69fa9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/BridgePairingDialog.js\":\"39d67feb8db9ba2f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/addMedia.js\":\"6f393db629d43674\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/backlinks.js\":\"1804e28979c5881c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/block.js\":\"2ff7be467be9bfcf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/context.js\":\"0ac64fca92b9a7df\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/displayIds.js\":\"88f69aba8b4769b3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/index.js\":\"c2ecfa1081b48fb7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/outline.js\":\"ed76f7e68fde2967\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/properties.js\":\"07e2dd1165029a2c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/refs.js\":\"85f5129b1dbdff3b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"60098cd003e5f7e4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/search.js\":\"60fb7c080abb59d2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/shared.js\":\"10499f569bbc20ad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"3377f30c8bcec657\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/text.js\":\"42eb17875adfbcb0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentWrites.js\":\"bd729dcda97ebb75\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/authoringCatalog.js\":\"cce82ece636603b7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/blockRefTargets.js\":\"676266c8c614125e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/bridge.js\":\"65cd37f21795efd9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/bridgeLoop.js\":\"f8fb7a112a51ae62\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/changeHistory.js\":\"431e26c132d0280a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/commands.js\":\"9670f4594ff179da\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/commentsCommands.js\":\"928c6e63aed23a29\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/dataExtension.js\":\"d1fddcd081496cee\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/dataModelGuide.js\":\"8d3be9581e8f339a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/dayPropertyInputs.js\":\"b16da0925479d12f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/describeRuntime.js\":\"e4fdfbd1807467f0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/extensionLint.js\":\"0cefabd4e2a558b6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/grainAudit.js\":\"a17adb42332f06c6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/healthCommand.js\":\"26f10251f045f54e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/index.js\":\"215f0c688c5cdfc6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/presetIdentity.js\":\"84a22df85a938bd4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"039e16a4da74d522\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/readMedia.js\":\"98e51f84f0b23596\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/schema.js\":\"0bed9e5fa0982f4c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/serialization.js\":\"3378d7e524e636ad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/targets.js\":\"85c30ab136948f49\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/tokens.js\":\"2203869db30d808a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/watchEvents.js\":\"f614867b02875559\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/workspaceGuard.js\":\"a742eff2900f2858\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/writeCommands.js\":\"f3027f7d7e4cfff2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/AliasCollisionToast.js\":\"334a3f04f2339809\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/DuplicateNameBanner.js\":\"058a17eb6d68e6ff\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/collisionMerge.js\":\"9568acf32c8c9140\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/dataExtension.js\":\"968973093f40224c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/index.js\":\"73a029475414bd01\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/mergeCollisionAction.js\":\"6961f9ff477d544d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/pageStyling.js\":\"d0f20056a4eef10b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/rejectionToast.js\":\"3814b373ad87c12b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/syncProcessor.js\":\"4b350da6d12d9c99\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/actions.js\":\"f641ae3d885d3556\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/addComment.js\":\"d45bb4751a10ae54\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/anchor.js\":\"61b5b25e114f8b53\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/anchorState.js\":\"70f115e631046b62\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/commentLinks.js\":\"87b4e7102e8cd559\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/confirmThreadDeletion.js\":\"f0261795569f211f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/container.js\":\"377183b212efde8c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/dataExtension.js\":\"b8fa88c5246f84ad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/deleteComment.js\":\"fef578515ee0a65e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/highlights.js\":\"cfe29884b2e310d8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/index.js\":\"39164535f06ea55d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/linkedCommentsPill.js\":\"25672b73898d0edf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/margin.js\":\"4a08d2abcba0f7ca\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/marginAnchorLinks.js\":\"96691a007d01a4d9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/marginSchema.js\":\"6bcd6ad5231fc3cf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/newComment.js\":\"12b9e750c52a9c9b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/ownThreadPicker.js\":\"baeecb2462fb028c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/placement.js\":\"2bbe3407eb0bf2a8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/queries.js\":\"8ed76f5ade3dd0f6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/quotePosition.js\":\"905a8a4c9968cf2b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/quotedIn.js\":\"77b46432d58eeecf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/quotedRange.js\":\"b4df16fa17cdf546\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/rangeRefs.js\":\"87f8a461f032cc24\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/readHighlights.js\":\"d067502ca691d468\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/readSelection.js\":\"da13f95c41060ef6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/readSelectionUi.js\":\"6f19bf55ed15cb0a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/reanchor.js\":\"7cd9b16d6d3d2247\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/schema.js\":\"028eed06829d7b4e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/scope.js\":\"8207e4aa64306230\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/scopeThreads.js\":\"d94c7a6a45fa6d20\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/splitRetarget.js\":\"69aed146219e26b7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/suggestionCard.js\":\"e9f537b677648434\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/suggestions.js\":\"c70507cea89cf518\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/summaries.js\":\"524195ae5e5ea4e8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/summaryBatch.js\":\"afe46e7bed6e2b51\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/surface.js\":\"644bd25c2de42e6e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/threadNavigation.js\":\"3af596df9dec2518\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/threads.js\":\"fff480971fb59f16\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/ui.js\":\"9c906fca838c3817\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/uiStore.js\":\"ebcdfb685403ee0c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-intents/appIntents.js\":\"32881f9bcd8dc1e1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-intents/index.js\":\"ed82ec4aa14f4828\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-update-prompt/index.js\":\"53e79d04ed0cf082\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-update-prompt/status.js\":\"25b57b7ff942a5f4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"81bb0508d92e7438\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/MediaBlockRenderer.js\":\"f730a4ba8557fc59\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/MediaDownLaneReplicator.js\":\"bf77caa2c80d19a0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/MediaUploadReconciler.js\":\"8dffa88e2f585799\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/assetDownLane.js\":\"8271e1e81ad637c5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/assetResolver.js\":\"50eb0c3533703b00\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/assetUpload.js\":\"f341cbeb265eb9ec\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/attachmentCleanerIO.js\":\"60e05ee19713a26b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/supabaseAuditIO.js\":\"0e0d9251cd616e7f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/blobStore.js\":\"402d7b53eab73bea\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/browserMedia.js\":\"cac2c18157df3ec0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/byteStore.js\":\"0a1927ff56582929\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/cleanerIO.js\":\"1628c337919ae55f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/cleanupAttachments.js\":\"afc960c571a26ff5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/dataExtension.js\":\"d717da668c711282\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/downLane.js\":\"12c2323ef0ebe841\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/index.js\":\"4282a4e1339d60ef\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/insertImageContribution.js\":\"d65b6a130a2f7f59\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/laneArming.js\":\"eb794089ba087ac4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/laneLock.js\":\"bc854faf2cb34a78\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaBlock.js\":\"c3810db832ee9ec7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaCapture.js\":\"e2bebfe702e7c988\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaLanes.js\":\"8720cb6374668ad7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaViewers.js\":\"99f8f062ba1733f2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaViewersFacet.js\":\"36a93c10aa2b2e53\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/pasteCapture.js\":\"a42b26700dd048a9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/resolver.js\":\"4c705dd6ad6602b7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/retryUploadsAction.js\":\"da67d0f3e46cac99\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/storagePaths.js\":\"3e723a183a51e166\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadDrain.js\":\"461da76bf954b129\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadLaneStatus.js\":\"ee3ce1fdce09225b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadReconcile.js\":\"064086116bdff7e7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadRecovery.js\":\"9d37ff73b88ab987\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadStore.js\":\"3d9d13c4771017c5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/useAssetObjectUrl.js\":\"ffee5973a126a65d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"ee8273e7fdd9c758\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/BacklinksViewSection.js\":\"b40dea2e11c65ab4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/facet.js\":\"55551970575529a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/index.js\":\"ecf8bf8a4dc9fafa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/prop.js\":\"2c6a35e78c153d05\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/BacklinkFilters.js\":\"e60ea7cdab263fb9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"1c29d6069dba17a5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/BlockEntry.js\":\"7d5bd84883043c1f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/LinkedReferences.js\":\"4b949ee8913ddaa3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"54cdfc10cfca1dac\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/dailyNoteDefaults.js\":\"b74b2f8d8a19afd1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/dataExtension.js\":\"d17595a70aa71e8f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/edgeExclusions.js\":\"c3357ac787251e84\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/filterProperty.js\":\"c1abe690351fc912\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/index.js\":\"9574274bf386ecf7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"e9e278de500f5ec2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/applies.js\":\"a2ef1da506014054\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/countQuery.js\":\"8d0c3f825e64686c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/expansionStore.js\":\"abea2f88bf044f6a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/index.js\":\"e677bd6b1a161072\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"a22c2d26ab7777d8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/presentationInvalidation.js\":\"5577962035a33fc5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/propertyEditorOverride.js\":\"4b0e531aac88b4cb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/propertyFilter.js\":\"26da1b7870c1f7dd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/query.js\":\"98dcdcd1e803f183\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/resolveFilter.js\":\"b93b844ef02c554a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/sourceBatch.js\":\"01373beb723de7be\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/sources.js\":\"e6adbbddc2aef5a1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/useBacklinks.js\":\"2ee63067526adf62\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"78338e6211e4ed04\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/BirthdayCelebration.js\":\"3c08807257c059aa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/BirthdayOverlay.js\":\"73fab03579219256\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/gate.js\":\"323543041c1a3a97\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/index.js\":\"73f17404b73f9143\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/wolfTheme.js\":\"b6d7876df9186c9e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/BlockDragLayer.js\":\"6c504e0a9a477606\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/dragController.js\":\"320534cbf47facad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/dropTarget.js\":\"f81a1c31f68a787c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/index.js\":\"546a3ed149ce6544\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/projection.js\":\"d85ce6e711b7cb67\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-info/BlockMetaCard.js\":\"59eae9786e70b65c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-info/index.js\":\"95b28cbb8eb73be3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/AddTagDialog.js\":\"ccccdf9fd1fe608f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"fdbc185053a68e2a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/TagNameIssueHint.js\":\"0b08562420360871\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/addTagAction.js\":\"956c493f6e51dcc2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/appendTag.js\":\"c619fc917afd7098\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/config.js\":\"62d5e1a38abc82e0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/dataExtension.js\":\"99a73544ef3ca329\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/index.js\":\"bf851e1a09275d88\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/propertyEditorOverride.js\":\"c9daa18eb7a0609f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/BreadcrumbList.js\":\"fbd63dfea52288cd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"db3fa81bc4f384dd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/Breadcrumbs.js\":\"d4df7b572a338f97\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"0582a61aa6125b01\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"2dd2e0b32ca919d5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/index.js\":\"6af46bcc51be0174\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"d0020ff57c3655f5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/CharacterCountItem.js\":\"abcc79318eb7c39c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/ProfilePropertyEditor.js\":\"472059e4618b7f3c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/actions.js\":\"89d89775c2a5c74c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/blockType.js\":\"e010bb1554be0278\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/charCount.js\":\"e470a2cf57a41807\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/dataExtension.js\":\"8b85a8650c6714fc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/index.js\":\"8700dd8854778c9f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/profiles.js\":\"4b7213a5643c9990\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/properties.js\":\"0b29e4def36c71d9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/subtree.js\":\"84134a85a8dd2cd1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/textCounts.js\":\"8486e2f8b34c18f1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/colemak-keybindings/index.js\":\"83e4458cab8a10d2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/CommandPalette.js\":\"ae2e35525e0c7402\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/HeaderItem.js\":\"bcb8dcad967a79fd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/context.js\":\"2c21e93bf75d6323\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/index.js\":\"7ed15c254917ff4b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/selection.js\":\"3734a9aa6173be36\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/toggleStore.js\":\"a516833d7080b6e2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/useCommandPaletteActions.js\":\"a8fd73b7602bbdb5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/ContributorBadges.js\":\"e4b75f1a83dc0536\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/ProfilePicture.js\":\"fac279f8e6038e6e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/author.js\":\"ec2c1980d44efef7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/codeMirrorExtensions.js\":\"fbcb6986e2a4a8dd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/dataExtension.js\":\"dcfd3e5bf9b747e3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/index.js\":\"de072da00dc1c6d2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/mentionAutocomplete.js\":\"ff2ed28d5f4dc70f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/processor.js\":\"bdd7464a2c364656\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/profiles.js\":\"2e5b21d83abbaa54\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/queries.js\":\"c233e55d5ead4cbd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/schema.js\":\"c0b65f63b72a659f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/useCommentAuthor.js\":\"c6aaf5fef940447f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"adc036918122c23d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/followOrigin.js\":\"56af70fc669420e2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/index.js\":\"f2f3acf710df6b2c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"1cee8239211a4130\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"a8a7996c1868350d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/CalendarGrid.js\":\"17130b8d94cdb1e9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DailyNotePicker.js\":\"a29481b87af1e5d0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"a8e6bfdb8e256c35\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DateNavDecorator.js\":\"fbbc7fd89244d58e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DateScrubOverlay.js\":\"d607d9f8030625a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DayPropertyControl.js\":\"8f9cf43cd42af713\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DayValueReferenceControl.js\":\"3d4dffe1fc7087c2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/HeaderItem.js\":\"2529645554cdb708\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/ReschedulePicker.js\":\"5b03a694fa7da937\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/SpreadDatesDialog.js\":\"8627b2e874a57d2b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/actions.js\":\"a77562a2c2ed53ea\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/blockDateAdapter.js\":\"dd4bf40b4d939ee6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/calendar.js\":\"6e968e70eb6a9d35\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dailyNotes.js\":\"8c3c1a04505b7f75\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dataExtension.js\":\"ef441709b0b0a846\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubActions.js\":\"2055fa6d228945b6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubGesture.js\":\"e09f4a206a1f7af0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubGestureActions.js\":\"6f607655d334a49f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubRecognizer.js\":\"88f0b9273bd85dbd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dayProperty.js\":\"671f7fa2a415adfc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"cfd04805122e6191\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/deletionGuard.js\":\"1a5ba6650f0107ab\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dueQuery.js\":\"d68d11c8964fc895\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/index.js\":\"a63f723da3a41361\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/landing.js\":\"166ad2c168129ff7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/localSchema.js\":\"9ca54b4e18fbda60\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/referenceDateAdapter.js\":\"32e755045b5d52d5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/rescheduleAction.js\":\"c854f1727f988d83\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/schema.js\":\"b6ad7ef6f8634e9d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/spreadBlockDates.js\":\"f3016db144c02c97\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/spreadDatesAction.js\":\"1acdc35b218e0e39\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/today.js\":\"59e40b5177a3e50c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"099065b6a4519a3c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"d598fc8047b591cf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/audit.js\":\"8f200217b378c6d7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/auditAction.js\":\"7a8ca6a0a39618de\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/auditRanges.js\":\"a6d17bb3873ba041\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/diagnosticsSource.js\":\"18d6386443f44783\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/divergenceScan.js\":\"84b61d730b832732\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/index.js\":\"22d5df732928e9f6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/propertyChildrenChecks.js\":\"8257b9654c60691a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/referencesMirror.js\":\"cace42bed147cf2e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/rowJson.js\":\"5a01f083070fb243\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/schedule.js\":\"c7b646698360df4d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/store.js\":\"823d95f112d9ce0a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-maintenance/action.js\":\"cc8c10c67124018e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-maintenance/index.js\":\"b10aa3053ff7b1ba\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-maintenance/plugin.js\":\"609e58df83da61c0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"12838bdb29f45feb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/actions.js\":\"9f86d805f0ef05be\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/changeMarker.js\":\"e606c90ba5cf380f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/diagnostics.js\":\"f6a51a5d5357376c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/fileSystemAccess.js\":\"e46d06cf6f0250ef\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/filenames.js\":\"27cdb6d6af0b8538\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/index.js\":\"5e46f2c91892b116\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/mirror.js\":\"5bfcf2840075d785\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/runLock.js\":\"8de346c48bb20706\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/runtimeHealth.js\":\"ce0588fcc0fadc68\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/schedule.js\":\"fa873df63c93e8a5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/store.js\":\"e052625595462e2a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/default-themes/index.js\":\"20228b81158850b2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/default-themes/themes.js\":\"e414bda8b5e0ed28\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/diagnostics/facet.js\":\"80ca996d43b2fac3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/diagnostics/useDiagnostics.js\":\"000d24b607e5010b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/dismissals.js\":\"906a72df52579004\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/index.js\":\"8f779e9b23d85e8b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/status.js\":\"1de40c4acb1ad4a2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/store.js\":\"deb3737904791b30\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"843073d225f70180\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/ExtensionsSettings.js\":\"9144827f1e495d99\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/actions.js\":\"3de3f0ce99a2157c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/config.js\":\"5c625873daf39296\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/dataExtension.js\":\"17eb3720aad5b7db\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/effect.js\":\"1a9e090f30a29f56\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/index.js\":\"a89c6444cbaac7f6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/propertyEditorOverride.js\":\"c4119f1af032bd8d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/useToggleTree.js\":\"07e3eb4beb9c12eb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/ExtractTypeDialog.js\":\"beb6ce0a613f6c3f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"a259e1ce5069fdfd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/PropertyShapePicker.js\":\"3da8b0b0f97c788a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/action.js\":\"1c8058186e57b75c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/index.js\":\"a05be450c8ad471c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/FindReplaceDialog.js\":\"3e444b14351dcd14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/HeaderItem.js\":\"d3ed7b20dcba3529\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/dataExtension.js\":\"b606098002eac2fc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/index.js\":\"56a1149e8776bce8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/search.js\":\"5b5cab5a7dad73b0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/toggleStore.js\":\"a031c82a18733df8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/LocationPropertyEditor.js\":\"b27b55fa34dde2a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/MapView.js\":\"a42194d7f3898c61\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/blockTypes.js\":\"9cf6c8a475a48db2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/codeMirrorExtensions.js\":\"6766ae8098be4844\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/createOrFindPlace.js\":\"ec2fe46668c47799\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/currentLocation.js\":\"d8af2457de0f396b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/dataExtension.js\":\"a3302c6e7376b67f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/geoContentDecorator.js\":\"a7a126a7cd6bbf94\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/googlePlacesClient.js\":\"0a88a17c7272844a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/index.js\":\"65bb880331de28c1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/locationsPage.js\":\"0ca3505fb7c072d4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/mapViewport.js\":\"052dc5954184ff8e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/pickCurrentLocation.js\":\"ba815e06af41586c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/placeAutocomplete.js\":\"be406590406c476a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/placeNameCollision.js\":\"5578430728f1cbdf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/properties.js\":\"966bf1f094b62da4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/propertyEditorOverrides.js\":\"52237ca318b3aa3b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/query.js\":\"12785743bd586019\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/usePlaceSearch.js\":\"98b253e96b20f4f6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"f2ef80e48cf71a36\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"42e3221345ce69da\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"fed087f9953e8436\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/config.js\":\"34705452d18d6ee1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/dataExtension.js\":\"51d009fe4ec6c05a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/facet.js\":\"f4c50f84f990c4c6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/grouping.js\":\"659ee07b5baec378\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/index.js\":\"2e54aa17e0963b53\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"f971484d450e1dd1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/query.js\":\"ead04948b9b41135\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/resolveConfig.js\":\"b3c61346aa59ba70\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"574664797e559f86\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"6d33f9e77046c809\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/HtmlDocumentContent.js\":\"095cf42619c763a3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/HtmlFrame.js\":\"926e3a245745a328\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/actions.js\":\"99435b279cfd30f7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/blockType.js\":\"20d030fccce24792\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/confirmRunScripts.js\":\"10d66d44f1001ceb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/dataExtension.js\":\"06c14abcd07c7498\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/frameAnnotations.js\":\"96df70185c2fc103\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/frameDocument.js\":\"d07381264a0e284f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/frameTheme.js\":\"58a8bc9722c5cb40\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/index.js\":\"2dad719521041966\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/scriptConsent.js\":\"e69baa4a70b8b41b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/sourceMap.js\":\"550034c4d8520dcd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/useDocumentScripts.js\":\"f6232ed4493ac7d7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/index.js\":\"da101584da9d99da\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/record.js\":\"dcdd2d68f3422739\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/recordStore.js\":\"eb93b3f7d73e25ff\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/responsiveness.js\":\"ce9b8d59195149da\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/schedule.js\":\"5def0042959cd832\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/sessionContext.js\":\"551f94203d60780d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"4434ce9dd1f15549\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"e1b67146e83bc781\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/actions.js\":\"bc0011f8e247281c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/config.js\":\"f0b54236c16c4c94\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/dataExtension.js\":\"2c0a84d8cd0083fc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/effect.js\":\"53c0995cde507f70\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/index.js\":\"18db0641183386ef\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/keyCapture.js\":\"5656d29d973e3142\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/overrideStore.js\":\"bbdcda30a06add55\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"3ffd4b7242e9fb20\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/HeaderItem.js\":\"48c08d53e937ea33\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/LeftSidebar.js\":\"c394be04f6c8ab47\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/actions.js\":\"b4560e1ac152fa54\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/facet.js\":\"d906ab53b607b666\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/index.js\":\"ed5d6ff047b79542\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/shortcuts.js\":\"2efa9c784b8134b9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/toggleStore.js\":\"a19d1c9ba4e57912\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/MergePicker.js\":\"b5cdca11d4609099\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/index.js\":\"6d82f75aa25b3afe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/mergeAction.js\":\"a5d2fea7878083f7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/strategy.js\":\"898c9f53bd70cd42\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/Button.js\":\"883af7f54dd83cbe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"679614c5f324f68e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/defaultItems.js\":\"4fe405fb0f5e678f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/facet.js\":\"a893049b2d499e32\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/index.js\":\"448f2b95f2e85271\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"f8e59229d0c8865d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/actions.js\":\"c9f405fe80fb2820\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"05fd822acd69474a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/facet.js\":\"82538b32bd090202\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/index.js\":\"b64f95143a7d69fb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/MoveDestinationPicker.js\":\"f689ed951500bdc9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/blockSubtreeMembership.js\":\"1409302fc5e1e5b1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/contextMenuItem.js\":\"8ad4cce1f256c1fe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/index.js\":\"11ef3e5ed70fec18\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/moveAction.js\":\"09c97c59a8449d97\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/moveBlocks.js\":\"64148c441cb18842\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/selectionAfterMove.js\":\"99ea865c7952ae70\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/TutorialBanner.js\":\"5ee81bce4a0e74cb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/action.js\":\"fa823ca851fde68f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/bannerDismissal.js\":\"3b7e4984fabd42c3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/documents/cheatSheet.js\":\"dd542cca9822308f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/index.js\":\"936e624b18029be7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/keys.js\":\"f33500b84618ad6c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/landing.js\":\"370e06bd9df0c5d7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/outline.js\":\"7e46ac5f338da684\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/seed.js\":\"5525c70e62a80e83\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/PerfTrendDialog.js\":\"ccbd58e285a274c3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/analyze.js\":\"520ee5f0a6b93a77\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/diagnosticsSource.js\":\"fcc9fcf5f75324c8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/index.js\":\"36f75ec28dd0a23d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/load.js\":\"9bd86048cba881be\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/monitorRun.js\":\"12e1284f79e09059\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/schedule.js\":\"3e595336ba502d1b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/series.js\":\"a29fd18f76a7abbb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/store.js\":\"4d33c89983ed7ad3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/trendAction.js\":\"ad3f6307928ebbcf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/verdict.js\":\"152316661e01fda4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/plain-outliner/clickToEditAction.js\":\"63b1a2dc824ec1a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/plain-outliner/index.js\":\"8b8461e9f8328569\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/plain-outliner/interactions.js\":\"368a9741241332e2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ee24732c5aba26d4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/MigrationGate.js\":\"7b665ae0a69e25d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/MigrationGateDialog.js\":\"f3e7e504b7a9bace\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/action.js\":\"a07397eadb215824\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/index.js\":\"482a4a43c62b16f0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/localRunMessage.js\":\"02a3c6bdfc123548\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/plugin.js\":\"f488c5e207f09e10\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/progressReport.js\":\"9f7520a4bbdd43b0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/sweepProgress.js\":\"40997d3148a391f3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/FieldRowRenderer.js\":\"796a16567ced972b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/ValueRowRenderer.js\":\"7589d25855c53028\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/actions.js\":\"d082ca78bfc9cc0d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/autocomplete.js\":\"49d9c658327ce8ea\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/fieldRow.js\":\"b168cdb88d3b7fce\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/index.js\":\"7ba8fd3f332f2ba2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/referenceWarning.js\":\"f038ee51f7b7ea2c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/valueAutocomplete.js\":\"efe63d8dc59a8dda\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/valueSchema.js\":\"08b9d1ca096382f7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/HeaderItem.js\":\"1e515ef08c65758d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/QuickFind.js\":\"d236214a28a58151\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/index.js\":\"f0585aea3e750ca6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/recents.js\":\"007c79321e90a667\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/resultItems.js\":\"835fc83b3b3f9a12\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/selection.js\":\"bc9bf3b8d01fb5e6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/toggleStore.js\":\"eee0c1921bc61650\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/HeaderItem.js\":\"146e923621b715c8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/RecentsPageBlockRenderer.js\":\"a3703bc3b872107d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/grouping.js\":\"273600ec59b0ed58\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/index.js\":\"fb60ebdf9e929b08\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/target.js\":\"9430a79794e5d1f1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/codeMirrorExtensions.js\":\"c2d14855bbe52b08\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/contentPrefill.js\":\"a156966dab6251aa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/dataExtension.js\":\"e67f6871049fb2ad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/index.js\":\"cdabbb06eeaa8252\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"951b5d288b14f4a0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/invalidation.js\":\"cea27cf06899cc44\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/localSchema.js\":\"586ed8abf18d14ca\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/blockrefs/index.js\":\"b051d877518d3d53\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"4129e7c14e0916c7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/index.js\":\"6608941cc2fe09d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/referenceNode.js\":\"770e079c56b97fe7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/remark-reference-occurrences.js\":\"fe5ecd43dbfdd377\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"7b1ebfe646eb9087\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/index.js\":\"4df5f50ae59d07f7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"fe32b78967222952\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"874fcbe37d8fe07e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/mergeRetargetProcessor.js\":\"bceb42100ade4911\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/parseFence.js\":\"7aa1a9de73cde981\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/referenceParser.js\":\"2e18c08cda891a6b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/referenceProjection.js\":\"f3090374d0324ddf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/referencesProcessor.js\":\"38b27bc523f9f2fd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/renameProcessor.js\":\"398a202615c7aee0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/spanReplacement.js\":\"0b422020094d5da0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/htmlToOutline.js\":\"51a0a748c983cf9e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/index.js\":\"9f537bbf7887f8b4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/normalizeClipboardDom.js\":\"0b1dd2a215ef8247\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/pasteDecision.js\":\"d4c494401fcbf085\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/action.js\":\"aac56a343d1705d0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/blockIds.js\":\"91c3abac4a8b49d8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/content.js\":\"91c57b7e3476554d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/effect.js\":\"2fa8a56b666a2367\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/ids.js\":\"d1eb4afeaee16976\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/import.js\":\"64f210e0063ec2dd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/index.js\":\"e13a13cbb5d8c68d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/plan.js\":\"7b8fbc7115505a13\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/plugin.js\":\"a72b3e00e41890f5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/promotion.js\":\"1804c5ddf08a3bb4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/properties.js\":\"98f59cc25c2750ca\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/references.js\":\"6911279ac4f4a391\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/report.js\":\"a9dde30e8b7b6330\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/roamMemo.js\":\"5608f173d2bd437c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/runtime.js\":\"7ad099c273417fd4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/schemaReconciliation.js\":\"776430fd0368c5a4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/srsMarkers.js\":\"5691fe17cc7135ac\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/todo.js\":\"120ee4a7f8f6c03b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/typeCandidates.js\":\"0e1ac7017d235aff\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/types.js\":\"195ba0e067349f18\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/search-health/index.js\":\"b3d27306a19e09f7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/search-health/store.js\":\"1c0abf9472d001d7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/HeaderItem.js\":\"d46527ca28918df8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"541b4ca0a7af9ab2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/index.js\":\"919023a4953afc18\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/model.js\":\"387c47a31f904b2f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/toggleStore.js\":\"234121ad9de79299\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/useKeyInspector.js\":\"619567745fbd9303\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"f9a2993a16dc07d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/ShellDecorator.js\":\"b4ffad9c20f219ee\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/actions.js\":\"19b24b10d592c5d9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/exclusionsFacet.js\":\"c93da54968752282\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/index.js\":\"d1ee1ade51ccf399\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/shell.js\":\"bd0794e6e8fabeff\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/surface.js\":\"c8663d555b0203f7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/walker.js\":\"c60679eb5da6fe42\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/RescheduleToast.js\":\"6c736fe752d2726c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/dataExtension.js\":\"48fecf2d6128c9d7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/index.js\":\"e98d6be47737da01\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/indicator.js\":\"0cbab3b58271072b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/moveSrsState.js\":\"634a81a2ef624534\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"61a6df2f91d37a37\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/scheduler.js\":\"f4b9b067e976cb5c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/schema.js\":\"4c6653dd0e5f61e1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"d844f561552bf0c5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/srsClipboard.js\":\"219fa18fc2b2e833\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"51f13d936188d487\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/DailyNoteReviewHint.js\":\"a02b3cc52d5a846c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/DeckPicker.js\":\"204e590d6235c0d3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/ReviewControls.js\":\"8cd257f2c0e0fdd0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/ReviewDeckRenderer.js\":\"6179ece27b529af3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/ReviewSession.js\":\"12fadb399d6f2ef1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/actions.js\":\"889e082bb50820c6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/archive.js\":\"a50cba7c5549b6be\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/dataExtension.js\":\"80ecd488554473d0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/deck.js\":\"e5286c81c0c4c46e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/dueQuery.js\":\"77c4a65f46d3205f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/gradeDecision.js\":\"874173ee2a883222\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/index.js\":\"ff1c67a272b8afd4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/keyHints.js\":\"e0062a447624f40d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/reviewCardLayout.js\":\"10046713416f5a56\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/reviewProgress.js\":\"fd80e6d20d19c051\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/schema.js\":\"e7b3f565c41b3391\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/useDueCards.js\":\"5c6c22e2d5fb6005\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/startup-metrics/index.js\":\"9955c144d00879ee\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/startup-metrics/record.js\":\"c4b2f514b5c34cce\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/storage-persistence/index.js\":\"24ed6e1f73c9fcca\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/storage-persistence/persistenceStatus.js\":\"0ad1ad1c06d4f818\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/storage-persistence/requestAction.js\":\"f2fc0a8a70c32b1e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/TypeChipsDecorator.js\":\"3a7bb9867f16bfb0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/codeMirrorExtensions.js\":\"f54d5dc311871813\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/index.js\":\"75318624a890072b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/typeAutocomplete.js\":\"bbd5270ac494d648\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"d09324605bf1b01e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/actions.js\":\"4b6257f2b3c02bf5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/anchor.js\":\"3248fa0408cd7fbe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/events.js\":\"bb1e0c989be32d78\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/gestureActions.js\":\"d2a357503640ea3a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/index.js\":\"04b63605855e6807\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"4931a97106ba41e6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/sync-metrics/collect.js\":\"505d03efb01484c4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/sync-metrics/index.js\":\"c7b7bd7c410e1d0b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/sync-metrics/record.js\":\"d7a85a6123811653\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/RejectionDialog.js\":\"5164b849ac50a12d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/SystemStatusHeaderItem.js\":\"c0c31585e2341597\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/index.js\":\"7e81b0e4c02f0da8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/model.js\":\"76e52282de587ae9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/queueCounts.js\":\"33563830a75fd0e4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/rejectedHelpers.js\":\"f991a3528cc3da1f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/rematerializeAction.js\":\"80f38a42071a2639\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/useHysteresis.js\":\"1bf231e8abbd87c9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/ColumnHeaders.js\":\"dde9d7fa69e8f08e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/QueryUi.js\":\"4e5f64e628f2a449\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/TableLayout.js\":\"2a6da6998414c095\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/actions.js\":\"651cdf7e913f46e4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/cellEdits.js\":\"120a6aec0be094ac\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/childrenViews.js\":\"d0a10125aeb2920f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/columns.js\":\"f34e01a909ec09a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/controller.js\":\"c06112a615286689\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/convert.js\":\"52029af34ca6b1c8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/dataExtension.js\":\"d5b6540ee7613be0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/index.js\":\"1e67c3a9fe5aec54\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/keys.js\":\"b5536f10c8a10370\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/model.js\":\"0cb8901e782477a9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/QueryText.js\":\"6276e8ecd575a0a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/backfill.js\":\"6cdd277c84a42976\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/completion.js\":\"2ab6cfe0f0430776\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/format.js\":\"c48a1219b759d5ef\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/parse.js\":\"ba217d0358e6844b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/queryValue.js\":\"97085b6175d02a21\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/registrations.js\":\"db523fd7915e2381\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/source.js\":\"a2cc0497200b8837\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/registry.js\":\"1143f04e367b4762\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/rowGutter.js\":\"6aa649fbc6b380d7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/rowVerbs.js\":\"0fcf6a81e1e624b4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/schema.js\":\"dfdf1a3fd7cbbe1e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/sort.js\":\"91aa3ddc943fc0e1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/theme-toggle/effect.js\":\"06d9e6851cad4011\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/theme-toggle/index.js\":\"f30d57a04eca8499\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/theme-toggle/theme.js\":\"f2fbfdfa095f2c22\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/actions.js\":\"7bc11cd781f9dfd9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/dataExtension.js\":\"97f729c8fafc6008\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/index.js\":\"82fb284562405914\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/schema.js\":\"fe95120061beab87\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/TouchSelectionLayer.js\":\"82a70540fcbb0ae7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/actions.js\":\"355f583d6bca82fb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/defaultItems.js\":\"14ef588cd41fe0c7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/facet.js\":\"d0319a9b5c7a317c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/holdRecognizer.js\":\"6a53fe24f031a91c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/index.js\":\"c580f08da72b68a0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/update-indicator/UpdateIndicator.js\":\"4fb404cb152f5dbd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/update-indicator/index.js\":\"f196f79035b4a1ad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/update-indicator/loadTimes.js\":\"54ff5852f10dd159\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/VideoNotesRenderer.js\":\"ad6ad2ba4620b185\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/VideoPlayerRenderer.js\":\"6660f214cf31eaa6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/VideoTimeStamp.js\":\"b881e8d26e965776\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/actions.js\":\"5b743a85231d6888\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/index.js\":\"69a95060373d320a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/markdown.js\":\"0679b7a3e991b9c3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/notes.js\":\"a5bf243782320599\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/registry.js\":\"e44af7447618d3fc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/remark-timestamps.js\":\"ba61d5072cd0d05f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/view.js\":\"5e6b02c3c8cbfa06\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/LinkHints.js\":\"f4a8233bfa1547a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/index.js\":\"60b4c6bc15d42b01\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/model.js\":\"5c2f3ce6496eff23\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/settings.js\":\"54ec50d20ea931e2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-normal-mode/actions.js\":\"0cb7e24ced93e331\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-normal-mode/index.js\":\"e0b37a23cb915c4d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-normal-mode/interactions.js\":\"96987012752e23ea\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/workspace-header/index.js\":\"9ba5094cb493e2c0\",\"/knowledge-medium/pr-preview/pr-1924/src/registerServiceWorker.js\":\"67a2bc0475ddfe32\",\"/knowledge-medium/pr-preview/pr-1924/src/requestPersistentStorage.js\":\"e85dc381763437e8\",\"/knowledge-medium/pr-preview/pr-1924/src/services/authRequestDeadline.js\":\"1052fb7a16033ac7\",\"/knowledge-medium/pr-preview/pr-1924/src/services/authStorage.js\":\"d833aff4070bebed\",\"/knowledge-medium/pr-preview/pr-1924/src/services/powersync.js\":\"9d15c581275f80e0\",\"/knowledge-medium/pr-preview/pr-1924/src/services/supabase.js\":\"eb9e50290bc6e98a\",\"/knowledge-medium/pr-preview/pr-1924/src/services/uploadErrorClassifier.js\":\"23bacb5d861ef54e\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/ActiveContexts.js\":\"efc0ecb0b9c03192\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/HotkeyReconciler.js\":\"dab603dd4dd324bb\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/WipeLocalDataDialog.js\":\"f015b3861524e70e\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/actionDispatch.js\":\"0731ecf19e0978a0\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/actionKeyHints.js\":\"888974e9684411de\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/actionRefItems.js\":\"f2479b58d3aef4ad\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/applyKeybindingOverrides.js\":\"0c9d88f5c5610b0a\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/blockActions.js\":\"f2961d48bd824927\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/blockMergeGesture.js\":\"0afe6741788fff53\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/canonicalizeChord.js\":\"2fafda8540109857\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/defaultContexts.js\":\"55435218211e8e1e\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/defaultShortcuts.js\":\"dff6b87d126c28ce\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/effectiveActions.js\":\"9ff206c8ade61ac8\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/formatChord.js\":\"990294a49480e675\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/gestureAction.js\":\"2168b38952a2a106\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/gestureBinding.js\":\"a011774edf0438fc\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/holdRegistry.js\":\"5bfefaa40bb23f37\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/keybindingConflicts.js\":\"fe71a057c27ef356\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/keybindingOverrides.js\":\"059aa1e6adc1eb83\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/pointerAction.js\":\"b3efd10ecf03efbd\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/resolve.js\":\"0002ad5da9a23d81\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/runAction.js\":\"18c184b21279d62e\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/sequenceMatcher.js\":\"86973acbcc20798b\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/types.js\":\"2679dfe86d2fa6eb\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/useActionContext.js\":\"319badd14cae1d81\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/useActionDiscovery.js\":\"2d1ce9c5c25d6b78\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/utils.js\":\"2efc1b240c857114\",\"/knowledge-medium/pr-preview/pr-1924/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1924/src/sw/bootStore.js\":\"06c4f460bb9831ee\",\"/knowledge-medium/pr-preview/pr-1924/src/sw/previewDatabases.js\":\"c0cc208179f9cc13\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/byteTransform.js\":\"a3fdc754fb24e5d5\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/attachmentCleaner.js\":\"47b95c3c887ec0a0\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/attachmentParts.js\":\"9dc5aa508acfa8c3\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/bundleParts.js\":\"3bcd647eb98b7ad8\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/bundleRecord.js\":\"3a081664d8dcd666\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/manifest.js\":\"6b972b612711aa3c\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/takeBundle.js\":\"89f84ec8eb9cb07f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/verifyBundle.js\":\"eea5e1efe8115615\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/cleaningStage.js\":\"68d20a0640e04e82\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/conversionKey.js\":\"479f6e6e2daa0b05\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/conversionServer.js\":\"1fea75248edffec2\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/flip.js\":\"fc0e48f329d67d69\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/flipAttempts.js\":\"b18d0c3d1c7f7846\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/pages.js\":\"82ac75033affbe55\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/preflight.js\":\"7371d3c23fb90f23\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/reseal.js\":\"27388da38285a895\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/runConversion.js\":\"6fecdce46a665a28\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/runLock.js\":\"4fc9b140a2889fce\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/sealing.js\":\"c6958adef5b04255\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/sealingStage.js\":\"b44636de3541d3e0\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/stage.js\":\"1090632fb4141338\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/verifyReseal.js\":\"6dae390b6ae382fd\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/aad.js\":\"061c1c5baae09a50\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/aead.js\":\"e45f2c5f78217f4f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/base32.js\":\"5e9ae478ca885b7a\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/base64url.js\":\"3e0bf879a11cad50\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/binaryEnvelope.js\":\"5523293aee5b13c2\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/byteAead.js\":\"5335b1381fa675cb\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/canary.js\":\"1e655ea613e236a0\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/contentHash.js\":\"2df9b12160ae8724\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/contentKey.js\":\"ffe80dc12f97cb8f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/derivedIdNamespace.js\":\"71e702fc13483a9a\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/envelope.js\":\"10e19127e3ad8efa\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/hex.js\":\"16d8f8bd7059fb82\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/sha256Hex.js\":\"539da2767b219154\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/workspaceKey.js\":\"08e3b3ad32a010de\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/conversionState.js\":\"191d44532e392324\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/createEncryptedWorkspace.js\":\"0066c2efa316569a\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/pastedKey.js\":\"cd54df33e12cf9ce\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"a6747616e8ecb86a\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/upgradeWorkspacePin.js\":\"9b1a12741a51b71e\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/keyStore.js\":\"9199edf87ebd1feb\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/mintWorkspaceKey.js\":\"e83a9b52601864ca\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/modePin.js\":\"1f5a0c5b18a468ea\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/openWorkspaceKeys.js\":\"3f23bb43cc67771c\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/resolveWorkspaceEntry.js\":\"fde539663f82344e\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/resolver.js\":\"795b81e3132b4187\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/workspaceAccess.js\":\"fee3b853c225f902\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/transform.js\":\"92963c940d512aaf\",\"/knowledge-medium/pr-preview/pr-1924/src/themeBootDefaults.js\":\"967cb3af91ddc065\",\"/knowledge-medium/pr-preview/pr-1924/src/types.js\":\"c9715989b16a1a16\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/ClientLocalSettings.js\":\"48f4d52b4faf13f7\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/abortableSleep.js\":\"ce72707e4a1112ef\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/array.js\":\"5074415f4552bf2f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/backlinkAutocomplete.js\":\"2a8fd52e94249eb8\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/blockCrumbs.js\":\"352a0acc052f63d5\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/blockrefAutocomplete.js\":\"77fe66948d01cc49\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/cadencedIdleJob.js\":\"87fb001f520741c1\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/callbackSet.js\":\"860de87224806e2a\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/clientId.js\":\"e551ec1193b8f4f8\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/codemirror.js\":\"dfb5f5dcb9aeccba\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/codemirrorCompletion.js\":\"b99b7c3668a345d5\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/copy.js\":\"903c3a5ff4728f0e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dailyPage.js\":\"6f5b3bb369378186\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dbForensics.js\":\"a9835712e11b989f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dbForensicsHooks.js\":\"61045d754c4b3a35\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/deleteBlockThroughUi.js\":\"2842bb9b61d6d6c7\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dialogs.js\":\"66d660a797a99a01\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dom.js\":\"eb1f81f020a82ced\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/downloadBlob.js\":\"867b25074521db99\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/drawnWalk.js\":\"3d54e528e3418ebf\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/exportSqliteDb.js\":\"974ff9af18f7047d\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/fileSystemAccess.js\":\"dd65398e02ca344f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/flipSlide.js\":\"9af40c3c6f52b2e3\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/fnv1a.js\":\"bf66cadc574c3c2b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/formatBytes.js\":\"f1ce5829f5fbd554\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/fuzzyRank.js\":\"bb82365217c81148\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/idbKeyedStore.js\":\"69cfc827826ddc4a\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/idleCallbackPolyfill.js\":\"4d0a03da958956c5\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/keyboardAwareScroll.js\":\"8c06ddf94c00b2a3\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/keyboardViewport.js\":\"d8c01fc8af57512d\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/lastWorkspace.js\":\"6eefcaec9b4a1293\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/layoutColumns.js\":\"b304895a1e07d223\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/layoutSessionDom.js\":\"7be5e6437866509a\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/layoutSessionId.js\":\"ddc6035c385ed486\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/linkClickGestures.js\":\"208ce5f70418b9e5\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/linkTargetAutocomplete.js\":\"2b038b2f61c556a0\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/localDbCorruption.js\":\"fb9207b7bc261e46\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/localDbRecovery.js\":\"3c04a218fddfb97e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/markdownParser.js\":\"8b9409f260eec7f4\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/memoize.js\":\"74cba39448228eea\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/nameFieldCommit.js\":\"403a5e3c57fce7d1\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/nameList.js\":\"b9476a4d1f04b0dd\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/navigation.js\":\"795249a37e8f6ea8\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/omnilinerNamespace.js\":\"813069c118adb446\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/opfsPageScan.js\":\"4ff422ffb77c3418\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelClearance.js\":\"07e95aaace79e695\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelHistory.js\":\"9d17eeb3b6842eea\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelLanes.js\":\"e3095001aca6935b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelLayoutProjection.js\":\"da5bcf6f8577e7bb\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelScrollAnchor.js\":\"cb1661368fe3c95e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelUrlFlags.js\":\"5dc20cf994746e25\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/platform.js\":\"0d5421569e45681b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/pluralize.js\":\"8f822881463e6109\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/propertyCreation.js\":\"19b73e0fb4cec5ef\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/propertyNavigation.js\":\"924e67829b630d5e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/propertyValueContext.js\":\"e335e54cbd61ecca\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/react.js\":\"037e6ec5f0bdc80c\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/relativeDate.js\":\"0ed1ef0c1c0f17e5\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/relativeTime.js\":\"221f14277e13b708\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/renderScope.js\":\"cf04afc6b06b41f4\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/resolvedThenable.js\":\"940da1880ade7ed1\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/routing.js\":\"69a988c40761671e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/safeMode.js\":\"1317f23cdb4b2320\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/scheduleIdle.js\":\"f53048b4862657e0\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/screenWakeLock.js\":\"0bdb069d06ea2889\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/selection.js\":\"0f424e6c72b4282e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/softKeyboardGrab.js\":\"7b599d7c4d059a24\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/startupTimeline.js\":\"5d5f023eba552745\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/state.js\":\"1f7bc9bee3904f7b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/string.js\":\"f463bc40954f234d\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/surfaceZoom.js\":\"51adb70b0a9035c7\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/time.js\":\"37deb358e627696a\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/toast.js\":\"1ad057365804d79c\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/toggleStore.js\":\"baba851f4df0a433\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/untilStopped.js\":\"3da90adfd2ded6b0\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/userActivity.js\":\"8ff62b3a4655f0a3\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/viewTransition.js\":\"8ac389253d42cbbd\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/viewport.js\":\"45a74965a744c25e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/webLock.js\":\"78f32af082457dfd\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/workspaceRecovery.js\":\"5638e385379eb16a\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/workspaceSnapshotStore.js\":\"1a62f6fb1425c6f3\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-compiler-runtime.js\":\"43ee9920a8fca9fc\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-client.js\":\"631ae0726512d9ca\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-server-edge.js\":\"d1e6e0e67f1bb0ea\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-server.js\":\"ec43fe42b94fe6d1\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-static-edge.js\":\"e3e6b4e51db8f9be\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-static.js\":\"df98ad6e69c96863\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-test-utils.js\":\"3cabea98e6dc1454\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom.js\":\"9246de594de06b0a\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-jsx-runtime.js\":\"7924599479bae439\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react.js\":\"facc9259f0520f30\",\"/knowledge-medium/pr-preview/pr-1924/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1924/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1924/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
