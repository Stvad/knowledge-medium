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
		buildId: "5043980fc319-c7c72731",
		scopeURL: new URL(self.registration.scope),
		keepGenerations: 3,
		staleScopeMs: 12096e5,
		touchIntervalMs: 864e5,
		precacheShell: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1924/\":\"f34a844ab1e93bfe\",\"/knowledge-medium/pr-preview/pr-1924/index.html\":\"f34a844ab1e93bfe\",\"/knowledge-medium/pr-preview/pr-1924/manifest.webmanifest\":\"6cf376e0df578d93\",\"/knowledge-medium/pr-preview/pr-1924/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1924/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1924/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1924/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1924/apple-touch-icon.png\":\"eebd8c5acbd6f04f\"}"),
		precacheAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1924/app.css\":\"636abd7c6bcf3d23\",\"/knowledge-medium/pr-preview/pr-1924/assets/FacadeVFS-CLU-lChw.js\":\"106e5bfef18c7604\",\"/knowledge-medium/pr-preview/pr-1924/assets/OPFSCoopSyncVFS-C9Bg9Ve6.js\":\"09441d6b652784ae\",\"/knowledge-medium/pr-preview/pr-1924/assets/OPFSWriteAheadVFS-CPvn8Gk8.js\":\"eb466f2aa0d7ad10\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-CePoIZt_.wasm\":\"d56db36a8dd12f89\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-D41mtu2Q.js\":\"7e62781e0291d551\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-async-B3FiUnt1.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1924/assets/wa-sqlite-async-CW0YAjpl.js\":\"a352279bca47c139\",\"/knowledge-medium/pr-preview/pr-1924/assets/worker-CEOE64nW.js\":\"155fed017e256545\",\"/knowledge-medium/pr-preview/pr-1924/assets/writeAheadVfsProbe.worker-D7yui5HO.js\":\"d78abb933d2b8d97\",\"/knowledge-medium/pr-preview/pr-1924/chunks/app-BvCTqwLw.js\":\"c03ee01b5ad3d08d\",\"/knowledge-medium/pr-preview/pr-1924/chunks/rolldown-runtime-CNOWq4Kh.js\":\"2d8d100f1a8f491d\",\"/knowledge-medium/pr-preview/pr-1924/index.js\":\"8dfaefd99a30f9b2\"}"),
		precacheRestAssets: JSON.parse("{\"/knowledge-medium/pr-preview/pr-1924/apple-touch-icon.png\":\"eebd8c5acbd6f04f\",\"/knowledge-medium/pr-preview/pr-1924/assets/AccessHandlePoolVFS-Bi1a0tMN.js\":\"13c9608a78a48084\",\"/knowledge-medium/pr-preview/pr-1924/assets/IDBBatchAtomicVFS-DcFVOYqP.js\":\"f5d141607bc3b1f5\",\"/knowledge-medium/pr-preview/pr-1924/assets/MemoryVFS-CG_emkB8.js\":\"6cf2043fdfee2f25\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-Cq3AePIW.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-Dz0GV88t.js\":\"6f8ffe196c5a2e3d\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-async-CTTUm0s9.js\":\"7ef39714fe888498\",\"/knowledge-medium/pr-preview/pr-1924/assets/mc-wa-sqlite-async-aRcIGeKj.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1924/assets/websockets-CyppMi_b.js\":\"1c2e8f008f569f73\",\"/knowledge-medium/pr-preview/pr-1924/chunks/AccessHandlePoolVFS-BelNfxpq.js\":\"23a12187940d0d70\",\"/knowledge-medium/pr-preview/pr-1924/chunks/FacadeVFS-CH3-sGNH.js\":\"f56a1da33e2aa1c9\",\"/knowledge-medium/pr-preview/pr-1924/chunks/IDBBatchAtomicVFS-CY635XMt.js\":\"ebac43954673f967\",\"/knowledge-medium/pr-preview/pr-1924/chunks/MemoryVFS-bhnJX694.js\":\"edb7c7d00835d1a9\",\"/knowledge-medium/pr-preview/pr-1924/chunks/OPFSCoopSyncVFS-B3pUchBU.js\":\"8e6016dedc590473\",\"/knowledge-medium/pr-preview/pr-1924/chunks/OPFSWriteAheadVFS-I4K3m69r.js\":\"01843f75dd2627cc\",\"/knowledge-medium/pr-preview/pr-1924/chunks/Preview-WGXvDdtU.js\":\"0e46ee8a374100ad\",\"/knowledge-medium/pr-preview/pr-1924/chunks/babel-BHJmTJNa.js\":\"e63d95d8ac2f299c\",\"/knowledge-medium/pr-preview/pr-1924/chunks/card-BEwj9W4w.js\":\"965a81f62ec1d8c5\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dash.all.min-DWmITN8V.js\":\"2ae14c5c8470b85e\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dist-7W5OdZjH.js\":\"507f07f67325d1ee\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dist-BvrWwRr5.js\":\"91c1df0f495d7ecc\",\"/knowledge-medium/pr-preview/pr-1924/chunks/dist-DVkYizKv.js\":\"e97553cc743277ff\",\"/knowledge-medium/pr-preview/pr-1924/chunks/freezeExtensionImports-BCfh5Zkv.js\":\"f149f0f8aefa78df\",\"/knowledge-medium/pr-preview/pr-1924/chunks/hls-CqFL_Jpx.js\":\"fb6d9d5c3cfa7064\",\"/knowledge-medium/pr-preview/pr-1924/chunks/lib-sLsWaEIT.js\":\"54ea87940a765649\",\"/knowledge-medium/pr-preview/pr-1924/chunks/mc-wa-sqlite-BfJegxcw.js\":\"2359c584017b1cf9\",\"/knowledge-medium/pr-preview/pr-1924/chunks/mc-wa-sqlite-async-DUl3mvxs.js\":\"1714dac622176348\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-BHcBJs-p.js\":\"738e8399efa71799\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-Br8U0wHO.js\":\"df226fedf57167d2\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-CI3hLr9S.js\":\"1425b5c82294ecdf\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-COAA6pCC.js\":\"3a708d0945571db0\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-CX-IMHap.js\":\"4e2e94004f3c1c0a\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-Csf4fOh0.js\":\"42b9b13daba5d3df\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-CybprfZQ.js\":\"45505b68af30201a\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-D-0KDKab.js\":\"d25198b01efb8628\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-dom-server-legacy.browser.production-Bas6yW7f.js\":\"cffc06d5a943c84b\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-dom-server.browser.production-Dgd-FfFR.js\":\"b20f5006b212bdab\",\"/knowledge-medium/pr-preview/pr-1924/chunks/react-dom-server.edge.production-CU8wh4If.js\":\"3de3d8d9c8f40857\",\"/knowledge-medium/pr-preview/pr-1924/chunks/server.browser-Dv-auBZe.js\":\"2941fe01f069e49b\",\"/knowledge-medium/pr-preview/pr-1924/chunks/textarea-B6WUg6GG.js\":\"dd09236fa652a7e6\",\"/knowledge-medium/pr-preview/pr-1924/chunks/ui-Cv2IDgXi.js\":\"d3d21a486a63dd87\",\"/knowledge-medium/pr-preview/pr-1924/chunks/wa-sqlite-SWkC1p24.js\":\"69a924a8a03c5aad\",\"/knowledge-medium/pr-preview/pr-1924/chunks/wa-sqlite-async-BR0G8gBn.js\":\"d6391cda2b8a1185\",\"/knowledge-medium/pr-preview/pr-1924/chunks/websockets-D5n9J5zD.js\":\"82786b8d215efc0d\",\"/knowledge-medium/pr-preview/pr-1924/extension-utilities.css\":\"8703f2ada2d5de0a\",\"/knowledge-medium/pr-preview/pr-1924/icon-192.png\":\"6f9c6d6b134e693b\",\"/knowledge-medium/pr-preview/pr-1924/icon-512.png\":\"5516a13d266c177a\",\"/knowledge-medium/pr-preview/pr-1924/icon-maskable.png\":\"8ee6b72637c58561\",\"/knowledge-medium/pr-preview/pr-1924/icon-maskable.svg\":\"860193ed68db0ad9\",\"/knowledge-medium/pr-preview/pr-1924/icon.svg\":\"e28a19b80fa1b856\",\"/knowledge-medium/pr-preview/pr-1924/mc-wa-sqlite-async.wasm\":\"4ff4be8698f346f5\",\"/knowledge-medium/pr-preview/pr-1924/mc-wa-sqlite.wasm\":\"dbd218c20b7fcbb5\",\"/knowledge-medium/pr-preview/pr-1924/src/App.js\":\"2f2c0d851488ae8d\",\"/knowledge-medium/pr-preview/pr-1924/src/appUpdate.js\":\"84afad57dc2e3ba4\",\"/knowledge-medium/pr-preview/pr-1924/src/appVersion.js\":\"46581f760432ac0c\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/initialLayout.js\":\"edacedf53ee1c00d\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/openWorkspaceData.js\":\"376ae642e826bd1f\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/resolveWorkspace.js\":\"338b9888e67a043f\",\"/knowledge-medium/pr-preview/pr-1924/src/bootstrap/workspaceBootstrap.js\":\"b2fbdbe5cedbbbd1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockComponent.js\":\"e9f5ec04a3b4f88f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockCrumbs.js\":\"7661251c369c50c7\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockEditor.js\":\"276e0e589f83aa6d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockLoadingPlaceholder.js\":\"a5932408ec165503\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockProperties.js\":\"555a5ec3dad4ede2\",\"/knowledge-medium/pr-preview/pr-1924/src/components/BlockSearchPicker.js\":\"fc2a64aca8bc5e8d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ConfirmBulkDeleteDialog.js\":\"9ec5c7b302a4a831\",\"/knowledge-medium/pr-preview/pr-1924/src/components/DividerHandle.js\":\"b5c37ca350bb1a7c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/DraftEditor.js\":\"b63fc6d339f3b354\",\"/knowledge-medium/pr-preview/pr-1924/src/components/GutterPill.js\":\"242a0eaa28cb965f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/Header.js\":\"a2615088cc8ec1d8\",\"/knowledge-medium/pr-preview/pr-1924/src/components/LazyBlockComponent.js\":\"75eb60268272e3a9\",\"/knowledge-medium/pr-preview/pr-1924/src/components/Login.js\":\"1e5cbda9963d7794\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ZoomableSurface.js\":\"142a230da90c33fd\",\"/knowledge-medium/pr-preview/pr-1924/src/components/editModeKeepalive.js\":\"a2ba6abeae5e49b3\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyDisplay/PropertyDisplayScope.js\":\"52af044bccef50b2\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/EnumOptionsConfigEditor.js\":\"8223363e5db3110c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/RefPropertyEditor.js\":\"6c1cdb6912aa38af\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/RefTargetTypePicker.js\":\"69d261c1d48b6b8a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/SelectPropertyEditor.js\":\"f022bfad6c864909\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/TypesPropertyEditor.js\":\"f2412aafc276020e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/defaults.js\":\"9949c448827b310a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/kernelValuePresets.js\":\"d0f3d317f4989c65\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/selectablePresets.js\":\"2fa22f3770a37c82\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyEditors/typesPropertyUi.js\":\"a49142625511ec0a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/AddPropertyForm.js\":\"ef84965b55a75773\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/PropertyPicker.js\":\"8868d265dd48c635\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/PropertyRow.js\":\"8b2827cd73d57f3a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/Rows.js\":\"9aa146b465822189\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/actions.js\":\"5b660b58359aa684\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/declarationOnly.js\":\"0b588e41df5cc8ff\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/layout.js\":\"f697b3f60829b56e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/model.js\":\"33bf610c876a9c87\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/shapeUi.js\":\"b4bb1e2bf4fb0b3e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/shapes.js\":\"cc2f68cd2d285d57\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/usePropertyEditingActivation.js\":\"be14012a221d3376\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanel/visibility.js\":\"1ee01c3b9d6421ac\",\"/knowledge-medium/pr-preview/pr-1924/src/components/propertyPanelSections.js\":\"5bf4c8e7d2b4ca15\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/BlockEmbed.js\":\"825c1840972697ab\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/BlockLink.js\":\"6af3ee6611bfac53\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/BlockRef.js\":\"db10c20863a3da91\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/CompactReferenceLink.js\":\"3e48b1aa855377fb\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/ReferenceLink.js\":\"58efa1bc85399933\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/cycleGuard.js\":\"f3005730bb1e9c28\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/cycleGuardContext.js\":\"035622a64e7bbcf8\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/linkInteraction.js\":\"34e2f2cc9ab87f96\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/referenceLayout.js\":\"4abfb7504b616d36\",\"/knowledge-medium/pr-preview/pr-1924/src/components/references/useBlockRefAncestors.js\":\"11d1235a686323f7\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockGutter.js\":\"0c0d82b7f3718e0d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockInfoDialog.js\":\"e9cb06a63868e2a9\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockReadText.js\":\"5244ea48caf53b7d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BlockTypeBlockRenderer.js\":\"94a43687cf8969d7\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/BulletHoverCard.js\":\"a239f00d83b64a22\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/CodeMirrorContentRenderer.js\":\"6e41d05df8a39779\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/CodeMirrorExtensionBlockRenderer.js\":\"c8b4dfdd91f7ce2f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/ColumnResizeHandles.js\":\"5168ea33ff56ab52\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/ConfirmDefinitionChangeDialog.js\":\"e6d58cfaf554ed69\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/DefaultBlockRenderer.js\":\"dbc27234f65820bb\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/LayoutRenderer.js\":\"db853dcced125f7f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/MarkdownContentRenderer.js\":\"c73a6112d9a25d60\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/MissingDataRenderer.js\":\"e3c24f3a3c700ddb\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/PanelRenderer.js\":\"4d3584ad4e4b7763\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/PropertySchemaBlockRenderer.js\":\"70fa7bd24106671c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/TopLevelRenderer.js\":\"8457c2c6134b57ed\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/blockGutterMode.js\":\"d9d797852b341b35\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/blockTitleText.js\":\"8d87b9bc7954e254\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/fieldCreationKeydown.js\":\"53972d874b8d804a\",\"/knowledge-medium/pr-preview/pr-1924/src/components/renderer/layoutRootContext.js\":\"919b30f3ab0646c4\",\"/knowledge-medium/pr-preview/pr-1924/src/components/typeChip/TypeChip.js\":\"6069ba7b5213b877\",\"/knowledge-medium/pr-preview/pr-1924/src/components/typeChip/chipStyle.js\":\"f7b78ffcf51126e1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/anchored-floating.js\":\"faabfa57b07399de\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/button.js\":\"644a434dcbc6686e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/card.js\":\"412a048f9e3e59ea\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/checkbox.js\":\"51f126dc0381062b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/collapsible.js\":\"7ad0fed4995a8c2f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/command.js\":\"b6df0c60480165f3\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/context-menu.js\":\"754a661a86cdb40d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/dialog.js\":\"a7142807a3144ad4\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/dropdown-menu.js\":\"21245142de8b76ae\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/floating-listbox.js\":\"bbf50fb633848437\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/index.js\":\"e841d5e9bdbbbc28\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/input.js\":\"16941e3d5b499eda\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/kbd.js\":\"b9405f75dd91ea0d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/label.js\":\"0e47233befd0ab32\",\"/knowledge-medium/pr-preview/pr-1924/src/components/ui/textarea.js\":\"3b4d241cda9e2380\",\"/knowledge-medium/pr-preview/pr-1924/src/components/useEditModeYieldKeepalive.js\":\"d605f6216cab8a2b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/BootFallback.js\":\"e8559b0841542f75\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/FocusedRowLazyMount.js\":\"7827e8b4f1298c1c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/LazyViewportMount.js\":\"3274d618080a6d98\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/LocalDbCorruptionFallback.js\":\"339874afc2134a8d\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/error.js\":\"93029c361f6b72b5\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/lazyMountRegistry.js\":\"441d200fe63b47b5\",\"/knowledge-medium/pr-preview/pr-1924/src/components/util/suspense.js\":\"090482fdb63ac02f\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/CreateWorkspaceDialog.js\":\"01c5280c23565474\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/PendingInvitations.js\":\"0227b7ee19df13e1\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/SyncProgress.js\":\"aa3f10415001e567\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/UnlockProgress.js\":\"8fce1ef665cb8963\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceKeyGate.js\":\"d5bfcb79097ea458\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceSettingsDialog.js\":\"5290f268f1f3355b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceSwitcher.js\":\"2307c2472ad1cf0c\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/WorkspaceSyncGate.js\":\"1dc7535f66b388a0\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/ConversionFlow.js\":\"877d5d645bfc711e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/ConversionFlowHost.js\":\"98495a38e36218ef\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/EncryptionSection.js\":\"72931439053aacb2\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/attachmentPrompts.js\":\"76a2e17189115fb7\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/bundleFolderPrompts.js\":\"15ba50b2244cbfbd\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/conversionFlowDeps.js\":\"14ead9b05fc44d65\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/conversionFlowStore.js\":\"f2301a78a1e899da\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/flowUi.js\":\"f5f0885bf17b9d99\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/conversion/useConversionRun.js\":\"a1512f21427c8c71\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/keyUi.js\":\"7b43a00accb3976b\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/useCloseOnKeyLoss.js\":\"80b8407dafc2e530\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/useCloseOnServerE2ee.js\":\"c603ea448081515e\",\"/knowledge-medium/pr-preview/pr-1924/src/components/workspace/workspaceUnlocked.js\":\"804192aed812b05b\",\"/knowledge-medium/pr-preview/pr-1924/src/context/backgroundSubtree.js\":\"14feaa91a6a4e705\",\"/knowledge-medium/pr-preview/pr-1924/src/context/block.js\":\"785eaf6f901caaf7\",\"/knowledge-medium/pr-preview/pr-1924/src/context/layoutWsContext.js\":\"e3f3e82c0f345654\",\"/knowledge-medium/pr-preview/pr-1924/src/context/propertyDisplay.js\":\"a87e5adf65a81a3c\",\"/knowledge-medium/pr-preview/pr-1924/src/context/repo.js\":\"cb995f3f17cd7bea\",\"/knowledge-medium/pr-preview/pr-1924/src/data/aliasClaim.js\":\"47531faa01227ffe\",\"/knowledge-medium/pr-preview/pr-1924/src/data/aliasSeatNamespace.js\":\"b2ea7511dee07245\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/blockData.js\":\"11bccacc87da04c6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/blockType.js\":\"a1b42cad075e6ba5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/changeScope.js\":\"b9df3e49923ad9d7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/codecs.js\":\"8f0a19edd165630f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/derivedData.js\":\"bd6b1f5bbcd05a57\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/errors.js\":\"e51e66b8c4177a53\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/events.js\":\"2eca90ef47fc13b2\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/handle.js\":\"696de0a4162f08b5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/index.js\":\"b1f526b896a16906\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/mutator.js\":\"5989f271e909b45c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/processor.js\":\"ef4570b788186bc3\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/propertySchema.js\":\"401842ff29b94673\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/query.js\":\"74f369f3699d077f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/sameTxProcessor.js\":\"9f0cfce9119aecdb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/schema.js\":\"696de0a4162f08b5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/tx.js\":\"696de0a4162f08b5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/typedBlockQuery.js\":\"869610d4d69951b9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/user.js\":\"aea3e45d371741ff\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/valuePresetCore.js\":\"5265f62cc8cee909\",\"/knowledge-medium/pr-preview/pr-1924/src/data/api/valuePresets.js\":\"b8f1e7df2264ebe2\",\"/knowledge-medium/pr-preview/pr-1924/src/data/attachmentCleanerIOVerb.js\":\"53fcb4a9617db183\",\"/knowledge-medium/pr-preview/pr-1924/src/data/block.js\":\"03db37934770c9e9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockCache.js\":\"01bfbf56f3affa21\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockId.js\":\"93b7010d4ccc8618\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockLiveness.js\":\"3ee51e4343380b14\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockMerge.js\":\"faa584b0f13b48bd\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockSchema.js\":\"8f5f98e28641fab9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockTypeLookup.js\":\"46c3c79e6f59747e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/blockTypes.js\":\"351075a9b882abcb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/childrenView.js\":\"c8343d2ddd3072f0\",\"/knowledge-medium/pr-preview/pr-1924/src/data/clientContext.js\":\"9ea302d50bc7d16d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/dbFileSiblings.js\":\"f0c612f7d147d574\",\"/knowledge-medium/pr-preview/pr-1924/src/data/definitionSeeds.js\":\"e5c5479fc48405da\",\"/knowledge-medium/pr-preview/pr-1924/src/data/derivedIds.js\":\"b9a0da016430341e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/drawnSubtree.js\":\"e89fb1d6afab7196\",\"/knowledge-medium/pr-preview/pr-1924/src/data/facetBridge.js\":\"8113f3ea94462b7e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/facets.js\":\"e5be94b33f90194c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/globalState.js\":\"1ed4f8240b4f9f2b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/aliasClaimRederiveProcessor.js\":\"05fdfc16a43cd0f4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/ancestorBatch.js\":\"47f7ef3a3d035de8\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/blockTypeTypeifyProcessor.js\":\"ec9d427ffbef3094\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/clientSchema.js\":\"963f54781106df9d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/commitPipeline.js\":\"2090fb615808c523\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/devAssertions.js\":\"fced412badeee337\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/firstSync.js\":\"c4602c41a234d04e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/freshInitialLoad.js\":\"907500d4c709fcf1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/graphBackfillClaim.js\":\"3919e76878062ca4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/handleStore.js\":\"7bb12fd6470b3c3c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/idleMarkerJobs.js\":\"2bcd6ff70efb31df\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/initialDownload.js\":\"6fb5702aff8600f2\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/initializeClientDatabase.js\":\"43587095ad834f8c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/jsonCanonical.js\":\"f89b2a67762a3335\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/kernelInvalidation.js\":\"ebf7d3c6fa9d69a0\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/kernelProcessors.js\":\"976f863efe9ef054\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/kernelQueries.js\":\"8d23d7dd078203d1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/mergeTypeMembershipProcessor.js\":\"def7d82bfdf02ada\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/normalizeReferencesProcessor.js\":\"6b84795b9dd2ef14\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/poolInstrumentation.js\":\"4e0b3007bc2192ad\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/processorRunner.js\":\"f394df8756fb9bc9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyCellBackfill.js\":\"abb659c4579e9bd1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyChildMint.js\":\"c22e3a96620604d1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyChildrenProcessor.js\":\"eac11194df1b8a39\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyDefinitionChangeProcessor.js\":\"3b190cb33a50fdcc\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyDefinitionSynthesis.js\":\"5b353677ba5dc84c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyKeyScan.js\":\"bdadb8df58623951\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertySchemaResolution.js\":\"b26043d9e17959ed\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/propertyValueEdits.js\":\"8ee041a6974c4534\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/raiseProtocol.js\":\"01ce67164f0bff3b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/readBatch.js\":\"6ab3ee843e3db3aa\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/refProjection.js\":\"117621e367424c45\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/referenceTargetLookups.js\":\"7a379edeaa255747\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/referenceTargetProcessor.js\":\"1d09ae256dcef1b6\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/replayMerge.js\":\"94ecd358a7be68ba\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/sqlBinds.js\":\"3a8f1488ad1f7660\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/analyzeOwedOnGrowth.js\":\"570e4017bbc2213a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/arrivalProcessors.js\":\"007fcbf15ae44c44\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/invalidate.js\":\"38353e784c698afd\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/materialize.js\":\"18640b5d210b5e7a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/observer.js\":\"02d8d125289403a2\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/syncObserver/reconcile.js\":\"197040a967326c72\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/timingMetrics.js\":\"6402dd2698b91d06\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/treeQueries.js\":\"6df0faf17984d590\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/txEngine.js\":\"d9c0c4938f6e4bc9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/txSnapshots.js\":\"7139dd044725582e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/typedBlockQuery.js\":\"aca5195ed0093dc5\",\"/knowledge-medium/pr-preview/pr-1924/src/data/internals/undoManager.js\":\"85b8fd958d119c6d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/invalidation.js\":\"2b419ba4d6ab344b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/kernelDataExtension.js\":\"6da2b3ae33396e67\",\"/knowledge-medium/pr-preview/pr-1924/src/data/kernelPage.js\":\"5df025962c02cfb1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/kernelValuePresetCores.js\":\"a5417c58ca8010ab\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localDbCorruptionSignal.js\":\"3adaa636ad68a0d9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localDbStorage.js\":\"a2f7684359222e29\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localDbVfs.js\":\"8d9a2348ce87a186\",\"/knowledge-medium/pr-preview/pr-1924/src/data/localSchema.js\":\"9682596b7e7bfa0b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/maintenance.js\":\"8fa3a0ca097d9cb9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/mergeProperties.js\":\"1a1e899cd4e3d592\",\"/knowledge-medium/pr-preview/pr-1924/src/data/metricsConsoleHook.js\":\"e031c97bd91387fa\",\"/knowledge-medium/pr-preview/pr-1924/src/data/migrationsPage.js\":\"8f2e06209dd7b0e8\",\"/knowledge-medium/pr-preview/pr-1924/src/data/mutators.js\":\"d447763df3ca12fd\",\"/knowledge-medium/pr-preview/pr-1924/src/data/orderKey.js\":\"d84ca5813f62bd85\",\"/knowledge-medium/pr-preview/pr-1924/src/data/orderKeyPlacement.js\":\"e6fa0db6f1d14c33\",\"/knowledge-medium/pr-preview/pr-1924/src/data/outlineSurface.js\":\"1afd970145e55f51\",\"/knowledge-medium/pr-preview/pr-1924/src/data/pendingEditorContent.js\":\"edbf8235b468d75c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/pendingUploadsSql.js\":\"0fd13c374cd0215b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/pluginStateExtensions.js\":\"003a9d4dad9bbad7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/powerSyncLogger.js\":\"5c01ba573582a39f\",\"/knowledge-medium/pr-preview/pr-1924/src/data/projectorRuntime.js\":\"e53f14a182eaefba\",\"/knowledge-medium/pr-preview/pr-1924/src/data/properties.js\":\"4dcc52c296593c44\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertiesPage.js\":\"6cfb9a325ec79765\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyChildren.js\":\"4f53dbb75cbe54c8\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDefinitionFanout.js\":\"ed719573b9b6ff67\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDefinitionMetadata.js\":\"fb5919ed227446f7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDefinitionRegistry.js\":\"a882ca057d49aac1\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyDisplayMode.js\":\"251cd789cbff708d\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertyRowCreation.js\":\"6e955a797aa77d02\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertySchemaCreation.js\":\"d861b116d8250ae3\",\"/knowledge-medium/pr-preview/pr-1924/src/data/propertySeeds.js\":\"041ace900a2b6e2b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/recentsPage.js\":\"47529370ebe4fba3\",\"/knowledge-medium/pr-preview/pr-1924/src/data/refTargetComparableProperty.js\":\"84246bf74e48855b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/referenceBlock.js\":\"265a24bb4e485fca\",\"/knowledge-medium/pr-preview/pr-1924/src/data/rejectedUploads.js\":\"528827e5dda5edfe\",\"/knowledge-medium/pr-preview/pr-1924/src/data/releasePowerSyncConnection.js\":\"960e3be60170d4d4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/repo.js\":\"97426cbffe883701\",\"/knowledge-medium/pr-preview/pr-1924/src/data/repoProvider.js\":\"617b54f85b6b741c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/rowProperty.js\":\"db8b62ba33d65b83\",\"/knowledge-medium/pr-preview/pr-1924/src/data/searchFilter.js\":\"33598b794f8a5670\",\"/knowledge-medium/pr-preview/pr-1924/src/data/seedIdentityLedger.js\":\"2f2542aae08b198b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/stateBlocks.js\":\"4838dc7c9426019a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/structuralEditPolicy.js\":\"c7687b8187968106\",\"/knowledge-medium/pr-preview/pr-1924/src/data/structuralInsert.js\":\"3353c33ed51bf9b9\",\"/knowledge-medium/pr-preview/pr-1924/src/data/subtreeDelete.js\":\"9020efedd583221c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/syncStreamLock.js\":\"e4e6c39565924372\",\"/knowledge-medium/pr-preview/pr-1924/src/data/syncedTableSqlRecognizer.js\":\"84a34c66fac02a95\",\"/knowledge-medium/pr-preview/pr-1924/src/data/syncedTableWriteGuard.js\":\"ae7157c2334cd97b\",\"/knowledge-medium/pr-preview/pr-1924/src/data/targets.js\":\"1800786fa8e50f83\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeColors.js\":\"03261bd1d2510d2a\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeDefinitionMetadata.js\":\"5ae785c802d69688\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeDefinitionRegistry.js\":\"0126f62bdc37ad27\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeExtraction.js\":\"3513376f48c1301c\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeInitialValues.js\":\"6f10def30c3473e4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typePropertyGroups.js\":\"237bc00591388440\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeSeeds.js\":\"1fb6347f9d6a6a6e\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typeTagger.js\":\"2b5e25c1574112eb\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typedRecords.js\":\"c56b4865a800bd88\",\"/knowledge-medium/pr-preview/pr-1924/src/data/typesPage.js\":\"9a4d3f3376a93064\",\"/knowledge-medium/pr-preview/pr-1924/src/data/userPrefs.js\":\"0b66d0bb4c9666a7\",\"/knowledge-medium/pr-preview/pr-1924/src/data/userSchemasService.js\":\"ea0a39b5fb1197d4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/userTypesService.js\":\"2c89da482e65beae\",\"/knowledge-medium/pr-preview/pr-1924/src/data/valuePresetRegistry.js\":\"60a9c20b287049a4\",\"/knowledge-medium/pr-preview/pr-1924/src/data/visibleChildren.js\":\"0b59dd6f08aa8295\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceConversion.js\":\"8db2877cf50f8a97\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceFirstSync.js\":\"5e0c252f451f8c76\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceIdNamespace.js\":\"43b394f164c35559\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaceSchema.js\":\"54114a29869bd494\",\"/knowledge-medium/pr-preview/pr-1924/src/data/workspaces.js\":\"56165a5e39c184db\",\"/knowledge-medium/pr-preview/pr-1924/src/data/writeAheadLog.js\":\"03b9ba03fbffd6d2\",\"/knowledge-medium/pr-preview/pr-1924/src/data/writeAheadVfsProbe.worker.js\":\"93996b46ecc18221\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/BlockPasteShellDecorator.js\":\"2cfaf4131a007164\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/atTrigger.js\":\"b033b4f24c884ae4\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/autocomplete.js\":\"8ab51a5705de0dce\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/codeMirrorExtensions.js\":\"193a6e8054537224\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/contentFlush.js\":\"ebdda47caecf257c\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/defaultInteractions.js\":\"b480e1d0bb6b1140\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/editSettleSignal.js\":\"923be2e8db8f3df6\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/insertImage.js\":\"5d64e6e9239ee013\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/referenceCompletionRange.js\":\"757f5566f2a25cf2\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/referenceTargetTypes.js\":\"3f241d728656859c\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/syntaxContext.js\":\"9cace6ecf99325ac\",\"/knowledge-medium/pr-preview/pr-1924/src/editor/triggerMatch.js\":\"8bf093e5e45ab5f8\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/AppRuntimeProvider.js\":\"426df5a03f23117e\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/BlockFocusShellDecorator.js\":\"20e6a3ca48c6c78b\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/ExtensionRenderBoundary.js\":\"1d7e5d84c4d82045\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/PanelContentRecovery.js\":\"83b4f74cf2828981\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/apiCatalog.js\":\"016ee5ea29776eef\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/appRuntimeController.js\":\"56368df831f0a349\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/approveExtensionHere.js\":\"912fd36c5f0701f5\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/armedCutAppMount.js\":\"5c013519b5d96521\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/batchableKeyedStore.js\":\"d7e4920df952de5b\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/blockInteraction.js\":\"4e931a460cc807b5\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/blockSelectionAction.js\":\"0f0bb200b0646127\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/buildApprovalRecord.js\":\"78f3d9bc5474804d\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/compileExtensionModule.js\":\"c0cef3f5d0842d51\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/compiledModuleCache.js\":\"1c453b6409def353\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/continuousGestures.js\":\"320a224b6fa499f2\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/core.js\":\"c6864a9a4fe317b1\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/defaultRenderers.js\":\"62b58fa34694f9a6\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/definitionFanoutAppMount.js\":\"ef9fd132ff3e8497\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/dialogAppMount.js\":\"7885b407f7375a17\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/dynamicExtensionSeeds.js\":\"548a63408915b2e4\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/dynamicExtensions.js\":\"8ecf12c4a019d835\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/exampleExtensions.js\":\"2a991ea14e7fd1bf\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionApprovalStatus.js\":\"8e42272795dcd1a0\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionImportPolicy.js\":\"96e92f308ccea6a5\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionLoadErrorToast.js\":\"b97d6defbf0c7679\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionLoadErrors.js\":\"0b73f9ecb1976eb1\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionLookup.js\":\"f64a14a64a24a4fd\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionToggles.js\":\"65a4fbe80bb47adf\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/extensionUtilitiesCss.js\":\"91895b8dafc9dcf1\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/kernelPageDeletionGuard.js\":\"c88e64c174ff6bcc\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/liveRuntime.js\":\"680aae07277102ef\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/normalizeExtensionSource.js\":\"41cbee01fd754ddd\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/openExtensionsSettings.js\":\"57154e32a9701343\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/overridesCache.js\":\"030d96e70308282e\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/pluginIds.js\":\"e13bf68ea0803ce1\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/processorRejectionToast.js\":\"ce5d9e0d06b0c2e8\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/runtimeActions.js\":\"556c0babeabc15e1\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/runtimeContext.js\":\"d41f813a17e2338a\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/staticAppExtensions.js\":\"9533e84930c92b8f\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/staticDataExtensions.js\":\"1ef1539a6ce9642d\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/toastAppMount.js\":\"8693fddecd7f2cb6\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/transpileExtension.js\":\"32ece29ef98dd793\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/useOverrides.js\":\"c18e3d89ae701e48\",\"/knowledge-medium/pr-preview/pr-1924/src/extensions/useShortcutSurfaceActivations.js\":\"8fcd36238cba5c12\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/discoverToggleTree.js\":\"0cbd87e9fe359a8c\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/facet.js\":\"0ec02549fac62d23\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/resolveAppRuntime.js\":\"755c7f5ba35e0af7\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/runtimeEvents.js\":\"be8dd5878d543833\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/togglable.js\":\"be5c445efd153945\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/variantFacet.js\":\"a8c8eb457a4b39d0\",\"/knowledge-medium/pr-preview/pr-1924/src/facets/verbFacet.js\":\"d3f175a0dc6c610f\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/block.js\":\"3921cf53b0b5bcee\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/focusedChild.js\":\"b0336e5ae8dabb4e\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/propertySchemas.js\":\"8108e4bae5ff0deb\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/typeRegistry.js\":\"acce55ddd5ce372f\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useAncestorCrumbs.js\":\"53b5c219a2e93b88\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useAutocompleteListbox.js\":\"fcdb3335415cd02c\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useDebouncedSearch.js\":\"6293b3eab8a47877\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useDebouncedValue.js\":\"fa906fae8ca08503\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useFacetValue.js\":\"c263b6ee2d70b85e\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useIsFocalRender.js\":\"181f2db517db22bb\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useIsReadOnly.js\":\"506f46da85e69575\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useMaterializeBacklog.js\":\"4ecb470c2e108bce\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useMinuteClock.js\":\"ef5afdb58847a113\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/usePanelLayoutProjection.js\":\"8ab0a67cd2b502c3\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/usePendingInvitations.js\":\"e3c37cb4e0785fc1\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useRendererRegistry.js\":\"561fae622fcbd797\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useRetainedFieldRows.js\":\"8760f91af467eabd\",\"/knowledge-medium/pr-preview/pr-1924/src/hooks/useWorkspaces.js\":\"612541431a59fbb9\",\"/knowledge-medium/pr-preview/pr-1924/src/lib/utils.js\":\"593e5a9e6dbe9929\",\"/knowledge-medium/pr-preview/pr-1924/src/main.js\":\"5a69f93592f3b34e\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/MarkdownImage.js\":\"b6880c57ef6b4689\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/blockSeparators.js\":\"b3e7ca33309d93da\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/context.js\":\"adf7a4dd774131b5\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/defaultMarkdownExtension.js\":\"d909d47fd4bf5f1b\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/extensions.js\":\"1f6ea8cdb9a72cd8\",\"/knowledge-medium/pr-preview/pr-1924/src/markdown/renderMarkdownHtml.js\":\"3d6399343b319bff\",\"/knowledge-medium/pr-preview/pr-1924/src/minimal-editor.js\":\"192d559266f39dfa\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/armedCut.js\":\"c7bee5660c367fae\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/captureMediaVerb.js\":\"40ec424504561d5b\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/clipboard.js\":\"f08d503725cd3f3d\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/decision.js\":\"0f770f1065837b6d\",\"/knowledge-medium/pr-preview/pr-1924/src/paste/operations.js\":\"446e5bb47b8211c6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/account-header/AccountHeaderItem.js\":\"c8add8e7ebc372d6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/account-header/index.js\":\"870bd17a111d9ac8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/AgentStatusChip.js\":\"6b1a1f1dd65d28bc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/askAgent.js\":\"f6e9afa18b64b584\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/askedStore.js\":\"2ac5c02222a8152f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/cancelAgent.js\":\"f2cf8bda618b259c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/chipState.js\":\"3761570c0acc1c51\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/dataExtension.js\":\"b9c9c34ac4a2e165\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/index.js\":\"62f838685e9ddd6a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/resumeCommand.js\":\"1f23984a1164ff86\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/retryAgent.js\":\"d30cf3c00d6082b6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-dispatch-companion/schema.js\":\"13f1f8fe39066d8c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/AgentTokensDialog.js\":\"a3a3f227953092f4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/BridgePairingDialog.js\":\"0341349a31a65b28\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/addMedia.js\":\"230228713be2dc81\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/backlinks.js\":\"747bd045d76b2ce4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/block.js\":\"6195a449db78eb75\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/context.js\":\"a9c8da17a4beca02\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/displayIds.js\":\"d8bccc85e33b82ab\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/index.js\":\"6beb521f38cb4737\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/outline.js\":\"1cb644c7c67519f0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/properties.js\":\"7672edc4e1ecdafa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/refs.js\":\"5c0224cc75890b92\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/resolveRef.js\":\"0bad9f2f18514278\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/search.js\":\"9e095f04669dfef6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/shared.js\":\"8ac5ce392a0c6590\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/sqlRows.js\":\"640b781f16acbc2f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentViews/text.js\":\"65d2e471d0635481\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/agentWrites.js\":\"b56f687ad0c10864\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/authoringCatalog.js\":\"a9031636b42c3a64\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/blockRefTargets.js\":\"09bc8ffca4192c60\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/bridge.js\":\"4a98e7fe038edb49\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/bridgeLoop.js\":\"24d7251e88901757\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/changeHistory.js\":\"bd5b762f13660f9f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/commands.js\":\"47fbe0226977511f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/commentsCommands.js\":\"011f49428b2cfa9d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/dataExtension.js\":\"443c25c48efc22eb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/dataModelGuide.js\":\"ac93ff5d9e115e84\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/dayPropertyInputs.js\":\"85ae86d2964291aa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/describeRuntime.js\":\"f92486ea8c2d7d3a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/extensionLint.js\":\"5ff60077d1c5ae06\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/grainAudit.js\":\"88d66a45ff2025ef\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/healthCommand.js\":\"fe914d1aafa707af\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/index.js\":\"d217a00fc6a9840a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/presetIdentity.js\":\"1d8722cd4c1f31a5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/propertyRegistrationAudit.js\":\"c58d7f4a6dfe58eb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/protocol.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/readMedia.js\":\"64929170b9007b3b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/schema.js\":\"57e483f8b854ac79\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/serialization.js\":\"195316948595713b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/targets.js\":\"aa580d68f35b7b36\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/tokens.js\":\"9bfa3c666c492549\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/watchEvents.js\":\"f85a353a5561ba52\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/workspaceGuard.js\":\"ea12f0c9a2d70d98\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/agent-runtime/writeCommands.js\":\"33128cfbf73ee5bb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/AliasCollisionToast.js\":\"6823399e48aba6b6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/DuplicateNameBanner.js\":\"fbfa5e558988197e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/collisionMerge.js\":\"d52efb9a53f42952\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/dataExtension.js\":\"05807de7d86d6c83\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/index.js\":\"8432e2a93c949639\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/mergeCollisionAction.js\":\"56fb56167673e1e7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/pageStyling.js\":\"648c93dad0248f39\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/rejectionToast.js\":\"01c1225ce6d72a58\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/alias/syncProcessor.js\":\"d05da163b89078f1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/actions.js\":\"6f9bd379f57abd07\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/addComment.js\":\"3fa7af6e138fb971\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/anchor.js\":\"c504eeef65a9d316\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/anchorState.js\":\"42d5f783db8caf45\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/commentLinks.js\":\"bd3ca8706ca1b99c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/confirmThreadDeletion.js\":\"7c1a5fa321bf4cf3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/container.js\":\"d5340f048ae4c774\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/dataExtension.js\":\"2947f9ff3efe96a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/deleteComment.js\":\"9f130236ef87bfa7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/highlights.js\":\"42a66b79387fd371\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/index.js\":\"fb460626ecf6093a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/linkedCommentsPill.js\":\"210701ee55bdfc7a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/margin.js\":\"b1a1ed94b57d5884\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/marginAnchorLinks.js\":\"c8ade61e2ccd2210\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/marginSchema.js\":\"2354bfe826e525ac\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/newComment.js\":\"ccda18397a0547d9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/ownThreadPicker.js\":\"9d346795ef11fe00\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/placement.js\":\"318dc130c7a28550\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/queries.js\":\"0ca60184e8eec039\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/quotePosition.js\":\"35e9583afa162b2b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/quotedIn.js\":\"7452cb150a6d3dfb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/quotedRange.js\":\"95c97c12a88a82f6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/rangeRefs.js\":\"8a316206bdd5efa3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/readHighlights.js\":\"d30bbf6c2cbc031e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/readSelection.js\":\"1426aa51f8326f33\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/readSelectionUi.js\":\"8c83ad041f82c4d4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/reanchor.js\":\"2dea59cedc9e21c1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/schema.js\":\"22b27203e9a47245\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/scope.js\":\"11e184675e39b86f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/scopeThreads.js\":\"c9caf1ecb2b8692f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/splitRetarget.js\":\"8ae95fec93446450\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/suggestionCard.js\":\"e33af36e53e3112a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/suggestions.js\":\"ba8619cb5f6b27fb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/summaries.js\":\"a43843306522aaeb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/summaryBatch.js\":\"a682f61ce0bf8c8c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/surface.js\":\"df67ac9acf4b05b7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/threadNavigation.js\":\"c2504177b6e41daf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/threads.js\":\"c4b04e7c0bde5d0f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/ui.js\":\"459b49800b0b0d88\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/annotations/uiStore.js\":\"01071638f647cf5a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-intents/appIntents.js\":\"d6cc1a65d7c925a0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-intents/index.js\":\"94a2861e2df85232\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-update-prompt/index.js\":\"0c6dde9c2a531a6e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/app-update-prompt/status.js\":\"d6138ed280d044fb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/CleanupAttachmentsDialog.js\":\"e2c6c614caf0ee0a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/MediaBlockRenderer.js\":\"e1803c9bc079030d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/MediaDownLaneReplicator.js\":\"7f1c4d137b2ac253\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/MediaUploadReconciler.js\":\"80b72bed0c368890\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/assetDownLane.js\":\"b7cd388a55de130f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/assetResolver.js\":\"8fc6456590305793\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/assetUpload.js\":\"4a32f64eb3aa1910\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/attachmentCleanerIO.js\":\"337ae2857052cf3e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/audit.js\":\"9340dc14c02771e1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/paginate.js\":\"778f6876fc78e97e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/report.js\":\"2111c76971267855\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/scan.js\":\"98bf8e4ad13d3d65\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/supabaseAuditIO.js\":\"d0f8201db69602be\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/audit/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/blobStore.js\":\"2e1b9fc2a84cf9df\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/browserMedia.js\":\"7e079d68dba333b4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/byteStore.js\":\"a1d702e443be01df\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/cleanerIO.js\":\"3981cd45751ffc39\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/cleanupAttachments.js\":\"fdc31ff810ba5d03\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/dataExtension.js\":\"9c3b3bca805f88bd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/downLane.js\":\"b5081d94f7e5ca98\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/index.js\":\"baad76eaa4d2fe6f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/insertImageContribution.js\":\"fc1a469abc7026e7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/laneArming.js\":\"2bfa7e690f4e0124\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/laneLock.js\":\"587a88db5d56052c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaBlock.js\":\"6c42134197c2e9df\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaCapture.js\":\"a7170d0b8440675d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaLanes.js\":\"e7591c5bd676da48\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaViewers.js\":\"a4c9b4472c04ae86\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/mediaViewersFacet.js\":\"2e00c904d7a2ff9f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/pasteCapture.js\":\"d0bf0951f36df081\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/resolver.js\":\"e084620769a73298\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/retryUploadsAction.js\":\"76f331c1a5c05505\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/storagePaths.js\":\"7e0cf5009113d487\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadDrain.js\":\"dfa671f205d6c8f6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadLaneStatus.js\":\"a4f6160400ab7ec8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadReconcile.js\":\"16f18acc44731d58\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadRecovery.js\":\"1c63978e4f5a7ac5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/uploadStore.js\":\"428280527d0990ad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/attachments/useAssetObjectUrl.js\":\"5ce3e92b0fbfcf61\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/BacklinksEmptyState.js\":\"bfdcc163052546c8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/BacklinksViewSection.js\":\"2ba0bfabd44305f2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/facet.js\":\"fc31944fd754643a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/index.js\":\"a568a6acf1535a2a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks-view/prop.js\":\"4f45a62f459758f4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/BacklinkFilters.js\":\"ec9829e9fd2d1644\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/BacklinksFilterPropertyEditor.js\":\"f6055ae7a1f68956\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/BlockEntry.js\":\"462c0c0358d30b49\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/LinkedReferences.js\":\"e46cbdce7c6f229f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/backlinkBreadcrumbShortcuts.js\":\"449e00729fdb72cd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/dailyNoteDefaults.js\":\"7400addc36b9715f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/dataExtension.js\":\"1a4b09e0a061e4a3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/edgeExclusions.js\":\"cd8b01f8f165f2db\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/filterProperty.js\":\"d0aaa7689927535a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/index.js\":\"625b54c0de783baf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/InlineBacklinkCount.js\":\"64ea37bcd8050a47\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/applies.js\":\"afbd108637bb3793\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/countQuery.js\":\"426657ffd2db98b2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/expansionStore.js\":\"0f25789a5cdd2d6c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/index.js\":\"d94132e7cad22aa4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/inline-counts/useBacklinkCount.js\":\"b929afc0b5084035\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/presentationInvalidation.js\":\"1ef49f7e1b54673b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/propertyEditorOverride.js\":\"2f30a1bbf0c77aa4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/propertyFilter.js\":\"7b699db91efa6553\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/query.js\":\"8c76f32ace591c24\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/resolveFilter.js\":\"4510cfc3205c1cbe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/sourceBatch.js\":\"fcfb15634455dd04\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/sources.js\":\"392fb738c2405f50\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/useBacklinks.js\":\"dba7ced19cbb2841\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/backlinks/useStoredBacklinkFilter.js\":\"00f2570ebf3a994c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/BirthdayCelebration.js\":\"5e38efa152f01027\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/BirthdayOverlay.js\":\"efcce9bf1d9e6834\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/gate.js\":\"ee68a8a2ff956330\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/index.js\":\"b4d72290177f1f83\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/birthday/wolfTheme.js\":\"6f29b811709df0db\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/BlockDragLayer.js\":\"c13b19abd864e75d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/dragController.js\":\"736fccd5074bb264\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/dropTarget.js\":\"2550d01758519752\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/index.js\":\"32a2993f3fe7fb8f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-drag/projection.js\":\"6959282782345a30\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-info/BlockMetaCard.js\":\"79358005486cd2b0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-info/index.js\":\"99a3ccd333abf66b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/AddTagDialog.js\":\"daeb4e1a16e7b9d7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/BlockTagsConfigEditor.js\":\"74a2abddc0f57fcc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/TagNameIssueHint.js\":\"258eeb373aa83ead\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/addTagAction.js\":\"475444aa331157cb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/appendTag.js\":\"2720ecaec310c7b3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/config.js\":\"2c20cb015638e31e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/dataExtension.js\":\"3a72c3bc5895018a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/index.js\":\"8de71c4cea132f85\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/block-tagging/propertyEditorOverride.js\":\"fb48e0ea995924c0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/BreadcrumbList.js\":\"cf11d92afdee21df\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/BreadcrumbRenderer.js\":\"f766095a54408f14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/Breadcrumbs.js\":\"7ad3af20a51a1f54\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/PromotableBreadcrumbList.js\":\"eb3dd2c1744caed8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/breadcrumbPreview.js\":\"d5b0ab977696384b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/index.js\":\"a74e5545b045579f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/breadcrumbs/usePromotableBreadcrumb.js\":\"56affb72b1491b68\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/CharacterCountItem.js\":\"2e5b9ebfe9c508d5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/ProfilePropertyEditor.js\":\"907329feeac9933b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/actions.js\":\"c96a2811478e6f8b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/blockType.js\":\"70f5d27a022fc7ac\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/charCount.js\":\"1e1ec24e7d88ff7f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/dataExtension.js\":\"f342f63aea2f39df\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/index.js\":\"a0c22ce0db003b02\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/profiles.js\":\"3555606c34daece5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/properties.js\":\"06f4ef20b56d5426\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/subtree.js\":\"eccfb3a8549f398c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/character-counter/textCounts.js\":\"998fb0ce545e5616\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/colemak-keybindings/index.js\":\"f8e166c815ec91f8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/CommandPalette.js\":\"754c6e8a22d08d1b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/HeaderItem.js\":\"18e3f87f49bff6f7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/context.js\":\"b9cd0be181a80649\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/index.js\":\"7399cb14b3b4318b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/selection.js\":\"48eef4f188a1aa27\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/toggleStore.js\":\"0d240523dc4e3063\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/command-palette/useCommandPaletteActions.js\":\"dc446ee84b7da31a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/ContributorBadges.js\":\"37fb599fe2feeb34\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/ProfilePicture.js\":\"236d9b7780b2f642\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/author.js\":\"38a90820c64eb15e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/codeMirrorExtensions.js\":\"4afa3e9c0a852a52\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/dataExtension.js\":\"88dca76b8cd02182\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/index.js\":\"23da2b5265580f9c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/mentionAutocomplete.js\":\"488a1b39075e4e6a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/processor.js\":\"054fd567d818ffff\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/profiles.js\":\"6a87c51d5482117d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/queries.js\":\"359ae26ab2bc13df\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/schema.js\":\"05743f2a9bb2c569\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/contributors/useCommentAuthor.js\":\"50032b7967dec6a0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/PanelCursorFollowsScroll.js\":\"af0a90c8cedb425a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/followOrigin.js\":\"6dc50dd32942cd86\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/index.js\":\"c9045925fad3bef7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/settleScheduler.js\":\"0e6f9e57e45a97ba\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/cursor-follows-scroll/viewportAnchor.js\":\"2cfef1aaffc41709\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/CalendarGrid.js\":\"97fb5cfba7b0c289\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DailyNotePicker.js\":\"7b884a06f2728a87\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DateKeyboardScrubController.js\":\"58ce5c10a2ff036b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DateNavDecorator.js\":\"877a73d57d4a11f4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DateScrubOverlay.js\":\"e4d29e10cb24d680\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DayPropertyControl.js\":\"56ba9b94ba6f85d2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/DayValueReferenceControl.js\":\"57e9ad4a97592d38\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/HeaderItem.js\":\"f28ea1dbd11d3bd1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/ReschedulePicker.js\":\"b3906b952ae36da3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/SpreadDatesDialog.js\":\"97bc07f065c23b66\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/actions.js\":\"3b2c014f3ade4426\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/blockDateAdapter.js\":\"1acafb5620589644\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/calendar.js\":\"a407321f8795fdf5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dailyNotes.js\":\"f1e2de5e23657786\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dataExtension.js\":\"7bd2df380f8b4ab6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubActions.js\":\"e4bb1f5872794634\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubGesture.js\":\"d0c8370741f8550f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubGestureActions.js\":\"e74327030baefdc9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dateScrubRecognizer.js\":\"de49464b2599de46\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dayProperty.js\":\"ab4d01ae5ac004cb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dayValueReferenceAdapter.js\":\"3e201337f645f281\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/deletionGuard.js\":\"a80c784732bc3be6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/dueQuery.js\":\"44fcb3e081254cd8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/index.js\":\"b395e6594579903e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/landing.js\":\"6af49f9b948e1939\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/localSchema.js\":\"b59a0822078a6628\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/referenceDateAdapter.js\":\"c5175e6468dc2a06\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/rescheduleAction.js\":\"a8fe3d386ac5f376\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/schema.js\":\"1fbb6d3622ad246a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/spreadBlockDates.js\":\"8160edb0a4ba9617\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/spreadDatesAction.js\":\"4e88b7fc505b7f4c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/today.js\":\"c0bd65065542b6ed\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/daily-notes/wikilinkDateDecorator.js\":\"b5b0b430eee535a9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/ConsistencyAuditDialog.js\":\"dcf71d507e373d9d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/audit.js\":\"2502a031fa666486\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/auditAction.js\":\"bb5099bf821d0e62\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/auditRanges.js\":\"d19524250cf98e5a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/diagnosticsSource.js\":\"985bd6581630a6ae\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/divergenceScan.js\":\"1ffc2a6cc2ae479a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/index.js\":\"97bef2df0292acc5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/propertyChildrenChecks.js\":\"69b56e61eb59f6ff\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/referencesMirror.js\":\"cf90d4374cdb29ee\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/rowJson.js\":\"f3f9b21d51902e97\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/schedule.js\":\"fac042c1f1e98a63\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/data-integrity/store.js\":\"1cbb5124142b1308\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-maintenance/action.js\":\"7562cbd746732b53\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-maintenance/index.js\":\"f261cc78494314d6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-maintenance/plugin.js\":\"124655f338cc18ba\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/DbMirrorSettingsDialog.js\":\"6946fe9b07abd461\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/actions.js\":\"e476f1920615aaa2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/changeMarker.js\":\"52c4a1358b1f8971\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/diagnostics.js\":\"104977d026be30db\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/fileSystemAccess.js\":\"a7caeda9136c32aa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/filenames.js\":\"5e4c9a29a7495de4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/index.js\":\"0aa932feb7bb7669\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/mirror.js\":\"fb7f6f3b67538fa3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/runLock.js\":\"7a79e05fe4b8e590\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/runtimeHealth.js\":\"911ed30cb7aa05b8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/schedule.js\":\"cd38510d101584f9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/db-mirror/store.js\":\"9e216d770d09bc9c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/default-themes/index.js\":\"957fd103d624f4b7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/default-themes/themes.js\":\"8eec05eff657a34e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/diagnostics/facet.js\":\"3a7818b51b95454f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/diagnostics/useDiagnostics.js\":\"46283ee816511538\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/dismissals.js\":\"585a949bec24d776\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/index.js\":\"5133575dc67c91b6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/status.js\":\"1c45d658ea34ee1b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extension-prompts/store.js\":\"1bdc3764a994eb9e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/ExtensionsOverridesEditor.js\":\"4c7b620075ae6d21\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/ExtensionsSettings.js\":\"cceee2d17618b546\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/actions.js\":\"9733f94fa0874a45\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/config.js\":\"58ec627a4858a118\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/dataExtension.js\":\"161469c2e90082e2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/effect.js\":\"359603e82301970c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/index.js\":\"a4d4f7b9fb2c8e10\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/propertyEditorOverride.js\":\"32b13286848ffb52\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extensions-settings/useToggleTree.js\":\"42ea8d2c1534c66e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/ExtractTypeDialog.js\":\"9af845046bea28c1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/FindTypeInstancesDialog.js\":\"070a53ea99d93db4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/PropertyShapePicker.js\":\"71e2d907317677cb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/action.js\":\"d99cb4d3110283d0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/extract-type/index.js\":\"8b3791ede5e16d69\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/FindReplaceDialog.js\":\"867ea387c0464d02\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/HeaderItem.js\":\"27e379deb9e82457\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/dataExtension.js\":\"8804b70cf765856c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/index.js\":\"7e6c0a7de74ed2b8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/search.js\":\"900d9f973e897055\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/toggleStore.js\":\"76cc4ad56fafb800\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/find-replace/types.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/LocationPropertyEditor.js\":\"a3f794af0fc78209\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/MapView.js\":\"534a90a7bac08cbd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/blockTypes.js\":\"f5c8f5a0a3cbb248\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/codeMirrorExtensions.js\":\"8a3cd89d3a716dae\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/createOrFindPlace.js\":\"bc6cb02475635f9c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/currentLocation.js\":\"6f7998dd3b89a253\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/dataExtension.js\":\"10d10cc5cd92b611\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/geoContentDecorator.js\":\"0e941630039a4409\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/googlePlacesClient.js\":\"2650b8d0940b6caf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/index.js\":\"89ef768087619e9b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/locationsPage.js\":\"1d1ec883db206790\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/mapViewport.js\":\"4af398f5342355ac\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/pickCurrentLocation.js\":\"655597898b74b8f3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/placeAutocomplete.js\":\"64691d9ea5bdb443\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/placeNameCollision.js\":\"93c0f44211afd8bb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/properties.js\":\"95fd21a67f7fbdcb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/propertyEditorOverrides.js\":\"f65e1e0dda21441f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/query.js\":\"7e1b949bdcbae8d9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/geo/usePlaceSearch.js\":\"8820cd2118dc4441\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/GroupHeaderActionButton.js\":\"3a5f45a59aed4d79\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/GroupedBacklinksConfigEditor.js\":\"b2a4c4c07a451096\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/GroupedLinkedReferences.js\":\"a2222bb834508cf2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/config.js\":\"00f0cf5c93dad1ea\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/dataExtension.js\":\"5e28f6d8a4ddefde\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/facet.js\":\"c8f5bd301edb74ad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/grouping.js\":\"caad2f97710461ba\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/index.js\":\"0882b32aaff76672\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/propertyEditorOverride.js\":\"fd2f08b36b94b24f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/query.js\":\"d315214101ebc3ea\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/resolveConfig.js\":\"c1d1a28657d739a8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/useGroupedBacklinks.js\":\"6cb4fc7f6fba3931\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/grouped-backlinks/useGroupedBacklinksConfig.js\":\"b51b76519f0d55e9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/HtmlDocumentContent.js\":\"b8c34d52b77640c9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/HtmlFrame.js\":\"6979321194fb78d4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/actions.js\":\"78cd7f060777b4e8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/blockType.js\":\"f9da9bc487d2d0bf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/confirmRunScripts.js\":\"d9e51bd0ca7c2a2c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/dataExtension.js\":\"9c208dacac23fd0e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/frameAnnotations.js\":\"8fd80f4c35a15159\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/frameDocument.js\":\"e2051574be811114\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/frameTheme.js\":\"c3fabd0f68ee2b74\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/index.js\":\"bcb7905b0ec7d664\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/scriptConsent.js\":\"f3290b1d3093755f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/sourceMap.js\":\"035856e3a094b63c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/html-document/useDocumentScripts.js\":\"ebd69b25231ca671\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/index.js\":\"3f3c82c657146040\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/record.js\":\"2e96bda028234779\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/recordStore.js\":\"7417e91af23e53ed\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/responsiveness.js\":\"eba4480a457451c1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/schedule.js\":\"32518f89a9aa99c6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/interaction-metrics/sessionContext.js\":\"ffd9166d82cc610c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/KeyCaptureInput.js\":\"96d86f959a90edc9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/KeybindingsEditor.js\":\"cf47ccb577637d51\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/actions.js\":\"4b9213daebd56083\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/config.js\":\"2dcc125a8d3df48d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/dataExtension.js\":\"e8501c26d8785ecc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/effect.js\":\"d145b4494cf0ae38\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/index.js\":\"252bd4cb97e8cddc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/keyCapture.js\":\"81a653c529577d3f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/overrideStore.js\":\"88a72e80e8a1e48b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/keybindings-settings/propertyEditorOverride.js\":\"f0394da28242e4d0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/HeaderItem.js\":\"15987d81d0360dcf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/LeftSidebar.js\":\"c6fa15dab7bb7c88\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/actions.js\":\"37fef6c70cd90063\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/facet.js\":\"c1d49879cd51861e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/index.js\":\"963b1d7f77e2eb61\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/shortcuts.js\":\"9f0326932146e8c3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/left-sidebar/toggleStore.js\":\"de3357de880e4730\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/MergePicker.js\":\"3c6e44f5d73285b2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/index.js\":\"ea0f4d4f43d072df\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/mergeAction.js\":\"42ef7975293e00e7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/merge-blocks/strategy.js\":\"b326a70942773f1a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/Button.js\":\"c18f5245ac3e6f04\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/MobileBottomNav.js\":\"a45b964a5ac624af\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/defaultItems.js\":\"e9d5e700ab866b92\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/facet.js\":\"e860392912d9772d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-bottom-nav/index.js\":\"502f3c1a5fb81c83\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/MobileKeyboardToolbar.js\":\"28969ce2541f190f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/actions.js\":\"deedb503758c1700\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/defaultItems.js\":\"8a40e120815aa320\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/facet.js\":\"102d1bbcb3488184\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/mobile-keyboard-toolbar/index.js\":\"deb00daa29c2eb27\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/MoveDestinationPicker.js\":\"b87cd97878c12e9f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/blockSubtreeMembership.js\":\"9a96f99b10ceeeb5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/contextMenuItem.js\":\"91112771923e0a7a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/index.js\":\"b5919f3811fdb257\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/moveAction.js\":\"4d9e0d2bb01aab45\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/moveBlocks.js\":\"f67ba832d24863cb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/move-blocks/selectionAfterMove.js\":\"9154fd80bf3c11b7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/TutorialBanner.js\":\"a86c76071ff156f0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/action.js\":\"bb8a4dad1fceb143\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/bannerDismissal.js\":\"7b3263e29bdb3ea7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/documents/cheatSheet.js\":\"63a9b395d0eca851\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/index.js\":\"2b7770d3fe6d7053\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/keys.js\":\"70fa159ce9987f10\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/landing.js\":\"785349ece212a114\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/outline.js\":\"8254768c47d2da42\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/onboarding/seed.js\":\"7e0e075964a48f3e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/PerfTrendDialog.js\":\"3f6054be43237d7e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/analyze.js\":\"7c0cd8061279db81\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/diagnosticsSource.js\":\"05b70771d97b575c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/index.js\":\"3a7c8589a04b4622\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/load.js\":\"134cccb0130af2b1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/monitorRun.js\":\"a18b4239a08e1d93\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/schedule.js\":\"8a991c5ea6733752\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/series.js\":\"aa5049f0e31a4d00\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/store.js\":\"3bb6e5dd84ba72fe\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/trendAction.js\":\"d47456573e9b58b5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/perf-monitor/verdict.js\":\"f99a375e1ab45a48\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/plain-outliner/clickToEditAction.js\":\"609b354bd86d5119\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/plain-outliner/index.js\":\"ec71f6a578f5c00a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/plain-outliner/interactions.js\":\"de648fb7e486b897\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/ConfirmMigrationDialog.js\":\"ade0e5e3b1b02949\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/MigrationGate.js\":\"e57ce46783815a01\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/MigrationGateDialog.js\":\"25e20a61d3c5ebef\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/action.js\":\"a9a69d3b12c06483\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/index.js\":\"3e1f5d7c5de11aed\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/localRunMessage.js\":\"c8debff483a59235\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/plugin.js\":\"c6da2ebe2675e7f4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/progressReport.js\":\"dee9e973f50e318e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/properties-migration/sweepProgress.js\":\"d57c60dfd3e0e96f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/FieldRowRenderer.js\":\"ea6106dfdc9de692\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/ValueRowRenderer.js\":\"642706113f58b1ee\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/actions.js\":\"3e9c87d08f0c5a39\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/autocomplete.js\":\"7adbda9b75884e99\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/fieldRow.js\":\"e04f2979106ad77d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/index.js\":\"068a5a431f19c955\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/referenceWarning.js\":\"014e7a8751674faa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/valueAutocomplete.js\":\"8b0a8ab2f16e327e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/property-rows/valueSchema.js\":\"ebe02ad54c0671f3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/HeaderItem.js\":\"118775c0573d5c2b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/QuickFind.js\":\"94b230fd377a9682\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/index.js\":\"b6bf12d9c8de4659\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/recents.js\":\"5ab413c3a8e0e03a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/resultItems.js\":\"90ef475a8ef75986\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/selection.js\":\"01f4f9ecbef8c463\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/quick-find/toggleStore.js\":\"8d565abc6c7015a1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/HeaderItem.js\":\"82423e0dda06a8bf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/RecentsPageBlockRenderer.js\":\"11cc0084e2968ab8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/grouping.js\":\"8f19f09e841faf6d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/index.js\":\"1e0fc1ba57a030ed\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/recents/target.js\":\"42028e202b3f5613\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/codeMirrorExtensions.js\":\"b031eee98795ea55\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/contentPrefill.js\":\"6cf16a2fddeb4275\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/dataExtension.js\":\"a50f37a20ee01c69\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/index.js\":\"b320aa5381205983\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/inlineDeletedBlockRefsProcessor.js\":\"d5813ba80bc24207\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/invalidation.js\":\"96b475a1a0498601\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/localSchema.js\":\"906cc199fd01005d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/blockrefs/index.js\":\"d4764b7e9d2b62dc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/blockrefs/remark-blockrefs.js\":\"2e714a55bdb1e72d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/index.js\":\"988d2259cef28612\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/referenceNode.js\":\"51a6559bce15e914\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/remark-reference-occurrences.js\":\"164997fe302dfae1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/Wikilink.js\":\"c05e8b4cb31c9b70\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/index.js\":\"6feefcc18d8b259e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/remark-wikilinks.js\":\"3208d5a3f752fa23\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/markdown/wikilinks/wikilinkDecorator.js\":\"75971a39a42bb249\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/mergeRetargetProcessor.js\":\"22abf065e4928d55\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/parseFence.js\":\"da0af6b1c4009670\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/referenceParser.js\":\"72f86420e2ee4024\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/referenceProjection.js\":\"404d7fa9b3cd0b02\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/referencesProcessor.js\":\"acb3e769a4038ce8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/renameProcessor.js\":\"82d912b3cffed874\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/references/spanReplacement.js\":\"fdd82b0b92f2027f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/htmlToOutline.js\":\"7d9c03b489b4e74b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/index.js\":\"e53e38f62f0ad795\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/normalizeClipboardDom.js\":\"5c9d1d1351c2c129\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/rich-paste/pasteDecision.js\":\"2976c924cb1c6cbd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/action.js\":\"71cf13f8d4203c0e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/blockIds.js\":\"37ea3bcc1dddb195\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/content.js\":\"91453a74b05d40fd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/effect.js\":\"30cfa2d0f40a6541\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/ids.js\":\"40acde893dfd62e5\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/import.js\":\"80e27caaac804f65\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/index.js\":\"777567f146994892\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/plan.js\":\"a7f4167d8f83d974\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/plugin.js\":\"d18e5fde5904de9c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/promotion.js\":\"d46a29aa0f59a649\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/properties.js\":\"38e25479fecd6dad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/references.js\":\"1cefebf833ec46de\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/report.js\":\"7aaa9e64bd060dba\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/roamMemo.js\":\"1f8d332fc13717cb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/runtime.js\":\"dd29e70b43515eba\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/schemaReconciliation.js\":\"05fcb35f0c73934d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/srsMarkers.js\":\"3b1f7a01d6717db6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/todo.js\":\"54df80bbe8d8989a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/typeCandidates.js\":\"d869b196489de605\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/roam-import/types.js\":\"531e9c91c938102c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/search-health/index.js\":\"b824d3cb4c69bd82\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/search-health/store.js\":\"9db3a63378b90dd8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/HeaderItem.js\":\"fc03310e95b72e7b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/ShortcutHelpOverlay.js\":\"57b29e3aacd24556\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/index.js\":\"228b2685d050b462\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/model.js\":\"6a8fb92a48badcb8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/toggleStore.js\":\"7e6a97969d1e8126\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/shortcut-help/useKeyInspector.js\":\"8f1d2a9692e2559d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/PanelFocusRecovery.js\":\"1ffc603bf489369c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/ShellDecorator.js\":\"abec4c63e440ba40\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/actions.js\":\"492251b0356c613c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/exclusionsFacet.js\":\"65feec12e350dc9a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/index.js\":\"254331f216362e52\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/shell.js\":\"7d6180b1c30b5a45\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/surface.js\":\"b6327c04a89caaf3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/spatial-navigation/walker.js\":\"0df412413cc41951\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/RescheduleToast.js\":\"63cf6acc05c8fbf9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/dataExtension.js\":\"1e3ced1700425ba4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/index.js\":\"8034e71837ba1bd2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/indicator.js\":\"842025393a5e4447\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/moveSrsState.js\":\"f508e575f467a125\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/rescheduleDecorator.js\":\"bb3071b9bd14a54c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/scheduler.js\":\"50a4b8a778bbcc7a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/schema.js\":\"707236e0c1ac99c9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/srsBlockDateAdapter.js\":\"715336e0adf39a1d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/srsClipboard.js\":\"687cabe413257aee\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-rescheduling/swipeRightDecorator.js\":\"7d4e1e14a45c4756\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/DailyNoteReviewHint.js\":\"0367bd2b1ad9d12d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/DeckPicker.js\":\"e4d5369e131a4380\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/ReviewControls.js\":\"00dbee4336d748fa\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/ReviewDeckRenderer.js\":\"f8d8591a648c54cf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/ReviewSession.js\":\"9e1bc656e4e64375\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/actions.js\":\"730e358d1bc828bc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/archive.js\":\"6e198580552861c1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/dataExtension.js\":\"2509e9f300b57df0\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/deck.js\":\"88ba66a999bf278f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/dueQuery.js\":\"fc66a8e2ea6b2b65\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/gradeDecision.js\":\"f6b8e29ff0905515\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/index.js\":\"49ba0fbd0069bd2a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/keyHints.js\":\"744d5d2dcb4be396\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/reviewCardLayout.js\":\"2667ca8ae36e462b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/reviewProgress.js\":\"a8204a76908e5a40\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/schema.js\":\"16802350862c8375\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/srs-review/useDueCards.js\":\"580733d77fdec1d7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/startup-metrics/index.js\":\"5d41e7b97b1f6e5c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/startup-metrics/record.js\":\"c8eb0969da553499\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/storage-persistence/index.js\":\"5f918a3b6f54aa49\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/storage-persistence/persistenceStatus.js\":\"c5fb551dc00a3587\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/storage-persistence/requestAction.js\":\"3af3e400305828c9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/TypeChipsDecorator.js\":\"af67133b3b7a69a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/codeMirrorExtensions.js\":\"a060bc04f53806b1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/index.js\":\"9963b0dad69f129d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/supertags/typeAutocomplete.js\":\"6e5bf97f9eb76f05\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/SwipeActionMenu.js\":\"76130f377d759b40\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/actions.js\":\"40c15e9085a7a057\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/anchor.js\":\"77bdfbb17af2d846\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/events.js\":\"e7643d11a84e47db\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/gestureActions.js\":\"ae9cdf20c49528bc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/index.js\":\"92d97ad132e3dcb7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/swipe-quick-actions/swipeRecognizer.js\":\"1756425547c169a7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/sync-metrics/collect.js\":\"060b335137261f0a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/sync-metrics/index.js\":\"5971f1bc1ee7141b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/sync-metrics/record.js\":\"024a1ee1c57451b9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/RejectionDialog.js\":\"e876914f0f6f75ad\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/SystemStatusHeaderItem.js\":\"2763ec9542e723b8\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/index.js\":\"298a6718c2a13b42\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/model.js\":\"1b6046df88b238bc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/queueCounts.js\":\"1660b52554838a15\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/rejectedHelpers.js\":\"5c781a0531655262\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/rematerializeAction.js\":\"b28dd8b3e6342355\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/system-status/useHysteresis.js\":\"ddef99f2ed9c29b6\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/ColumnHeaders.js\":\"ab11e84cbaa7335c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/QueryUi.js\":\"fb7515efd045c700\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/TableLayout.js\":\"75813ca902d7dc30\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/actions.js\":\"a9b52976ea7be591\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/cellEdits.js\":\"21ebb4e16ce82c24\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/childrenViews.js\":\"a92e14bf8390cf93\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/columns.js\":\"85999ce4175083ab\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/controller.js\":\"85bbd38264cf7b07\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/convert.js\":\"d2aa6fa708c76819\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/dataExtension.js\":\"c868b56433258102\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/index.js\":\"478558904f142e47\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/keys.js\":\"e7fd9b7fa20551ac\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/model.js\":\"eeda6c5d0fb22afc\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/QueryText.js\":\"c95fede4756f8015\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/backfill.js\":\"3fd2b5df4080b901\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/completion.js\":\"43cb12d3da82aa54\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/format.js\":\"1be6b33deb21cbe2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/parse.js\":\"2216a5b88068207e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/queryValue.js\":\"c4e0c4a8b213a12d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/registrations.js\":\"a00bc4fa1643ef69\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/query/source.js\":\"e54e55d312d7754b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/registry.js\":\"215cad8c32c72116\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/rowGutter.js\":\"cdca0d332744f5f2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/rowVerbs.js\":\"278f59ac5eae2366\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/schema.js\":\"64b049c248a523eb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/tables/sort.js\":\"cb816c307a0d9402\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/theme-toggle/effect.js\":\"822296408a15137b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/theme-toggle/index.js\":\"70909c64b1a91db9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/theme-toggle/theme.js\":\"6731e0b728846219\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/actions.js\":\"baa3b373ae407a88\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/dataExtension.js\":\"72fe390c6419ffd2\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/index.js\":\"721d04103d1554e4\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/todo/schema.js\":\"5d0db525910f41d1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/TouchSelectionLayer.js\":\"fc9f704c35d6c5bb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/actions.js\":\"b611d1ec03aa49ef\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/defaultItems.js\":\"69e72607e516c3c7\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/facet.js\":\"88d1d2cfb23061eb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/holdRecognizer.js\":\"5ba0838c7cf91923\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/touch-selection/index.js\":\"69fc10b11886541d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/update-indicator/UpdateIndicator.js\":\"82393282cb0ed1c1\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/update-indicator/index.js\":\"e08a84e27586a49e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/update-indicator/loadTimes.js\":\"c75c5d9c73c13baf\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/VideoNotesRenderer.js\":\"fe539a399f4a5fec\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/VideoPlayerRenderer.js\":\"7301ccf22e7276eb\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/VideoTimeStamp.js\":\"782abae1bc51cb1f\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/actions.js\":\"a2ed4c829853b9c3\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/index.js\":\"c60952125feb1f23\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/markdown.js\":\"2233060fdcaadc66\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/notes.js\":\"f97d0641d24c824d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/registry.js\":\"62acf4e8260e6b2b\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/remark-timestamps.js\":\"87f752d84fab87b9\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/video-player/view.js\":\"67a8ba11f4e6c7dd\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/LinkHints.js\":\"12cc3091e5fb7b99\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/index.js\":\"7929745c7c44145d\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/model.js\":\"78402a4f92d24a0c\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-link-hints/settings.js\":\"8517471492ae0053\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-normal-mode/actions.js\":\"c0a0af02a6dd3a7a\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-normal-mode/index.js\":\"c20e79822341ad0e\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/vim-normal-mode/interactions.js\":\"7132cdd371049744\",\"/knowledge-medium/pr-preview/pr-1924/src/plugins/workspace-header/index.js\":\"8e49916bd7e2a0ea\",\"/knowledge-medium/pr-preview/pr-1924/src/registerServiceWorker.js\":\"ca0a275cfb14de7e\",\"/knowledge-medium/pr-preview/pr-1924/src/requestPersistentStorage.js\":\"fc2209a62d0e0630\",\"/knowledge-medium/pr-preview/pr-1924/src/services/authRequestDeadline.js\":\"f5e97ef0fde39907\",\"/knowledge-medium/pr-preview/pr-1924/src/services/authStorage.js\":\"eb3ce5dfa512e486\",\"/knowledge-medium/pr-preview/pr-1924/src/services/powersync.js\":\"343ff7e77848053c\",\"/knowledge-medium/pr-preview/pr-1924/src/services/supabase.js\":\"efdfb5e576c2b4e9\",\"/knowledge-medium/pr-preview/pr-1924/src/services/uploadErrorClassifier.js\":\"11e30f8d6c99f736\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/ActiveContexts.js\":\"f1e4463940a5aea7\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/HotkeyReconciler.js\":\"18a229c75d697652\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/WipeLocalDataDialog.js\":\"64d4dee7eebef759\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/actionDispatch.js\":\"af6931870dbdb301\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/actionKeyHints.js\":\"4e5f248e340fd495\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/actionRefItems.js\":\"de0c2705d356dee6\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/applyKeybindingOverrides.js\":\"2e4998be144f16ee\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/blockActions.js\":\"ee5551551952afca\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/blockMergeGesture.js\":\"c9cd59c0cb7d739d\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/canonicalizeChord.js\":\"047ac8a56c977736\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/defaultContexts.js\":\"4b9d2132c81f39fb\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/defaultShortcuts.js\":\"656e6b09a91c8a7a\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/effectiveActions.js\":\"79e4360fa67a1490\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/formatChord.js\":\"5c49415a99c543fe\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/gestureAction.js\":\"2cec0b518e796fb8\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/gestureBinding.js\":\"09f13320ee9e2853\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/holdRegistry.js\":\"6e2900e0b99969b2\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/keybindingConflicts.js\":\"e6c10c8f104a4514\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/keybindingOverrides.js\":\"db1cda16b0f5490a\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/pointerAction.js\":\"4bca686fd35787b9\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/resolve.js\":\"774db131031b04bc\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/runAction.js\":\"51dc1520c0b98e50\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/sequenceMatcher.js\":\"1ab9fff84e130efb\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/types.js\":\"6c552bcc821596ad\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/useActionContext.js\":\"e8f32ad0d8230796\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/useActionDiscovery.js\":\"ce8e4df2985ad6cf\",\"/knowledge-medium/pr-preview/pr-1924/src/shortcuts/utils.js\":\"d00562d0f412bba5\",\"/knowledge-medium/pr-preview/pr-1924/src/sw/assets.js\":\"d651b7a0d2026416\",\"/knowledge-medium/pr-preview/pr-1924/src/sw/bootStore.js\":\"542c66410544e1f6\",\"/knowledge-medium/pr-preview/pr-1924/src/sw/previewDatabases.js\":\"d06020ddd396d2e6\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/byteTransform.js\":\"3d581644fd26e3a1\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/attachmentCleaner.js\":\"bae8618274357a3c\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/attachmentParts.js\":\"123ea55b79a654b1\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/bundleParts.js\":\"33b9f7370064348d\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/bundleRecord.js\":\"6004d966561c9ea5\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/manifest.js\":\"7e772b30e0bc57a8\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/takeBundle.js\":\"56f672084a57299d\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/bundle/verifyBundle.js\":\"8bbb46fd5751d3c8\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/cleaningStage.js\":\"a974f23a1ab56890\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/conversionAttachments.js\":\"e3b0c44298fc1c14\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/conversionKey.js\":\"e6d3707f728379c9\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/conversionServer.js\":\"f8efecd11fb797bc\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/flip.js\":\"548c046406418bc5\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/flipAttempts.js\":\"332b53033bd49ade\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/pages.js\":\"f4301d6f37cdccea\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/preflight.js\":\"08a4d0cb7ca6dbf7\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/reseal.js\":\"4b39a30438836362\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/runConversion.js\":\"488300a0cf749d4b\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/runLock.js\":\"224fe44aeea37fde\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/sealing.js\":\"5ebcffca7305a5bf\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/sealingStage.js\":\"91ad3c4e762427e3\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/stage.js\":\"9e1a75a5161e404e\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/conversion/verifyReseal.js\":\"bb97145af1991b6c\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/aad.js\":\"b7a93af274f64d5b\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/aead.js\":\"86d95794595368d6\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/base32.js\":\"0680bda7ebc07631\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/base64url.js\":\"e886a35e5d1cb171\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/binaryEnvelope.js\":\"2cf6e2d8d2d6177c\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/byteAead.js\":\"9f225bb3b000ff0e\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/canary.js\":\"b4e27f9f609a6e95\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/contentHash.js\":\"a58e9a03215882a2\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/contentKey.js\":\"834010a0b148c437\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/derivedIdNamespace.js\":\"4f69a4aee63f4714\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/envelope.js\":\"dee02d0c3b1e04d3\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/hex.js\":\"f26fe0c416d52cc6\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/sha256Hex.js\":\"b20af6f73cde67cf\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/crypto/workspaceKey.js\":\"d3ceb37cb36ba06b\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/conversionState.js\":\"34a657450f0f16f3\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/createEncryptedWorkspace.js\":\"2ca8c47771210609\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/pastedKey.js\":\"9a2f61fc71e1d54e\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/unlockWorkspaceWithKey.js\":\"88aff8071c81226f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/flows/upgradeWorkspacePin.js\":\"2b13543ec326fa3c\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/keyStore.js\":\"a3edceced361e113\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/mintWorkspaceKey.js\":\"da10458c09646169\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/modePin.js\":\"25d68b8360a2b334\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/openWorkspaceKeys.js\":\"8edee0a37057e255\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/resolveWorkspaceEntry.js\":\"7b9bbfb66d4ee22f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/resolver.js\":\"aacbde30abd43b6f\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/keys/workspaceAccess.js\":\"eca8e2dd5ac11d70\",\"/knowledge-medium/pr-preview/pr-1924/src/sync/transform.js\":\"7d7b1555c0c8354c\",\"/knowledge-medium/pr-preview/pr-1924/src/themeBootDefaults.js\":\"73f4ae6771fd35b1\",\"/knowledge-medium/pr-preview/pr-1924/src/types.js\":\"b082b5afd3f02627\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/ClientLocalSettings.js\":\"ef859e4fa101b823\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/abortableSleep.js\":\"1b8758bd4b5e7147\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/array.js\":\"061b6a227bc963fa\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/backlinkAutocomplete.js\":\"47b3f88f28b4d165\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/blockCrumbs.js\":\"bbfb93747e0d988f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/blockrefAutocomplete.js\":\"cd317bcb7e89ae2f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/cadencedIdleJob.js\":\"93973cd5da399d72\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/callbackSet.js\":\"4c6156f263bb3562\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/clientId.js\":\"49680a7316811857\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/codemirror.js\":\"11c2468d31852192\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/codemirrorCompletion.js\":\"47c817e23d586ce9\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/copy.js\":\"338986bb8cde02af\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dailyPage.js\":\"2564214d6b3e4f1f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dbForensics.js\":\"8c8a6750ba167ca9\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dbForensicsHooks.js\":\"7518b345468b147e\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/deleteBlockThroughUi.js\":\"1ef56dc7778ce391\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dialogs.js\":\"ed760094d9cbd285\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/dom.js\":\"e9e367d1eab83aff\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/downloadBlob.js\":\"4ffc141285b213fb\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/drawnWalk.js\":\"6575f228fab4e7ca\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/exportSqliteDb.js\":\"2c306c38207ef821\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/fileSystemAccess.js\":\"162ea6e13271aca3\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/flipSlide.js\":\"fd6176b88b4025a4\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/fnv1a.js\":\"956c84f69581def7\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/formatBytes.js\":\"1ea854dd4ed454ed\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/fuzzyRank.js\":\"5aa8d6af9c3b2ec4\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/idbKeyedStore.js\":\"ccb320bdd4870ce6\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/idleCallbackPolyfill.js\":\"acdb50438a7eb2dd\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/keyboardAwareScroll.js\":\"86c050a662e9ba0c\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/keyboardViewport.js\":\"e62906823fc83ddd\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/lastWorkspace.js\":\"04724a02d98d7880\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/layoutColumns.js\":\"04a4f7f4d1834add\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/layoutSessionDom.js\":\"0b362ea885da2f3f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/layoutSessionId.js\":\"c9f4f4bf5b49b333\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/linkClickGestures.js\":\"484a4982b3b9746f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/linkTargetAutocomplete.js\":\"0bc611b0de4c349b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/localDbCorruption.js\":\"44cd24c18537d184\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/localDbRecovery.js\":\"2ac33076d26b9084\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/markdownParser.js\":\"50d69c5130262d6a\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/memoize.js\":\"a0e711baec169b33\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/nameFieldCommit.js\":\"0ceb34ba858c1bb3\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/nameList.js\":\"f360d5493393c6bf\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/navigation.js\":\"b25af8d44de2d1ff\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/omnilinerNamespace.js\":\"24d48fd0d8610fda\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/opfsPageScan.js\":\"1e36e573a6095669\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelClearance.js\":\"f52ef1e0461b406c\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelHistory.js\":\"7fdbcb887a8e3bee\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelLanes.js\":\"805706f1015d2f34\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelLayoutProjection.js\":\"aa123fbb7a9c1392\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelScrollAnchor.js\":\"6eb3ca5aa555eab8\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/panelUrlFlags.js\":\"7ff446afb3c951dd\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/platform.js\":\"52a46ae7184c3ab0\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/pluralize.js\":\"ce9a67e331b40ce9\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/propertyCreation.js\":\"d9be231e5232e8d7\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/propertyNavigation.js\":\"f6dad7b7b2b88b79\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/propertyValueContext.js\":\"2f0dde5758950e83\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/react.js\":\"dc77607d09dbf501\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/relativeDate.js\":\"94c79b8a581b17d3\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/relativeTime.js\":\"fce3ef1f17b7a364\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/renderScope.js\":\"419e5ee042b76824\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/resolvedThenable.js\":\"0d9cb3d24d76b350\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/routing.js\":\"bc8ce0ae45048331\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/safeMode.js\":\"93826744cab326c0\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/scheduleIdle.js\":\"e55406d86cdf257d\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/screenWakeLock.js\":\"7ed7c15cc3d2ddbe\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/selection.js\":\"9d845593cccd5e11\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/softKeyboardGrab.js\":\"6eebf6443d49dacc\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/startupTimeline.js\":\"45e66101a9886fe7\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/state.js\":\"200ba577757bcfad\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/string.js\":\"48ee0327d9fa8357\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/surfaceZoom.js\":\"d570aaada635fbcf\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/templateLiterals.js\":\"916ff48997098807\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/time.js\":\"1af2bc599fb3f58b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/toast.js\":\"ea3161e17b695c8b\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/toggleStore.js\":\"64e5976bbc7b5c73\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/types.js\":\"5fe1aac1cd4da1e6\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/untilStopped.js\":\"51566839a297dde4\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/userActivity.js\":\"6b96f587379daa16\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/viewTransition.js\":\"804ac8bdb4212c47\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/viewport.js\":\"d2f0bf15ac2f5ff9\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/webLock.js\":\"cb432b45e7cbb12f\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/workspaceRecovery.js\":\"0fb4c6b7671dfc64\",\"/knowledge-medium/pr-preview/pr-1924/src/utils/workspaceSnapshotStore.js\":\"9978caba9e4069a3\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-compiler-runtime.js\":\"e73ca8667fdc4ddb\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-client.js\":\"dbc80307576dc7c2\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-server-edge.js\":\"3a3124568dd97f46\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-server.js\":\"adc2d567f4e3f8a4\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-static-edge.js\":\"e14316361570ea35\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-static.js\":\"fb188ed4e25a9b62\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom-test-utils.js\":\"fd0b85c4e2b1732a\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-dom.js\":\"036e44cfba7b20ce\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-jsx-dev-runtime.js\":\"d3555f8f9b1489a9\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react-jsx-runtime.js\":\"eb2c2b6fb18a0396\",\"/knowledge-medium/pr-preview/pr-1924/src/vendor/react.js\":\"478c60bbba5bf9e6\",\"/knowledge-medium/pr-preview/pr-1924/vite.svg\":\"4a748afd443918bb\",\"/knowledge-medium/pr-preview/pr-1924/wa-sqlite-async.wasm\":\"3b14f2a6854e2577\",\"/knowledge-medium/pr-preview/pr-1924/wa-sqlite.wasm\":\"d56db36a8dd12f89\"}")
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
